/**
 * Turns the microphone's samples into the gateway's audio format: 16 kHz
 * mono signed 16-bit little-endian samples, in pieces of 100 ms (1,600
 * samples, 3,200 bytes). See src/remote/README.md, "Listening browsers".
 *
 * Input: blocks of mono float samples (-1 … 1) at the audio context's rate
 * (usually 48 kHz, sometimes 44.1 kHz), as the AudioWorklet receives them.
 * Output: each complete piece, handed to `onPiece` as its own ArrayBuffer.
 *
 * The browser's audio context runs at the device's rate, and browsers
 * differ in whether a microphone may be connected to a context with another
 * rate (design note, section 3), so the conversion happens here, not by
 * asking for a 16 kHz context.
 *
 * Conversion: every output sample is the average of the input samples that
 * fall in its 1/16,000-second interval (a box filter). This removes most of
 * what lies above 8 kHz before the rate drops, which is enough for speech
 * recognition, and costs a few additions per sample. Over time exactly
 * 16,000 samples come out per second of input, also for rates that are not
 * a whole multiple (44.1 kHz gives intervals of 2 or 3 input samples).
 *
 * Used inside the AudioWorklet (capture-worklet.ts) and in the unit tests;
 * it touches no browser interface.
 */

/** The gateway's sample rate (16 kHz mono). */
export const outputSampleRate = 16_000;

/** Samples per piece: 100 ms at 16 kHz. */
export const pieceSamples = 1_600;

export class PcmPieces {
  /** The input rate in whole samples a second (48,000 or 44,100). */
  private readonly inputRate: number;

  /**
   * How far the current output interval has been filled, in units of
   * 1/(input rate × 16,000) seconds: each input sample adds 16,000, and an
   * output interval is complete at the input rate. Whole numbers, so no
   * rounding error builds up over hours.
   */
  private filled = 0;
  private sum = 0;
  private count = 0;

  /**
   * The piece being filled, and how many of its samples are written. The
   * samples are written little-endian whatever the browser's own byte order
   * (the gateway's format), through a DataView.
   */
  private piece = new DataView(new ArrayBuffer(pieceSamples * 2));
  private written = 0;

  constructor(
    inputSampleRate: number,
    private readonly onPiece: (piece: ArrayBuffer) => void,
  ) {
    if (!(inputSampleRate > 0)) {
      throw Error(`Unusable sample rate ${inputSampleRate}`);
    }
    this.inputRate = Math.round(inputSampleRate);
  }

  /** Add one block of input samples. */
  push(input: Float32Array): void {
    for (let index = 0; index < input.length; index++) {
      this.sum += input[index];
      this.count++;
      this.filled += outputSampleRate;

      // A rate below 16 kHz completes more than one output interval per
      // input sample: each of those repeats the same average.
      while (this.filled >= this.inputRate) {
        this.filled -= this.inputRate;
        this.write(this.sum / this.count);
        if (this.filled < this.inputRate) {
          this.sum = 0;
          this.count = 0;
        }
      }
    }
  }

  private write(value: number): void {
    let clamped = value;
    if (clamped > 1) {
      clamped = 1;
    } else if (clamped < -1) {
      clamped = -1;
    }
    this.piece.setInt16(this.written * 2, Math.round(clamped * 32767), true);
    this.written++;

    if (this.written === pieceSamples) {
      const complete = this.piece;
      this.piece = new DataView(new ArrayBuffer(pieceSamples * 2));
      this.written = 0;
      this.onPiece(complete.buffer);
    }
  }
}

/**
 * The loudness of a piece for the level meter: its peak, 0 … 1. A peak (not
 * an average) makes the meter move for quiet speech too.
 */
export function pieceLevel(piece: ArrayBuffer): number {
  const samples = new DataView(piece);
  const count = Math.floor(piece.byteLength / 2);
  let peak = 0;
  for (let index = 0; index < count; index++) {
    const magnitude = Math.abs(samples.getInt16(index * 2, true));
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return peak / 32768;
}
