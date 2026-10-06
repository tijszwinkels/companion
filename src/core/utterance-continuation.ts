import { LEGACY_ENDPOINT_MS, SAMPLE_RATE, VAD_SETTINGS } from '../sensors/audio/segmenter.ts';

export { LEGACY_ENDPOINT_MS };

/**
 * Provisional utterances and their commitment point.
 *
 * The segmenter closes a candidate after a short silence (ENDPOINT_MS, 224 ms).
 * The pipeline treats that segment as a provisional attempt: it plays the
 * processing cue, captures the screen, and starts ASR and then the intent LLM
 * immediately. Until the attempt commits to an action, the user may resume
 * speaking. The listener then reports:
 *
 * 1. Resumed speech (a new VAD candidate opened): the attempt is held. ASR and
 *    inference keep running, but the attempt cannot pass its commitment point.
 * 2. The candidate was rejected as too short: the hold is released and the
 *    attempt continues as if nothing happened. No work is lost or repeated.
 * 3. The candidate was accepted: the attempt is superseded. Its routing work is
 *    aborted and a new attempt transcribes the combined raw audio, then runs a
 *    fresh intent LLM on the whole transcript.
 *
 * The commitment point is `commit`, which the router awaits immediately before
 * its first externally visible decision (dispatch or skip). A spoken decision
 * commits only when it is ready AND SPEECH_QUIET_MS have passed since the latest
 * VAD-detected speech: max(speech end + 800 ms, decision ready). A result that
 * arrives early therefore stays provisional, and resumed speech can still
 * replace it; a slow result commits as soon as it is ready. The pipeline also
 * awaits `commit` (for EMPTY_QUIET_MS) before discarding an empty transcript, so
 * an unreadable fragment can still be completed by the speech that follows it.
 * Once `commit` returns, the attempt can no longer be held or superseded, so
 * later speech is a new request and no side effect is ever undone or replayed.
 *
 * Timing: all deadlines use one monotonic clock (performance.now() in
 * production). The speech end is derived from the silence the segmenter
 * actually measured, never assumed: see `AttemptTiming.trailingSilenceMs`.
 *
 * Concurrency: JavaScript runs these callbacks on one thread. `commit` checks
 * the hold and the deadline and marks the attempt committed without an
 * intervening `await`, so resumed speech, the deadline timer and inference
 * completion are ordered, never interleaved.
 */

/**
 * The minimum silence after the latest VAD-detected speech before a spoken
 * decision (the intent LLM's answer, or a prefix/exact-label shortcut) commits.
 * Tijs (2026-09-26): the same total quiet period as the legacy endpoint, 800 ms.
 * Work is not delayed: ASR and inference start at the provisional endpoint, and
 * only the commitment waits. After an ordinary silence endpoint, 224 ms of this
 * period have already passed at admission, so 800 − 224 = 576 ms remain.
 *
 * For shortcuts this is product choice D1: they have no inference time in which
 * a pause can be bridged, so without the floor "go to session ‹pause› three"
 * would dispatch the bare prefix.
 */
export const SPEECH_QUIET_MS = LEGACY_ENDPOINT_MS;

/**
 * How long an attempt whose transcript is empty stays continuable, after the
 * provisional endpoint. A fragment cut by a pause mid-sentence can be
 * unreadable on its own; the words return only when it is retranscribed with
 * the speech that follows. Nothing is shown, played or dispatched while it
 * waits, so this window is longer than the spoken-decision floor. With public
 * audio, it recovered sentences split by pauses of 750–1200 ms that both a
 * 576 ms window and the legacy 800 ms endpoint lost (docs/speech-timing.md).
 * The cost: typed input queued behind such an attempt waits up to this long,
 * and speech within it is joined with the unreadable sound.
 */
export const EMPTY_QUIET_MS = 1200;

/**
 * Product choice D3: combined audio (including the restored pause) is limited
 * to the segmenter's 60-second cap. A continuation that would exceed it is not
 * merged; the held attempt proceeds and the continuation becomes a new request,
 * as a 60-second `limit` segment split would. The transcriber's 61-second
 * request bound leaves room for its empty-result retry padding.
 */
