/**
 * The browser's side of "Listen here": opening and closing the microphone,
 * and the signs that it is open outside the page's own drawing (the "●"
 * before the tab's title and, while the page is visible, the screen kept
 * awake).
 *
 * listen-here.ts decides when to open and close; this file only does it.
 * It is the one place that touches the browser's media interfaces, so the
 * rules in listen-here.ts can be tested with a fake (test/shell/listen-rules.test.ts).
 *
 * Capture: `getUserMedia` with echo cancellation, noise suppression and
 * automatic gain on (as the two reference applications), an audio context
 * at the device's own rate, and the AudioWorklet `listen-here-capture`
 * (capture-worklet.ts, served as listen-worklet.js from the shell's own
 * origin), which posts 100 ms pieces of 16 kHz signed 16-bit samples. The
 * worklet's node has no output: nothing is played.
 *
 * Resources: an open capture owns the microphone track, the audio context
 * and the worklet node. `close()` releases all three; the browser's own
 * microphone sign goes off with the track.
 */

/** Why the microphone could not be opened, for the page's wording. */
export type CaptureFailure = 'refused' | 'no-microphone' | 'failed';

export class CaptureError extends Error {
  constructor(
    readonly failure: CaptureFailure,
    message: string,
  ) {
    super(message);
  }
}

/** An open microphone. */
export interface OpenCapture {
  /** Release the microphone, the audio context and the worklet. Idempotent. */
  close(): void;
}

/** What the page hears from an opening microphone. */
export interface CaptureHandlers {
  /**
   * The browser granted the microphone: its track is live from now on, also
   * while the worklet still loads. The page shows its mark from here.
   */
  onGranted(): void;
  /** Each 100 ms piece, once the worklet runs. */
  onPiece(piece: ArrayBuffer): void;
  /**
   * Called once if the browser ends the track by itself (permission
   * withdrawn, device removed), or keeps it muted for `mutedLimitMs`.
   */
  onEnded(): void;
}

/**
 * A track muted this long counts as ended: the device was interrupted (a
 * call, another application) and the page would otherwise send silence
 * while saying "Listening". Shorter mutes pass unnoticed.
 */
export const mutedLimitMs = 3_000;

/** What listen-here.ts needs from the browser; a fake in the unit tests. */
export interface CaptureEnvironment {
  /**
   * Why this page cannot listen at all, or '' when it can: no secure page,
   * no capture interfaces, or a page policy without the microphone (a
   * gateway started without `--allow-microphone`).
   */
  unavailable(): string;
  /**
   * Open the microphone. Rejects with a CaptureError. Aborting `signal`
   * before it resolved releases the microphone at once (also while the
   * worklet still loads); the promise then rejects.
   */
  open(handlers: CaptureHandlers, signal: AbortSignal): Promise<OpenCapture>;
  /** The signs outside the page's drawing: "●" in the title, the wake lock. */
  setCapturing(capturing: boolean): void;
  /** Milliseconds on a monotonic clock. */
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): () => void;
}

/** The worklet's file in dist/, next to app.js (build.ts). */
const workletAddress = 'listen-worklet.js';

/** The tab's title mark while this page captures. */
const titleMark = '● ';

/** The browser's real capture. */
export class BrowserCapture implements CaptureEnvironment {
  private wakeLock?: { release(): Promise<void> };
  private capturing = false;

