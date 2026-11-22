import { pcmFrames } from './capture.ts';
import { SAMPLE_RATE } from './segmenter.ts';

/**
 * Sound from a browser's microphone, as the listener receives it.
 *
 * Purpose: a listening browser (the shell's "Listen here") sends its
 * microphone as 16 kHz mono signed 16-bit little-endian samples, in pieces
 * relayed by the remote gateway as `audio-chunk` requests (see
 * src/desktop/README.md, "Microphones and listening browsers"). This source turns those
 * pieces into the same 512-sample frames the computer's recorder yields
 * (`pcmFrames`), so one listening period (`listen`) runs on it unchanged.
 *
 * Input:  `push(bytes)` for each piece, in arrival order.
 * Output: `frames(signal)`, an async iterable of Float32 frames for one
 *         listening period. It yields every byte that was pushed, in order,
 *         without gaps or padding between pieces.
 *
 * Bound: pieces wait here only while the period's voice detector is behind.
 * If more than `maximumQueuedMs` of sound waits, `push` refuses the piece
 * and returns false; the owner ends the stream (the listener is too slow).
 * Sound is never dropped silently inside a stream.
 *
 * Ending: the frames end only when `signal` aborts (the stream ended, pause
 * or shutdown); the iterator then throws the abort reason, as the computer's
 * recorder does for a requested stop. Queued pieces are released at once.
 */
export class NetworkAudioSource {
  /** Pieces received and not yet read, oldest first. */
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  /** Wakes the reader waiting for the next piece, if any. */
  private wake?: () => void;
  private reading = false;

  /** Most bytes that may wait: `maximumQueuedMs` of 16-bit samples. */
  private readonly maximumQueuedBytes: number;

  constructor(maximumQueuedMs: number) {
    this.maximumQueuedBytes = Math.round((SAMPLE_RATE * 2 * maximumQueuedMs) / 1000);
  }

  /** Sound waiting for the voice detector, in milliseconds. */
  get queuedMs(): number {
    return (this.queuedBytes / 2 / SAMPLE_RATE) * 1000;
  }

  /**
   * Add one piece of 16-bit samples. Returns false, keeping nothing, when it
   * would make more than the bound wait: the caller ends the stream.
   */
  push(bytes: Buffer): boolean {
    if (this.queuedBytes + bytes.length > this.maximumQueuedBytes) {
      return false;
    }

    this.queue.push(bytes);
    this.queuedBytes += bytes.length;

    const wake = this.wake;
    this.wake = undefined;
    wake?.();
    return true;
  }

  /**
   * The frames of one listening period. May be called once: a stream feeds
   * exactly one period.
   */
  frames(signal: AbortSignal): AsyncIterable<Float32Array> {
    if (this.reading) {
      throw Error('A browser stream feeds only one listening period');
    }
    this.reading = true;

    return pcmFrames(this.pieces(signal));
  }

  /** Yield pieces as they arrive until `signal` aborts. */
  private async *pieces(signal: AbortSignal): AsyncGenerator<Buffer> {
    try {
      while (true) {
        signal.throwIfAborted();

        const piece = this.queue.shift();
        if (piece) {
          this.queuedBytes -= piece.length;
          yield piece;
          continue;
        }

        await this.nextPiece(signal);
      }
    } finally {
      // The period has ended: nothing will read what is still queued.
      this.queue.length = 0;
      this.queuedBytes = 0;
    }
  }

  /** Resolve when a piece arrives; reject with the abort reason if `signal` aborts first. */
  private nextPiece(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const aborted = () => {
        this.wake = undefined;
        reject(signal.reason);
      };

      this.wake = () => {
        signal.removeEventListener('abort', aborted);
        resolve();
      };
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
