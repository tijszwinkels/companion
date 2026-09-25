import { AsrWorker } from './asr-worker.ts';
import { encodePcm16, SAMPLE_RATE } from './segmenter.ts';
import type { InspectableModule } from '../../core/module.ts';
import { audioLevels, MIN_SPEECH_WINDOW_RMS, type AudioLevels } from './levels.ts';

/** The worker's protocol bound; also the longest input this module accepts. */
const MAX_REQUEST_SAMPLES = SAMPLE_RATE * 31;

/**
 * Digital silence added on each side of the one retry after an empty result.
 * The retry changes only the model's framing and context; it never scales,
 * trims or otherwise alters the captured samples.
 */
const EMPTY_RETRY_PADDING_MS = 250;
const EMPTY_RETRY_PADDING_SAMPLES = (SAMPLE_RATE * EMPTY_RETRY_PADDING_MS) / 1000;

/**
 * Minimum strongest-128-ms-window RMS for an empty-result retry. This is ten
 * times the silence floor. On quiet public regression phrases just above that
 * floor, padded retries mostly produced wrong words, so an empty result is
 * the safer outcome there.
 */
const MIN_EMPTY_RETRY_WINDOW_RMS = MIN_SPEECH_WINDOW_RMS * 10;

/**
 * What happened after a first decoder pass returned no text at all:
 * - `recovered`, `punctuation`, `empty`, `error`: the padded retry's result.
 * - `quiet`: no retry; the input is below the retry energy floor.
 * - `too-long`: no retry; padding would exceed the 31-second request bound.
 */
export type EmptyRetryOutcome =
  'recovered' | 'punctuation' | 'empty' | 'error' | 'quiet' | 'too-long';

/** Numeric, bounded evidence only: no samples, transcript, or model paths. */
export interface TranscriptionDiagnostic extends AudioLevels {
  /** The final outcome, after any empty-result retry. */
  outcome: 'silence' | 'empty' | 'punctuation' | 'text' | 'error';
  audioMs: number;
  /** Total ASR operation time, including a retry. */
  elapsedMs: number;
  characters: number;
  /** Present only when the first decoder pass returned empty text. */
  emptyRetry?: EmptyRetryOutcome;
  /** Duration of the retry request, when one was sent. */
  retryMs?: number;
}

/** Letters or digits make a usable utterance; punctuation alone does not. */
function usableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** Why an empty first pass must not be retried, if any reason applies. */
function emptyRetrySkipReason(
  samples: Float32Array,
  levels: AudioLevels,
): EmptyRetryOutcome | undefined {
  if (levels.speechWindowRms < MIN_EMPTY_RETRY_WINDOW_RMS) {
    return 'quiet';
  }
  if (samples.length + 2 * EMPTY_RETRY_PADDING_SAMPLES > MAX_REQUEST_SAMPLES) {
    return 'too-long';
  }
  return undefined;
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
 * call can start a replacement, after the old process has been reaped. The only
 * repeated request is one padded retry after an empty result (see transcribe).
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
      if (samples.length > MAX_REQUEST_SAMPLES) {
        throw Error('Utterance exceeds 31 seconds');
      }

      const started = performance.now();
      const levels = audioLevels(samples);
      let emptyRetry: EmptyRetryOutcome | undefined;
      let retryMs: number | undefined;

      // Report exactly once per operation, with the final outcome. Retry
      // details are optional fields, so a recovered result reads as text.
      const report = (outcome: TranscriptionDiagnostic['outcome'], characters = 0) => {
        try {
          observe?.({
            outcome,
            audioMs: samples.length / 16,
            elapsedMs: Math.round(performance.now() - started),
            characters,
            ...levels,
            ...(emptyRetry ? { emptyRetry } : {}),
            ...(retryMs === undefined ? {} : { retryMs }),
          });
        } catch {
          // Optional diagnostics must not replace a result or the worker's
          // original error, nor turn a successful report into a second report.
        }
      };

      // Endpoint silence must not dilute a short word below the silence floor.
      // Keep the same threshold, applied to a speech-sized window, and send
      // exactly the captured audio to Parakeet when it passes this guard.
      if (levels.speechWindowRms < MIN_SPEECH_WINDOW_RMS) {
        report('silence');
        return '';
      }

      try {
        const worker = await this.ensureWorker(operationSignal);
        operationSignal.throwIfAborted();

        let text = await this.request(worker, samples, 0, operationSignal);

        // Parakeet occasionally returns nothing for clear, VAD-accepted speech,
        // and then returns words when the same samples are framed differently.
        // Retry such a result once, with digital silence around the original
        // samples, on the same worker and within the same timeout. Punctuation,
        // silence, errors and cancellation are never retried, and nothing
        // follows the retry.
        if (!text) {
          const skipReason = emptyRetrySkipReason(samples, levels);

          if (skipReason) {
            emptyRetry = skipReason;
          } else {
            const retryStarted = performance.now();

            try {
              text = await this.request(
                worker,
                samples,
                EMPTY_RETRY_PADDING_SAMPLES,
                operationSignal,
              );
            } catch (error) {
              // Timeout, cancellation and worker failures end the operation.
              emptyRetry = 'error';
              throw error;
            } finally {
              retryMs = Math.round(performance.now() - retryStarted);
            }

            if (!text) {
              emptyRetry = 'empty';
            } else if (usableText(text)) {
              emptyRetry = 'recovered';
            } else {
              emptyRetry = 'punctuation';
            }
          }
        }

        // Punctuation-only output is not a usable utterance.
        const usable = usableText(text);
        report(usable ? 'text' : text ? 'punctuation' : 'empty', text.length);
        return usable ? text : '';
      } catch (error) {
        report('error');
        throw error;
      }
    });
  }

  /**
   * Send one request and return its trimmed text. Padding is written as PCM16
   * zeros around a copy of the samples; the caller's samples are never changed.
   * Encoded buffers are cleared when the request settles, including on errors.
   */
  private async request(
    worker: AsrWorker,
    samples: Float32Array,
    paddingSamples: number,
    signal: AbortSignal,
  ): Promise<string> {
    let packet: Buffer | undefined;

    try {
      // Reuse the existing PCM16 conversion, including its asymmetric rounding,
      // so the model sees exactly the samples that Voxtype's WAV reader saw.
      const pcm = encodePcm16(samples);
      const sampleCount = samples.length + 2 * paddingSamples;

      // Buffer.alloc zero-fills, which supplies the padding on both sides.
      packet = Buffer.alloc(4 + sampleCount * 2);
      packet.writeUInt32LE(sampleCount, 0);
      pcm.copy(packet, 4 + paddingSamples * 2);
      pcm.fill(0);

      const text = (await worker.transcribe(packet, signal)).trim();
      signal.throwIfAborted();
      return text;
    } finally {
      packet?.fill(0);
    }
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
