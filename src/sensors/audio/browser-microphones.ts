import { randomUUID } from 'node:crypto';

import type { Activity } from '../../core/activity.ts';
import { notAdmitted, type CaptureAdmission } from '../../capture-storage/policy.ts';
import type { Log } from '../../core/frame.ts';
import type { PauseControl } from '../../core/pause-control.ts';
import type { SensorPipeline } from '../../core/pipeline.ts';
import { listen } from './listener.ts';
import { NetworkAudioSource } from './network-source.ts';
import { SAMPLE_RATE } from './segmenter.ts';
import type { SpeechIndicator } from './speech-indicator.ts';
import type { VoiceActivityDetector } from './vad.ts';

/**
 * Listening browsers: one more microphone of Companion per browser stream.
 *
 * Purpose: a paired browser that switched on "Listen here" streams its
 * microphone through the remote gateway (src/remote/README.md, "Listening
 * browsers"). Each stream is a microphone of its own and gets its own
 * listening period: its own voice detector, segmenter and `listen` call, on a
 * `NetworkAudioSource`. Its speech enters the same pipeline as the
 * computer's, named by the stream's ID, so continuation stays per microphone
 * (src/core/pipeline.ts). Nothing after the microphone treats it differently.
 * The rules are in src/sensors/audio/README.md.
 *
 * Inputs (from the listener's control socket, src/desktop/runtime.ts):
 * - `start(owner, name)` for a remote connection's `audio-start`;
 * - `push(owner, bytes)` for its `audio-chunk` pieces;
 * - `stop(owner, reason)` for `audio-stop` and a closed connection.
 * `owner` is the control connection's client ID: a connection holds at most
 * one stream, and only it can feed or stop it.
 *
 * Outputs: speech submitted to the pipeline; `ended(owner, id, reason)` for
 * every end of a stream, including the ones the owner asked for; `changed()`
 * whenever the list of streams changes.
 *
 * Lifetime and resources: a stream's period holds one voice detector, created
 * when the stream starts and closed when its period has ended; queued sound
 * is bounded by `maximumQueuedMs` (beyond it the stream ends as `slow`). At
 * most `maximumPeriods` periods exist at once, counting those of ended
 * streams whose detector is still loading or closing, so restarts can never
 * pile up detectors. A stream whose sound falls more than `maximumLagMs`
 * (plus 1% of its age, for clock drift) behind real time ends as `stalled`:
 * a phone whose capture stopped, or that delivers far too little sound,
 * while its page stays connected. Its open candidate could otherwise hold
 * the shared queue.
 * Pause ends every stream (`paused`); the browser opens a new one when the
 * listener is listening again. Shutdown ends them all; `idle()` waits until
 * every period has ended and its detector is closed.
 *
 * Accepted work is never cancelled by the end of a stream, only by pause and
 * shutdown, exactly as for the computer's microphone. The open candidate of
 * an ended stream is discarded.
 */

/** Why a stream ended. `stopped`: its owner asked; the others are reported to it. */
export type BrowserStreamEnd =
  'stopped' | 'replaced' | 'paused' | 'slow' | 'stalled' | 'failed' | 'disconnected' | 'shutdown';

/** A listening browser as the listener's state shows it. */
export interface BrowserMicrophone {
  /** The stream's ID: random, new for every stream. */
  id: string;
  /** The paired device's name, as the gateway reported it. */
  name: string;
}

export interface BrowserMicrophonesOptions {
  pipeline: SensorPipeline;
  pause: PauseControl;
  /** Listener shutdown. */
  signal: AbortSignal;
  /** A fresh voice detector for each stream; closed when its period ends. */
  createVad(): Promise<VoiceActivityDetector>;
  /** Activity callbacks shared with the computer's microphone. */
  activity: Activity;
  /** Joins every microphone's speech into "hearing speech". */
  speech: SpeechIndicator;
  log: Log;
  /** Listening periods at once, of open and of ending streams; 8 by default. */
  maximumPeriods?: number;
  /** Sound that may wait for a stream's voice detector; 5 seconds by default. */
  maximumQueuedMs?: number;
  /**
   * How far a stream's sound may fall behind real time before it ends as
   * `stalled`; 3 seconds by default.
   */
  maximumLagMs?: number;
}

/**
 * Listening periods at once by default: the gateway's connection limit
 * (`maximumRemoteConnections`, src/remote/protocol.ts), one stream each. The
 * gateway's own limit of four streams applies first; the listener's bound is
 * higher so that a takeover (the new stream's start and the old stream's stop
 * arrive on different connections) is never refused at four.
 */