  constructor() {
    // A wake lock is released by the browser whenever the page is hidden;
    // it is asked for again when the page is shown while still capturing.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.capturing) {
        void this.keepAwake();
      }
    });
  }

  unavailable(): string {
    if (!window.isSecureContext) {
      return 'Needs a secure (HTTPS) page';
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      return 'This browser cannot capture sound here';
    }
    // Chromium reports the page's Permissions-Policy; other browsers find
    // out when the microphone is asked for (then "refused").
    const policy = (document as { featurePolicy?: { allowsFeature(name: string): boolean } })
      .featurePolicy;
    if (policy && !policy.allowsFeature('microphone')) {
      return 'Companion’s gateway does not allow the microphone on this page';
    }
    return '';
  }

  async open(handlers: CaptureHandlers, signal: AbortSignal): Promise<OpenCapture> {
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw mediaError(error);
    }

    // From here on the microphone is open: every failure, and the page
    // giving up meanwhile (`signal`), must release it at once.
    let context: AudioContext | undefined;
    let closed = false;
    let mutedTimer: number | undefined;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      window.clearTimeout(mutedTimer);
      for (const mediaTrack of media.getTracks()) {
        mediaTrack.stop();
      }
      void context?.close();
    };
    if (signal.aborted) {
      close();
      throw new CaptureError('failed', 'Cancelled');
    }
    signal.addEventListener('abort', close);
    handlers.onGranted();

    const track = media.getAudioTracks()[0];
    const ended = () => {
      if (!closed) {
        handlers.onEnded();
      }
    };
    track?.addEventListener('ended', ended);
    // A track that stays muted (see `mutedLimitMs`) counts as ended.
    const watchMuted = () => {
      window.clearTimeout(mutedTimer);
      if (track?.muted) {
        mutedTimer = window.setTimeout(() => {
          if (track.muted) {
            ended();
          }
        }, mutedLimitMs);
      }
    };
    track?.addEventListener('mute', watchMuted);
    track?.addEventListener('unmute', watchMuted);
    watchMuted();

    try {
      context = new AudioContext();
      await context.audioWorklet.addModule(workletAddress);
      if (closed) {
        throw new CaptureError('failed', 'Cancelled');
      }
      const source = context.createMediaStreamSource(media);
      const node = new AudioWorkletNode(context, 'listen-here-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        handlers.onPiece(event.data);
      };
      source.connect(node);
      // A context made without a recent click (Resume, a reconnect) may
      // start suspended; the switch's click made the page's activation.
      await context.resume();
      if (closed) {
        throw new CaptureError('failed', 'Cancelled');
      }
      signal.removeEventListener('abort', close);
      return {
        close: () => {
          node.port.onmessage = null;
          source.disconnect();
          close();
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', close);
      close();
      if (error instanceof CaptureError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CaptureError('failed', `The microphone could not be used: ${message}`);
    }
  }

  setCapturing(capturing: boolean): void {
    if (capturing === this.capturing) {
      return;
    }
    this.capturing = capturing;

    // The tab's title, so a listening tab is recognisable among others.
    const title = document.title.startsWith(titleMark)
      ? document.title.slice(titleMark.length)
      : document.title;
    document.title = capturing ? titleMark + title : title;

    if (capturing) {
      void this.keepAwake();
    } else {
      const lock = this.wakeLock;
      this.wakeLock = undefined;
      void lock?.release().catch(() => {});
    }
  }

  /**
   * Keep the screen on while listening: a phone stops capturing when its
   * screen locks (design note, section 6). Where the browser has no wake
   * lock, or refuses it, nothing else changes.
   */
  private async keepAwake(): Promise<void> {
    const wakeLock = (
      navigator as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }
    ).wakeLock;
    if (!wakeLock || this.wakeLock) {
      return;
    }
    try {
      const lock = await wakeLock.request('screen');
      if (this.capturing && !this.wakeLock) {
        this.wakeLock = lock;
        // The browser releases it when the page is hidden; forget it then,
        // so showing the page again asks for a new one.
        (lock as unknown as EventTarget).addEventListener?.('release', () => {
          if (this.wakeLock === lock) {
            this.wakeLock = undefined;
          }
        });
      } else {
        await lock.release();
      }
    } catch {
      // Hidden page, low battery or a policy: the screen may sleep.
    }
  }

  now(): number {
    return performance.now();
  }

  setTimeout(callback: () => void, milliseconds: number): () => void {
    const timer = window.setTimeout(callback, milliseconds);
    return () => window.clearTimeout(timer);
  }
}

/** The getUserMedia error, in the page's terms. */
function mediaError(error: unknown): CaptureError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('refused', 'The browser refused the microphone');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CaptureError('no-microphone', 'No microphone was found on this device');
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CaptureError('failed', `The microphone could not be opened: ${message}`);
}
