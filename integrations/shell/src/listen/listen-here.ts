/**
 * "Listen here": this browser's microphone as one more microphone of
 * Companion (integrations/shell/README.md, "Listen here"; the rules there
 * are tested in test/shell/listen-rules.test.ts).
 *
 * One object per page (main.tsx). Inputs:
 * - the reader's switch (`setWanted`);
 * - the phone Store's state, through `ListenHost`: whether requests are
 *   admitted, whether the device is paired, and the listener's `paused`,
 *   `ready` and `microphones`;
 * - the gateway's `audio-ended` messages and the answers to `audio-start`
 *   and `audio-stop`, on the page's existing connection;
 * - the microphone's 100 ms pieces and the end of its track (capture.ts).
 *
 * Outputs: requests and binary pieces on that connection; the view the
 * Activity column and the bar's mark draw (`view`, `level`).
 *
 * The rule in one sentence: the microphone is open, and a stream is open
 * or opening, exactly while Listen here is on, the page is connected and
 * admitted, Companion runs and listening is not paused. Everything else is
 * closed. That covers Pause and Resume from any panel, a lost connection
 * and the reconnect, sign-out, and the listener's own end of a stream.
 * While the microphone is open the page shows the mark in the bar and "●"
 * before the tab's title.
 *
 * When the page switches Listen here off by itself (the browser refused the
 * microphone, another tab took over, no sound arrived, Companion refused),
 * it says why (`problem`) and never starts again until the reader switches
 * it on: two tabs never take the stream from each other in turn.
 *
 * Sending: a piece goes out only while the stream is open. When more than
 * two seconds of sound wait in the socket to be sent, the page ends the
 * stream (`audio-stop`), drops what the microphone delivers until the
 * gateway answered, starts a new stream and says "Connection too slow: some
 * speech was lost". Sound is never dropped inside a stream: what was handed
 * to the socket is delivered or the connection (and with it the stream)
 * ends.
 */

import { UncertainOutcome } from '../../../mobile/src/connection.ts';
import type { AudioEndedMessage, MicrophonesState } from '../../../../src/remote/protocol.ts';
import { CaptureError, type CaptureEnvironment, type OpenCapture } from './capture.ts';
import { choiceChanged, initialChoice } from './choice.ts';
import { pieceLevel } from './pcm-pieces.ts';

/** What the controller needs of the listener's state. */
export interface ListenEngine {
  ready: boolean;
  paused: boolean;
  microphones?: MicrophonesState;
}

/** The page's connection, as main.tsx builds it from the Store and bridge. */
export interface ListenHost {
  /** Requests are admitted: connected, and this connection's snapshot arrived. */
  admitted(): boolean;
  /** This browser is paired (not signed out or revoked). */
  paired(): boolean;
  engine(): ListenEngine | undefined;
  /** Called after every change of the above. */
  subscribe(listener: () => void): () => void;
  /** A request without the Store's error toast; rejects with the gateway's message. */
  request(action: 'audio-start' | 'audio-stop'): Promise<unknown>;
  /** One binary message on the open socket; false while not online. */
  sendAudio(piece: ArrayBuffer): boolean;
  /** Bytes the socket still holds to send. */
  bufferedAmount(): number;
  /** Receives each `audio-ended` of this page's connection. */
  onAudioEnded(listener: (message: AudioEndedMessage) => void): void;
  /** A page-level warning (the Store's toast), seen also with Activity hidden. */
  warn(text: string): void;
}

/** Why the page switched Listen here off by itself. */
export type ListenProblemKind = 'refused' | 'no-microphone' | 'moved' | 'lost' | 'stopped';

export interface ListenProblem {
  kind: ListenProblemKind;
  message: string;
}

/**
 * What this browser's row shows:
 * - `unavailable`: no switch; `unavailable` says why;
 * - `off`: the switch is off (`problem` says why, when the page did it);
 * - `asking`: on, waiting for the browser's permission; nothing captured;
 * - `listening`: on, the microphone is open (the stream opens or is open);
 * - `waiting`: on, but the microphone is closed until `waitingFor` ends.
 */
export type ListenPhase = 'unavailable' | 'off' | 'asking' | 'listening' | 'waiting';

export interface ListenView {
  phase: ListenPhase;
  unavailable: string;
  problem?: ListenProblem;
  /** A passing message, such as "Connection too slow: some speech was lost". */
  notice: string;
  waitingFor: 'paused' | 'connection' | 'companion' | '';
  /** This page's stream while it is open ('' otherwise): its entry in `listening`. */
  streamId: string;
}

/** Two seconds of 16 kHz 16-bit sound. */
export const maximumBacklogBytes = 2 * 32_000;

/** A second automatic restart within this time switches Listen here off instead. */
export const automaticRestartInterval = 10_000;

