import type { DictationCapture } from '../src/core/dictation/controller.ts';
import type { DictationSink } from '../src/sensors/audio/dictation-listener.ts';
import type { VoiceActivityDetector } from '../src/sensors/audio/vad.ts';
import { deferred } from './helpers.ts';

/**
 * Synthetic manual-recording capture: no microphone, VAD or audio file. Each
 * chunk is a small buffer filled with its chunk number, which scripted ASR
 * maps to text.
 */

export const vad = {} as VoiceActivityDetector;

export function chunk(marker: number): Float32Array {
  return new Float32Array(16).fill(marker);
}

/** A capture loop the test drives: chunks, the final chunk at Stop, and failure. */
export function scriptedCapture() {
  const started = deferred<{ sink: DictationSink; stop: AbortSignal }>();
  const ended = deferred<void>();
  const script: { tail?: Float32Array; failure?: unknown; calls: number } = { calls: 0 };

  const capture: DictationCapture = async (_vad, sink, _log, signal, stop) => {
    script.calls++;
    started.resolve({ sink, stop });

    // Capture runs until Stop (or an automatic boundary), a scripted end, or shutdown.
    await Promise.race([
      new Promise<void>((resolve) => {
        if (stop.aborted) {
          resolve();
        }
        stop.addEventListener('abort', () => resolve(), { once: true });
      }),
      ended.promise,
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]).catch(() => {});

    // Like recordDictation: shutdown discards the open candidate and rethrows.
    if (signal.aborted) {
      sink.captureEnded();
      throw signal.reason;
    }

    if (script.tail) {
      sink.accept(script.tail);
    }
    sink.captureEnded(script.failure);
  };

  return { capture, started: started.promise, end: () => ended.resolve(), script };
}
