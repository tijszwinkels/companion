import { InferenceSession, Tensor } from 'onnxruntime-node';

import { FRAME_SAMPLES } from './segmenter.ts';

/** Silero v5: 32 ms frames, recurrent state, and 4 ms of previous audio. */
export class VoiceActivityDetector {
  // The model's recurrent state is carried between frames, not between sessions.
  private state: Tensor = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
  private readonly rate = new Tensor('int64', [16000n]);

  // Reuse the input tensor: 64 previous samples followed by 512 new samples.
  private readonly input = new Float32Array(64 + FRAME_SAMPLES);
  private readonly tensor = new Tensor('float32', this.input, [1, 64 + FRAME_SAMPLES]);

  private constructor(private readonly session: InferenceSession) {}

  static async create(modelPath: string): Promise<VoiceActivityDetector> {
    // This small model runs every 32 ms; one CPU thread avoids thread-pool overhead.
    const session = await InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });

    return new VoiceActivityDetector(session);
  }

  /** Called sequentially because both the audio context and state are mutable. */
  async probability(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SAMPLES) {
      throw Error('VAD expects 512 samples');
    }

    this.input.set(frame, 64);
    const output = await this.session.run({ input: this.tensor, state: this.state, sr: this.rate });

    // Replace the recurrent state only after inference has finished using it.
    this.state.dispose();
    this.state = output.stateN;

    // Keep this frame's last 64 samples as context for the next inference.
    this.input.copyWithin(0, this.input.length - 64);

    const probability = Number(output.output.data[0]);
    output.output.dispose();

    return probability;
  }

  /** Reset acoustic context between listening periods, never during inference. */
  reset(): void {
    this.state.dispose();
    this.state = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
    this.input.fill(0);
  }

  /** Release native ONNX resources after the audio loop has stopped. */
  async close(): Promise<void> {
    await this.session.release();
    this.state.dispose();
    this.rate.dispose();
    this.tensor.dispose();
  }
}