/** How long a passing notice stays. */
const noticeMilliseconds = 10_000;

/**
 * How long the worklet may take to start once the browser granted the
 * microphone. Longer (a stalled download, an audio context the browser
 * keeps suspended) and the page gives up and releases the microphone,
 * instead of holding it while nothing can be sent.
 */
export const startupLimitMs = 10_000;

/** The listener's refusal of `audio-start` while paused (src/sensors/audio/browser-microphones.ts). */
const pausedRefusal = 'Listening is paused';

/**
 * The gateway's refusal of an unanswered `audio-start` that another tab of
 * this device took over meanwhile (src/remote/relay.ts, `audioEndMessages`).
 */
const takenOverRefusal = 'Listening moved to another tab or window of this device';

const notAvailableHere = 'Listening here is not available on this computer';

interface Stream {
  /** `starting` until the gateway answered; `stopping` after a slow-connection stop. */
  phase: 'starting' | 'open' | 'stopping';
  streamId: string;
  /** An `audio-ended` that arrived while the start was unanswered. */
  endedEarly?: AudioEndedMessage;
}

interface Capture {
  /** Gives up the opening: the microphone is released at once. */
  abort: AbortController;
  /** The browser granted the microphone: its track is live (the mark shows). */
  granted: boolean;
  /** Set once the worklet runs: pieces arrive, a stream may start. */
  open?: OpenCapture;
}

export class ListenHere {
  private wanted = initialChoice();
  private problem?: ListenProblem;
  private notice = '';
  private cancelNotice?: () => void;

  private capture?: Capture;
  private stream?: Stream;
  private level = 0;

  /**
   * After the stream ended or was refused because of Pause, no new one
   * starts before the next state message: the message saying "paused" may
   * still be on its way, and a start before it would be refused again.
   */
  private holdUntilState = false;
  private lastEngine?: ListenEngine;
  private lastAutomaticRestart = -Infinity;

  private readonly listeners = new Set<() => void>();
  private readonly levelListeners = new Set<() => void>();
  private updating = false;
  private updateAgain = false;

  constructor(
    private readonly host: ListenHost,
    private readonly environment: CaptureEnvironment,
  ) {
    host.subscribe(() => this.update());
    host.onAudioEnded((message) => this.audioEnded(message));
    this.update();
  }

  // ---- What the page draws ---------------------------------------------------

  get view(): ListenView {
    const unavailable = this.unavailableReason();
    const view: ListenView = {
      phase: 'off',
      unavailable,
      problem: this.problem,
      notice: this.notice,
      waitingFor: '',
      streamId: '',
    };
    if (this.stream?.phase === 'open') {
      view.streamId = this.stream.streamId;
    }

    if (unavailable) {
      view.phase = 'unavailable';
    } else if (!this.wanted) {
      view.phase = 'off';
    } else if (this.capture && !this.capture.granted) {
      view.phase = 'asking';
    } else if (this.capture?.granted) {
      view.phase = 'listening';
    } else {
      view.phase = 'waiting';
      const engine = this.host.engine();
      if (!this.host.admitted()) {
        view.waitingFor = 'connection';
      } else if (engine?.paused || this.holdUntilState) {
        view.waitingFor = 'paused';
      } else {
        view.waitingFor = 'companion';
      }
    }
    return view;
  }

