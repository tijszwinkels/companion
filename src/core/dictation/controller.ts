import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { Log } from '../frame.ts';
import type { PauseControl } from '../pause-control.ts';
import { MAX_DIRECT_USER_MESSAGE_LENGTH } from '../../agents/message-limits.ts';
import { recordDictation, type DictationSink } from '../../sensors/audio/dictation-listener.ts';
import type { VoiceActivityDetector } from '../../sensors/audio/vad.ts';

/**
 * Manual recording into a conversation's text box ("Record" / "Stop recording").
 *
 * Purpose: dictate a longer prompt without pauses causing automatic commands.
 * Recorded speech is transcribed in chunks and appended to one conversation's
 * unsent draft in the panel that started it. It never reaches the router,
 * intent inference, voice shortcuts, transcription cleanup, screenshots,
 * Activity history, capture storage or an agent turn. Send stays the user's
 * separate, explicit action.
 *
 * Inputs: `start`/`stop` from the desktop runtime (one owning panel connection
 * and conversation), the microphone through `record`, and the pause state.
 * Output: ordered `append` requests to the owning panel, each acknowledged
 * with the draft's resulting length, plus `change` and `finished` events.
 *
 * Lifetimes. A recording is `starting` until the CLI's microphone loop hands
 * it the microphone, `recording` while it captures, and `finishing` from the
 * capture boundary until every accepted chunk has been transcribed and
 * delivered. Capture and accepted work are separate: Stop ends capture at
 * once and keeps the final words, then the queue drains. Only one recording
 * exists at a time, so there is never a second recorder or a second caller of
 * the ASR worker from here.
 *
 * Bounds. At most MAX_WAITING_CHUNKS chunks (each at most 60 s of audio)
 * wait for transcription. Capture stops one chunk earlier, so the final chunk
 * always has room and nothing is dropped. Delivery waits for each
 * acknowledgement, so chunks arrive once and in speech order. An append that
 * is not confirmed is never resent: recording stops and says the text may be
 * incomplete. Nothing is retried automatically.
 */

/** The desktop composer's Send limit, shared with agent follow-ups. */
export const DICTATION_CHARACTER_LIMIT = MAX_DIRECT_USER_MESSAGE_LENGTH;

/** Chunks that may wait for transcription; one more may be in progress. */
export const MAX_WAITING_CHUNKS = 4;

/** Capture stops at this backlog, which leaves one free slot for the final chunk. */
const OVERLOAD_WAITING_CHUNKS = MAX_WAITING_CHUNKS - 1;

export type DictationPhase = 'starting' | 'recording' | 'finishing';

/**
 * Why capture ended. `stopped` is the user's Stop recording; the others are
 * automatic boundaries, each explained to the user in `DictationSummary`.
 */
export type DictationStopReason =
  | 'stopped'
  | 'limit'
  | 'navigation'
  | 'paused'
  | 'overload'
  | 'microphone'
  | 'transcription'
  | 'delivery'
  | 'disconnected'
  | 'shutdown';

/** The public state of the current recording, as published to every panel. */
export interface DictationStatus {
  recordingId: string;
  sessionId: string;
  state: DictationPhase;
}

/** One chunk's text for the owning panel, numbered from 1 in speech order. */
export interface DictationAppendRequest {
  recordingId: string;
  clientId: number;
  sessionId: string;
  sequence: number;
  text: string;
}

/**
 * The panel's answer. `appended` carries the draft's resulting length in
 * UTF-16 code units, the same unit as the composer's character counter.
 * `unavailable`: the panel refused (the conversation is not open there, or
 * the recording is not the one it started). `unconfirmed`: no answer in time,
 * or the connection closed after sending; the text may or may not be there.
 * `offline`: nothing was sent.
 */
export type DictationAppendResult =
  | { outcome: 'appended'; length: number }
  | { outcome: 'unavailable' | 'unconfirmed' | 'offline'; reason: string };

export type DictationAppend = (
  request: DictationAppendRequest,
  signal: AbortSignal,
) => Promise<DictationAppendResult>;

