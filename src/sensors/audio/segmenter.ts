export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;

// Separate start/continue thresholds prevent rapid toggling near the boundary.
export const VAD_SETTINGS = {
  positive: 0.65,
  negative: 0.35,
  minSpeechMs: 400,
  silenceMs: 800,
  maxMs: 30000,
  preRollMs: 256,
};

/** A complete utterance, with the reason its audio buffer was closed. */
export interface Segment {
  samples: Float32Array;
  reason: 'silence' | 'limit' | 'end';
}

/** Silero probabilities segment speech; a loud noise alone is not a trigger. */
export class Segmenter {
  // Before speech starts, retain a short lead-in so the first syllable is kept.
  private pre: Float32Array[] = [];

  // Once speech starts, include both voiced frames and brief pauses between them.
  private frames: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;

  /** The latest frame's speech state, used by the CLI for progress messages. */
  speaking = false;

  /** Return a segment only when enough speech ends in silence or reaches the cap. */
  push(probability: number, frame: Float32Array): Segment | undefined {
    if (
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1 ||
      frame.length !== FRAME_SAMPLES
    ) {
      throw Error('Invalid VAD frame');
    }

    // At 16 kHz, each millisecond contains 16 samples; a frame lasts 32 ms.
    const ms = FRAME_SAMPLES / 16;
    this.speaking = probability >= (this.speaking ? VAD_SETTINGS.negative : VAD_SETTINGS.positive);

    if (!this.frames.length && this.speaking) {
      this.frames = this.pre;
      this.pre = [];
    }

    if (!this.frames.length && !this.speaking) {
      this.pre.push(frame.slice());

      if (this.pre.length * ms > VAD_SETTINGS.preRollMs) {
        this.pre.shift();
      }

      return;
    }

    this.frames.push(frame.slice());

    if (this.speaking) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
    }

    if (this.frames.length * ms >= VAD_SETTINGS.maxMs) {
      return this.finish('limit');
    }
    if (this.silenceMs >= VAD_SETTINGS.silenceMs) {
      return this.finish('silence');
    }
  }

  /** Also used at end-of-file, when there may be speech without trailing silence. */
  finish(reason: Segment['reason'] = 'end'): Segment | undefined {
    let segment: Segment | undefined;

    // Short VAD triggers are discarded instead of sent to transcription.
    if (this.speechMs >= VAD_SETTINGS.minSpeechMs) {
      const samples = new Float32Array(this.frames.length * FRAME_SAMPLES);
      this.frames.forEach((frame, i) => samples.set(frame, i * FRAME_SAMPLES));
      segment = { samples, reason };
    }

    // Start the next utterance with independent duration counters and buffers.
    this.frames = [];
    this.pre = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.speaking = false;

    return segment;
  }
}

/** Wrap samples in a mono, 16 kHz PCM16 WAV file for fixtures and file tools. */
export function encodeWav(samples: Float32Array): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);

  // RIFF container header, followed by the 16-byte uncompressed PCM format chunk.
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);

  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM encoding.
  wav.writeUInt16LE(1, 22); // One channel.
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); // Bytes per sample across all channels.
  wav.writeUInt16LE(16, 34); // Bits per sample.

  // The data chunk contains only audio; its size excludes the 44-byte header.
  wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);

  encodePcm16(samples).copy(wav, 44);

  return wav;
}

/** Shared PCM16 conversion for WAV files and the persistent worker's pipe. */
export function encodePcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);

  // PCM16 has asymmetric limits: -32768 and +32767. Clamp before conversion.
  samples.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    const scale = value < 0 ? 32768 : 32767;
    pcm.writeInt16LE(Math.round(clamped * scale), index * 2);
  });

  return pcm;
}
