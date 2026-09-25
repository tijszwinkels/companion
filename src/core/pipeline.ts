import type { InteractionContext, Log, Screenshot } from './frame.ts';
import type { UserSensorRouter } from './router.ts';
import type { Activity } from './activity.ts';
import { failureOutcome } from './delivery-error.ts';
import type { InspectableModule } from './module.ts';
import type { ScreenSensor } from '../sensors/screen/sensor.ts';
import type { SpeechTranscriber, TranscriptionDiagnostic } from '../sensors/audio/transcriber.ts';
import { VAD_SETTINGS } from '../sensors/audio/segmenter.ts';
import { MIN_SPEECH_WINDOW_RMS } from '../sensors/audio/levels.ts';
import {
  MAX_UTTERANCE_SAMPLES,
  ProvisionalAttempt,
  type TranscriptChain,
} from './utterance-continuation.ts';

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

/** Spoken or typed input plus the already-running capture for a future frame. */
interface Job {
  id: number;
  observedAt: number;
  samples?: Float32Array;
  text?: string;
  capture: Promise<CaptureResult>;
  /** Pause and shutdown. ASR uses only this signal (see `routeSignal`). */
  signal: AbortSignal;
  /**
   * `signal` plus supersession by resumed speech. Used for capture, recording,
   * inference and dispatch. ASR deliberately ignores supersession: aborting a
   * request kills the resident worker, and restarting it costs far more than
   * letting a short request finish and discarding its result.
   */
  routeSignal: AbortSignal;
  interaction?: InteractionContext;
  /** Speech only: hold and commitment state for this provisional attempt. */
  attempt?: ProvisionalAttempt;
  /** Speech only: shared by every attempt of one spoken utterance. */
  chain?: TranscriptChain;
  /** Set when processing has ended, before the sample buffer is cleared. */
  settled: boolean;
}

/** Input for admission; a continuation also names the attempt it replaces. */
type JobInput =
  | { samples: Float32Array; text?: never; replaces?: Job }
  | { text: string; samples?: never; replaces?: never };

/** Audio/VAD continues independently; one worker routes frames in speech order. */
export class SensorPipeline implements InspectableModule {
  readonly label = 'Sensor pipeline';

  private readonly pending: Job[] = [];
  private worker?: Promise<void>;
  private nextId = 0;

  // The most recently admitted job. Only it can be continued by resumed
  // speech; anything admitted later, including typed input, is a boundary.
  private newest?: Job;

  // The attempt held by an open VAD candidate, until that candidate resolves.
  private held?: Job;

  // Cleanup of superseded jobs that never reached the worker. Tracked so that
  // idle() and shutdown wait for their capture and activity callbacks.
  private readonly retiring = new Set<Promise<void>>();

  /** Reported by the CLI as a nonzero exit status, without stopping later jobs. */
  failures = 0;

  constructor(
    readonly dependencies: PipelineDependencies,
    private readonly log: Log,
    private readonly signal: AbortSignal,
    private readonly activity: Activity = {},
    readonly id = 'pipeline',
  ) {}

  /**
   * Accept ownership of a complete utterance without blocking microphone input.
   * If this segment resumed speech during a held provisional attempt, it is
   * merged with that attempt's audio instead of starting a new request. The
   * optional lead-in is the pause between the two that the segment's preroll
   * could not hold (Segment.leadIn); it is used only for a merge, so the
   * combined audio keeps the real pause up to the legacy endpoint.
   */
  submit(
    samples: Float32Array,
    signal = this.signal,
    leadIn: Float32Array = new Float32Array(0),
  ): boolean {
    const held = this.held;
    this.held = undefined;

    if (held && this.continuable(held, leadIn.length + samples.length)) {
      const combined = concatenate([held.samples!, leadIn, samples]);
      return this.enqueue({ samples: combined, replaces: held }, signal);
    }

    // Not a continuation (or not mergeable): the held attempt proceeds.
    held?.attempt!.release();
    return this.enqueue({ samples }, signal);
  }

  /**
   * The listener opened a new VAD candidate. Hold the newest attempt if it has
   * not committed yet, so it cannot act until the candidate is resolved by
   * `submit` (speech) or `speechDiscarded` (too short, or listening ended).
   */
  speechResumed(): void {
    this.speechDiscarded();

    const job = this.newest;
    if (!job?.attempt || job.settled) {
      return;
    }

    if (job.attempt.hold()) {
      this.held = job;
      this.log('hold', 'Speech resumed before dispatch; holding this attempt', job.id);
    }
  }

  /** The open candidate did not become speech. Idempotent; safe on every exit path. */
  speechDiscarded(): void {
    const job = this.held;
    this.held = undefined;

    if (job) {
      job.attempt!.release();
      if (!job.settled) {
        this.log('release', 'Resumed sound was not speech; continuing', job.id);
      }
    }
  }

