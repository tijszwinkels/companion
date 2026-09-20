import type { Log } from '../../core/frame.ts';
import type { SensorPipeline } from '../../core/pipeline.ts';
import type { Activity } from '../../core/activity.ts';
import { audioFrames } from './capture.ts';
import { Segmenter } from './segmenter.ts';
import type { VoiceActivityDetector } from './vad.ts';
import { CaptureDiagnostics } from './capture-diagnostics.ts';

/** One listening period owns its recorder and segmenter; pause discards both. */
export async function listen(
  vad: VoiceActivityDetector,
  pipeline: SensorPipeline,
  log: Log,
  signal: AbortSignal,
  options: { file?: string; device?: string },
  activity: Activity = {},
): Promise<void> {
  const segmenter = new Segmenter((diagnostic) => {
    log('vad', JSON.stringify(diagnostic));
  });
  const captureDiagnostics = new CaptureDiagnostics(log);
  let completed = false;
  vad.reset();

  try {
    for await (const frame of audioFrames(signal, options)) {
      signal.throwIfAborted();
      const wasSpeaking = segmenter.speaking;
      const probability = await vad.probability(frame);
      signal.throwIfAborted();
      captureDiagnostics.push(frame, probability);
      const segment = segmenter.push(probability, frame);

      // Report transitions only, rather than sending desktop updates at 31 Hz.
      // This also clears the indicator for short sounds that never become jobs.
      if (wasSpeaking !== segmenter.speaking) {
        activity.speechChanged?.(segmenter.speaking);
      }

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
      log('utterance', 'Speech ended (end)');
      pipeline.submit(tail.samples, signal);
    }
    completed = true;
  } finally {
    captureDiagnostics.finish();
    log('audio-end', signal.aborted ? 'cancelled' : completed ? 'eof' : 'failed');
    // EOF, pause, failure, and shutdown must never leave the microphone red.
    activity.speechChanged?.(false);
  }
}
