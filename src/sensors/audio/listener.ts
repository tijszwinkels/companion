import type { Log } from '../../core/frame.ts';
import { computerMicrophone, type SensorPipeline } from '../../core/pipeline.ts';
import type { Activity } from '../../core/activity.ts';
import { audioFrames } from './capture.ts';
import { FRAME_SAMPLES, SAMPLE_RATE, Segmenter, type Segment } from './segmenter.ts';
import type { VoiceActivityDetector } from './vad.ts';
import { CaptureDiagnostics } from './capture-diagnostics.ts';
import { notAdmitted, type CaptureAdmission } from '../../capture-storage/policy.ts';

/**
 * The fastest rate, in samples per millisecond, at which the microphone
 * recorder can deliver captured audio: 16 kHz plus 0.2% for clock drift
 * (real devices stay within about 0.01%). Live capture cannot run faster than
 * this, so the sample at stream position p was acquired no earlier than
 * `recorderStarted + p / maximumSamplesPerMs`, however long VAD, the pipe or
 * the queue delayed its processing. This does not hold for a file: ffmpeg
 * decodes it faster than real time, so a later position may already be
 * buffered long before this formula's time. File input therefore uses the
 * admission from before decoding for every segment (see `listen`).
 */
const maximumSamplesPerMs = (SAMPLE_RATE / 1000) * 1.002;

/** Where one listening period's sound comes from, and how it ends early. */
export interface ListenOptions {
  /** An audio file (`--wav`), decoded by ffmpeg; it ends at EOF. */
  file?: string;
  /** PipeWire target node of the computer's microphone. */
  device?: string;
  /**
   * A browser's stream instead of a recorder or file (network-source.ts):
   * called once with the period's capture signal, which ends the frames.
   */
  source?: (signal: AbortSignal) => AsyncIterable<Float32Array>;
  /**
   * Ends this listening period without cancelling accepted work: manual
   * recording takes the computer's microphone (core/dictation), or a
   * browser's stream ended. Unlike `signal` (pause and shutdown), only the
   * open candidate is discarded.
   */
  handoff?: AbortSignal;
  /** The microphone this period listens to; `computerMicrophone` by default. */
  microphone?: string;
  /**
   * A browser stream's capture-storage admission, taken when the stream was
   * accepted (before any of its sound was queued). Without it, a `source`
   * period takes its admission when the period starts.
   */
  captureAdmission?: CaptureAdmission;
}

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
 *
 * Sound comes from the computer's recorder (`device`), a file (`file`) or a
 * browser's stream (`source`, see network-source.ts). Every period tells the
 * pipeline which microphone it listens to (`microphone`, the computer's by
 * default), so that speech resumed on one microphone continues only that
 * microphone's attempt.
 */
