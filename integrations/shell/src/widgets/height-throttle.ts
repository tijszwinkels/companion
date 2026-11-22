/**
 * Applies a frame's reported heights to the page at most once per interval.
 *
 * A frame decides when it reports its height; a hostile or broken one may
 * report thousands of times per second. Each change of a panel's height
 * makes the chat lay out its transcript again (and keep the reader's row in
 * place), so the shell applies at most one height per 100 ms and drops the
 * ones in between: the first report applies at once, later ones within the
 * interval wait, and only the last of those is applied when it ends. A
 * height equal to the one applied is not applied again.
 *
 * Timing comes from the caller (the page's clock and timers, or a test's),
 * so the rule is tested in Node. `dispose()` cancels a waiting height; the
 * panel calls it when it is removed, so nothing is applied afterwards.
 */

export const heightIntervalMilliseconds = 100;

export interface ThrottleTimers {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class HeightThrottle {
  private lastApplied = -Infinity;
  private appliedHeight: number | null = null;
  private waitingHeight: number | null = null;
  private timer: unknown = null;

  constructor(
    private readonly apply: (height: number) => void,
    private readonly timers: ThrottleTimers,
    private readonly interval = heightIntervalMilliseconds,
  ) {}

  /** A height already within the bounds (frame-messages.ts clampFrameHeight). */
  report(height: number): void {
    const elapsed = this.timers.now() - this.lastApplied;
    if (this.timer === null && elapsed >= this.interval) {
      this.applyNow(height);
      return;
    }

    // Within the interval: keep only the latest, applied when it ends.
    this.waitingHeight = height;
    if (this.timer === null) {
      const wait = Math.max(0, this.interval - elapsed);
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        const waiting = this.waitingHeight;
        this.waitingHeight = null;
        if (waiting !== null) {
          this.applyNow(waiting);
        }
      }, wait);
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.waitingHeight = null;
  }

  private applyNow(height: number): void {
    // An unchanged height lays out nothing, so it does not start an interval.
    if (height === this.appliedHeight) {
      return;
    }
    this.lastApplied = this.timers.now();
    this.appliedHeight = height;
    this.apply(height);
  }
}
