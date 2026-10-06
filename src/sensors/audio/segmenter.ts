export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;

/** One VAD frame lasts 32 ms: 512 samples at 16 samples per millisecond. */
export const FRAME_MS = FRAME_SAMPLES / 16;

// Separate start/continue thresholds prevent rapid toggling near the boundary.
export const VAD_SETTINGS = {
  positive: 0.65,
  negative: 0.35,
  // Count voiced frames only. Short answers such as "stop", "yes", and "no"
  // must survive the duration gate; four 32 ms frames still reject brief spikes.
  minSpeechMs: 128,
  // Provisional endpoint. The pipeline starts ASR and the intent LLM here and
  // merges resumed speech until dispatch commits (see core/utterance-continuation.ts).
  // Silence is counted in whole frames, so the effective value is ENDPOINT_MS.
  silenceMs: 200,
  // Long enough to speak naturally for a minute. 60000 ms is exactly 1875
  // frames, so a `limit` segment holds exactly MAX_UTTERANCE_SAMPLES.
  maxMs: 60000,
  preRollMs: 256,
};

/**
 * The actual silence after which a candidate closes: the smallest whole number
 * of 32 ms frames that reaches silenceMs. For 200 ms that is 7 frames (224 ms);
 * 6 frames would be only 192 ms.
 */
export const ENDPOINT_MS = Math.ceil(VAD_SETTINGS.silenceMs / FRAME_MS) * FRAME_MS;

/** The silence endpoint before provisional attempts were introduced. */
export const LEGACY_ENDPOINT_MS = 800;

/**
 * Silence between two candidates that the preroll cannot hold, but that a
 * merged utterance restores: 800 − 224 − 256 = 320 ms. With the previous
 * segment's 224 ms of trailing silence and the next segment's 256 ms preroll,
 * a merge then contains the real pause up to the legacy endpoint, so it is the
 * same audio the old segmenter would have transcribed as one utterance.
 */
export const CONTINUATION_GAP_MS = LEGACY_ENDPOINT_MS - ENDPOINT_MS - VAD_SETTINGS.preRollMs;

/** A complete utterance, with the reason its audio buffer was closed. */
export interface Segment {
  samples: Float32Array;
  reason: 'silence' | 'limit' | 'end';
  /**
   * Up to CONTINUATION_GAP_MS of the audio that directly followed the previous
   * candidate, before this segment's preroll. Used only when this segment is
   * merged into a provisional attempt; otherwise it is ignored. It may be empty.
   */
  leadIn: Float32Array;
  /**
   * Silence counted at the end of `samples`, in milliseconds: ENDPOINT_MS for a
   * `silence` endpoint, and whatever silence had accumulated (often 0) when the
   * 60-second `limit` or the end of the input closed the segment. The speech
   * ended this long before the segment was returned; the commitment floor is
   * measured from that moment (core/utterance-continuation.ts).
   */
  trailingSilenceMs: number;
}

/** One report per completed candidate, including candidates rejected by VAD. */
export interface SegmentDiagnostic {
  outcome: 'accepted' | 'too-short';
  reason: Segment['reason'];
  audioMs: number;
  speechMs: number;
  trailingSilenceMs: number;
  peakProbability: number;
}

/** Silero probabilities segment speech; a loud noise alone is not a trigger. */
export class Segmenter {
  // Before speech starts, retain a short lead-in so the first syllable is kept.
  private pre: Float32Array[] = [];

  // Frames pushed out of `pre` since the previous candidate closed, keeping
  // only the earliest CONTINUATION_GAP_MS. Bounded, and reset with each candidate.
  private gap: Float32Array[] = [];

  // Once speech starts, include both voiced frames and brief pauses between them.
  private frames: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private peakProbability = 0;

  constructor(private readonly observe?: (diagnostic: SegmentDiagnostic) => void) {}

  /** The latest frame's speech state, used by the CLI for progress messages. */
  speaking = false;

  /**
   * Whether a candidate is open: speech has started and the candidate has not
   * yet been accepted or rejected. The listener uses the transitions of this
   * value to report resumed speech and rejected bursts to the pipeline.
   */
  get collecting(): boolean {
    return this.frames.length > 0;
  }

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

    const ms = FRAME_MS;
    this.speaking = probability >= (this.speaking ? VAD_SETTINGS.negative : VAD_SETTINGS.positive);

    if (!this.frames.length && this.speaking) {
      this.frames = this.pre;
      this.pre = [];
    }

    if (!this.frames.length && !this.speaking) {
      this.pre.push(frame.slice());

      if (this.pre.length * ms > VAD_SETTINGS.preRollMs) {
        const expired = this.pre.shift()!;

        if (this.gap.length * ms < CONTINUATION_GAP_MS) {
          this.gap.push(expired);
        }
      }

      return;
    }

    this.frames.push(frame.slice());
    this.peakProbability = Math.max(this.peakProbability, probability);

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
      segment = {
        samples: joinFrames(this.frames),
        reason,
        leadIn: joinFrames(this.gap),
        trailingSilenceMs: this.silenceMs,
      };
    }

    if (this.frames.length) {
      this.observe?.({
        outcome: segment ? 'accepted' : 'too-short',
        reason,
        audioMs: (this.frames.length * FRAME_SAMPLES * 1000) / SAMPLE_RATE,
        speechMs: this.speechMs,
        trailingSilenceMs: this.silenceMs,
        peakProbability: this.peakProbability,
      });
    }

    // Start the next utterance with independent duration counters and buffers.
    this.frames = [];
    this.pre = [];
    this.gap = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.peakProbability = 0;
    this.speaking = false;

    return segment;
  }
}

/** Copy whole frames into one contiguous buffer. */
function joinFrames(frames: Float32Array[]): Float32Array {
  const samples = new Float32Array(frames.length * FRAME_SAMPLES);

  frames.forEach((frame, index) => {
    samples.set(frame, index * FRAME_SAMPLES);
  });

  return samples;
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