export const maximumBrowserPeriods = 8;

/** Sound that may wait for a stream's voice detector by default, in milliseconds. */
export const maximumQueuedSoundMs = 5000;

/**
 * How far a stream's sound may fall behind real time by default, in
 * milliseconds. A browser sends a piece of 100 ms every 100 ms; being three
 * seconds behind means its capture stopped or its connection cannot carry it.
 */
export const maximumSoundLagMs = 3000;

/**
 * How far ahead of real time a stream's sound counts for the lag bound: the
 * gateway's burst (`audioBurstSeconds` in src/remote/protocol.ts).
 */
const maximumAheadMs = 2000;

/**
 * Clock drift allowed between a browser's sound and the listener's clock: 1%
 * of the stream's age, but never more than `maximumDriftMs` in all.
 *
 * Why 10 seconds: real sound clocks differ by about 0.01% (100 ppm) at most,
 * so a browser whose clock runs that slow falls 13 seconds behind (3 s lag +
 * 10 s drift) only after about 36 hours of uninterrupted listening; it then
 * ends as `stalled` (its open candidate, if any, is lost), and the browser
 * must send a new `audio-start` to go on listening. Without a cap the allowance grows with the stream's
 * age: after eight hours a phone whose capture stopped would stay
 * "listening" (and could hold its open candidate in the shared queue) for
 * almost five minutes. With it, such a stream ends at most 15 seconds after
 * its last piece, at any age: up to 2 s of sound credited ahead of real
 * time (`maximumAheadMs`), 3 s lag and 10 s drift.
 */
const allowedDrift = 0.01;
export const maximumDriftMs = 10_000;

/**
 * The stream age, in milliseconds, at which a stream that has delivered
 * `receivedMs` of sound counts as stalled: when its sound is more than
 * `maximumLagMs` plus the drift allowance (1% of its age, at most
 * `driftCapMs`) behind real time. The allowance reaches its cap at the age
 * `driftCapMs / allowedDrift`; before that, age * (1 - drift) must reach
 * the sound plus the lag, after it, age - cap must.
 */
export function stalledAtAgeMs(
  receivedMs: number,
  maximumLagMs: number,
  driftCapMs: number = maximumDriftMs,
): number {
  const owed = maximumLagMs + receivedMs;
  const uncappedAge = owed / (1 - allowedDrift);
  if (uncappedAge * allowedDrift <= driftCapMs) {
    return uncappedAge;
  }
  return owed + driftCapMs;
}

/** Names of ended streams kept for Activity entries still being processed. */
const rememberedNames = 64;

interface Stream extends BrowserMicrophone {
  owner: number;
  source: NetworkAudioSource;
  /** Capture-storage admission, taken when the stream was accepted. */
  admission: CaptureAdmission;
  /** Aborted when the stream ends for any reason; ends the period's frames. */
  end: AbortController;
  /** When the stream was accepted (performance.now), and the sound received since, in ms. */
  startedAt: number;
  receivedMs: number;
  /** Ends the stream as `stalled` when its sound falls too far behind. */
  lagTimer?: ReturnType<typeof setTimeout>;
  /** This stream's "hearing speech" report (SpeechIndicator). */
  speechChanged: (speaking: boolean) => void;
  /** Settles when the period has ended and its voice detector is closed. */
  period?: Promise<void>;
}

export class BrowserMicrophones {
  private readonly streams = new Map<number, Stream>();
  private readonly periods = new Set<Promise<void>>();
  /** Stream ID → device name, for streams that are open or ended recently. */
  private readonly names = new Map<string, string>();
  private readonly maximumPeriods: number;
  private readonly maximumQueuedMs: number;
  private readonly maximumLagMs: number;

  /** Called for every end of a stream; set by the owner of the control socket. */
  ended: (owner: number, id: string, reason: BrowserStreamEnd) => void = () => {};
  /** Called whenever the list of open streams changed. */
  changed: () => void = () => {};

  constructor(private readonly options: BrowserMicrophonesOptions) {
    this.maximumPeriods = options.maximumPeriods ?? maximumBrowserPeriods;
    this.maximumQueuedMs = options.maximumQueuedMs ?? maximumQueuedSoundMs;
    this.maximumLagMs = options.maximumLagMs ?? maximumSoundLagMs;
    options.pause.on('change', this.pauseChanged);
    options.signal.addEventListener('abort', this.shutdown, { once: true });
  }