  /** Whether a finished candidate can be merged into the attempt it held. */
  private continuable(held: Job, addedSamples: number): boolean {
    // Anything admitted since, such as typed input, separates the two.
    if (held !== this.newest || held.settled || !held.attempt || held.attempt.committed) {
      return false;
    }

    if (held.samples!.length + addedSamples > MAX_UTTERANCE_SAMPLES) {
      this.log('continuation', 'Combined audio would exceed 30 s; starting a new request', held.id);
      return false;
    }

    return true;
  }

  /** Typed observations share speech ordering, capture, history and routing. */
  submitText(text: string, signal = this.signal, target?: string): boolean {
    if (!text.trim() || text.length > 4000) {
      throw Error('Enter between 1 and 4000 characters');
    }
    return this.enqueue({ text }, signal, target);
  }

  private enqueue(input: JobInput, signal: AbortSignal, target?: string): boolean {
    const { replaces, ...observation } = input;

    if (signal.aborted || this.signal.aborted) {
      replaces?.attempt!.release();
      return false;
    }

    const id = ++this.nextId;

    // One job can be active and two waiting. Bound memory and make overload
    // visible rather than silently accumulating increasingly stale utterances.
    // A continuation replaces its attempt in place, so it never counts twice
    // and can never be dropped here.
    if (!replaces && this.pending.length >= 2) {
      this.log('dropped', 'Two utterances already queued; this utterance was not processed', id);

      // Later speech must not skip over the dropped audio into an older attempt.
      this.newest = undefined;
      return false;
    }

    const observedAt = Date.now();
    const jobSignal = AbortSignal.any([signal, this.signal]);
    const attempt = observation.samples ? new ProvisionalAttempt() : undefined;
    const routeSignal = attempt ? AbortSignal.any([jobSignal, attempt.signal]) : jobSignal;

    // Supersede before admitting the replacement: the old attempt's routing is
    // aborted now, and its samples were already copied into the combined buffer.
    if (replaces) {
      replaces.attempt!.supersede();
      this.log('superseded', `Speech resumed; continued as ${id}`, replaces.id);
    }

    // Every provisional endpoint, including a merged one, is a speech end.
    this.activity.processing?.(id);
    const interaction = this.activity.interactionContext?.();
    this.log('capture', 'Capturing active window', id);

    // Capture at speech end, even if ASR is busy. Handle rejection immediately.
    let application: Screenshot['window'] | undefined;
    const capture = this.dependencies.screen
      .capture(routeSignal, (window) => {
        application = window;
      })
      .then(
        (screenshot): CaptureResult => {
          if (target && screenshot.window.address !== target) {
            return { error: Error('Application focus changed before capture'), application };
          }
          this.log(
            'screen',
            `${JSON.stringify(screenshot.window.app)} ${screenshot.width}x${screenshot.height}`,
            id,
          );
          return { screenshot, application: screenshot.window };
        },
        (error) => ({ error, application }),
      );

    const job: Job = {
      id,
      observedAt,
      ...observation,
      capture,
      signal: jobSignal,
      routeSignal,
      interaction,
      attempt,
      chain: attempt ? (replaces?.chain ?? {}) : undefined,
      settled: false,
    };
    this.newest = job;

    // Replace a waiting attempt at its queue position. An active attempt is the
    // newest job, so nothing waits behind it and the replacement runs next.
    const waitingIndex = replaces ? this.pending.indexOf(replaces) : -1;
    if (waitingIndex >= 0) {
      this.pending.splice(waitingIndex, 1, job);
      this.retire(replaces!);
    } else if (replaces) {
      this.pending.unshift(job);
    } else {
      this.pending.push(job);
    }

    this.log(
      'queued',
      observation.samples
        ? `${(observation.samples.length / 16000).toFixed(2)} s audio` +
            (replaces ? ` (continues ${replaces.id})` : '')
        : 'Typed utterance',
      id,
    );

    // At most one worker runs; it preserves speech order through ASR and routing.
    this.worker ??= this.drain().finally(() => {
      this.worker = undefined;
    });

    return true;
  }

  /** Used by file playback and shutdown to wait for accepted work to settle. */
  async idle(): Promise<void> {
    while (this.worker || this.retiring.size) {
      await Promise.all([this.worker, ...this.retiring]);
    }
  }

