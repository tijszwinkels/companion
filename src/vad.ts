import { InferenceSession, Tensor } from 'onnxruntime-node';
import { FRAME_SAMPLES } from './segmenter.ts';

/** Silero v5: 32 ms frames, recurrent state, and 4 ms of previous audio. */
export class VoiceActivityDetector {
  private state: Tensor = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
  private readonly rate = new Tensor('int64', [16000n]);
  private readonly input = new Float32Array(64 + FRAME_SAMPLES);
  private readonly tensor = new Tensor('float32', this.input, [1, 64 + FRAME_SAMPLES]);

  private constructor(private readonly session: InferenceSession) {}

  static async create(modelPath: string): Promise<VoiceActivityDetector> {
    const session = await InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
    return new VoiceActivityDetector(session);
  }

  async probability(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SAMPLES) throw Error('VAD expects 512 samples');
    this.input.set(frame, 64);
    const output = await this.session.run({ input: this.tensor, state: this.state, sr: this.rate });
    this.state.dispose(); this.state = output.stateN;
    this.input.copyWithin(0, this.input.length - 64);
    const probability = Number(output.output.data[0]);
    output.output.dispose();
    return probability;
  }

  async close(): Promise<void> {
    await this.session.release(); this.state.dispose(); this.rate.dispose(); this.tensor.dispose();
  }
}
