import type { Log } from '../../core/frame.ts';
import type { SensorPipeline } from '../../core/pipeline.ts';
import { audioFrames } from './capture.ts';
import { Segmenter } from './segmenter.ts';
import type { VoiceActivityDetector } from './vad.ts';

/** One listening period owns its recorder and segmenter; pause discards both. */
export async function listen(
  vad: VoiceActivityDetector,
  pipeline: SensorPipeline,
  log: Log,
  signal: AbortSignal,
  options: { file?: string; device?: string },
): Promise<void> {
  const segmenter = new Segmenter();
  vad.reset();

  for await (const frame of audioFrames(signal, options)) {
    signal.throwIfAborted();
    const wasSpeaking = segmenter.speaking;
    const segment = segmenter.push(await vad.probability(frame), frame);

    if (!wasSpeaking && segmenter.speaking) {
      log('speech', 'Speech detected');
    }

    if (segment) {
      log('utterance', `Speech ended (${segment.reason})`);
      pipeline.submit(segment.samples, signal);

      // Files decode faster than real time. Keep every file segment by waiting
      // for the worker; microphone capture always continues independently.
      if (options.file) {
        await pipeline.idle();
      }
    }
  }

  signal.throwIfAborted();
  const tail = segmenter.finish();

  if (tail) {
    pipeline.submit(tail.samples, signal);
  }
}