/** How a recording ended, sent once to the panel that started it. */
export interface DictationSummary {
  recordingId: string;
  clientId: number;
  sessionId: string;
  reason: DictationStopReason;
  /** False when some recorded speech may be missing from the draft. */
  complete: boolean;
  /** A short explanation for the user; empty after an ordinary Stop. */
  message: string;
  appendedChunks: number;
}

export interface DictationStartRequest {
  clientId: number;
  sessionId: string;
  /** The draft's current length, as reported by the panel. */
  draftLength: number;
  append: DictationAppend;
}

/** Transcribe one chunk on the shared ASR worker (SensorPipeline.transcribeInTurn). */
export type DictationTranscribe = (samples: Float32Array, signal: AbortSignal) => Promise<string>;

/** The capture loop; `recordDictation` in production, a scripted one in tests. */
export type DictationCapture = typeof recordDictation;

/** One recording's capture, queue and delivery state. */
class Recording implements DictationSink {
  readonly id = randomUUID();
  phase: DictationPhase = 'starting';

  // Ends capture gracefully (Stop and every automatic boundary).
  readonly captureStop = new AbortController();
  // Abandons delivery: queued chunks are discarded and nothing more is sent.
  readonly abandoned = new AbortController();

  readonly waiting: Float32Array[] = [];
  // Set once the capture loop has reported its end (or never started).
  captureDone = false;
  worker?: Promise<void>;
  sequence = 0;
  appendedChunks = 0;

  // The first reason wins; later boundaries do not rewrite the explanation.
  stopReason?: DictationStopReason;
  // Set when recorded speech may be missing from the draft.
  incomplete = false;

  constructor(
    readonly clientId: number,
    readonly sessionId: string,
    readonly append: DictationAppend,
    private readonly controller: DictationController,
  ) {}

  accept(samples: Float32Array): void {
    this.controller.accept(this, samples);
  }

  captureEnded(error?: unknown): void {
    this.controller.captureFinished(this, error);
  }
}

export class DictationController extends EventEmitter {
  private current?: Recording;

  // Aborted when a recording asks for the microphone; ordinary listening
  // watches it (see `handoff`). Replaced once that request has been served.
  private handoffController = new AbortController();

  // Pausing (manual or media) also stops manual capture. Only the transition
  // into a pause counts: Record may start while already paused.
  private wasPaused: boolean;

  constructor(
    private readonly transcribe: DictationTranscribe,
    private readonly pause: PauseControl,
    private readonly log: Log,
    // Listener shutdown. Aborts waiting, transcription and delivery.
    private readonly signal: AbortSignal,
    private readonly capture: DictationCapture = recordDictation,
  ) {
    super();
    this.wasPaused = pause.paused;
    pause.on('change', this.pauseChanged);
    signal.addEventListener('abort', this.shutdown, { once: true });
  }

  /** The current recording, or undefined when idle. */
  get status(): DictationStatus | undefined {
    const recording = this.current;
    if (!recording) {
      return undefined;
    }
    return { recordingId: recording.id, sessionId: recording.sessionId, state: recording.phase };
  }

  /** Whether `clientId` started the current recording. */
  ownedBy(clientId: number): boolean {
    return this.current?.clientId === clientId;
  }

  /**
   * Closing the conversation that is being recorded into would discard the
   * words still on their way. Returns the refusal, or undefined when closing
   * is fine. An abandoned recording no longer delivers anything, so it does
   * not block closing.
   */
  closeRefusal(sessionId: string): string | undefined {
    const recording = this.current;
    if (!recording || recording.sessionId !== sessionId || recording.abandoned.signal.aborted) {
      return undefined;
    }
    return 'This conversation is recording into its text box. Stop recording and wait for the transcription to finish before closing it.';
  }

