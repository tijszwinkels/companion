import type { InteractionContext, Log, Screenshot } from './frame.ts';
import type { UserSensorRouter } from './router.ts';
import type { Activity } from './activity.ts';
import { failureOutcome } from './delivery-error.ts';
import type { InspectableModule } from './module.ts';
import type { ScreenSensor } from '../sensors/screen/sensor.ts';
import type { SpeechTranscriber } from '../sensors/audio/transcriber.ts';

/** The exact objects used for capture, transcription, and dispatch. */
export type PipelineDependencies = {
  readonly screen: ScreenSensor;
  readonly transcriber: SpeechTranscriber;
  readonly router: UserSensorRouter;
};

// Capture starts before its job reaches the worker. Store failures as values so
// an early rejection cannot become an unhandled promise while the job is queued.
type CaptureResult = (
  { screenshot: Screenshot; error?: never } | { error: unknown; screenshot?: never }
) & { application?: Screenshot['window'] };

/** Audio plus the already-running capture for a future sensor frame. */
interface Job {
  id: number;
  observedAt: number;
  samples: Float32Array;
  capture: Promise<CaptureResult>;
  signal: AbortSignal;
  interaction?: InteractionContext;
}

/** Audio/VAD continues independently; one worker routes frames in speech order. */
export class SensorPipeline implements InspectableModule {
  readonly label = 'Sensor pipeline';

  private readonly pending: Job[] = [];
  private worker?: Promise<void>;
  private nextId = 0;

  /** Reported by the CLI as a nonzero exit status, without stopping later jobs. */
  failures = 0;

  constructor(
    readonly dependencies: PipelineDependencies,
    private readonly log: Log,
    private readonly signal: AbortSignal,
    private readonly activity: Activity = {},
    readonly id = 'pipeline',
  ) {}

  /** Accept ownership of a complete utterance without blocking microphone input. */
  submit(samples: Float32Array, signal = this.signal): boolean {
    if (signal.aborted || this.signal.aborted) {
      return false;
    }

    const id = ++this.nextId;

    // One job can be active and two waiting. Bound memory and make overload
    // visible rather than silently accumulating increasingly stale utterances.
    if (this.pending.length >= 2) {
      this.log('dropped', 'Two utterances already queued; this utterance was not processed', id);
      return false;
    }

    const observedAt = Date.now();
    const jobSignal = AbortSignal.any([signal, this.signal]);
    this.activity.processing?.(id);
    const interaction = this.activity.interactionContext?.();
    this.log('capture', 'Capturing active window', id);

    // Capture at speech end, even if ASR is busy. Handle rejection immediately.
    let application: Screenshot['window'] | undefined;
    const capture = this.dependencies.screen
      .capture(jobSignal, (window) => {
        application = window;
      })
      .then(
        (screenshot) => {
          this.log(
            'screen',
            `${JSON.stringify(screenshot.window.app)} ${screenshot.width}x${screenshot.height}`,
            id,
          );
          return { screenshot, application: screenshot.window };
        },
        (error) => ({ error, application }),
      );

    this.pending.push({ id, observedAt, samples, capture, signal: jobSignal, interaction });
    this.log('queued', `${(samples.length / 16000).toFixed(2)} s audio`, id);

    // At most one worker runs; it preserves speech order through ASR and routing.
    this.worker ??= this.drain().finally(() => {
      this.worker = undefined;
    });

    return true;
  }

  /** Used by file playback and shutdown to wait for accepted work to settle. */
  async idle(): Promise<void> {
    await this.worker;
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const job = this.pending.shift()!;

      try {
        job.signal.throwIfAborted();
        this.log('transcribe', 'Recognizing speech', job.id);
        const started = performance.now();

        // Capture is already in progress. Await both halves of the same frame;
        // a new screenshot taken after transcription could show another app.
        const [utterance, capture] = await Promise.all([
          this.dependencies.transcriber.transcribe(job.samples, job.signal),
          job.capture,
        ]);

        this.log(
          'transcript',
          `${JSON.stringify(utterance)} (${Math.round(performance.now() - started)} ms including capture)`,
          job.id,
        );

        if (!utterance.trim()) {
          this.log('filtered', 'No speech text', job.id);
          continue;
        }

        // Save text before classification, including when capture failed. A late
        // ASR result is retained, but cancellation still prevents its delivery.
        this.activity.transcribed?.({
          id: job.id,
          observedAt: job.observedAt,
          utterance,
          application: capture.application ?? capture.screenshot?.window,
        });

        // Preserve each available input independently, including a late ASR
        // result after cancellation. One failed write must not discard the
        // other recording. Await both before reporting a failure or clearing
        // this job's samples in finally; Promise.all would return too early.
        const audioWrite = this.activity.audioCaptured?.(job.id, job.samples);
        const screenshotWrite = capture.screenshot
          ? this.activity.screenshotCaptured?.(job.id, capture.screenshot)
          : undefined;
        const recordings = await Promise.allSettled([audioWrite, screenshotWrite]);

        for (const recording of recordings) {
          if (recording.status === 'rejected') {
            throw recording.reason;
          }
        }

        job.signal.throwIfAborted();

        if (!capture.screenshot) {
          throw capture.error;
        }

        this.log('frame', 'Utterance + screenshot', job.id);
        await this.dependencies.router.route(
          {
            id: job.id,
            observedAt: job.observedAt,
            utterance,
            screenshot: capture.screenshot,
            interaction: job.interaction,
          },
          job.signal,
        );

        this.log('done', `${Date.now() - job.observedAt} ms since speech end`, job.id);
      } catch (error) {
        // A failed frame should not stop listening. A requested shutdown is
        // expected control flow and does not count as a processing failure.
        this.activity.outcome?.(job.id, failureOutcome(error, job.signal));

        if (!job.signal.aborted) {
          this.failures++;
          this.log('error', error instanceof Error ? error.message : String(error), job.id);
        }
      } finally {
        // This job owns the audio buffer; no later processor needs raw samples.
        job.samples.fill(0);

        await job.capture; // Settle capture before shutdown releases the job.
        this.activity.finished?.(job.id);
      }
    }
  }
}
