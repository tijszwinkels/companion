import { setTimeout as delay } from 'node:timers/promises';

/**
 * How long ordinary listening waits before it opens a new microphone recorder
 * after live capture was lost (see `microphone-loop.ts`).
 *
 * Purpose: an audio-service repair or a PipeWire/WirePlumber restart ends the
 * running `pw-record`. Companion keeps running and simply records again once
 * the audio service is back. Retrying never stops, because the user expects
 * listening to come back without restarting Companion, but the growing delay
 * keeps a PipeWire that stays down from causing a tight respawn loop.
 *
 * Policy, all in milliseconds of monotonic time:
 *
 * - The first retry waits FIRST_RETRY_DELAY_MS; each consecutive loss doubles
 *   the wait, up to MAX_RETRY_DELAY_MS. With these values: 500, 1000, 2000,
 *   4000, then 5000 for every later attempt.
 * - Reset after healthy capture: once one recorder has run for at least
 *   HEALTHY_CAPTURE_MS, however that period ended, the next loss starts again
 *   at the first delay. A recorder that keeps dying shortly after it starts
 *   therefore stays at the capped delay.
 * - Pause, resume and manual recording do not reset the count. They can end
 *   a wait early (see the loop), but they do not prove the microphone works.
 */
export const FIRST_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 5000;
export const HEALTHY_CAPTURE_MS = 10_000;

export class CaptureRetryDelay {
  private nextDelayMs = FIRST_RETRY_DELAY_MS;

  /**
   * Record how long one ordinary listening period had a running recorder.
   * Called for every period, whether it ended by loss, pause or handoff.
   */
  captureLasted(durationMs: number): void {
    if (durationMs >= HEALTHY_CAPTURE_MS) {
      this.nextDelayMs = FIRST_RETRY_DELAY_MS;
    }
  }

  /** Capture was lost: the wait before the next recorder, which grows each time. */
  lost(): number {
    const delayMs = this.nextDelayMs;
    this.nextDelayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
    return delayMs;
  }
}

/** Time source for the microphone loop; tests replace it with fake time. */
export interface RetryClock {
  /** Monotonic milliseconds, used only for durations. */
  now(): number;
  /**
   * Resolve after `durationMs`, or as soon as `signal` aborts. Never rejects:
   * the caller decides what an interrupted wait means.
   */
  sleep(durationMs: number, signal: AbortSignal): Promise<void>;
}

export const systemRetryClock: RetryClock = {
  now: () => performance.now(),
  sleep: async (durationMs, signal) => {
    try {
      await delay(durationMs, undefined, { signal });
    } catch (error) {
      // Only the abort is expected; it ends the wait early.
      if (!signal.aborted) {
        throw error;
      }
    }
  },
};
