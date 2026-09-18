import { AsrWorker } from './asr-worker.ts';
import { encodePcm16 } from './segmenter.ts';
import type { InspectableModule } from '../../core/module.ts';

export interface SpeechTranscriber extends InspectableModule {
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
}

export interface AsrConfig {
  workerBinary: string;
  modelDir: string;
  timeoutMs: number;
}

/**
 * Own one Parakeet worker for an audio session. Construction is inert; the CLI
 * calls start before capture and close during shutdown. Successful utterances
 * reuse the model. A failed/cancelled request is never replayed; only a later
 * call can start a replacement, after the old process has been reaped.
 */
export class Transcriber implements SpeechTranscriber {
  readonly label = 'Speech transcriber';
  readonly dependencies = {};

  private worker?: AsrWorker;
  private readonly lifetime = new AbortController();
  private busy = false;

  constructor(
    private readonly config: AsrConfig,
    readonly id = 'transcriber',
  ) {}

  /** Warm the model without opening a microphone or retaining sample audio. */
  async start(signal: AbortSignal): Promise<void> {
    await this.run(signal, async (operationSignal) => {
      await this.ensureWorker(operationSignal);
    });
  }

  async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
    return this.run(signal, async (operationSignal) => {
      if (samples.length > 16000 * 31) {
        throw Error('Utterance exceeds 31 seconds');
      }

      // Preserve the digital-silence filter before acquiring any resources.
      // Reject nonfinite samples instead of serializing damaged audio.
      let energy = 0;
      for (const sample of samples) {
        if (!Number.isFinite(sample)) {
          throw Error('Utterance contains a nonfinite sample');
        }
        energy += sample * sample;
      }
      if (!samples.length || Math.sqrt(energy / samples.length) < 0.0005) {
        return '';
      }

      const worker = await this.ensureWorker(operationSignal);
      operationSignal.throwIfAborted();

      // Reuse the existing PCM16 conversion, including its asymmetric rounding,
      // so the model sees exactly the samples that Voxtype's WAV reader saw.
      const pcm = encodePcm16(samples);
      const packet = Buffer.alloc(4 + pcm.length);
      packet.writeUInt32LE(samples.length, 0);
      pcm.copy(packet, 4);
      pcm.fill(0);

      try {
        const text = (await worker.transcribe(packet, operationSignal)).trim();
        operationSignal.throwIfAborted();

        // Punctuation-only output is not a usable utterance.
        return /[\p{L}\p{N}]/u.test(text) ? text : '';
      } finally {
        packet.fill(0);
      }
    });
  }

  /** Permanent and idempotent. Also interrupts startup or an active request. */
  async close(): Promise<void> {
    this.lifetime.abort(Error('ASR transcriber closed'));
    this.worker?.stop(Error('ASR transcriber closed'));
    await this.worker?.closed;
  }

  private async ensureWorker(signal: AbortSignal): Promise<AsrWorker> {
    if (this.worker && !this.worker.usable) {
      await this.worker.closed;
      this.worker = undefined;
    }

    signal.throwIfAborted();
    if (!this.worker) {
      this.worker = new AsrWorker(this.config.workerBinary, this.config.modelDir);
      await this.worker.ready(signal);
    }

    return this.worker;
  }

  private async run<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.busy) {
      throw Error('ASR already has an active operation');
    }

    this.busy = true;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(Error('ASR operation timed out'));
    }, this.config.timeoutMs);
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal, timeout.signal]);

    try {
      return await operation(operationSignal);
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
}