  /**
   * Finish a superseded attempt that was still waiting: it never reached ASR,
   * so it only reports its outcome, releases its samples and settles capture,
   * exactly like the worker's own cleanup.
   */
  private retire(job: Job): void {
    const cleanup = (async () => {
      job.settled = true;
      job.samples?.fill(0);
      this.activity.outcome?.(job.id, 'superseded');
      await job.capture;
      this.activity.finished?.(job.id);
    })().finally(() => {
      this.retiring.delete(cleanup);
    });

    this.retiring.add(cleanup);
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const job = this.pending.shift()!;
      let stage = 'transcription';

      try {
        // A superseded attempt that has not started ASR needs no transcription.
        job.routeSignal.throwIfAborted();
        if (job.samples) {
          this.log('transcribe', 'Recognizing speech', job.id);
        }
        const started = performance.now();
        let transcription: TranscriptionDiagnostic | undefined;

        // Capture is already in progress. Await both halves of the same frame;
        // a new screenshot taken after transcription could show another app.
        const [transcript, capture] = await Promise.all([
          job.samples
            ? this.dependencies.transcriber.transcribe(job.samples, job.signal, (diagnostic) => {
                transcription = diagnostic;
                this.log('asr', JSON.stringify(diagnostic), job.id);
              })
            : job.text!,
          job.capture,
        ]);

        let utterance = transcript;

        this.log(
          'transcript',
          `${JSON.stringify(utterance)} (${Math.round(performance.now() - started)} ms including capture)`,
          job.id,
        );

        // Remember usable text for a later, combined attempt of this utterance.
        const fallback = job.chain?.latestTranscript;
        if (job.chain && utterance.trim()) {
          job.chain.latestTranscript = utterance;
        }

        // Resumed speech replaced this attempt while ASR was running. Its text
        // is superseded too: no history row, recording or empty-clip retention.
        if (job.attempt?.superseded) {
          throw job.routeSignal.reason;
        }

        if (!utterance.trim()) {
          // An empty attempt takes no action, but it may be a fragment that the
          // decoder cannot read alone, such as speech cut by a pause mid-word.
          // Like a shortcut, it has no inference time in which speech can
          // resume, so keep it continuable for the legacy quiet window. A
          // continuation then retranscribes it together with the new audio.
          if (!fallback && job.attempt) {
            try {
              await job.attempt.commit('shortcut', job.routeSignal);
            } catch (error) {
              if (job.attempt.superseded) {
                throw error;
              }
              // Pause or shutdown: keep the existing empty-result handling.
            }
          }

          // Live candidates already passed VAD's voiced-duration gate. Reuse
          // its duration floor and the ASR energy floor for direct callers too.
          // Only a confirmed empty decoder response qualifies: silence,
          // punctuation, transport failures and untranscribed jobs do not.
          if (
            job.samples &&
            transcription?.outcome === 'empty' &&
            transcription.audioMs >= VAD_SETTINGS.minSpeechMs &&
            transcription.speechWindowRms >= MIN_SPEECH_WINDOW_RMS &&
            this.activity.emptyAudioCaptured
          ) {
            stage = 'recording';

            // Like successful transcript recordings, a completed ASR result
            // remains useful after cancellation. Await storage before finally
            // clears this job's samples or shutdown releases desktop services.
            const clipId = await this.activity.emptyAudioCaptured({
              id: job.id,
              observedAt: job.observedAt,
              samples: job.samples,
              diagnostic: transcription,
            });
            this.log('asr-recorded', `Empty transcript audio saved (${clipId})`, job.id);
          }

          // Product choice D2: a combined retranscription can come back empty
          // even though an earlier attempt of the same utterance had words.
          // Keep that earlier content instead of dropping the utterance.
          if (!fallback) {
            this.log('filtered', 'No speech text', job.id);
            continue;
          }

          utterance = fallback;
          this.log('fallback', 'Combined audio had no text; using the earlier transcript', job.id);
        }

        // Save text before classification, including when capture failed. A late
        // ASR result is retained, but cancellation still prevents its delivery.
        stage = 'recording';
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
        const audioWrite = job.samples
          ? this.activity.audioCaptured?.(job.id, job.samples)
          : undefined;
        const screenshotWrite = capture.screenshot
          ? this.activity.screenshotCaptured?.(job.id, capture.screenshot)
          : undefined;
        const recordings = await Promise.allSettled([audioWrite, screenshotWrite]);

        for (const recording of recordings) {
          if (recording.status === 'rejected') {
            throw recording.reason;
          }
        }

        job.routeSignal.throwIfAborted();

        if (!capture.screenshot) {
          stage = 'capture';
          throw capture.error;
        }

        stage = 'routing';
        this.log('frame', 'Utterance + screenshot', job.id);
        await this.dependencies.router.route(
          {
            id: job.id,
            observedAt: job.observedAt,
            utterance,
            screenshot: capture.screenshot,
            interaction: job.interaction,
          },
          job.routeSignal,
          job.attempt,
        );

        this.log('done', `${Date.now() - job.observedAt} ms since speech end`, job.id);
      } catch (error) {
        // A failed frame should not stop listening. A requested shutdown is
        // expected control flow and does not count as a processing failure.
        this.activity.outcome?.(job.id, failureOutcome(error, job.routeSignal));

        if (job.attempt?.superseded && !job.signal.aborted) {
          this.log('superseded', 'Replaced by the resumed utterance before dispatch', job.id);
        } else if (!job.routeSignal.aborted) {
          this.failures++;
          const message = error instanceof Error ? error.message : String(error);
          this.log('error', `${stage}: ${message}`, job.id);
        }
      } finally {
        // From here on the attempt cannot be continued: a merge needs intact
        // samples, and this job owns the audio buffer, which is cleared now.
        job.settled = true;
        job.samples?.fill(0);

        await job.capture; // Settle capture before shutdown releases the job.
        this.activity.finished?.(job.id);
      }
    }
  }
}

/** Join the raw audio of a provisional attempt, the pause and its continuation. */
function concatenate(parts: Float32Array[]): Float32Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }

  const combined = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  return combined;
}
