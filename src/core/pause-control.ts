import { EventEmitter } from 'node:events';

/**
 * Each listening period owns a cancellation signal. Pausing aborts capture,
 * queued work, inference, and delivery. Resuming always creates a fresh period;
 * work from the previous period can never become eligible for delivery again.
 */
export class PauseControl extends EventEmitter {
  private controller = new AbortController();
  private manuallyPaused = false;
  private mediaPlaying = false;
  private mediaOverridden = false;
  private pauseReason: 'manual' | 'media' | '' = '';

  get paused(): boolean {
    return this.pauseReason !== '';
  }

  get reason(): 'manual' | 'media' | '' {
    return this.pauseReason;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  toggle(): void {
    if (this.paused) {
      this.manuallyPaused = false;
      // An explicit resume wins for this playback period. Repeated desktop
      // reports must not immediately undo it; a later stop rearms auto-pause.
      this.mediaOverridden = this.mediaPlaying;
    } else {
      this.manuallyPaused = true;
    }

    this.update();
  }

  /** Playback owns only its pause; it can never clear a manual pause. */
  setMediaPlaying(playing: boolean): void {
    this.mediaPlaying = playing;

    if (!playing) {
      this.mediaOverridden = false;
    }

    this.update();
  }

  private update(): void {
    const reason = this.manuallyPaused
      ? 'manual'
      : this.mediaPlaying && !this.mediaOverridden
        ? 'media'
        : '';

    if (reason === this.pauseReason) {
      return;
    }

    this.pauseReason = reason;

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
