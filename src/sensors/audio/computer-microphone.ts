import { EventEmitter } from 'node:events';

/**
 * The computer's microphone switch (decision D8 of the browser voice design).
 *
 * Purpose: two microphones in one room hear the same sentence, and Companion
 * then acts on it twice. The listener does not try to detect that; instead
 * the user can switch the computer's microphone off while a browser (a phone
 * beside the computer, say) listens. Turning it off ends the computer's
 * current listening period as a manual recording's hand-over does: the open
 * candidate is discarded, utterances already accepted continue. Turning it
 * on starts a new period (unless listening is paused).
 *
 * The switch is independent of Pause: Pause stops every microphone; this
 * switch stops only the computer's. Like the sound switch, it lives for the
 * listener's run and starts on. Manual recording (Record) still uses the
 * computer's microphone while the switch is off: Record is an explicit
 * request for that microphone.
 *
 * `listening` says whether an ordinary listening period of the computer's
 * microphone runs right now (set by `listenWhileSwitchedOn`): false while
 * switched off, while paused, between a lost recorder and its retry, and
 * while Record has the microphone.
 *
 * Events: `change` after every change of `enabled` or `listening`.
 */
export class ComputerMicrophoneSwitch extends EventEmitter {
  private switchedOn = true;
  private periodRunning = false;
  // Aborted when the switch turns off; replaced when it turns on again.
  private controller = new AbortController();

  get enabled(): boolean {
    return this.switchedOn;
  }

  /** An ordinary listening period of the computer's microphone runs now. */
  get listening(): boolean {
    return this.periodRunning;
  }

  /** Set by `listenWhileSwitchedOn` around each period. */
  setListening(listening: boolean): void {
    if (listening !== this.periodRunning) {
      this.periodRunning = listening;
      this.emit('change');
    }
  }

  /** Aborts when the switch turns off; a fresh signal after it turned on again. */
  get offSignal(): AbortSignal {
    return this.controller.signal;
  }

  /** Turn the computer's microphone on or off; returns whether anything changed. */
  set(enabled: boolean): boolean {
    if (enabled === this.switchedOn) {
      return false;
    }

    this.switchedOn = enabled;
    if (enabled) {
      this.controller = new AbortController();
    } else {
      this.controller.abort();
    }

    this.emit('change');
    return true;
  }

  /**
   * Resolve once the switch is on, at once if it already is. Rejects with
   * the abort reason when `signal` aborts first.
   */
  async waitUntilOn(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    if (this.switchedOn) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.off('change', changed);
        signal.removeEventListener('abort', aborted);
      };

      const changed = () => {
        if (this.switchedOn) {
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

/**
 * One ordinary listening period of the computer's microphone, as
 * `listenToMicrophone` (microphone-loop.ts) expects it, with the switch in
 * front of it. That loop is unchanged: from its side, a period that starts
 * while the switch is off simply waits; a switch turned off ends the period
 * and waits for it to turn on again.
 *
 * Inputs: the loop's `listeningSignal` (pause and shutdown) and `handoff`
 * (manual recording asks for the microphone); `listenOnce(handoff)` runs one
 * real period (`listen` in listener.ts) that ends early without cancelling
 * accepted work when `handoff` aborts.
 *
 * Contract with the loop, kept exactly:
 * - pause or shutdown: rejects with the abort reason, as `listen` does;
 * - a manual recording's hand-over: returns, so the loop records next;
 * - the recorder ended on its own or failed: returns or rejects as
 *   `listen` did, so lost capture is retried exactly as before.
 *
 * Off-time spent waiting here is reported to the loop as time the period
 * ran, which can only shorten a grown retry delay after lost capture (see
 * CaptureRetryDelay); it never makes a lost recorder retry sooner than the
 * first delay.
 */
export async function listenWhileSwitchedOn(
  microphoneSwitch: ComputerMicrophoneSwitch,
  listeningSignal: AbortSignal,
  handoff: AbortSignal | undefined,
  listenOnce: (handoff: AbortSignal) => Promise<void>,
): Promise<void> {
  // Waiting for the switch also ends for a manual recording request.
  const waitInterrupted = handoff ? AbortSignal.any([listeningSignal, handoff]) : listeningSignal;

  while (true) {
    try {
      await microphoneSwitch.waitUntilOn(waitInterrupted);
    } catch (error) {
      if (listeningSignal.aborted || !handoff?.aborted) {
        throw error;
      }
      // Record asked for the microphone while it was switched off.
      return;
    }

    const switchedOff = microphoneSwitch.offSignal;
    const periodEnd = handoff ? AbortSignal.any([handoff, switchedOff]) : switchedOff;

    microphoneSwitch.setListening(true);
    try {
      await listenOnce(periodEnd);
    } finally {
      microphoneSwitch.setListening(false);
    }

    // Ended for Record, or the recorder ended by itself (lost capture): the
    // loop decides, exactly as without the switch.
    if (handoff?.aborted || !switchedOff.aborted) {
      return;
    }
    // Switched off: wait until it is on again, then listen anew.
  }
}