export const MAX_UTTERANCE_SAMPLES = (SAMPLE_RATE * VAD_SETTINGS.maxMs) / 1000;

/**
 * Which kind of decision is about to be made. Inference and shortcuts commit
 * once SPEECH_QUIET_MS have passed since the latest speech; filtering an empty
 * transcript waits EMPTY_QUIET_MS after the provisional endpoint.
 */
export type CommitRoute = 'inference' | 'shortcut' | 'empty';

/**
 * Monotonic time in milliseconds, and timers on the same time base. Production
 * uses `systemClock`; tests substitute a controlled clock so that a deadline
 * can be checked at exact instants (for example 799 and 800 ms after speech).
 */
export interface CommitClock {
  now(): number;

  /** Run `callback` after `delayMs`. Returns a function that cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
}

/** performance.now() is monotonic: it never jumps with wall-clock adjustments. */
export const systemClock: CommitClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** How one attempt measures its quiet periods. Every field has a default. */
export interface AttemptTiming {
  /**
   * The silence at the end of the admitted segment, as measured by the
   * segmenter (`Segment.trailingSilenceMs`). The speech ended this long before
   * admission. A silence endpoint measures 224 ms; a segment closed by the
   * 60-second limit or at end of file may end in less, often 0. The default,
   * 0, is for callers without VAD: no silence is assumed that was not heard.
   */
  trailingSilenceMs?: number;
  clock?: CommitClock;
  speechQuietMs?: number;
  emptyQuietMs?: number;
}

/** The router's view of an attempt: wait until acting on it is final. */
export interface DispatchCommitment {
  /**
   * Resolve once the attempt is committed, or reject with the abort reason if
   * the attempt is superseded or cancelled first. The caller must perform its
   * decision without first awaiting anything else.
   */
  commit(route: CommitRoute, signal: AbortSignal): Promise<void>;
}

/** Abort reason for an attempt replaced by a combined, retranscribed utterance. */
export class UtteranceSupersededError extends Error {
  constructor() {
    super('Speech resumed; this provisional attempt was replaced');
  }
}

/**
 * Transcripts shared by all attempts of one spoken utterance. Only the latest
 * usable text is kept, so memory stays bounded however often the user pauses.
 */
export interface TranscriptChain {
  /** Product choice D2: fallback text if a combined retranscription is empty. */
  latestTranscript?: string;

  /**
   * Frame ids of this utterance's attempts that were superseded, oldest first.
   * The chain's final attempt reports them when it settles, so the desktop can
   * keep one record per utterance (Activity.continuationSettled). Bounded by
   * the number of pauses within the 60-second combined audio cap.
   */
  supersededAttempts: number[];
}

/**
 * Hold and commitment state for one provisional speech attempt. The pipeline
 * creates one per speech job, at admission; typed input has none and is never
 * held.
 */
export class ProvisionalAttempt implements DispatchCommitment {
  private readonly supersession = new AbortController();
  private held = false;
  private isCommitted = false;

  private readonly clock: CommitClock;
  private readonly speechQuietMs: number;
  private readonly emptyQuietMs: number;

  // The two anchors of the quiet periods, in the clock's milliseconds. Both
  // move only when a released hold proves a later sound (see `release`).
  //
  // `endpointAt`: when the latest sound was closed by the segmenter, i.e.
  // admission at the provisional endpoint. EMPTY_QUIET_MS counts from here.
  //
  // `speechEndedAt`: when the latest VAD-detected speech ended, i.e. the
  // endpoint minus its measured trailing silence. SPEECH_QUIET_MS counts from
  // here. Time the job then spends queued, in ASR or in inference is part of
  // the quiet period, because the user was silent throughout it.
  private endpointAt: number;
  private speechEndedAt: number;

  // Waiters in `commit`, woken whenever the hold or supersession changes.
  private waiters: (() => void)[] = [];

  constructor(timing: AttemptTiming = {}) {
    this.clock = timing.clock ?? systemClock;
    this.speechQuietMs = timing.speechQuietMs ?? SPEECH_QUIET_MS;
    this.emptyQuietMs = timing.emptyQuietMs ?? EMPTY_QUIET_MS;

    this.endpointAt = this.clock.now();
    this.speechEndedAt = this.endpointAt - measuredSilence(timing.trailingSilenceMs);
  }

