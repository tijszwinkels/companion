import { SAMPLE_RATE } from './segmenter.ts';

/** Shared silence floor for inference and retention of empty ASR attempts. */
export const MIN_SPEECH_WINDOW_RMS = 0.0005;

export interface AudioLevels {
  rms: number;
  peak: number;
  speechWindowRms: number;
}

/**
 * Measure the original samples without normalizing or trimming them. The
 * strongest 128 ms window makes the digital-silence guard independent of the
 * amount of preroll, endpoint silence, and pauses in an utterance. This is an
 * energy check only; Silero still decides whether a sound is speech.
 */
export function audioLevels(samples: Float32Array): AudioLevels {
  // Sliding-window array indices must stay integral at any sample rate.
  const windowSamples = Math.max(1, Math.round((SAMPLE_RATE * 128) / 1000));
  let energy = 0;
  let windowEnergy = 0;
  let strongestWindowEnergy = 0;
  let peak = 0;

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) {
      throw Error('Utterance contains a nonfinite sample');
    }

    energy += sample * sample;
    windowEnergy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));

    if (index >= windowSamples) {
      const previous = samples[index - windowSamples];
      windowEnergy -= previous * previous;
    }

    // Prefix energy only grows until the first full window, so including those
    // prefixes cannot raise the maximum. For shorter input, the divisor below
    // uses its actual length and measures the whole input as one window.
    strongestWindowEnergy = Math.max(strongestWindowEnergy, windowEnergy);
  }

  return {
    rms: samples.length ? Math.sqrt(energy / samples.length) : 0,
    peak,
    speechWindowRms: samples.length
      ? Math.sqrt(strongestWindowEnergy / Math.min(samples.length, windowSamples))
      : 0,
  };
}