  /** The microphone's loudness, 0 … 1, while it is open; 0 otherwise. */
  get currentLevel(): number {
    return this.level;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The level meter's own subscription: ten changes a second while listening. */
  subscribeLevel(listener: () => void): () => void {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  }

  // ---- The reader's switch ---------------------------------------------------

  /**
   * Listen here on or off. On is accepted only while requests are admitted
   * and listening here is available; off always.
   */
  setWanted(on: boolean): void {
    if (on) {
      if (!this.host.admitted() || this.unavailableReason()) {
        return;
      }
    }
    this.wanted = on;
    this.problem = undefined;
    this.clearNotice();
    choiceChanged(on);
    this.update();
  }

  // ---- The rule ---------------------------------------------------------------

  private unavailableReason(): string {
    const environment = this.environment.unavailable();
    if (environment) {
      return environment;
    }
    // The listener's support is known only from this connection's state.
    if (this.host.admitted() && this.host.engine()?.microphones?.streams !== true) {
      return notAvailableHere;
    }
    return '';
  }

  /**
   * Whether the microphone may be open and a stream open now. A pause the
   * gateway reported before the state did (`holdUntilState`) counts as
   * paused: the microphone closes at once.
   */
  private allowed(): boolean {
    const engine = this.host.engine();
    return (
      this.wanted &&
      this.host.admitted() &&
      this.unavailableReason() === '' &&
      engine?.ready === true &&
      !engine.paused &&
      !this.holdUntilState
    );
  }

  /**
   * Bring the microphone and the stream in line with the rule. Called on
   * every change of the Store's state and after each answer; re-entrant
   * calls (an answer settling while it runs) run it once more afterwards.
   */
  private update(): void {
    if (this.updating) {
      this.updateAgain = true;
      return;
    }
    this.updating = true;
    try {
      do {
        this.updateAgain = false;
        this.updateOnce();
      } while (this.updateAgain);
    } finally {
      this.updating = false;
    }
    this.emit();
  }

  private updateOnce(): void {
    const engine = this.host.engine();
    if (engine !== this.lastEngine) {
      this.lastEngine = engine;
      this.holdUntilState = false;
    }

    // Signed out or revoked: the next pairing starts with Listen here off.
    if (!this.host.paired()) {
      this.wanted = false;
      this.problem = undefined;
    }
    // Known not to be possible on this page or computer: off, without a
    // problem (the row says why instead of offering the switch).
    if (this.wanted && this.unavailableReason() !== '' && this.host.admitted()) {
      this.wanted = false;
      choiceChanged(false);
    }

    if (!this.allowed()) {
      this.stopStream();
      this.closeCapture();
      return;
    }
    if (!this.capture) {
      this.openCapture();
      return;
    }
    if (this.capture.open && !this.stream) {
      this.startStream();
    }
  }

  /** The page switches Listen here off by itself and says why. */
  private turnOff(problem: ListenProblem): void {
    this.wanted = false;
    this.problem = problem;
    choiceChanged(false);
    this.stopStream();
    this.closeCapture();
    this.update();
  }

  // ---- The microphone -----------------------------------------------------------

  private openCapture(): void {
    const capture: Capture = { abort: new AbortController(), granted: false };
    this.capture = capture;

    const opened = this.environment.open(
      {
        onGranted: () => {
          // The track is live from here: the mark and "●" show at once,
          // also while the worklet still loads.
          if (this.capture === capture && !capture.granted) {
            capture.granted = true;
            this.environment.setCapturing(true);
            this.environment.setTimeout(() => {
              if (this.capture === capture && !capture.open) {
                this.turnOff({
                  kind: 'stopped',
                  message: 'The microphone could not be started in time',
                });
              }
            }, startupLimitMs);
            this.emit();
          }
        },
        onPiece: (piece) => this.piece(capture, piece),
        onEnded: () => {
          if (this.capture === capture) {
            this.turnOff({
              kind: 'lost',
              message: 'The microphone stopped (switched off, removed or interrupted)',
            });
          }
        },
      },
      capture.abort.signal,
    );
    opened.then(
      (open) => {
        if (this.capture !== capture) {
          // Switched off (or paused, disconnected) while the browser asked.
          open.close();
          return;
        }
        capture.open = open;
        if (!capture.granted) {
          capture.granted = true;
          this.environment.setCapturing(true);
        }
        this.update();
      },
      (error: unknown) => {
        if (this.capture !== capture) {
          return;
        }
        // The signs go with the microphone (the worklet failed after the
        // browser had granted it).
        this.capture = undefined;
        if (capture.granted) {
          this.environment.setCapturing(false);
        }
        let failure = new CaptureError('failed', String(error));
        if (error instanceof CaptureError) {
          failure = error;
        }
        let kind: ListenProblemKind = 'stopped';
        if (failure.failure === 'refused' || failure.failure === 'no-microphone') {
          kind = failure.failure;
        }
        this.turnOff({ kind, message: failure.message });
      },
    );
  }

  private closeCapture(): void {
    const capture = this.capture;
    if (!capture) {
      return;
    }
    this.capture = undefined;
    if (capture.open) {
      capture.open.close();
    } else {
      // Still asking, or granted while the worklet loads: release now.
      capture.abort.abort();
    }
    if (capture.granted) {
      this.environment.setCapturing(false);
    }
    this.setLevel(0);
  }

  /** One 100 ms piece from the microphone. */
  private piece(capture: Capture, piece: ArrayBuffer): void {
    if (this.capture !== capture || !capture.open) {
      return;
    }
    this.setLevel(pieceLevel(piece));

    const stream = this.stream;
    if (stream?.phase !== 'open') {
      // No stream is open (starting, stopping, or none): this sound belongs
      // to no stream and is not sent.
      return;
    }
    if (this.host.bufferedAmount() > maximumBacklogBytes) {
      this.slowConnection(stream);
      return;
    }
    this.host.sendAudio(piece);
  }

  // ---- The stream -----------------------------------------------------------------

  private startStream(): void {
    const stream: Stream = { phase: 'starting', streamId: '' };
    this.stream = stream;

    this.host.request('audio-start').then(
      (result) => {
        if (this.stream !== stream) {
          // Stopped while starting: the gateway ends that stream itself.
          return;
        }
        const streamId = (result as { streamId?: unknown } | null)?.streamId;
        if (typeof streamId !== 'string' || streamId === '') {
          this.stream = undefined;
          this.turnOff({ kind: 'stopped', message: 'Listening here failed' });
          return;
        }
        stream.phase = 'open';
        stream.streamId = streamId;
        const endedEarly = stream.endedEarly;
        if (endedEarly && endedEarly.streamId === streamId) {
          this.audioEnded(endedEarly);
          return;
        }
        this.emit();
      },
      (error: unknown) => {
        if (this.stream !== stream) {
          return;
        }
        this.stream = undefined;
        // The connection went away: the reconnect starts a new stream.
        if (error instanceof UncertainOutcome || !this.host.admitted()) {
          this.update();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message === pausedRefusal) {
          this.holdUntilState = true;
          this.update();
          return;
        }
        if (message === takenOverRefusal) {
          this.turnOff({
            kind: 'moved',
            message: 'Listening moved to another tab of this browser',
          });
          return;
        }
        this.turnOff({ kind: 'stopped', message });
      },
    );
  }

  /** End the stream, if any. The gateway's answer is not needed. */
  private stopStream(): void {
    const stream = this.stream;
    if (!stream) {
      return;
    }
    this.stream = undefined;
    // A stream already being stopped (slow connection) has its stop on the
    // way; without a connection the gateway ended the stream with it.
    if (stream.phase !== 'stopping' && this.host.admitted()) {
      this.host.request('audio-stop').catch(() => {});
    }
  }

  /**
   * More than two seconds of sound wait to be sent: end this stream, and
   * start a new one once the gateway answered the stop (the answer comes
   * after everything sent before it). Pieces meanwhile are not sent.
   */
  private slowConnection(stream: Stream): void {
    stream.phase = 'stopping';
    this.showNotice('Connection too slow: some speech was lost', true);
    const stopped = () => {
      if (this.stream === stream) {
        this.stream = undefined;
        this.update();
      }
    };
    this.host.request('audio-stop').then(stopped, stopped);
    this.emit();
  }

  /** The gateway ended a stream of this connection without being asked. */
  private audioEnded(message: AudioEndedMessage): void {
    const stream = this.stream;
    if (!stream) {
      return;
    }
    if (stream.phase === 'starting') {
      // Its stream ID is not known yet: decided when the start is answered.
      stream.endedEarly = message;
      return;
    }
    if (message.streamId !== stream.streamId) {
      // An earlier stream of this page.
      return;
    }
    // A stream the page is already ending for a slow connection: a limit
    // or a stall is part of the same congestion, and the stop's answer
    // starts the new stream. Pause, takeover and the rest apply as always.
    const congestion = ['too-large', 'too-fast', 'slow-listener', 'slow', 'stalled'];
    if (stream.phase === 'stopping' && congestion.includes(message.reason)) {
      return;
    }
    this.stream = undefined;

    switch (message.reason) {
      case 'paused':
        // Resume (from any panel) starts a new stream.
        this.holdUntilState = true;
        this.update();
        return;
      case 'taken-over':
        this.turnOff({ kind: 'moved', message: 'Listening moved to another tab of this browser' });
        return;
      case 'stalled':
        this.turnOff({ kind: 'lost', message: 'No sound from this browser' });
        return;
      case 'too-large':
      case 'too-fast':
      case 'slow-listener':
      case 'slow': {
        // A limit: start again at once, unless that already happened just
        // now (then something keeps going wrong and the reader decides).
        const now = this.environment.now();
        if (now - this.lastAutomaticRestart < automaticRestartInterval) {
          this.turnOff({ kind: 'stopped', message: message.message });
          return;
        }
        this.lastAutomaticRestart = now;
        this.showNotice(`Some speech was lost: ${message.message}`, true);
        this.update();
        return;
      }
      default:
        // failed, shutdown, replaced, or a reason this page does not know.
        this.turnOff({ kind: 'stopped', message: message.message || 'Listening here ended' });
    }
  }

  // ---- Notifications ----------------------------------------------------------

  /**
   * A passing notice in this browser's row; `warn` also shows it as a toast,
   * so it is seen with Activity hidden.
   */
  private showNotice(text: string, warn = false): void {
    if (warn) {
      this.host.warn(text);
    }
    this.cancelNotice?.();
    this.notice = text;
    this.cancelNotice = this.environment.setTimeout(() => {
      this.cancelNotice = undefined;
      this.notice = '';
      this.emit();
    }, noticeMilliseconds);
  }

  private clearNotice(): void {
    this.cancelNotice?.();
    this.cancelNotice = undefined;
    this.notice = '';
  }

  private setLevel(level: number): void {
    if (level === this.level) {
      return;
    }
    this.level = level;
    for (const listener of this.levelListeners) {
      listener();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
