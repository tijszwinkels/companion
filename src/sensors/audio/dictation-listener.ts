import type { Log } from '../../core/frame.ts';
import { audioFrames } from './capture.ts';
import { LEGACY_ENDPOINT_MS, Segmenter } from './segmenter.ts';
import type { VoiceActivityDetector } from './vad.ts';

/**
 * Silence that closes a manual-recording chunk: the 800 ms endpoint Companion
 * used for every utterance before provisional endpoints. Manual chunks are
 * never merged or retranscribed, so each one must be a phrase that Parakeet
 * can read on its own. The 224 ms provisional endpoint cuts too many words in
 * half for that (docs/speech-timing.md). The 60-second segment cap, the VAD
 * thresholds, the voiced minimum and the preroll are the ordinary settings.
 */
export const DICTATION_ENDPOINT_MS = LEGACY_ENDPOINT_MS;

/** Where the manual capture loop hands its audio. */
export interface DictationSink {
  /**
   * One closed chunk, in speech order. The sink owns the buffer from now on
   * and must clear it when done. Called synchronously from the capture loop,
   * so the sink can stop capture before the next frame is read.
   */
  accept(samples: Float32Array): void;
  /**
   * Capture has ended and no further chunk will follow. `error` is set when
   * the microphone or VAD failed, rather than an ordinary stop.
   */
  captureEnded(error?: unknown): void;
}

/**
 * Capture microphone audio for manual recording ("Record" under a session's
 * text box) until `stop` aborts, handing each closed chunk to `sink`.
 *
 * This is a separate, smaller loop than `listen`: it owns the recorder for one
 * recording and reports nothing to the speech pipeline. There are no
 * provisional attempts, holds, continuations, Activity callbacks, screenshots
 * or capture-storage admissions. The caller (the CLI's microphone loop) runs
 * at most one of `listen` or this function at a time, so there is only ever one
 * recorder and one user of the VAD.
 *
 * Stop is a graceful capture boundary, unlike pause: the recorder is killed,
 * then the open candidate is closed with `Segmenter.finish()` and handed over
 * as the final chunk, so the last words before Stop are kept. A microphone or
 * VAD failure ends capture the same way, keeping the audio captured so far, and
 * is reported to the sink rather than thrown.
 *
 * `signal` is shutdown. It discards the open candidate and is rethrown, as for
 * ordinary listening.
 */
export async function recordDictation(
  vad: VoiceActivityDetector,
  sink: DictationSink,
  log: Log,
  signal: AbortSignal,
  stop: AbortSignal,
  // `file` replaces the microphone with a decoded audio file (synthetic tests).
  options: { device?: string; file?: string } = {},
): Promise<void> {
  const segmenter = new Segmenter((diagnostic) => {
    log('dictation-vad', JSON.stringify(diagnostic));
  }, DICTATION_ENDPOINT_MS);
  vad.reset();

  // Stop also kills the recorder, so a silent or wedged microphone cannot keep
  // the loop waiting for its next frame.
  const captureSignal = AbortSignal.any([signal, stop]);
  let captureError: unknown;

  try {
    for await (const frame of audioFrames(captureSignal, options)) {
      // Frames still buffered in the pipe when Stop was clicked are ignored:
      // the boundary is the click, not the moment the recorder exited.
      if (stop.aborted) {
        break;
      }
      signal.throwIfAborted();

      const probability = await vad.probability(frame);
      signal.throwIfAborted();

      const segment = segmenter.push(probability, frame);
      if (segment) {
        log('dictation', `Chunk closed (${segment.reason}, ${segment.samples.length / 16} ms)`);
        sink.accept(segment.samples);
      }
    }
  } catch (error) {
    if (signal.aborted) {
      sink.captureEnded();
      throw error;
    }

    // Killing the recorder for Stop surfaces as its abort; that is the
    // ordinary end. Anything else is a real capture or VAD failure.
    if (!stop.aborted) {
      captureError = error;
    }
  }

  // Graceful end, after Stop, a failure or the end of a file: keep the audio
  // already captured.
  const tail = segmenter.finish();
  if (tail) {
    log('dictation', `Final chunk closed (${tail.samples.length / 16} ms)`);
    sink.accept(tail.samples);
  }

  sink.captureEnded(captureError);
}
