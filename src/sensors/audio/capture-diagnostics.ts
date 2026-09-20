import type { Log } from '../../core/frame.ts';
import { SAMPLE_RATE } from './segmenter.ts';

/**
 * Aggregate five seconds of decoded input, including sounds that never cross
 * Silero's starting threshold. No raw audio or per-frame history is retained.
 * A partial window is reported when capture ends or is cancelled. Times refer
 * to decoded audio, so file replay produces the same measurements as capture.
 */
export class CaptureDiagnostics {
  private samples = 0;
  private energy = 0;
  private peak = 0;
  private peakProbability = 0;

  constructor(private readonly log: Log) {}

  push(frame: Float32Array, probability: number): void {
    this.samples += frame.length;
    this.peakProbability = Math.max(this.peakProbability, probability);

    for (const sample of frame) {
      this.energy += sample * sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
    }

    if (this.samples >= SAMPLE_RATE * 5) {
      this.finish();
    }
  }

  finish(): void {
    if (!this.samples) {
      return;
    }

    this.log(
      'audio-levels',
      JSON.stringify({
        audioMs: (this.samples * 1000) / SAMPLE_RATE,
        rms: Math.sqrt(this.energy / this.samples),
        peak: this.peak,
        peakProbability: this.peakProbability,
      }),
    );

    this.samples = 0;
    this.energy = 0;
    this.peak = 0;
    this.peakProbability = 0;
  }
}