  /** Aborted with UtteranceSupersededError when a continuation replaces this attempt. */
  get signal(): AbortSignal {
    return this.supersession.signal;
  }

  get committed(): boolean {
    return this.isCommitted;
  }

  get superseded(): boolean {
    return this.supersession.signal.aborted;
  }

  /** Resumed speech. Returns false once the attempt has committed or been replaced. */
  hold(): boolean {
    if (this.isCommitted || this.superseded) {
      return false;
    }

    this.held = true;
    this.notify();
    return true;
  }

  /**
   * The resumed sound will not continue this attempt: continue as though it
   * never happened.
   *
   * With `burstTrailingSilenceMs`, the sound was a rejected burst that VAD heard
   * to its end, with that much silence after it. It is now the latest speech, so
   * both quiet periods restart from it, exactly as they do from an endpoint:
   * the user may still continue the utterance after a cough.
   *
   * Without it, the hold ends because no later sound can join this attempt any
   * more: typed input became a boundary, listening ended, or the continuation
   * cannot be merged. Waiting longer could not change the outcome and would
   * only delay this attempt and whatever is queued behind it, so the deadlines
   * stay as they were.
   */
  release(burstTrailingSilenceMs?: number): void {
    if (!this.held) {
      return;
    }

    this.held = false;

    // The burst began after this attempt was admitted, so it can only move the
    // deadlines later; Math.max makes that explicit for any caller.
    if (burstTrailingSilenceMs !== undefined) {
      const rejectedAt = this.clock.now();
      const burstEndedAt = rejectedAt - measuredSilence(burstTrailingSilenceMs);

      this.endpointAt = Math.max(this.endpointAt, rejectedAt);
      this.speechEndedAt = Math.max(this.speechEndedAt, burstEndedAt);
    }

    this.notify();
  }

  /** Replace this attempt. Returns false if it already committed to an action. */
  supersede(): boolean {
    if (this.isCommitted) {
      return false;
    }

    this.held = false;
    this.supersession.abort(new UtteranceSupersededError());
    this.notify();
    return true;
  }

  async commit(route: CommitRoute, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      this.supersession.signal.throwIfAborted();

      // Resumed speech is being collected: wait until it is merged (supersede)
      // or rejected (release), however long the deadline has been passed.
      if (this.held) {
        await this.nextChange(signal);
        continue;
      }

      // The decision is ready, but the user may not have finished speaking.
      // A release can move the deadline later, so it is recomputed each time.
      const remainingMs = this.deadline(route) - this.clock.now();
      if (remainingMs > 0) {
        await this.nextChange(signal, remainingMs);
        continue;
      }

      // No await since the checks above: resumed speech cannot slip in between.
      this.isCommitted = true;
      return;
    }
  }

  /** The earliest clock time at which `route` may commit, if nothing holds it. */
  private deadline(route: CommitRoute): number {
    if (route === 'empty') {
      return this.endpointAt + this.emptyQuietMs;
    }

    return this.speechEndedAt + this.speechQuietMs;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];

    for (const wake of waiters) {
      wake();
    }
  }

  /**
   * Wait for a hold/supersession change, cancellation, or the optional timeout.
   * It always resolves; the caller's loop re-examines the state afterwards.
   * The timer and abort listener are removed so nothing outlives the wait.
   */
  private nextChange(signal: AbortSignal, timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let cancelTimer: (() => void) | undefined;

      const done = () => {
        cancelTimer?.();
        signal.removeEventListener('abort', done);
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      };

      if (timeoutMs !== undefined) {
        cancelTimer = this.clock.schedule(done, timeoutMs);
      }
      signal.addEventListener('abort', done, { once: true });
      this.waiters.push(done);
    });
  }
}

/**
 * A measured trailing silence in milliseconds. Anything that is not a finite,
 * positive duration counts as none: a deadline may be late, never early.
 */
function measuredSilence(trailingSilenceMs: number | undefined): number {
  if (trailingSilenceMs === undefined || !Number.isFinite(trailingSilenceMs)) {
    return 0;
  }

  return Math.max(0, trailingSilenceMs);
}