  /** The open streams, oldest first. */
  get list(): BrowserMicrophone[] {
    return [...this.streams.values()].map((stream) => ({ id: stream.id, name: stream.name }));
  }

  /** The device name of a stream that is open or ended recently. */
  nameOf(id: string): string | undefined {
    for (const stream of this.streams.values()) {
      if (stream.id === id) {
        return stream.name;
      }
    }
    return this.names.get(id);
  }

  /**
   * The connection that owns the stream `id` while that stream is open;
   * undefined once it has ended (or for the computer's microphone). Speech
   * a browser heard follows what that connection shows.
   */
  ownerOf(id: string): number | undefined {
    for (const stream of this.streams.values()) {
      if (stream.id === id) {
        return stream.owner;
      }
    }
    return undefined;
  }

  /**
   * Start a stream for connection `owner`, named after its device. Ends the
   * connection's earlier stream first (`replaced`). Throws, starting
   * nothing, while paused, at shutdown, or when `maximumPeriods` periods
   * (of open or ending streams) exist. Returns the new stream's ID.
   *
   * The stream's capture-storage admission is taken now, before any of its
   * sound can be queued (src/sensors/audio/README.md, "Stored audio").
   */
  start(owner: number, name: string): string {
    this.options.signal.throwIfAborted();
    if (this.options.pause.paused) {
      throw Error('Listening is paused');
    }

    this.stop(owner, 'replaced');
    if (this.periods.size >= this.maximumPeriods) {
      throw Error('Too many browsers are listening');
    }

    const stream: Stream = {
      id: randomUUID(),
      name,
      owner,
      source: new NetworkAudioSource(this.maximumQueuedMs),
      admission: this.options.activity.admitCapture?.() ?? notAdmitted,
      end: new AbortController(),
      startedAt: performance.now(),
      receivedMs: 0,
      speechChanged: () => {},
    };
    stream.speechChanged = this.options.speech.reporter(stream.id);
    this.streams.set(owner, stream);
    this.remember(stream);
    this.watchLag(stream);

    const period = this.run(stream).finally(() => {
      this.periods.delete(period);
    });
    stream.period = period;
    this.periods.add(period);

    this.options.log('microphone', `Browser listening: ${name}`);
    this.changed();
    return stream.id;
  }

  /**
   * One piece of the connection's stream: 16-bit little-endian samples.
   * Throws when the connection has no stream. A piece the stream cannot
   * hold ends the stream (`slow`) and is not an error of the request.
   */
  push(owner: number, bytes: Buffer): void {
    const stream = this.streams.get(owner);
    if (!stream) {
      throw Error('No audio stream is open on this connection');
    }

    if (!stream.source.push(bytes)) {
      this.options.log(
        'microphone',
        `Browser stream ${stream.name}: more than ${this.maximumQueuedMs} ms of sound waiting; ending it`,
      );
      this.finish(stream, 'slow');
      return;
    }
    // Sound ahead of real time earns credit only up to the gateway's burst
    // (two seconds): a stream cannot bank early sound and then hold the
    // shared queue silently for longer than the bound.
    const elapsedMs = performance.now() - stream.startedAt;
    const pieceMs = (bytes.length / 2 / SAMPLE_RATE) * 1000;
    stream.receivedMs = Math.min(stream.receivedMs + pieceMs, elapsedMs + maximumAheadMs);
    this.watchLag(stream);
  }

  /**
   * (Re)start the stream's lag timer. It fires when the stream's sound would
   * fall more than `maximumLagMs` (plus the capped drift allowance) behind
   * real time (`stalledAtAgeMs`). Every piece moves it later by the sound it
   * carried, so a stream that stops, or trickles, ends in time, and one that
   * keeps up never.
   */
  private watchLag(stream: Stream): void {
    clearTimeout(stream.lagTimer);
    const deadline = stream.startedAt + stalledAtAgeMs(stream.receivedMs, this.maximumLagMs);
    stream.lagTimer = setTimeout(
      () => {
        this.options.log(
          'microphone',
          `Browser stream ${stream.name}: its sound fell ${this.maximumLagMs} ms behind; ending it`,
        );
        this.finish(stream, 'stalled');
      },
      Math.max(0, deadline - performance.now()),
    );
    // A timer never keeps the listener process alive on its own.
    stream.lagTimer.unref();
  }

