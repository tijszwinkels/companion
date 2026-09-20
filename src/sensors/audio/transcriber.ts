import { AsrWorker } from './asr-worker.ts';
import { encodePcm16 } from './segmenter.ts';
import type { InspectableModule } from '../../core/module.ts';
import { audioLevels, type AudioLevels } from './levels.ts';

/** Numeric, bounded evidence only: no samples, transcript, or model paths. */
export interface TranscriptionDiagnostic extends AudioLevels {
  outcome: 'silence' | 'empty' | 'punctuation' | 'text' | 'error';
  audioMs: number;
  elapsedMs: number;
  characters: number;
}

export type ObserveTranscription = (diagnostic: TranscriptionDiagnostic) => void;

export interface SpeechTranscriber extends InspectableModule {
  transcribe(
    samples: Float32Array,
    signal: AbortSignal,
    observe?: ObserveTranscription,
  ): Promise<string>;
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

  async transcribe(
    samples: Float32Array,
    signal: AbortSignal,
    observe?: ObserveTranscription,
  ): Promise<string> {
    return this.run(signal, async (operationSignal) => {
      if (samples.length > 16000 * 31) {
        throw Error('Utterance exceeds 31 seconds');
      }

      const started = performance.now();
      const levels = audioLevels(samples);
      const report = (outcome: TranscriptionDiagnostic['outcome'], characters = 0) => {
        try {
          observe?.({
            outcome,
            audioMs: samples.length / 16,
            elapsedMs: Math.round(performance.now() - started),
            characters,
            ...levels,
          });
        } catch {
          // Optional diagnostics must not replace a result or the worker's
          // original error, nor turn a successful report into a second report.
        }
      };

      // Endpoint silence must not dilute a short word below the silence floor.
      // Keep the same threshold, applied to a speech-sized window, and send
      // exactly the captured audio to Parakeet when it passes this guard.
      if (levels.speechWindowRms < 0.0005) {
        report('silence');
        return '';
      }

      let packet: Buffer | undefined;
      try {
        const worker = await this.ensureWorker(operationSignal);
        operationSignal.throwIfAborted();

        // Reuse the existing PCM16 conversion, including its asymmetric rounding,
        // so the model sees exactly the samples that Voxtype's WAV reader saw.
        const pcm = encodePcm16(samples);
        packet = Buffer.alloc(4 + pcm.length);
        packet.writeUInt32LE(samples.length, 0);
        pcm.copy(packet, 4);
        pcm.fill(0);

        const text = (await worker.transcribe(packet, operationSignal)).trim();
        operationSignal.throwIfAborted();

        // Punctuation-only output is not a usable utterance.
        const usable = /[\p{L}\p{N}]/u.test(text);
        report(usable ? 'text' : text ? 'punctuation' : 'empty', text.length);
        return usable ? text : '';
      } catch (error) {
        report('error');
        throw error;
      } finally {
        packet?.fill(0);
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
