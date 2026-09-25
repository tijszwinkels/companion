import { ENDPOINT_MS, SAMPLE_RATE, VAD_SETTINGS } from '../sensors/audio/segmenter.ts';

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
 * its first externally visible decision (dispatch or skip). Once `commit`
 * returns, the attempt can no longer be held or superseded, so later speech is
 * a new request and no side effect is ever undone or replayed.
 *
 * Concurrency: JavaScript runs these callbacks on one thread. `commit` checks
 * the hold and marks the attempt committed without an intervening `await`, so
 * resumed speech and inference completion are ordered, never interleaved.
 */

/** The endpoint before provisional attempts; shortcut commands keep its quiet window. */
export const LEGACY_ENDPOINT_MS = 800;

/**
 * Product choice D1: prefix and exact-label shortcuts have no LLM wait, so they
 * would otherwise commit as soon as ASR returns and split commands such as
 * "go to session ‹pause› three". Instead they commit only after the same total
 * quiet period as the old endpoint: 800 ms after speech ended, which is
 * 800 − 224 = 576 ms after the provisional endpoint. Derived from both values so
 * the two cannot drift apart. The LLM path has no additional wait.
 */
export const SHORTCUT_QUIET_MS = LEGACY_ENDPOINT_MS - ENDPOINT_MS;

/**
 * Product choice D3: combined audio is limited to the segmenter's existing
 * 30-second cap. A continuation that would exceed it is not merged; the held
 * attempt proceeds and the continuation becomes a new request, as a 30-second
 * `limit` segment split would today.
 */
export const MAX_UTTERANCE_SAMPLES = (SAMPLE_RATE * VAD_SETTINGS.maxMs) / 1000;

/** Which kind of route is about to act; shortcuts wait for the legacy quiet window. */
export type CommitRoute = 'inference' | 'shortcut';

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
}

/**
 * Hold and commitment state for one provisional speech attempt. The pipeline
 * creates one per speech job; typed input has none and is never held.
 */
export class ProvisionalAttempt implements DispatchCommitment {
  private readonly supersession = new AbortController();
  private held = false;
  private isCommitted = false;

  // Start of the current quiet period, in performance.now() milliseconds.
  // Admission happens at the provisional endpoint; a released hold restarts
  // the period because the rejected burst was the most recent sound.
  private quietSince = performance.now();

  // Waiters in `commit`, woken whenever the hold or supersession changes.
  private waiters: (() => void)[] = [];

  constructor(private readonly shortcutQuietMs = SHORTCUT_QUIET_MS) {}

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

  /** The resumed sound was not speech: continue as though it never happened. */
  release(): void {
    if (!this.held) {
      return;
    }

    this.held = false;
    this.quietSince = performance.now();
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

      if (this.held) {
        await this.nextChange(signal);
        continue;
      }

      if (route === 'shortcut') {
        const remainingMs = this.quietSince + this.shortcutQuietMs - performance.now();

        if (remainingMs > 0) {
          await this.nextChange(signal, remainingMs);
          continue;
        }
      }

      // No await since the checks above: resumed speech cannot slip in between.
      this.isCommitted = true;
      return;
    }
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
      let timer: ReturnType<typeof setTimeout> | undefined;

      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      };

      if (timeoutMs !== undefined) {
        timer = setTimeout(done, timeoutMs);
      }
      signal.addEventListener('abort', done, { once: true });
      this.waiters.push(done);
    });
  }
}