export async function listen(
  vad: VoiceActivityDetector,
  pipeline: SensorPipeline,
  log: Log,
  signal: AbortSignal,
  options: ListenOptions,
  activity: Activity = {},
): Promise<void> {
  const microphone = options.microphone ?? computerMicrophone;

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

  // Capture-storage admission (docs/capture-storage.md): the recorder starts
  // after this moment, and `received` counts every sample it delivered.
  //
  // Microphone: a segment ends with the newest frame, so its first sample's
  // position is `received - samples.length` (one extra frame is subtracted
  // as a margin). That position gives a conservative earliest acquisition
  // time on the capture-storage clock.
  //
  // File (--wav): the whole file may be decoded and buffered at once, so
  // every segment retains the admission from before decoding starts. A
  // replay begun while off stays unsaved, including equal-clock transitions.
  //
  // Browser stream: its sound may have been captured and buffered in the
  // browser before it arrives, and no recorder clock bounds that here. So it
  // is treated like a file: every segment retains the admission from when
  // the stream's period started. A stream begun while storage was off stays
  // unsaved; turning storage off revokes the admission as for any capture.
  const recorderStarted = activity.captureClock?.() ?? 0;
  let replayAdmission: CaptureAdmission | undefined = options.captureAdmission;
  if (!replayAdmission && (options.file || options.source)) {
    replayAdmission = activity.admitCapture?.() ?? notAdmitted;
  }
  let received = 0;
  const capturedFrom = (segment: Segment) => {
    const firstSample = Math.max(0, received - segment.samples.length - FRAME_SAMPLES);
    return recorderStarted + firstSample / maximumSamplesPerMs;
  };

  // A handoff also kills the recorder, so the next period can open its own.
  // For a browser stream, `handoff` is the end of the stream.
  const handoff = options.handoff;
  const captureSignal = handoff ? AbortSignal.any([signal, handoff]) : signal;
  let handedOver = false;

  try {
    try {
      await listenToFrames();
    } catch (error) {
      // The recorder was killed for the handoff; that is not a failure.
      if (!handoff?.aborted || signal.aborted) {
        throw error;
      }
    }

    signal.throwIfAborted();

    if (handoff?.aborted) {
      // Manual recording takes the microphone. Discard the open candidate, as
      // a pause would: its words were meant for ordinary listening, which has
      // stopped. Accepted utterances continue, because their jobs use `signal`.
      handedOver = true;
    } else {
      const tailWasOpen = segmenter.collecting;
      const tail = segmenter.finish();

      if (tail) {
        log('utterance', 'Speech ended (end)');
        pipeline.submit(
          tail.samples,
          signal,
          tail.leadIn,
          tail.trailingSilenceMs,
          capturedFrom(tail),
          replayAdmission,
          microphone,
        );
      } else if (tailWasOpen) {
        // A too-short tail at the end of the input is a rejected burst like any
        // other: its sound was the latest speech, so the held attempt's floor
        // restarts from the tail's measured end (often 0 ms before EOF).
        pipeline.speechDiscarded(closedTrailingSilenceMs, microphone);
      }
    }
    completed = true;
  } finally {
    // Pause, capture or VAD failure, handoff and shutdown: any candidate still
    // open will never be submitted. Idempotent after submit or a rejected tail.
    // Listening has stopped, so no sound can continue the held attempt, and
    // its deadlines stay as they were (no trailing silence is passed).
    pipeline.speechDiscarded(undefined, microphone);

    captureDiagnostics.finish();
    let ending = completed ? 'eof' : 'failed';
    if (handedOver) {
      ending = options.source ? 'stream-ended' : 'handed-over';
    }
    log('audio-end', signal.aborted ? 'cancelled' : ending);
    // EOF, pause, failure, and shutdown must never leave the microphone red.
    activity.speechChanged?.(false);
  }

  /** Read, classify and segment frames until the input ends or listening stops. */
  async function listenToFrames(): Promise<void> {
    const frames = options.source
      ? options.source(captureSignal)
      : audioFrames(captureSignal, options);

    for await (const frame of frames) {
      if (handoff?.aborted) {
        break;
      }
      signal.throwIfAborted();
      received += frame.length;
      const wasSpeaking = segmenter.speaking;
      const wasCollecting = segmenter.collecting;
      const probability = await vad.probability(frame);
      signal.throwIfAborted();
      // The period may have ended while this frame was in the voice
      // detector (a hand-over, the computer switched off, a browser stream
      // ended). Its candidate was still open then: nothing more is decided.
      if (handoff?.aborted) {
        break;
      }
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
        pipeline.speechResumed(microphone);
      }

      // The candidate closed without a segment: too little voiced audio. Its
      // sound is still the latest speech, so the quiet period restarts from it.
      if (wasCollecting && !segmenter.collecting && !segment) {
        pipeline.speechDiscarded(closedTrailingSilenceMs, microphone);
      }

      if (segment) {
        log('utterance', `Speech ended (${segment.reason})`);
        pipeline.submit(
          segment.samples,
          signal,
          segment.leadIn,
          segment.trailingSilenceMs,
          capturedFrom(segment),
          replayAdmission,
          microphone,
        );

        // Files decode faster than real time. Keep every file segment by waiting
        // for the worker; microphone capture always continues independently.
        if (options.file) {
          await pipeline.idle();
        }
      }
    }
  }
}
