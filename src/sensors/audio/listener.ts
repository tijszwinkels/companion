import type { Log } from '../../core/frame.ts';
import type { SensorPipeline } from '../../core/pipeline.ts';
import type { Activity } from '../../core/activity.ts';
import { audioFrames } from './capture.ts';
import { Segmenter } from './segmenter.ts';
import type { VoiceActivityDetector } from './vad.ts';
import { CaptureDiagnostics } from './capture-diagnostics.ts';

/**
 * One listening period owns its recorder and segmenter; pause discards both.
 *
 * Besides accepted segments, the listener reports candidate boundaries so the
 * pipeline can continue a provisional utterance: a newly opened candidate
 * holds the newest attempt (`speechResumed`), and a candidate that closes
 * without a segment releases it (`speechDiscarded`). Every exit path releases
 * an open hold, so no attempt can wait for a candidate that will never close.
 *
 * Both accepted segments and rejected candidates carry the silence the
 * segmenter measured after their last voiced frame. The pipeline subtracts it
 * from the moment it is told, so the commitment floor counts from when speech
 * actually ended, not from when the segment closed.
 */
export async function listen(
  vad: VoiceActivityDetector,
  pipeline: SensorPipeline,
  log: Log,
  signal: AbortSignal,
  options: { file?: string; device?: string },
  activity: Activity = {},
): Promise<void> {
  // Trailing silence of the candidate that closed most recently. The segmenter
  // reports every closed candidate synchronously, before `push` returns.
  let closedTrailingSilenceMs = 0;
  const segmenter = new Segmenter((diagnostic) => {
    closedTrailingSilenceMs = diagnostic.trailingSilenceMs;
    log('vad', JSON.stringify(diagnostic));
  });
  const captureDiagnostics = new CaptureDiagnostics(log);
  let completed = false;
  vad.reset();

  try {
    for await (const frame of audioFrames(signal, options)) {
      signal.throwIfAborted();
      const wasSpeaking = segmenter.speaking;
      const wasCollecting = segmenter.collecting;
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

      // A new candidate may continue a provisional utterance that has not yet
      // committed. Hold it now, before its inference can complete and act.
      if (!wasCollecting && segmenter.collecting) {
        pipeline.speechResumed();
      }

      // The candidate closed without a segment: too little voiced audio. Its
      // sound is still the latest speech, so the quiet period restarts from it.
      if (wasCollecting && !segmenter.collecting && !segment) {
        pipeline.speechDiscarded(closedTrailingSilenceMs);
      }

      if (segment) {
        log('utterance', `Speech ended (${segment.reason})`);
        pipeline.submit(segment.samples, signal, segment.leadIn, segment.trailingSilenceMs);

        // Files decode faster than real time. Keep every file segment by waiting
        // for the worker; microphone capture always continues independently.
        if (options.file) {
          await pipeline.idle();
        }
      }
    }

    signal.throwIfAborted();
    const tailWasOpen = segmenter.collecting;
    const tail = segmenter.finish();

    if (tail) {
      log('utterance', 'Speech ended (end)');
      pipeline.submit(tail.samples, signal, tail.leadIn, tail.trailingSilenceMs);
    } else if (tailWasOpen) {
      // A too-short tail at the end of the input is a rejected burst like any
      // other: its sound was the latest speech, so the held attempt's floor
      // restarts from the tail's measured end (often 0 ms before EOF).
      pipeline.speechDiscarded(closedTrailingSilenceMs);
    }
    completed = true;
  } finally {
    // Pause, capture or VAD failure, and shutdown: any candidate still open
    // will never be submitted. Idempotent after submit or a rejected tail.
    // Listening has stopped, so no sound can continue the held attempt, and
    // its deadlines stay as they were (no trailing silence is passed).
    pipeline.speechDiscarded();

    captureDiagnostics.finish();
    log('audio-end', signal.aborted ? 'cancelled' : completed ? 'eof' : 'failed');
    // EOF, pause, failure, and shutdown must never leave the microphone red.
    activity.speechChanged?.(false);
  }
}
