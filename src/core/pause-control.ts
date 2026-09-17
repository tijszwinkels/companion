import { EventEmitter } from 'node:events';

/**
 * Each listening period owns a cancellation signal. Pausing aborts capture,
 * queued work, inference, and delivery. Resuming always creates a fresh period;
 * work from the previous period can never become eligible for delivery again.
 */
export class PauseControl extends EventEmitter {
  private controller = new AbortController();
  paused = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  toggle(): void {
    this.paused = !this.paused;

    if (this.paused) {
      this.controller.abort();
    } else {
      this.controller = new AbortController();
    }

    this.emit('change');
  }

  /** Shutdown also wakes a paused listener so it can release native resources. */
  async waitUntilResumed(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    if (!this.paused) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.off('change', changed);
        signal.removeEventListener('abort', aborted);
      };

      const changed = () => {
        if (!this.paused) {
          cleanup();
          resolve();
        }
      };

      const aborted = () => {
        cleanup();
        reject(signal.reason);
      };

      this.on('change', changed);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
