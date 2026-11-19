import type { DictationController } from '../../core/dictation/controller.ts';
import type { Log } from '../../core/frame.ts';
import type { PauseControl } from '../../core/pause-control.ts';
import { CaptureLostError } from './capture.ts';
import { CaptureRetryDelay, systemRetryClock, type RetryClock } from './capture-retry.ts';
import type { VoiceActivityDetector } from './vad.ts';

/**
 * The live microphone loop of the CLI listener (not used for `--wav`).
 *
 * Purpose: one listening period at a time owns the microphone, either
 * ordinary listening while not paused, or a manual recording, which may also
 * run while ordinary listening is paused. Accepted chunks keep transcribing
 * after capture ends, while the microphone returns to ordinary listening.
 *
 * Lost capture. When PipeWire or WirePlumber restarts, the running recorder
 * ends or fails on its own. Ordinary listening then logs the interruption,
 * waits (CaptureRetryDelay: growing, capped, reset after healthy capture) and
 * opens a new recorder in the same process. Only lost capture is retried;
 * any other error that escapes `listen` (for example from VAD) still ends
 * the listener, as before. Transcription and other pipeline job failures keep
 * their existing handling inside SensorPipeline: they are logged and counted,
 * and listening continues. The lost period's open speech candidate is
 * resolved by `listen` exactly as for any capture end; accepted utterances
 * continue and are never submitted again.
 *
 * A manual recording that loses capture ends with the `microphone` reason
 * (see dictation-listener.ts). It is never restarted here: the loop goes back
 * to ordinary listening, and the recorded draft waits for the user's Send.
 *
 * Ownership. Every period, recording and retry wait is awaited before the
 * next one starts, and each period's recorder has exited before it returns
 * (audioFrames). So there is at most one capture child process at a time.
 *
 * Cancellation. A retry wait ends early for shutdown, pause and a manual
 * recording request:
 *
 * - shutdown (`signal`) throws its reason, as the rest of the loop does;
 * - pause waits for cancelled pipeline work to settle, then for resume;
 * - Record runs the recording first.
 *
 * After a pause or recording, ordinary listening opens its recorder
 * immediately; the next loss still uses the grown delay.
 *
 * Output: the loop runs until shutdown or a non-capture failure and therefore
 * only ever ends by throwing.
 */
export interface MicrophoneLoopOptions {
  /** Listener shutdown. */
  signal: AbortSignal;
  pause: PauseControl;
  /** Manual recording; present only when a desktop panel can hold drafts. */
  dictation?: DictationController;
  /** Used by manual recordings; ordinary listening receives it via `listen`. */
  vad: VoiceActivityDetector;
  /** PipeWire target node for both kinds of capture. */
  device?: string;
  /**
   * One ordinary listening period (`listen` in listener.ts). `signal` covers
   * pause and shutdown; `handoff` aborts when a manual recording asks for the
   * microphone.
   */
  listen(signal: AbortSignal, handoff: AbortSignal | undefined): Promise<void>;
  /** Wait until cancelled pipeline work has settled (SensorPipeline.idle). */
  idle(): Promise<void>;
  log: Log;
  /** Replaced by fake time in tests. */
  clock?: RetryClock;
  retryDelay?: CaptureRetryDelay;
}

export async function listenToMicrophone(options: MicrophoneLoopOptions): Promise<never> {
  const { signal, pause, dictation, log } = options;
  const clock = options.clock ?? systemRetryClock;
  const retryDelay = options.retryDelay ?? new CaptureRetryDelay();

  // Set after a loss, so that the reopened recorder is visible in the log.
  let reopening = false;

  while (true) {
    if (dictation) {
      await dictation.waitForMicrophone(signal);
    } else {
      await pause.waitUntilResumed(signal);
    }

    if (dictation?.waitingForMicrophone) {
      await dictation.record(options.vad, { device: options.device });
      continue;
    }

    const listeningSignal = AbortSignal.any([signal, pause.signal]);
    // Aborted when a recording asks for the microphone. It ends this
    // period without cancelling utterances that were already accepted.
    const handoff = dictation?.handoff();

    if (reopening) {
      log('microphone', 'Opening the microphone again');
      reopening = false;
    }

    const started = clock.now();
    let lost: CaptureLostError;

    try {
      try {
        await options.listen(listeningSignal, handoff);
      } finally {
        // Only the time the recorder ran counts as capture. Measure it now:
        // waiting below for cancelled work to settle proves nothing about
        // the microphone and must not reset a grown delay.
        retryDelay.captureLasted(clock.now() - started);
      }

      if (handoff?.aborted) {
        continue;
      }

      // The live recorder exited successfully, which it does not do while
      // PipeWire runs: the audio service went away underneath it.
      lost = new CaptureLostError('The microphone recorder ended unexpectedly');
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      if (listeningSignal.aborted) {
        // Pause killed the recorder and pending work. Wait for cancellation to
        // settle before a new period reuses VAD or accepts more microphone audio.
        await options.idle();
        continue;
      }

      // Anything else (VAD, pipeline) is not a capture interruption.
      if (!(error instanceof CaptureLostError)) {
        throw error;
      }

      lost = error;
    }

    const delayMs = retryDelay.lost();
    log('microphone', `Capture lost (${lost.message}); recording again in ${delayMs} ms`);
    reopening = true;

    // Shutdown, pause and a manual recording request end the wait early.
    const waitInterrupted = handoff ? AbortSignal.any([listeningSignal, handoff]) : listeningSignal;
    await clock.sleep(delayMs, waitInterrupted);
    signal.throwIfAborted();

    if (listeningSignal.aborted) {
      // Paused during the wait: the lost period's accepted work was cancelled
      // with it. Let that settle, as after any paused period.
      await options.idle();
    }
  }
}