  /**
   * Begin a recording for one panel connection and conversation. Throws a
   * user-facing refusal; nothing changes then. The microphone is taken over
   * by the CLI loop shortly afterwards (`starting` → `recording`).
   */
  start(request: DictationStartRequest): DictationStatus {
    if (this.signal.aborted) {
      throw Error('Companion is shutting down');
    }
    if (this.current) {
      throw Error(
        this.current.phase === 'finishing'
          ? 'The previous recording is still finishing its transcription'
          : 'Another recording is already running',
      );
    }
    if (!Number.isSafeInteger(request.draftLength) || request.draftLength < 0) {
      throw Error('Expected the current draft length');
    }
    if (request.draftLength >= DICTATION_CHARACTER_LIMIT) {
      throw Error(
        `The text box already has ${DICTATION_CHARACTER_LIMIT} or more characters. Shorten it before recording more.`,
      );
    }

    const recording = new Recording(request.clientId, request.sessionId, request.append, this);
    this.current = recording;
    this.log('dictation', `Recording requested for conversation ${request.sessionId}`);

    // Ordinary listening (if running) ends its period and hands over.
    this.handoffController.abort();
    this.changed();

    return this.status!;
  }

  /**
   * End capture gracefully: the final words are still transcribed and
   * delivered. Returns false when there is no recording to stop.
   */
  stop(reason: DictationStopReason): boolean {
    const recording = this.current;
    if (!recording) {
      return false;
    }

    this.endCapture(recording, reason);
    return true;
  }

  /**
   * The owning panel is gone (or Companion is stopping): stop capture,
   * discard queued chunks and deliver nothing more. A chunk already being
   * transcribed finishes on the worker, and its text is dropped.
   */
  abandon(reason: 'disconnected' | 'shutdown'): void {
    const recording = this.current;
    if (!recording) {
      return;
    }

    if (!recording.abandoned.signal.aborted) {
      if (recording.waiting.length > 0 || recording.worker || !recording.captureDone) {
        recording.incomplete = true;
      }
      this.discardWaiting(recording);
      recording.abandoned.abort();
    }
    this.endCapture(recording, reason);
  }

  /** The owning panel now shows something else: stop, and drain to the original draft. */
  ownerViewChanged(clientId: number, sessionId: string): void {
    const recording = this.current;
    if (recording && recording.clientId === clientId && recording.sessionId !== sessionId) {
      this.stop('navigation');
    }
  }

  // ---- Microphone handover (called by the CLI's listening loop) ------------

  /** True while a recording waits for the microphone. */
  get waitingForMicrophone(): boolean {
    return this.current?.phase === 'starting';
  }

  /**
   * For one ordinary listening period: aborted when a recording asks for the
   * microphone, so `listen` ends its period without cancelling accepted work.
   */
  handoff(): AbortSignal {
    if (this.waitingForMicrophone) {
      return AbortSignal.abort();
    }
    if (this.handoffController.signal.aborted) {
      this.handoffController = new AbortController();
    }
    return this.handoffController.signal;
  }

