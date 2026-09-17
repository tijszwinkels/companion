export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;
export const VAD_SETTINGS = { positive: 0.65, negative: 0.35, minSpeechMs: 400, silenceMs: 800, maxMs: 30000, preRollMs: 256 };
export interface Segment { samples: Float32Array; reason: 'silence' | 'limit' | 'end' }

/** Silero probabilities segment speech; a loud noise alone is not a trigger. */
export class Segmenter {
  private pre: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  speaking = false;

  push(probability: number, frame: Float32Array): Segment | undefined {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1 || frame.length !== FRAME_SAMPLES) {
      throw Error('Invalid VAD frame');
    }
    const ms = FRAME_SAMPLES / 16;
    this.speaking = probability >= (this.speaking ? VAD_SETTINGS.negative : VAD_SETTINGS.positive);
    if (!this.frames.length && this.speaking) { this.frames = this.pre; this.pre = []; }
    if (!this.frames.length && !this.speaking) {
      this.pre.push(frame.slice());
      if (this.pre.length * ms > VAD_SETTINGS.preRollMs) this.pre.shift();
      return;
    }
    this.frames.push(frame.slice());
    if (this.speaking) { this.speechMs += ms; this.silenceMs = 0; }
    else this.silenceMs += ms;
    if (this.frames.length * ms >= VAD_SETTINGS.maxMs) return this.finish('limit');
    if (this.silenceMs >= VAD_SETTINGS.silenceMs) return this.finish('silence');
  }

  finish(reason: Segment['reason'] = 'end'): Segment | undefined {
    let segment: Segment | undefined;
    if (this.speechMs >= VAD_SETTINGS.minSpeechMs) {
      const samples = new Float32Array(this.frames.length * FRAME_SAMPLES);
      this.frames.forEach((frame, i) => samples.set(frame, i * FRAME_SAMPLES));
      segment = { samples, reason };
    }
    this.frames = []; this.pre = []; this.speechMs = 0; this.silenceMs = 0; this.speaking = false;
    return segment;
  }
}

export function encodeWav(samples: Float32Array): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), 44 + i * 2));
  return wav;
}
