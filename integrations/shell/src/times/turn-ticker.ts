/**
 * Advances every running turn timer shown on the page (the bar's and the
 * list's), without drawing the page again.
 *
 * Each shown timer registers a text node and the start of its turn on the
 * listener's clock (`add`); the ticker writes `elapsedText(listenerNow -
 * startedAt)` into it, at once and then each time the shown second
 * changes. Only the text of the registered nodes changes: Preact does not
 * draw anything for a tick, so selection, focus and input elsewhere on the
 * page are untouched.
 *
 * Timing: one timeout for all timers, set for the earliest moment one of
 * them reaches its next whole second (and never more than a second ahead,
 * so a changed clock offset or a clock that was behind is caught up within
 * a second). A change of the listener clock's offset (a new state message)
 * writes every timer at once. No timeout is pending while no timer is
 * shown.
 *
 * Ownership: the component that adds a timer removes it when it goes away
 * (../times/TurnTimer.tsx); `add` returns that removal.
 */

import type { ListenerClock } from './listener-clock.ts';
import { elapsedText } from './turn-times.ts';

/** The part of a DOM Text node the ticker writes (tests pass a stand-in). */
export interface TimerText {
  data: string;
}

/** Timeouts, so tests can drive the ticker without waiting. */
export interface TickerTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: TickerTimers = {
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The longest wait between two checks of the timers, in milliseconds. */
const longestWait = 1000;

interface ShownTimer {
  text: TimerText;
  /** The turn's start, epoch milliseconds on the listener's clock. */
  startedAt: number;
}

export class TurnTicker {
  private readonly timers = new Set<ShownTimer>();
  private pending: unknown = undefined;
  private scheduled = false;

  constructor(
    private readonly clock: Pick<ListenerClock, 'listenerNow' | 'subscribe'>,
    private readonly timeouts: TickerTimers = browserTimers,
  ) {
    // A new offset moves every running time: write them all now.
    clock.subscribe(() => {
      this.tick();
    });
  }

  /** How many timers are shown now (for tests). */
  get count(): number {
    return this.timers.size;
  }

  /** Show a running time in `text` from now on; returns its removal. */
  add(text: TimerText, startedAt: number): () => void {
    const timer: ShownTimer = { text, startedAt };
    this.timers.add(timer);
    this.tick();
    return () => {
      this.timers.delete(timer);
      if (this.timers.size === 0) {
        this.cancel();
      }
    };
  }

  /** Write every timer's text and wait for the next change of a second. */
  private tick(): void {
    this.cancel();
    if (this.timers.size === 0) {
      return;
    }

    const now = this.clock.listenerNow();
    let wait = longestWait;
    for (const timer of this.timers) {
      const elapsed = now - timer.startedAt;
      const text = elapsedText(elapsed);
      if (timer.text.data !== text) {
        timer.text.data = text;
      }
      if (elapsed >= 0) {
        // The next whole second of this timer (1 ms late, so the division
        // there lands on it, not just before it).
        const untilNextSecond = 1000 - (elapsed % 1000) + 1;
        wait = Math.min(wait, untilNextSecond);
      }
    }

    this.scheduled = true;
    this.pending = this.timeouts.setTimeout(() => {
      this.scheduled = false;
      this.pending = undefined;
      this.tick();
    }, wait);
  }

  private cancel(): void {
    if (this.scheduled) {
      this.timeouts.clearTimeout(this.pending);
      this.scheduled = false;
      this.pending = undefined;
    }
  }
}