  /**
   * Resolve when the microphone has work: a recording is waiting for it, or
   * ordinary listening is not paused. Rejects on shutdown.
   */
  async waitForMicrophone(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.waitingForMicrophone || !this.pause.paused) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.waitingForMicrophone || !this.pause.paused) {
          cleanup();
          resolve();
        }
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        this.off('change', check);
        this.pause.off('change', check);
        signal.removeEventListener('abort', aborted);
      };

      this.on('change', check);
      this.pause.on('change', check);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /**
   * Run the waiting recording's capture on the microphone. Returns when
   * capture has ended; accepted chunks keep draining in the background while
   * the caller returns the microphone to ordinary listening. Rethrows only
   * shutdown.
   */
  async record(
    vad: VoiceActivityDetector,
    options: { device?: string; file?: string } = {},
  ): Promise<void> {
    const recording = this.current;
    if (!recording || recording.phase !== 'starting') {
      return;
    }

    recording.phase = 'recording';
    this.log('dictation', 'Recording started');
    this.changed();

    await this.capture(
      vad,
      recording,
      this.log,
      this.signal,
      recording.captureStop.signal,
      options,
    );
  }

  // ---- Capture callbacks (Recording implements DictationSink) --------------

  /** @internal A closed chunk from the capture loop, in speech order. */
  accept(recording: Recording, samples: Float32Array): void {
    if (recording.abandoned.signal.aborted || recording.captureDone) {
      samples.fill(0);
      return;
    }

    // Unreachable while capture stops at OVERLOAD_WAITING_CHUNKS; kept so a
    // future change cannot grow the queue without bound or lose words silently.
    if (recording.waiting.length >= MAX_WAITING_CHUNKS) {
      samples.fill(0);
      recording.incomplete = true;
      this.log('dictation', 'Transcription backlog full; a chunk was not transcribed');
      this.endCapture(recording, 'overload');
      return;
    }

    recording.waiting.push(samples);
    this.ensureWorker(recording);

    // Keep the last slot for the final chunk that Stop will produce.
    if (
      !recording.captureStop.signal.aborted &&
      recording.waiting.length >= OVERLOAD_WAITING_CHUNKS
    ) {
      this.log('dictation', 'Transcription is falling behind; stopping capture');
      this.endCapture(recording, 'overload');
    }
  }

  /** @internal Capture has ended; no further chunk will follow. */
  captureFinished(recording: Recording, error?: unknown): void {
    recording.captureDone = true;

    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('dictation', `Microphone capture failed: ${message}`);
      recording.incomplete = true;
      this.endCapture(recording, 'microphone');
    } else {
      // A file can also end on its own; treat it as Stop.
      this.endCapture(recording, 'stopped');
    }

    this.finishIfDone(recording);
  }

  // ---- Internals -------------------------------------------------------

  private readonly pauseChanged = () => {
    const paused = this.pause.paused;
    if (paused && !this.wasPaused) {
      this.stop('paused');
    }
    this.wasPaused = paused;
  };

  private readonly shutdown = () => {
    this.abandon('shutdown');
  };

  /** Stop capture (once) and move to `finishing`. The first reason is kept. */
  private endCapture(recording: Recording, reason: DictationStopReason): void {
    recording.stopReason ??= reason;

    if (!recording.captureStop.signal.aborted) {
      this.log('dictation', `Capture stopping (${reason})`);
      recording.captureStop.abort();
    }

    // Never given the microphone: there is nothing to capture or drain.
    if (recording.phase === 'starting') {
      recording.captureDone = true;
      recording.phase = 'finishing';
      this.finishIfDone(recording);
      return;
    }

    if (recording.phase === 'recording') {
      recording.phase = 'finishing';
      this.changed();
    }
  }

  private ensureWorker(recording: Recording): void {
    if (recording.worker) {
      return;
    }

    recording.worker = this.drain(recording)
      .catch((error: unknown) => {
        // Not expected: transcription and delivery report failures as values.
        const message = error instanceof Error ? error.message : String(error);
        this.log('dictation', `Recording failed: ${message}`);
        this.failed(recording, 'delivery');
      })
      .finally(() => {
        recording.worker = undefined;

        // A chunk may have arrived after the loop's last check.
        if (recording.waiting.length > 0 && !recording.abandoned.signal.aborted) {
          this.ensureWorker(recording);
        } else {
          this.finishIfDone(recording);
        }
      });
  }

  /** Transcribe and deliver one chunk at a time, in speech order. */
  private async drain(recording: Recording): Promise<void> {
    const deliverySignal = AbortSignal.any([this.signal, recording.abandoned.signal]);

    while (recording.waiting.length > 0 && !recording.abandoned.signal.aborted) {
      const samples = recording.waiting.shift()!;
      let text: string;

      // Shutdown is the only cancellation: aborting a request kills the
      // resident ASR worker, so an abandoned chunk finishes and is dropped.
      try {
        text = await this.transcribe(samples, this.signal);
      } catch (error) {
        if (!this.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          this.log('dictation', `Transcription failed: ${message}`);
        }
        this.failed(recording, 'transcription');
        return;
      } finally {
        samples.fill(0);
      }

      if (recording.abandoned.signal.aborted) {
        return;
      }

      // Silence or unreadable sound: nothing to add, as in ordinary listening.
      const trimmed = text.trim();
      if (!trimmed) {
        continue;
      }

      recording.sequence++;
      const result = await recording.append(
        {
          recordingId: recording.id,
          clientId: recording.clientId,
          sessionId: recording.sessionId,
          sequence: recording.sequence,
          text: trimmed,
        },
        deliverySignal,
      );

      if (result.outcome !== 'appended') {
        this.log('dictation', `Chunk ${recording.sequence} not appended (${result.outcome})`);
        this.failed(recording, 'delivery');
        return;
      }

      recording.appendedChunks++;
      this.log(
        'dictation',
        `Chunk ${recording.sequence}: ${trimmed.length} characters appended (draft ${result.length})`,
      );

      // The draft reached the Send limit: stop capture, but keep the words
      // already captured. The draft may then exceed the limit; Send asks the
      // user to shorten it rather than this code cutting any text.
      if (result.length >= DICTATION_CHARACTER_LIMIT) {
        this.endCapture(recording, 'limit');
      }
    }
  }

  /** Transcription or delivery failed: keep what was added, drop the rest. */
  private failed(recording: Recording, reason: 'transcription' | 'delivery'): void {
    if (!recording.abandoned.signal.aborted) {
      recording.incomplete = true;
      this.discardWaiting(recording);
      recording.abandoned.abort();
    }
    this.endCapture(recording, reason);
  }

  private discardWaiting(recording: Recording): void {
    for (const samples of recording.waiting.splice(0)) {
      samples.fill(0);
    }
  }

  private finishIfDone(recording: Recording): void {
    if (
      this.current !== recording ||
      !recording.captureDone ||
      recording.worker ||
      recording.waiting.length > 0
    ) {
      return;
    }

    this.current = undefined;
    const reason = recording.stopReason ?? 'stopped';
    const summary: DictationSummary = {
      recordingId: recording.id,
      clientId: recording.clientId,
      sessionId: recording.sessionId,
      reason,
      complete: !recording.incomplete,
      message: summaryMessage(reason, recording.incomplete),
      appendedChunks: recording.appendedChunks,
    };

    this.log(
      'dictation',
      `Recording finished (${reason}): ${summary.appendedChunks} chunks appended` +
        (summary.complete ? '' : '; text may be incomplete'),
    );
    this.emit('finished', summary);
    this.changed();
  }

  private changed(): void {
    this.emit('change');
  }

  /** Wait until no chunk of the current recording is being transcribed or delivered. */
  async idle(): Promise<void> {
    while (this.current?.worker) {
      await this.current.worker;
    }
  }

  /** Detach from the pause control; used when the listener stops. */
  close(): void {
    this.pause.off('change', this.pauseChanged);
    this.signal.removeEventListener('abort', this.shutdown);
  }
}

/** The explanation shown below the text box when a recording ends. */
function summaryMessage(reason: DictationStopReason, incomplete: boolean): string {
  switch (reason) {
    case 'stopped':
      return '';
    case 'limit':
      return `Recording stopped at ${DICTATION_CHARACTER_LIMIT} characters. Shorten the text before sending.`;
    case 'navigation':
      return 'Recording stopped because you left this conversation. The recorded text was added here.';
    case 'paused':
      return 'Recording stopped because listening was paused.';
    case 'overload':
      return incomplete
        ? 'Recording stopped because transcription fell behind. Some speech may be missing.'
        : 'Recording stopped because transcription fell behind. Everything recorded so far was added.';
    case 'microphone':
      return 'The microphone stopped, so recording ended. Speech after that point was not recorded.';
    case 'transcription':
      return 'Transcription failed, so recording stopped. The text is incomplete: later speech was not added.';
    case 'delivery':
      return 'The text box did not confirm a transcript chunk, so recording stopped. Check the text: some speech may be missing.';
    case 'disconnected':
    case 'shutdown':
      return 'Recording stopped because Companion disconnected. Some speech may be missing.';
  }
}
