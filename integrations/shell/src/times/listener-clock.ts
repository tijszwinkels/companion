/**
 * The listener's clock as this page knows it.
 *
 * The listener stamps its times (a turn's `turnStartedAt`, a message's
 * `createdAt`) on its own clock, which may differ from this browser's (the
 * listener runs on another computer). Every `state` message carries
 * `listenerTime`, the listener's clock when it built that message (see
 * src/desktop/README.md, "Listener time"). On receiving one, this page
 * keeps `offset = listenerTime - Date.now()`; then
 *
 * - a running turn has lasted `Date.now() + offset - turnStartedAt`;
 * - a message was written at `createdAt - offset` on this browser's clock.
 *
 * The error is the delivery delay of the latest state message. Without
 * `listenerTime` (an older listener) the offset is 0.
 *
 * How a state message is noticed: the phone Store replaces its `engine`
 * object exactly when it applies a `state` message (a snapshot, or the
 * engine fields of a later one) and clears it on sign-out; it notifies its
 * subscribers synchronously from the socket's message handler. main.tsx
 * subscribes `observe` to the Store before anything else, so the offset is
 * taken in the same task the message arrived in, before the chat bridge or
 * the page read it. A state message the Store ignores (engine fields before
 * this connection's snapshot) does not change the offset.
 */

import type { AppState } from '../../../mobile/src/store.ts';

export class ListenerClock {
  private offsetMilliseconds = 0;
  private engineSeen: AppState['engine'] = undefined;
  private readonly listeners = new Set<() => void>();

  /** `now` is this browser's clock (`Date.now`); tests pass their own. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The listener's clock minus this browser's, in milliseconds. */
  get offset(): number {
    return this.offsetMilliseconds;
  }

  /** This moment on the listener's clock, in epoch milliseconds. */
  listenerNow(): number {
    return this.now() + this.offsetMilliseconds;
  }

  /** This moment on this browser's clock, in epoch milliseconds. */
  readerNow(): number {
    return this.now();
  }

  /** Told after every change of the offset. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Called with the Store's engine state after every Store change. A new
   * engine object is a state message just applied: take the offset from
   * its `listenerTime` now.
   */
  observe(engine: AppState['engine']): void {
    if (engine === this.engineSeen) {
      return;
    }
    this.engineSeen = engine;
    if (engine === undefined) {
      // Signed out: nothing is shown until the next pairing's snapshot,
      // which sets the offset again.
      return;
    }

    let offset = 0;
    const listenerTime = engine.listenerTime;
    if (typeof listenerTime === 'number' && Number.isFinite(listenerTime)) {
      offset = listenerTime - this.now();
    }
    if (offset === this.offsetMilliseconds) {
      return;
    }
    this.offsetMilliseconds = offset;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