  /**
   * End the connection's stream, if it has one, and only if it is `streamId`
   * when one is named (a late stop must never end a newer stream). Returns
   * whether a stream ended.
   */
  stop(owner: number, reason: BrowserStreamEnd, streamId?: string): boolean {
    const stream = this.streams.get(owner);
    if (!stream || (streamId !== undefined && stream.id !== streamId)) {
      return false;
    }

    this.finish(stream, reason);
    return true;
  }

  /** Wait until every stream's period has ended and its detector is closed. */
  async idle(): Promise<void> {
    while (this.periods.size) {
      await Promise.all(this.periods);
    }
  }

  /** Stop following pause and shutdown, end every stream, wait for their periods. */
  async close(): Promise<void> {
    this.options.pause.off('change', this.pauseChanged);
    this.options.signal.removeEventListener('abort', this.shutdown);
    this.endAll('shutdown');
    await this.idle();
  }

  /** Pause stops every microphone: the browsers open new streams on Resume. */
  private readonly pauseChanged = () => {
    if (this.options.pause.paused) {
      this.endAll('paused');
    }
  };

  private readonly shutdown = () => {
    this.endAll('shutdown');
  };

  private endAll(reason: BrowserStreamEnd): void {
    for (const stream of [...this.streams.values()]) {
      this.finish(stream, reason);
    }
  }

  /** Remove a stream, end its period and tell its owner why. */
  private finish(stream: Stream, reason: BrowserStreamEnd): void {
    if (this.streams.get(stream.owner) !== stream) {
      return;
    }

    this.streams.delete(stream.owner);
    clearTimeout(stream.lagTimer);
    stream.end.abort();
    // Nothing will listen to its unread sound: drop it now, not only when
    // the period's detector has finished loading or its current frame.
    stream.source.clear();

    // Release the stream's hold and "hearing speech" now, not only when its
    // period has unwound: a frame may still be in the voice detector, and
    // other microphones' speech must not wait for it. Both are idempotent;
    // the period does the same in `listen`'s cleanup.
    this.options.pipeline.speechDiscarded(undefined, stream.id);
    stream.speechChanged(false);
    // Its last utterances may still be transcribed: keep its name among
    // the most recent ones.
    this.remember(stream);

    this.options.log('microphone', `Browser stream ended (${reason}): ${stream.name}`);
    this.ended(stream.owner, stream.id, reason);
    this.changed();
  }

  /** Keep a stream's name for its Activity entries, bounded to the latest streams. */
  private remember(stream: Stream): void {
    this.names.delete(stream.id);
    this.names.set(stream.id, stream.name);
    while (this.names.size > rememberedNames) {
      const oldest = this.names.keys().next().value!;
      this.names.delete(oldest);
    }
  }

  /**
   * The stream's listening period. Pause and shutdown cancel its accepted
   * work (as for the computer's microphone); the end of the stream does not.
   */
  private async run(stream: Stream): Promise<void> {
    const { pipeline, log } = this.options;
    const listeningSignal = AbortSignal.any([this.options.signal, this.options.pause.signal]);
    const activity: Activity = {
      ...this.options.activity,
      speechChanged: stream.speechChanged,
    };
    let vad: VoiceActivityDetector | undefined;

    try {
      vad = await this.options.createVad();

      // The stream may have ended while the detector was loading.
      if (stream.end.signal.aborted || listeningSignal.aborted) {
        return;
      }

      await listen(
        vad,
        pipeline,
        log,
        listeningSignal,
        {
          source: (signal) => stream.source.frames(signal),
          handoff: stream.end.signal,
          microphone: stream.id,
          captureAdmission: stream.admission,
        },
        activity,
      );
    } catch (error) {
      // Pause, shutdown and the end of the stream are not failures.
      if (!listeningSignal.aborted && !stream.end.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        log('microphone', `Browser stream ${stream.name} failed: ${message}`);
        this.finish(stream, 'failed');
      }
    } finally {
      // The stream never outlives its period. Usually it has already ended
      // (stopped, paused, failed above); otherwise its period ended without
      // a reason given here, and nothing reads it any more.
      this.finish(stream, 'failed');
      try {
        await vad?.close();
      } catch (error) {
        // A detached period must never reject: that would end the listener.
        const message = error instanceof Error ? error.message : String(error);
        log(
          'microphone',
          `Browser stream ${stream.name}: closing its voice detector failed: ${message}`,
        );
      }
    }
  }
}
