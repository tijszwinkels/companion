import assert from 'node:assert/strict';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import type { UserSensorFrame } from '../../src/core/frame.ts';
import type { UtteranceOutcome } from '../../src/core/activity.ts';
import {
  EMPTY_QUIET_MS,
  MAX_UTTERANCE_SAMPLES,
  ProvisionalAttempt,
  SPEECH_QUIET_MS,
  UtteranceSupersededError,
} from '../../src/core/utterance-continuation.ts';
import type { CleanupDetection, Detector } from '../../src/core/router.ts';
import { ENDPOINT_MS } from '../../src/sensors/audio/segmenter.ts';
import type { TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import {
  deferred,
  ManualClock,
  processor,
  screenshot,
  signal,
  testDetector,
  testSensors,
} from '../helpers.ts';

// These tests drive the pipeline's continuation interface directly, in the
// order the listener calls it: submit (provisional endpoint), speechResumed
// (a new VAD candidate), then submit (accepted) or speechDiscarded (rejected).
// Transcription and inference are controlled promises, and commitment deadlines
// run on a ManualClock, so every race and every deadline is reproduced exactly,
// without audio devices, models or real waiting.

/** Recognizable audio: every sample of a segment carries the same marker value. */
function audio(marker: number, samples = 1600): Float32Array {
  return new Float32Array(samples).fill(marker);
}

/** Decode the marker sequence of a (possibly combined) buffer, e.g. [0.1, 0.2]. */
function markers(samples: Float32Array): number[] {
  const values: number[] = [];

  for (const sample of samples) {
    // Float32 cannot store 0.1 exactly; compare at the precision markers use.
    const value = Math.round(sample * 1000) / 1000;
    if (values.at(-1) !== value) {
      values.push(value);
    }
  }

  return values;
}

/** Let promise continuations run without waiting for real time. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type Harness = ReturnType<typeof harness>;

/**
 * Admit a segment closed by an ordinary silence endpoint, as the listener does:
 * the speech ended ENDPOINT_MS (224 ms) before admission. Returns the clock
 * time at which the speech ended, the origin of its 800 ms floor.
 */
function endpoint(setup: Harness, marker: number, leadIn?: Float32Array): number {
  setup.pipeline.submit(audio(marker), undefined, leadIn, ENDPOINT_MS);
  return setup.clock.now() - ENDPOINT_MS;
}

/** Move the controlled clock to `time`, then let the woken work run. */
async function advanceTo(setup: Harness, time: number): Promise<void> {
  setup.clock.advanceTo(time);
  await settle();
}

/** Let every outstanding deadline pass, then wait until the pipeline is idle. */
async function finish(setup: Harness): Promise<void> {
  let idle = false;
  const idled = setup.pipeline.idle().then(() => {
    idle = true;
  });

  for (let round = 0; !idle; round++) {
    assert.ok(round < 50, 'The pipeline settles once its deadlines have passed');
    setup.clock.advance(EMPTY_QUIET_MS + SPEECH_QUIET_MS);
    await settle();
  }

  await idled;
  assert.equal(setup.clock.pendingTimers, 0, 'No commitment timer outlives its attempt');
}

const textDiagnostic: TranscriptionDiagnostic = {
  outcome: 'text',
  audioMs: 1000,
  elapsedMs: 10,
  characters: 5,
  rms: 0.1,
  peak: 0.1,
  speechWindowRms: 0.1,
};

const emptyDiagnostic: TranscriptionDiagnostic = {
  ...textDiagnostic,
  outcome: 'empty',
  characters: 0,
};

/**
 * One pipeline with controllable ASR and inference. Each transcription and
 * detection waits for the test to answer it, unless `answer` is supplied.
 */
function harness(
  options: {
    transcript?: (samples: Float32Array) => string | undefined;
    intent?: (frame: UserSensorFrame) => string | undefined;
    prefixes?: string[];
    /** An exact contextual label, such as a visible choice, routed without inference. */
    exactLabel?: string;
    /** A model client that ignores cancellation and still answers late. */
    ignoresAbort?: boolean;
    /**
     * Transcription cleanup on: inference uses the json-cleanup call and the
     * processor is a text route, whose prefix text is cleaned after commitment.
     */
    cleanup?: boolean;
    /** The Groq request profile: inference starts only after the speech floor. */
    groq?: boolean;
    /**
     * Answer every inference with the send intent this long after it started,
     * on the controlled clock, instead of waiting for the test to answer it.
     */
    inferenceMs?: number;
  } = {},
) {
  const controller = new AbortController();
  const clock = new ManualClock();
  const send = options.cleanup ? 'SEND_TEXT_TO_APPLICATION' : 'SEND';
  const cleanerCalls: string[] = [];
  const events: string[] = [];
  const outcomes = new Map<number, UtteranceOutcome>();
  const transcribed = new Map<number, string>();
  const audioSaved = new Map<number, number[]>();
  const emptyClips: number[][] = [];
  const dispatched: { id: number; utterance: string }[] = [];
  // Controlled-clock time of each processor dispatch, in dispatch order.
  const dispatchedAt: number[] = [];
  const asrSignals: AbortSignal[] = [];
  const asrInputs: number[][] = [];
  const asrLengths: number[] = [];
  const detectSignals: AbortSignal[] = [];
  // Every inference request, when it started on the controlled clock and how
  // it ended: answered, or aborted while it was still running.
  const requests: { startedAt: number; utterance: string; ended?: 'answered' | 'aborted' }[] = [];
  const logs: { stage: string; detail: string; id?: number }[] = [];

  const transcriptions: {
    samples: number[];
    answer: (text: string, diagnostic?: TranscriptionDiagnostic) => void;
  }[] = [];
  const detections: { utterance: string; answer: (intent: string) => void }[] = [];
  let dispatchGate: Promise<void> | undefined;

  const detect = async (frame: UserSensorFrame, signal: AbortSignal): Promise<string> => {
    detectSignals.push(signal);
    const request: (typeof requests)[number] = {
      startedAt: clock.now(),
      utterance: frame.utterance,
    };
    requests.push(request);
    signal.addEventListener(
      'abort',
      () => {
        request.ended ??= 'aborted';
      },
      { once: true },
    );

    const known = options.intent?.(frame);
    if (known) {
      request.ended = 'answered';
      return known;
    }

    if (options.inferenceMs !== undefined) {
      const inferenceMs = options.inferenceMs;
      return new Promise<string>((resolve, reject) => {
        const aborted = () => {
          cancelAnswer();
          reject(signal.reason);
        };
        const cancelAnswer = clock.schedule(() => {
          signal.removeEventListener('abort', aborted);
          request.ended = 'answered';
          resolve(send);
        }, inferenceMs);
        signal.addEventListener('abort', aborted, { once: true });
      });
    }

    const reply = deferred<string>();
    detections.push({
      utterance: frame.utterance,
      answer: (intent) => {
        request.ended ??= 'answered';
        reply.resolve(intent);
      },
    });
    if (options.ignoresAbort) {
      return reply.promise;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return Promise.race([reply.promise, aborted]);
  };

  const detector: Detector = {
    ...testDetector({
      detect: async (frame, _intents, signal) => detect(frame, signal),
    }),
    ...(options.groq ? { startsAfterSpeechQuiet: true } : {}),
  };
  if (options.cleanup) {
    // One call returns the intent and the cleaned text, as json-cleanup-v1 does.
    detector.detectWithCleanup = async (frame, _intents, signal): Promise<CleanupDetection> => {
      const intent = await detect(frame, signal);
      return { intent, text: `${frame.utterance} (cleaned)`, fallback: null };
    };
  }

  const router = new UserSensorRouter(
    {
      detector,
      cleaner: {
        id: 'test-cleaner',
        label: 'Test cleaner',
        dependencies: {},
        clean: async (_route, text) => {
          cleanerCalls.push(text);
          return { kind: 'cleaned', text: `${text} (cleaned)` };
        },
      },
    },
    () => {},
    {},
    'router',
    { enabled: options.cleanup ?? false },
  );

  processor('IGNORE').subscribe(router);
  const sendProcessor = processor(send, async (frame) => {
    events.push(`dispatch ${frame.id}`);
    dispatched.push({ id: frame.id, utterance: frame.utterance });
    dispatchedAt.push(clock.now());
    await dispatchGate;
  });
  if (options.prefixes) {
    Object.assign(sendProcessor, { prefixes: options.prefixes, acceptsEmptyPrefix: true });
  }
  sendProcessor.subscribe(router);

  if (options.exactLabel) {
    const label = options.exactLabel;
    router.registerScoped(() => [
      {
        name: 'CHOICE',
        exactUtterance: label,
        process: async (frame) => {
          events.push(`dispatch ${frame.id}`);
          dispatched.push({ id: frame.id, utterance: `CHOICE ${frame.utterance}` });
        },
      },
    ]);
  }

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (samples, signal, observe) => {
          asrSignals.push(signal);
          asrInputs.push(markers(samples));
          asrLengths.push(samples.length);
          const known = options.transcript?.(samples);
          if (known !== undefined) {
            observe?.(known ? textDiagnostic : emptyDiagnostic);
            return known;
          }

          const reply = deferred<{ text: string; diagnostic: TranscriptionDiagnostic }>();
          transcriptions.push({
            samples: markers(samples),
            answer: (text, diagnostic = text ? textDiagnostic : emptyDiagnostic) => {
              reply.resolve({ text, diagnostic });
            },
          });
          const result = await reply.promise;
          observe?.(result.diagnostic);
          return result.text;
        },
      }),
      router,
    },
    (stage, detail, id) => {
      logs.push({ stage, detail, id });
    },
    controller.signal,
    {
      processing: (id) => {
        events.push(`processing ${id}`);
      },
      transcribed: (transcript) => {
        transcribed.set(transcript.id, transcript.utterance);
      },
      audioCaptured: async (id, samples) => {
        audioSaved.set(id, markers(samples));
      },
      emptyAudioCaptured: async (clip) => {
        emptyClips.push(markers(clip.samples));
        return 'clip';
      },
      outcome: (id, outcome) => {
        outcomes.set(id, outcome);
      },
      continuationSettled: (finalId, supersededIds) => {
        events.push(`settled ${finalId} replacing ${supersededIds.join(',')}`);
      },
      finished: (id) => {
        events.push(`finished ${id}`);
      },
    },
    'pipeline',
    clock,
  );

  return {
    pipeline,
    controller,
    clock,
    send,
    cleanerCalls,
    events,
    outcomes,
    transcribed,
    audioSaved,
    emptyClips,
    dispatched,
    dispatchedAt,
    asrSignals,
    asrInputs,
    asrLengths,
    detectSignals,
    requests,
    transcriptions,
    detections,
    logs,
    holdDispatch(gate: Promise<void>) {
      dispatchGate = gate;
    },
  };
}

// ---------------------------------------------------------------------------
// ProvisionalAttempt on its own
// ---------------------------------------------------------------------------

test('spoken decisions commit 800 ms after speech: 576 ms after the provisional endpoint', () => {
  assert.equal(ENDPOINT_MS, 224);
  assert.equal(SPEECH_QUIET_MS, 800);
  assert.equal(SPEECH_QUIET_MS - ENDPOINT_MS, 576);
  assert.equal(EMPTY_QUIET_MS, 1200, 'The empty-transcript window is unchanged');
  assert.equal(MAX_UTTERANCE_SAMPLES, 16000 * 60, 'Single and combined utterances: one minute');
});

for (const route of ['inference', 'shortcut'] as const) {
  test(`a ${route} decision commits at the speech floor and is final afterwards`, async () => {
    const clock = new ManualClock();
    const attempt = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
    let committed = false;
    const commit = attempt.commit(route, signal()).then(() => {
      committed = true;
    });

    // Admission is at the endpoint: speech ended 224 ms ago, 576 ms remain.
    clock.advance(575);
    await settle();
    assert.equal(committed, false, 'Still provisional 799 ms after speech');

    clock.advance(1);
    await settle();
    assert.equal(committed, true, 'Committed 800 ms after speech');
    await commit;
    assert.equal(attempt.committed, true);
    assert.equal(clock.pendingTimers, 0);

    assert.equal(attempt.hold(), false, 'Speech after commitment is a new request');
    assert.equal(attempt.supersede(), false);
    assert.equal(attempt.signal.aborted, false);
  });
}

test('a decision that is ready after the floor commits at once, without a timer', async () => {
  const clock = new ManualClock();
  const attempt = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });

  clock.advance(1100 - ENDPOINT_MS);
  void attempt.commit('inference', signal());
  await settle();

  assert.equal(attempt.committed, true);
  assert.equal(clock.now(), 1100 - ENDPOINT_MS, 'Not 800 ms after the decision');
  assert.equal(clock.pendingTimers, 0);
});

test('no silence is assumed that was not measured', async () => {
  // EOF or the 60-second limit can close a segment with little or no trailing
  // silence, and direct callers have no VAD: the whole floor still applies.
  for (const trailingSilenceMs of [undefined, 0, 96, -50, Number.NaN, Infinity]) {
    const clock = new ManualClock();
    const attempt = new ProvisionalAttempt({ clock, trailingSilenceMs });
    let committed = false;
    const commit = attempt.commit('inference', signal()).then(() => {
      committed = true;
    });

    const measured = trailingSilenceMs === 96 ? 96 : 0;
    clock.advance(SPEECH_QUIET_MS - measured - 1);
    await settle();
    assert.equal(committed, false, `Not early for ${trailingSilenceMs}`);

    clock.advance(1);
    await settle();
    assert.equal(committed, true, `Committed at the floor for ${trailingSilenceMs}`);
    await commit;
  }
});

test('a hold delays commitment past its deadline until released, and supersession rejects it', async () => {
  const clock = new ManualClock();
  const released = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  assert.equal(released.hold(), true);
  let committed = false;
  const waiting = released.commit('inference', signal()).then(() => {
    committed = true;
  });

  clock.advance(5000);
  await settle();
  assert.equal(committed, false, 'An open candidate holds the attempt however long it lasts');

  // Released without a measured burst (typed input, listening ended): the
  // deadline is unchanged and has long passed, so it commits at once.
  released.release();
  await waiting;
  assert.equal(committed, true);
  assert.equal(clock.pendingTimers, 0);

  const replaced = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const rejected = replaced.commit('inference', signal());
  await settle();
  assert.equal(clock.pendingTimers, 1, 'Waiting for the floor');
  assert.equal(replaced.supersede(), true);
  await assert.rejects(rejected, UtteranceSupersededError);
  assert.equal(replaced.committed, false);
  assert.equal(replaced.hold(), false);
  assert.equal(clock.pendingTimers, 0, 'Supersession cancels the deadline timer');
});

test('a rejected burst restarts both quiet periods from the burst', async () => {
  const clock = new ManualClock();
  const spoken = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const empty = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const spokenCommit = spoken.commit('shortcut', signal());
  const emptyCommit = empty.commit('empty', signal());

  // A cough opens a candidate 400 ms after admission; VAD rejects it 200 ms
  // later, after measuring 224 ms of silence behind it.
  clock.advance(400);
  spoken.hold();
  empty.hold();
  clock.advance(200);
  spoken.release(ENDPOINT_MS);
  empty.release(ENDPOINT_MS);
  const releasedAt = clock.now();

  let spokenDone = false;
  let emptyDone = false;
  void spokenCommit.then(() => {
    spokenDone = true;
  });
  void emptyCommit.then(() => {
    emptyDone = true;
  });

  // The burst is the latest speech: 800 ms after it ended, i.e. 576 ms after
  // the release. The empty window restarts 1200 ms after the release.
  clock.advanceTo(releasedAt + 575);
  await settle();
  assert.equal(spokenDone, false);
  clock.advanceTo(releasedAt + 576);
  await settle();
  assert.equal(spokenDone, true);

  clock.advanceTo(releasedAt + EMPTY_QUIET_MS - 1);
  await settle();
  assert.equal(emptyDone, false);
  clock.advanceTo(releasedAt + EMPTY_QUIET_MS);
  await settle();
  assert.equal(emptyDone, true);
  assert.equal(clock.pendingTimers, 0);
});

test('cancellation rejects a waiting commitment at once and leaves no timer', async () => {
  const clock = new ManualClock();

  const held = new ProvisionalAttempt({ clock });
  const heldController = new AbortController();
  held.hold();
  const heldCommit = held.commit('shortcut', heldController.signal);
  heldController.abort(Error('Paused'));
  await assert.rejects(heldCommit, /Paused/);
  assert.equal(held.committed, false);

  const timed = new ProvisionalAttempt({ clock });
  const timedController = new AbortController();
  const timedCommit = timed.commit('inference', timedController.signal);
  await settle();
  assert.equal(clock.pendingTimers, 1);
  timedController.abort(Error('Shutdown'));
  await assert.rejects(timedCommit, /Shutdown/);
  assert.equal(timed.committed, false);
  assert.equal(clock.pendingTimers, 0);
});

// ---------------------------------------------------------------------------
// The 800 ms floor through the pipeline and router
// ---------------------------------------------------------------------------

test('a result 500 ms after speech waits through 799 ms and dispatches at 800 ms', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  assert.deepEqual(setup.events, ['processing 1'], 'The processing cue plays at the endpoint');

  // ASR and inference start at once: no added wait before either.
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  assert.equal(setup.detections.length, 1, 'Inference starts as soon as the transcript is ready');

  await advanceTo(setup, spoke + 500);
  setup.detections[0].answer('SEND');
  await settle();
  assert.deepEqual(setup.dispatched, [], 'The early result is provisional');

  await advanceTo(setup, spoke + 799);
  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.has(1), false, 'No outcome is reported while provisional');

  await advanceTo(setup, spoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);

  await finish(setup);
  assert.equal(setup.pipeline.failures, 0);
});

test('a result 1100 ms after speech dispatches when it is ready, not 800 ms later', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  await advanceTo(setup, spoke + 1100);
  assert.deepEqual(setup.dispatched, [], 'Inference is still running');
  setup.detections[0].answer('SEND');
  await settle();

  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  assert.equal(setup.clock.now(), spoke + 1100);
  assert.equal(setup.clock.pendingTimers, 0);
  await finish(setup);
});

test('speech 700 ms after speech end replaces a completed early result and retranscribes it all', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();
  await advanceTo(setup, spoke + 500);
  setup.detections[0].answer('SEND');
  await settle();

  // The user resumes 700 ms after the first part; the candidate is accepted
  // when it closes. The old result's deadline passes in the meantime.
  await advanceTo(setup, spoke + 700);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 1500);
  assert.deepEqual(setup.dispatched, [], 'The held result cannot dispatch at its deadline');

  const resumedSpoke = endpoint(setup, 0.2, audio(0.05, 512));
  await settle();
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.05, 0.2], 'Whole raw audio');
  assert.deepEqual(
    setup.asrSignals.map((asrSignal) => asrSignal.aborted),
    [false, false],
  );

  setup.transcriptions[1].answer('Open the browser');
  await settle();
  assert.equal(setup.detections.length, 2, 'A fresh inference for the whole transcript');
  assert.equal(setup.detections[1].utterance, 'Open the browser');
  setup.detections[1].answer('SEND');

  // The new attempt has its own floor, from the end of the resumed speech.
  await advanceTo(setup, resumedSpoke + 799);
  assert.deepEqual(setup.dispatched, []);
  await advanceTo(setup, resumedSpoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);

  await finish(setup);
  assert.deepEqual(
    setup.events.filter((event) => event.startsWith('processing')),
    ['processing 1', 'processing 2'],
  );
});

test('speech more than 800 ms after speech end still continues a pending inference', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();

  // A slow model: nothing has committed 900 ms after the speech ended.
  await advanceTo(setup, spoke + 900);
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();

  assert.equal(setup.detectSignals[0].aborted, true, 'The pending inference is aborted');
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.2]);
  setup.transcriptions[1].answer('Open the browser');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
});

test('a VAD onset in the same tick as the deadline holds the dispatch', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  await advanceTo(setup, spoke + 500);
  setup.detections[0].answer('SEND');
  await settle();

  // The deadline timer fires; the listener reports speech before the waiting
  // commitment resumes. The commitment re-examines the hold and waits.
  setup.clock.advanceTo(spoke + 800);
  setup.pipeline.speechResumed();
  await settle();
  assert.deepEqual(setup.dispatched, []);

  // The sound was a burst: rejected at +1000 after 224 ms of silence, so it
  // ended at +776 and the floor now ends at +1576.
  await advanceTo(setup, spoke + 1000);
  setup.pipeline.speechDiscarded(ENDPOINT_MS);
  await advanceTo(setup, spoke + 1575);
  assert.deepEqual(setup.dispatched, []);
  await advanceTo(setup, spoke + 1576);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);

  assert.equal(setup.transcriptions.length, 1, 'The burst repeated no work');
  assert.equal(setup.detections.length, 1);
  await finish(setup);
});

test('when the deadline wins the race, the resumed speech is a new request', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  setup.detections[0].answer('SEND');

  // The commitment resumes and dispatches before the listener reports speech.
  await advanceTo(setup, spoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();

  assert.equal(setup.logs.filter((entry) => entry.stage === 'hold').length, 0);
  assert.deepEqual(setup.transcriptions[1].samples, [0.2], 'Never merged after commitment');
  setup.transcriptions[1].answer('and close it');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.id),
    [1, 2],
  );
});

test('speech detected in the same tick as inference completion still holds dispatch', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();

  // A late answer: the floor has passed, so the router would commit at once.
  // Its continuation has not run yet when the listener reports speech.
  await advanceTo(setup, spoke + 1200);
  setup.detections[0].answer('SEND');
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();

  assert.deepEqual(setup.dispatched, [], 'No stale dispatch');
  assert.equal(setup.outcomes.get(1), 'superseded');
  setup.transcriptions[1].answer('Open the browser');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
});

test('a rejected burst releases the held attempt at a floor measured from the burst', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  await advanceTo(setup, spoke + 300);
  setup.detections[0].answer('SEND');
  await settle();

  await advanceTo(setup, spoke + 400);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 700);
  setup.pipeline.speechDiscarded(ENDPOINT_MS);

  // The burst ended at +476: dispatch at +1276, not at the original +800.
  await advanceTo(setup, spoke + 1275);
  assert.deepEqual(setup.dispatched, [], 'Inference completed, but the burst restarted the floor');
  await advanceTo(setup, spoke + 1276);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);

  assert.equal(setup.transcriptions.length, 1, 'Nothing is lost or repeated');
  assert.equal(setup.detections.length, 1);
  assert.ok(setup.logs.some((entry) => entry.stage === 'release' && entry.id === 1));
  await finish(setup);
});

test('a too-short tail at the end of the input delays an earlier result until 800 ms after it', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  await advanceTo(setup, spoke + 300);
  setup.detections[0].answer('SEND');

  // A candidate opens at +500; the input ends at +600 while it is still too
  // short. The listener rejects it with no trailing silence: its sound was
  // the latest speech, heard until +600.
  await advanceTo(setup, spoke + 500);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 600);
  setup.pipeline.speechDiscarded(0);

  await advanceTo(setup, spoke + 1399);
  assert.deepEqual(setup.dispatched, [], 'Not before the tail ended + 800 ms');
  await advanceTo(setup, spoke + 1400);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  await finish(setup);
});

test('a segment closed by EOF or the 60-second limit owes the floor it did not measure', async () => {
  for (const trailingSilenceMs of [0, 96]) {
    const setup = harness();
    setup.pipeline.submit(audio(0.1), undefined, undefined, trailingSilenceMs);
    const admitted = setup.clock.now();
    await settle();
    setup.transcriptions[0].answer('Open the browser');
    await settle();
    setup.detections[0].answer('SEND');

    const deadline = admitted - trailingSilenceMs + SPEECH_QUIET_MS;
    await advanceTo(setup, deadline - 1);
    assert.deepEqual(setup.dispatched, [], `No 224 ms endpoint is assumed (${trailingSilenceMs})`);
    await advanceTo(setup, deadline);
    assert.equal(setup.dispatched.length, 1);
    await finish(setup);
  }
});

test('time spent queued behind another job counts as quiet time', async () => {
  const setup = harness();
  const delivery = deferred<void>();
  setup.holdDispatch(delivery.promise);

  // Job 1 dispatches at its floor and then takes 2 s to deliver.
  const firstSpoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('First');
  await settle();
  setup.detections[0].answer('SEND');
  await advanceTo(setup, firstSpoke + 800);
  assert.equal(setup.dispatched.length, 1);

  // Job 2 is admitted while job 1 delivers, and waits in the queue.
  const secondSpoke = endpoint(setup, 0.2);
  await advanceTo(setup, secondSpoke + 2000);
  delivery.resolve();
  await settle();
  setup.transcriptions[1].answer('Second');
  await settle();
  setup.detections[1].answer('SEND');
  await settle();

  // The user has been silent for 2 s: no further wait.
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['First', 'Second'],
  );
  assert.equal(setup.clock.pendingTimers, 0);
  await finish(setup);
});

for (const route of ['prefix', 'exact label'] as const) {
  test(`a spoken ${route} shortcut waits for the same 800 ms floor`, async () => {
    const setup = harness({
      prefixes: route === 'prefix' ? ['insert'] : undefined,
      exactLabel: route === 'exact label' ? 'Option two' : undefined,
    });
    const spoke = endpoint(setup, 0.1);
    await settle();
    setup.transcriptions[0].answer(route === 'prefix' ? 'Insert hello' : 'Option two');

    await advanceTo(setup, spoke + 799);
    assert.deepEqual(setup.dispatched, []);
    await advanceTo(setup, spoke + 800);
    assert.deepEqual(setup.dispatched, [
      { id: 1, utterance: route === 'prefix' ? 'hello' : 'CHOICE Option two' },
    ]);
    assert.equal(setup.detections.length, 0, 'Shortcuts need no inference');
    await finish(setup);
  });
}

for (const route of ['inference', 'prefix'] as const) {
  test(`with transcription cleanup on, ${route} commits at the same floor`, async () => {
    const setup = harness({ cleanup: true, prefixes: ['insert'] });
    const spoke = endpoint(setup, 0.1);
    await settle();
    setup.transcriptions[0].answer(route === 'prefix' ? 'Insert hello' : 'Hello there');
    await settle();

    if (route === 'inference') {
      await advanceTo(setup, spoke + 500);
      assert.equal(setup.detections.length, 1, 'The json-cleanup call starts at once');
      setup.detections[0].answer(setup.send);
    }

    await advanceTo(setup, spoke + 799);
    assert.deepEqual(setup.dispatched, []);
    assert.deepEqual(setup.cleanerCalls, [], 'Shortcut text is cleaned only after commitment');

    await advanceTo(setup, spoke + 800);
    assert.deepEqual(setup.dispatched, [
      { id: 1, utterance: route === 'prefix' ? 'hello (cleaned)' : 'Hello there (cleaned)' },
    ]);
    assert.deepEqual(setup.cleanerCalls, route === 'prefix' ? ['hello'] : []);
    await finish(setup);
  });
}

test('an empty transcript is still filtered 1200 ms after the endpoint', async () => {
  const setup = harness();
  endpoint(setup, 0.1);
  const admitted = setup.clock.now();
  await settle();
  setup.transcriptions[0].answer('');

  await advanceTo(setup, admitted + EMPTY_QUIET_MS - 1);
  assert.deepEqual(setup.emptyClips, [], 'Still continuable');
  await advanceTo(setup, admitted + EMPTY_QUIET_MS);
  assert.deepEqual(setup.emptyClips, [[0.1]]);
  assert.ok(setup.logs.some((entry) => entry.stage === 'filtered'));
  assert.deepEqual(setup.dispatched, []);
  await finish(setup);
});

test('pausing during the floor cancels the early result without dispatch or timers', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  setup.detections[0].answer('SEND');
  await advanceTo(setup, spoke + 500);
  assert.equal(setup.clock.pendingTimers, 1, 'Waiting for the floor');

  setup.controller.abort();
  await settle();
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.get(1), 'cancelled');
  assert.equal(setup.pipeline.failures, 0);
  assert.equal(setup.clock.pendingTimers, 0);
});

test('typed input during an open candidate releases the hold without moving the deadline', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  setup.detections[0].answer('SEND');

  // Speech opens a candidate, then text is typed while it is still open. The
  // candidate can no longer continue the attempt, so waiting would gain nothing.
  await advanceTo(setup, spoke + 600);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 700);
  assert.equal(setup.pipeline.submitText('typed words'), true);

  await advanceTo(setup, spoke + 799);
  assert.equal(setup.dispatched.length, 0);
  await advanceTo(setup, spoke + 800);
  setup.detections[1].answer('SEND');
  await settle();

  // Typed input has no speech timer: it dispatches as soon as it is decided.
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Open the browser', 'typed words'],
    'Both dispatch before the candidate closes',
  );
  assert.equal(setup.clock.now(), spoke + 800);
  assert.ok(setup.logs.some((entry) => entry.stage === 'release' && entry.id === 1));

  // When the candidate is accepted, it is a new request after the typed text.
  endpoint(setup, 0.2);
  await settle();
  assert.deepEqual(setup.transcriptions[1].samples, [0.2]);
  setup.transcriptions[1].answer('and close it');
  await settle();
  setup.detections[2].answer('SEND');
  await finish(setup);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Open the browser', 'typed words', 'and close it'],
  );
  assert.notEqual(setup.outcomes.get(1), 'superseded');
});

// ---------------------------------------------------------------------------
// Continuation behavior (unchanged by the floor)
// ---------------------------------------------------------------------------

test('resumed speech during inference aborts it and retranscribes the combined raw audio', async () => {
  const setup = harness();
  const first = audio(0.1);
  setup.pipeline.submit(first);

  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();
  assert.equal(setup.detections.length, 1, 'Inference starts immediately after ASR');

  // New speech opens a candidate while inference is pending, then is accepted.
  setup.pipeline.speechResumed();
  assert.equal(setup.pipeline.submit(audio(0.2)), true);
  await settle();

  assert.equal(setup.detectSignals[0].aborted, true, 'The stale inference is aborted');
  assert.ok(setup.detectSignals[0].reason instanceof UtteranceSupersededError);
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.equal(setup.transcribed.get(1), 'Open the', 'The provisional text stays in history');

  // The whole utterance is transcribed again from raw audio, not joined text.
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.2]);
  setup.transcriptions[1].answer('Open the browser');
  await settle();
  assert.equal(setup.detections[1].utterance, 'Open the browser');
  setup.detections[1].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
  assert.deepEqual(setup.audioSaved.get(2), [0.1, 0.2]);
  assert.equal(setup.outcomes.get(2), undefined, 'A test processor reports no outcome');
  assert.deepEqual(
    setup.events.filter((event) => event.startsWith('processing')),
    ['processing 1', 'processing 2'],
    'Each provisional endpoint keeps the processing cue',
  );
  assert.equal(setup.pipeline.failures, 0);
  assert.deepEqual([...first], [...new Float32Array(1600)], 'The superseded buffer is cleared');
});

test('a merge restores the pause between the parts from the segment lead-in', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('And says');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2), undefined, audio(0.05, 512));
  await settle();
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.05, 0.2]);
  setup.transcriptions[1].answer('And says how do I get to Dublin');
  await settle();
  setup.detections[1].answer('SEND');

  // Without a held attempt, the lead-in is not part of a new request.
  setup.pipeline.submit(audio(0.3), undefined, audio(0.05, 512));
  await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
  assert.deepEqual(setup.transcriptions[2].samples, [0.3]);
  setup.transcriptions[2].answer('Next');
  await settle();
  setup.detections[2].answer('SEND');
  await finish(setup);
});

test('resumed speech during ASR lets the request finish, then discards its result', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();

  // Aborting would kill the resident ASR worker; the request must complete.
  assert.equal(setup.asrSignals[0].aborted, false);
  assert.equal(setup.transcriptions.length, 1, 'ASR is serial; the combined job waits');

  setup.transcriptions[0].answer('Open the');
  await settle();
  assert.equal(setup.transcribed.has(1), false, 'No history row for a result already replaced');
  assert.equal(setup.audioSaved.has(1), false);
  assert.equal(setup.detections.length, 0, 'No inference for the superseded attempt');
  assert.equal(setup.outcomes.get(1), 'superseded');

  setup.transcriptions[1].answer('Open the browser');
  await settle();
  setup.detections[0].answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
});

test('speech after dispatch has started is a new request and never replays the action', async () => {
  const setup = harness();
  const delivery = deferred<void>();
  setup.holdDispatch(delivery.promise);
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  setup.detections[0].answer('SEND');
  await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  delivery.resolve();
  await settle();

  assert.notEqual(setup.outcomes.get(1), 'superseded');
  assert.deepEqual(setup.transcriptions[1].samples, [0.2], 'The new request has only new audio');
  setup.transcriptions[1].answer('and close it');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Open the browser', 'and close it'],
  );
});

test('a waiting attempt is replaced in place before ASR, even when the queue is full', async () => {
  const setup = harness();
  const delivery = deferred<void>();
  setup.holdDispatch(delivery.promise);

  // Job 1 is dispatching. Jobs 2 and 3 fill both waiting places.
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('First');
  await settle();
  setup.detections[0].answer('SEND');
  await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
  setup.pipeline.submit(audio(0.2));
  setup.pipeline.submit(audio(0.3));

  setup.pipeline.speechResumed();
  assert.equal(setup.pipeline.submit(audio(0.4)), true, 'The continuation is never dropped');
  await settle();
  assert.equal(setup.outcomes.get(3), 'superseded');
  assert.ok(setup.events.includes('finished 3'), 'The replaced attempt is cleaned up');
  assert.equal(
    setup.pipeline.submit(audio(0.5)),
    false,
    'The replacement kept the queue bound: two waiting jobs',
  );

  // Speech after a dropped segment must not merge past it into job 4.
  const holds = setup.logs.filter((entry) => entry.stage === 'hold').length;
  setup.pipeline.speechResumed();
  assert.equal(setup.logs.filter((entry) => entry.stage === 'hold').length, holds);

  delivery.resolve();
  for (const text of ['Second', 'Third continued']) {
    await settle();
    setup.transcriptions.at(-1)!.answer(text);
    await settle();
    setup.detections.at(-1)!.answer('SEND');
    await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
  }
  await finish(setup);

  assert.deepEqual(setup.asrInputs, [[0.1], [0.2], [0.3, 0.4]], 'Job 3 never reached ASR');
  assert.deepEqual(
    setup.events.filter((event) => event.startsWith('settled')),
    ['settled 4 replacing 3'],
    'Only the continued utterance reports a chain',
  );
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.id),
    [1, 2, 4],
  );
  assert.ok(setup.logs.some((entry) => entry.stage === 'dropped' && entry.id === 5));
});

test('repeated pauses keep merging the whole utterance, each with a fresh floor', async () => {
  const setup = harness();
  endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('One');
  await settle();
  setup.detections[0].answer('SEND');

  // Each part resumes 700 ms after the previous one ended: always in time.
  await advanceTo(setup, setup.clock.now() + 700 - ENDPOINT_MS);
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();
  setup.transcriptions[1].answer('One two');
  await settle();
  setup.detections[1].answer('SEND');

  await advanceTo(setup, setup.clock.now() + 700 - ENDPOINT_MS);
  setup.pipeline.speechResumed();
  const lastSpoke = endpoint(setup, 0.3);
  await settle();
  assert.deepEqual(setup.transcriptions[2].samples, [0.1, 0.2, 0.3]);
  setup.transcriptions[2].answer('One two three');
  await settle();
  setup.detections.at(-1)!.answer('SEND');

  await advanceTo(setup, lastSpoke + 799);
  assert.deepEqual(setup.dispatched, []);
  await advanceTo(setup, lastSpoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 3, utterance: 'One two three' }]);
  assert.deepEqual([setup.outcomes.get(1), setup.outcomes.get(2)], ['superseded', 'superseded']);
  await finish(setup);

  // The final attempt names every attempt it replaced, once, after they have
  // finished and just before its own `finished`.
  assert.deepEqual(
    setup.events.filter((event) => /^(settled|finished)/.test(event)),
    ['finished 1', 'finished 2', 'settled 3 replacing 1,2', 'finished 3'],
  );
});

test('an empty combined transcript falls back to the earlier words and keeps the clip', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  setup.transcriptions[1].answer('');
  await settle();

  assert.deepEqual(setup.emptyClips, [[0.1, 0.2]], 'The empty combined clip is retained');
  assert.equal(setup.detections.at(-1)!.utterance, 'Open the browser');
  setup.detections.at(-1)!.answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
  assert.ok(setup.logs.some((entry) => entry.stage === 'fallback' && entry.id === 2));
});

test('an empty first attempt has no fallback and is still filtered', async () => {
  const setup = harness({ transcript: () => '' });
  setup.pipeline.submit(audio(0.1));
  await finish(setup);

  assert.deepEqual(setup.dispatched, []);
  assert.deepEqual(setup.emptyClips, [[0.1]]);
  assert.ok(setup.logs.some((entry) => entry.stage === 'filtered'));
});

test('an unreadable fragment stays continuable and is retranscribed with its continuation', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();

  // The decoder cannot read the first fragment alone. Nothing is filtered or
  // retained yet: speech may still resume within the empty-transcript window.
  setup.transcriptions[0].answer('');
  await settle();
  assert.deepEqual(setup.emptyClips, []);
  assert.equal(
    setup.logs.some((entry) => entry.stage === 'filtered'),
    false,
  );

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.2]);
  setup.transcriptions[1].answer('How do I get to Dublin');
  await settle();
  setup.detections[0].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'How do I get to Dublin' }]);
  assert.deepEqual(setup.emptyClips, [], 'A superseded fragment is not retained as empty');
});

// Both parts are longer than the old 31-second ASR bound on their own or
// combined, and the restored pause counts towards the cap.
const LONG_FIRST_PART_SAMPLES = 16000 * 40;
const LONG_LEAD_IN_SAMPLES = 5120;
const LONG_SECOND_PART_SAMPLES =
  MAX_UTTERANCE_SAMPLES - LONG_FIRST_PART_SAMPLES - LONG_LEAD_IN_SAMPLES;

test('a continuation that fills the 60-second cap exactly is one request and one action', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1, LONG_FIRST_PART_SAMPLES));
  await settle();
  setup.transcriptions[0].answer('Long dictation');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(
    audio(0.2, LONG_SECOND_PART_SAMPLES),
    undefined,
    audio(0.05, LONG_LEAD_IN_SAMPLES),
  );
  await settle();
  assert.equal(setup.detectSignals[0].aborted, true, 'The 40-second attempt is superseded');
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.equal(setup.transcribed.get(1), 'Long dictation', 'Its provisional text stays in history');

  setup.transcriptions[1].answer('Long dictation that goes on');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.asrLengths, [LONG_FIRST_PART_SAMPLES, MAX_UTTERANCE_SAMPLES]);
  assert.deepEqual(setup.asrInputs, [[0.1], [0.1, 0.05, 0.2]]);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Long dictation that goes on' }]);
  assert.deepEqual(setup.audioSaved.get(2), [0.1, 0.05, 0.2]);
  assert.ok(setup.events.includes('settled 2 replacing 1'));
  assert.equal(
    setup.logs.some((entry) => entry.stage === 'continuation'),
    false,
    'Exactly at the cap is not a split',
  );
  assert.equal(setup.pipeline.failures, 0);
});

test('a continuation one sample beyond the 60-second cap becomes a separate request', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1, LONG_FIRST_PART_SAMPLES));
  await settle();
  setup.transcriptions[0].answer('Long dictation');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(
    audio(0.2, LONG_SECOND_PART_SAMPLES + 1),
    undefined,
    audio(0.05, LONG_LEAD_IN_SAMPLES),
  );
  await settle();
  assert.equal(setup.detectSignals[0].aborted, false);
  assert.deepEqual(
    setup.logs.filter((entry) => entry.stage === 'continuation').map((entry) => entry.id),
    [1],
  );

  setup.detections[0].answer('SEND');
  await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
  setup.transcriptions[1].answer('More');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);

  // The lead-in belongs only to a merge; the new request is the segment alone.
  assert.deepEqual(setup.asrLengths, [LONG_FIRST_PART_SAMPLES, LONG_SECOND_PART_SAMPLES + 1]);
  assert.deepEqual(setup.asrInputs, [[0.1], [0.2]]);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Long dictation', 'More'],
  );
  assert.deepEqual(setup.audioSaved.get(1), [0.1]);
  assert.deepEqual(setup.audioSaved.get(2), [0.2]);
  assert.equal(setup.pipeline.failures, 0);
});

test('typed input is a boundary and never waits for speech holds or quiet windows', async () => {
  const setup = harness({ prefixes: ['insert'] });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  // Typed text is admitted after the provisional attempt. Speech after it
  // cannot reach back past the typed request.
  setup.pipeline.submitText('insert typed words');
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  setup.detections[0].answer('SEND');
  await settle();
  assert.notEqual(setup.outcomes.get(1), 'superseded');

  // The typed prefix dispatches at the same instant as the attempt before it.
  await advanceTo(setup, spoke + 800);
  assert.equal(setup.dispatched[1]?.utterance, 'typed words', 'Typed prefix is immediate');
  assert.equal(setup.clock.now(), spoke + 800);

  setup.transcriptions[1].answer('Something else');
  await settle();
  setup.detections[1].answer('SEND');
  await finish(setup);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Open the browser', 'typed words', 'Something else'],
  );
});

test('a spoken prefix waits for the speech floor, so a paused command merges', async () => {
  const setup = harness({ prefixes: ['go to session'] });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Go to session.');
  await advanceTo(setup, spoke + 700);
  assert.deepEqual(setup.dispatched, [], 'The bare prefix does not dispatch at once');

  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();
  setup.transcriptions[1].answer('Go to session three.');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'three.' }]);
  assert.equal(setup.outcomes.get(1), 'superseded');
});

test('pausing the listener cancels a held attempt instead of leaving it waiting', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  setup.pipeline.speechResumed();
  setup.detections[0].answer('SEND');

  setup.controller.abort();
  setup.pipeline.speechDiscarded();
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.get(1), 'cancelled');
  assert.equal(setup.pipeline.failures, 0);
  assert.equal(setup.clock.pendingTimers, 0);
});

// Tijs (2026-09-25): "don't forget to cancel the LLM if a shortcut arrives".
// While a provisional attempt's inference is pending, resumed speech merges and
// the whole utterance routes afresh. Whatever route wins, the old inference is
// aborted and can never dispatch; the new route acts exactly once.
for (const route of ['prefix', 'exact label', 'inference'] as const) {
  test(`a merge that routes to ${route} aborts the pending inference and dispatches once`, async () => {
    const setup = harness({
      prefixes: route === 'prefix' ? ['go to session'] : undefined,
      exactLabel: route === 'exact label' ? 'Option two' : undefined,
      // A late answer from the old request must still be unable to dispatch.
      ignoresAbort: true,
    });
    setup.pipeline.submit(audio(0.1));
    await settle();
    setup.transcriptions[0].answer(
      route === 'inference' ? 'Open the' : route === 'prefix' ? 'Go to' : 'Option',
    );
    await settle();
    assert.equal(setup.detections.length, 1, 'The first attempt is waiting for inference');

    setup.pipeline.speechResumed();
    setup.pipeline.submit(audio(0.2));
    await settle();
    assert.equal(setup.detectSignals[0].aborted, true, 'The pending inference is cancelled');
    assert.ok(setup.detectSignals[0].reason instanceof UtteranceSupersededError);

    // The old model answers anyway, after it was cancelled.
    setup.detections[0].answer('SEND');
    await advanceTo(setup, setup.clock.now() + SPEECH_QUIET_MS);
    assert.deepEqual(setup.dispatched, []);
    assert.equal(setup.outcomes.get(1), 'superseded');

    const combined =
      route === 'prefix'
        ? 'Go to session three'
        : route === 'exact label'
          ? 'Option two'
          : 'Open the browser';
    setup.transcriptions[1].answer(combined);
    await settle();
    if (route === 'inference') {
      setup.detections[1].answer('SEND');
    }
    await finish(setup);

    const expected =
      route === 'prefix'
        ? 'three'
        : route === 'exact label'
          ? 'CHOICE Option two'
          : 'Open the browser';
    // Exactly one dispatch, from the combined attempt: zero stale dispatches.
    assert.deepEqual(setup.dispatched, [{ id: 2, utterance: expected }]);
    assert.equal(
      setup.detections.length,
      route === 'inference' ? 2 : 1,
      'No inference for a shortcut',
    );
  });
}

test('the shortcut floor is never a grace period for the cancelled inference', async () => {
  const setup = harness({ prefixes: ['go to session'] });
  endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Go to');
  await settle();

  setup.pipeline.speechResumed();
  const resumedSpoke = endpoint(setup, 0.2);
  await settle();
  assert.equal(setup.detectSignals[0].aborted, true, 'Cancelled before the new attempt routes');

  setup.transcriptions[1].answer('Go to session three');

  // The combined attempt waits for its floor with no dispatch at all.
  await advanceTo(setup, resumedSpoke + 799);
  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.get(1), 'superseded');

  await advanceTo(setup, resumedSpoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'three' }]);
  assert.equal(setup.detections.length, 1, 'The shortcut needs no new inference');
  await finish(setup);
});

test('a paused listener releases an empty attempt waiting in its quiet window', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('');
  await settle();
  assert.deepEqual(setup.emptyClips, [], 'Still inside the quiet window');

  const paused = setup.clock.now();
  setup.controller.abort();
  await setup.pipeline.idle();

  assert.equal(setup.clock.now(), paused, 'Pause ends the wait at once');
  assert.equal(setup.clock.pendingTimers, 0);
  assert.deepEqual(setup.emptyClips, [[0.1]], 'Retained once, as a paused empty result was before');
  assert.equal(setup.pipeline.failures, 0);
});

test('only the combined attempt is retained when both parts transcribe empty', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  setup.transcriptions[1].answer('');
  await finish(setup);

  assert.deepEqual(setup.emptyClips, [[0.1, 0.2]], 'The superseded fragment is not retained');
  assert.deepEqual(setup.dispatched, []);
});

test('an unreadable fragment stays continuable beyond the speech floor', async () => {
  const setup = harness();
  endpoint(setup, 0.1);
  const admitted = setup.clock.now();
  await settle();
  setup.transcriptions[0].answer('');

  // Speech resumes after the 800 ms floor, within EMPTY_QUIET_MS.
  await advanceTo(setup, admitted + SPEECH_QUIET_MS + 150);
  assert.equal(
    setup.logs.some((entry) => entry.stage === 'filtered'),
    false,
  );
  setup.pipeline.speechResumed();
  endpoint(setup, 0.2);
  await settle();
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.2]);
  setup.transcriptions[1].answer('How do I get to Dublin');
  await settle();
  setup.detections[0].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'How do I get to Dublin' }]);
  assert.deepEqual(setup.emptyClips, []);
});

for (const earlierText of [true, false]) {
  test(`a failed empty-clip write ${earlierText ? 'still routes the earlier words' : 'fails the job as before'}`, async () => {
    const setup = harness();
    const logs: string[] = [];
    const router = setup.pipeline.dependencies.router;
    const pipeline = new SensorPipeline(
      setup.pipeline.dependencies,
      (stage, detail) => {
        logs.push(`${stage}: ${detail}`);
      },
      setup.controller.signal,
      {
        emptyAudioCaptured: async () => {
          throw Error('Disk full');
        },
      },
      'pipeline',
      setup.clock,
    );
    assert.equal(pipeline.dependencies.router, router);

    pipeline.submit(audio(0.1));
    await settle();
    setup.transcriptions[0].answer(earlierText ? 'Open the browser' : '');
    await settle();

    pipeline.speechResumed();
    pipeline.submit(audio(0.2));
    await settle();
    setup.transcriptions[1].answer('');
    await settle();

    if (earlierText) {
      setup.detections.at(-1)!.answer('SEND');
    }
    await finish({ ...setup, pipeline });

    assert.ok(logs.includes('error: recording: Disk full'));
    assert.equal(pipeline.failures, 1);
    assert.deepEqual(
      setup.dispatched.map((entry) => entry.utterance),
      earlierText ? ['Open the browser'] : [],
    );
  });
}

// ---------------------------------------------------------------------------
// Groq request profile: the classifier request waits for the speech floor
// ---------------------------------------------------------------------------
//
// Tijs (2026-10-15): with `llm.requestProfile: "groq"`, a spoken utterance's
// classifier request (bare-name or inferred cleanup) starts only once 800 ms
// have passed since the latest speech AND the transcript is ready. It is not
// 800 ms after ASR. ASR still starts at the 224 ms provisional endpoint, the
// commitment floor is unchanged, and other profiles, typed input and shortcuts
// do not wait.

test('speechQuiet resolves at the inference floor without committing the attempt', async () => {
  const clock = new ManualClock();
  const attempt = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  let quiet = false;
  const waiting = attempt.speechQuiet(signal()).then(() => {
    quiet = true;
  });

  clock.advance(SPEECH_QUIET_MS - ENDPOINT_MS - 1);
  await settle();
  assert.equal(quiet, false, 'Not quiet 799 ms after speech');

  clock.advance(1);
  await waiting;
  assert.equal(quiet, true, 'Quiet 800 ms after speech');
  assert.equal(attempt.committed, false, 'Waiting for quiet commits nothing');
  assert.equal(clock.pendingTimers, 0);

  // The attempt is still continuable: speech can hold and replace it.
  assert.equal(attempt.hold(), true);
  assert.equal(attempt.supersede(), true);
});

test('speechQuiet follows holds, rejected bursts, supersession and cancellation', async () => {
  const clock = new ManualClock();

  // A hold blocks past the deadline; a rejected burst restarts the floor from
  // the burst's own end, exactly as for commitment.
  const burst = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const spoke = clock.now() - ENDPOINT_MS;
  let quiet = false;
  const waiting = burst.speechQuiet(signal()).then(() => {
    quiet = true;
  });
  clock.advanceTo(spoke + 799);
  assert.equal(burst.hold(), true);
  clock.advanceTo(spoke + 900);
  await settle();
  assert.equal(quiet, false, 'Held across the old deadline');
  burst.release(ENDPOINT_MS);
  clock.advanceTo(spoke + 900 - ENDPOINT_MS + 799);
  await settle();
  assert.equal(quiet, false, 'Not quiet 799 ms after the burst ended');
  clock.advanceTo(spoke + 900 - ENDPOINT_MS + 800);
  await waiting;
  assert.equal(quiet, true);
  assert.equal(burst.committed, false);

  // Supersession rejects the wait and leaves no timer.
  const replaced = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const rejected = replaced.speechQuiet(signal());
  await settle();
  assert.equal(clock.pendingTimers, 1);
  replaced.supersede();
  await assert.rejects(rejected, UtteranceSupersededError);
  assert.equal(clock.pendingTimers, 0);

  // Pause or shutdown rejects with the abort reason and leaves no timer.
  const controller = new AbortController();
  const cancelled = new ProvisionalAttempt({ clock, trailingSilenceMs: ENDPOINT_MS });
  const aborted = cancelled.speechQuiet(controller.signal);
  await settle();
  controller.abort(Error('paused'));
  await assert.rejects(aborted, /paused/);
  assert.equal(clock.pendingTimers, 0);
});

test('Groq: the request starts 800 ms after speech, not at 224 or 799 ms', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();

  // ASR starts at the provisional endpoint and is ready at once.
  assert.equal(setup.transcriptions.length, 1, 'Local ASR still starts at 224 ms');
  setup.transcriptions[0].answer('Open the browser');
  await settle();
  assert.equal(setup.requests.length, 0, 'No Groq request at the 224 ms endpoint');

  await advanceTo(setup, spoke + 799);
  assert.equal(setup.requests.length, 0, 'No Groq request 799 ms after speech');

  await advanceTo(setup, spoke + 800);
  assert.deepEqual(setup.requests, [{ startedAt: spoke + 800, utterance: 'Open the browser' }]);
  assert.equal(setup.clock.pendingTimers, 0, 'The quiet timer has ended');

  // The commitment floor has already passed: a 300 ms answer dispatches at once.
  await advanceTo(setup, spoke + 1100);
  setup.detections[0].answer('SEND');
  await settle();
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  assert.equal(setup.clock.now(), spoke + 1100);
  await finish(setup);
});

test('Groq: a transcript ready after the floor starts the request at once, without another 800 ms', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();

  await advanceTo(setup, spoke + 1000);
  assert.equal(setup.requests.length, 0, 'Inference needs the transcript');
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  assert.deepEqual(setup.requests, [{ startedAt: spoke + 1000, utterance: 'Open the browser' }]);
  assert.equal(setup.clock.pendingTimers, 0, 'No timer: the floor had passed');
  setup.detections[0].answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
});

test('Groq: other profiles still start inference at the provisional endpoint', async () => {
  const setup = harness();
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  assert.deepEqual(setup.requests, [
    { startedAt: spoke + ENDPOINT_MS, utterance: 'Open the browser' },
  ]);
  assert.ok(!setup.logs.some((entry) => entry.stage === 'quiet'));
  setup.detections[0].answer('SEND');
  await advanceTo(setup, spoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  await finish(setup);
});

test('Groq: speech resumed before the floor sends nothing for the replaced attempt', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();

  await advanceTo(setup, spoke + 700);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 1500);
  assert.equal(setup.requests.length, 0, 'A hold keeps the request unsent past the floor');

  const resumedSpoke = endpoint(setup, 0.2);
  await settle();
  assert.equal(setup.outcomes.get(1), 'superseded');
  setup.transcriptions[1].answer('Open the browser');
  await settle();

  // The continuation measures 800 ms from its own, latest speech end.
  await advanceTo(setup, resumedSpoke + 799);
  assert.equal(setup.requests.length, 0);
  await advanceTo(setup, resumedSpoke + 800);
  assert.deepEqual(setup.requests, [
    { startedAt: resumedSpoke + 800, utterance: 'Open the browser' },
  ]);
  setup.detections[0].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
  assert.equal(setup.requests.length, 1, 'The superseded attempt never sent a request');
});

test('Groq: a VAD onset in the same tick as the quiet deadline keeps the request unsent', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();

  // The quiet timer fires, and the listener reports speech before the waiting
  // request resumes: the wait re-examines the hold first.
  setup.clock.advanceTo(spoke + 800);
  setup.pipeline.speechResumed();
  await settle();
  assert.equal(setup.requests.length, 0);

  const resumedSpoke = endpoint(setup, 0.2);
  await settle();
  setup.transcriptions[1].answer('Open the browser');
  await advanceTo(setup, resumedSpoke + 800);
  setup.detections[0].answer('SEND');
  await finish(setup);

  assert.deepEqual(
    setup.requests.map((request) => request.utterance),
    ['Open the browser'],
  );
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
  assert.equal(setup.outcomes.get(1), 'superseded');
});

for (const cleanup of [false, true]) {
  test(`Groq: an onset queued just behind the quiet deadline keeps the request unsent (cleanup ${cleanup ? 'on' : 'off'})`, async () => {
    const setup = harness({ groq: true, cleanup });
    const spoke = endpoint(setup, 0.1);
    await settle();
    setup.transcriptions[0].answer('Open the');
    await settle();

    // The quiet timer resolves the wait; the onset arrives in the microtask
    // right behind it, before the router has resumed. The router re-checks
    // the attempt synchronously and does not start the request.
    setup.clock.advanceTo(spoke + 800);
    queueMicrotask(() => {
      setup.pipeline.speechResumed();
    });
    await settle();
    assert.equal(setup.requests.length, 0, 'No request after the onset');

    const resumedSpoke = endpoint(setup, 0.2);
    await settle();
    setup.transcriptions[1].answer('Open the browser');
    await advanceTo(setup, resumedSpoke + 800);
    setup.detections[0].answer(setup.send);
    await finish(setup);

    assert.deepEqual(
      setup.requests.map((request) => request.utterance),
      ['Open the browser'],
    );
    assert.equal(setup.dispatched.length, 1);
    assert.equal(setup.dispatched[0].id, 2);
    assert.equal(setup.outcomes.get(1), 'superseded');
  });
}

test('Groq: a burst rejected just behind the quiet deadline delays the request to its new floor', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  // A zero-silence rejected tail in the microtask after the deadline: the
  // floor now counts from +800, so the request starts at +1600.
  setup.clock.advanceTo(spoke + 800);
  queueMicrotask(() => {
    setup.pipeline.speechResumed();
    setup.pipeline.speechDiscarded(0);
  });
  await settle();
  assert.equal(setup.requests.length, 0, 'Not sent against the old deadline');

  await advanceTo(setup, spoke + 1599);
  assert.equal(setup.requests.length, 0);
  await advanceTo(setup, spoke + 1600);
  assert.deepEqual(setup.requests, [{ startedAt: spoke + 1600, utterance: 'Open the browser' }]);

  setup.detections[0].answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
});

test('Groq: a rejected burst near the boundary restarts the quiet period from the burst', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  // A cough at +790 is rejected at +1000, having ended at +776.
  await advanceTo(setup, spoke + 790);
  setup.pipeline.speechResumed();
  await advanceTo(setup, spoke + 1000);
  setup.pipeline.speechDiscarded(ENDPOINT_MS);
  await advanceTo(setup, spoke + 1575);
  assert.equal(setup.requests.length, 0, '799 ms after the burst ended');
  await advanceTo(setup, spoke + 1576);
  assert.deepEqual(setup.requests, [{ startedAt: spoke + 1576, utterance: 'Open the browser' }]);

  setup.detections[0].answer('SEND');
  await finish(setup);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  assert.equal(setup.transcriptions.length, 1, 'The burst repeated no work');
});

test('Groq: speech resumed after the request was sent cancels it and never dispatches it', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the');
  await advanceTo(setup, spoke + 800);
  assert.equal(setup.requests.length, 1, 'Sent at the floor');

  // Speech resumes 1000 ms after the first part, while Groq is answering.
  await advanceTo(setup, spoke + 1000);
  setup.pipeline.speechResumed();
  const resumedSpoke = endpoint(setup, 0.2);
  await settle();
  assert.equal(setup.requests[0].ended, 'aborted', 'Already sent, then cancelled');
  assert.equal(setup.detectSignals[0].aborted, true);

  // A late answer from a client that ignored the abort changes nothing.
  setup.detections[0].answer('SEND');
  setup.transcriptions[1].answer('Open the browser');
  await advanceTo(setup, resumedSpoke + 800);
  setup.detections[1].answer('SEND');
  await finish(setup);

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
});

test('Groq: inferred cleanup waits for quiet; fixed-route cleanup runs once after commitment', async () => {
  // Inferred cleanup: the json-cleanup call is the Groq request that waits.
  const inferred = harness({ groq: true, cleanup: true });
  const spoke = endpoint(inferred, 0.1);
  await settle();
  inferred.transcriptions[0].answer('Open the browser');
  await advanceTo(inferred, spoke + 799);
  assert.equal(inferred.requests.length, 0);
  await advanceTo(inferred, spoke + 800);
  assert.equal(inferred.requests.length, 1);
  inferred.detections[0].answer('SEND_TEXT_TO_APPLICATION');
  await finish(inferred);
  assert.deepEqual(inferred.dispatched, [{ id: 1, utterance: 'Open the browser (cleaned)' }]);
  assert.deepEqual(inferred.cleanerCalls, [], 'Inference does not call the separate cleaner');

  // A prefix shortcut: no inference; its cleanup call already starts after
  // the 800 ms commitment, so it gets no second wait.
  const shortcut = harness({ groq: true, cleanup: true, prefixes: ['insert'] });
  const shortcutSpoke = endpoint(shortcut, 0.1);
  await settle();
  shortcut.transcriptions[0].answer('Insert hello there');
  await advanceTo(shortcut, shortcutSpoke + 799);
  assert.deepEqual(shortcut.cleanerCalls, []);
  await advanceTo(shortcut, shortcutSpoke + 800);
  assert.deepEqual(shortcut.cleanerCalls, ['hello there']);
  assert.deepEqual(shortcut.dispatched, [{ id: 1, utterance: 'hello there (cleaned)' }]);
  assert.equal(shortcut.clock.now(), shortcutSpoke + 800, 'Dispatched at the floor');
  assert.equal(shortcut.requests.length, 0);
  await finish(shortcut);
});

test('Groq: exact labels and prefixes bypass inference and dispatch at the floor', async () => {
  const setup = harness({ groq: true, prefixes: ['insert'], exactLabel: 'Option two' });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Option two');
  await advanceTo(setup, spoke + 800);
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'CHOICE Option two' }]);

  const prefixSpoke = endpoint(setup, 0.2);
  await settle();
  setup.transcriptions[1].answer('Insert words');
  await advanceTo(setup, prefixSpoke + 800);
  assert.deepEqual(setup.dispatched[1], { id: 2, utterance: 'words' });
  assert.equal(setup.requests.length, 0);
  await finish(setup);
});

test('Groq: typed input starts its request at once, also when queued behind speech', async () => {
  const setup = harness({ groq: true });
  setup.pipeline.submitText('Typed request');
  await settle();
  assert.deepEqual(setup.requests, [{ startedAt: 0, utterance: 'Typed request' }]);
  setup.detections[0].answer('SEND');
  await settle();
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Typed request' }]);

  // Behind a waiting speech attempt, typed text keeps its FIFO place and
  // starts as soon as the attempt ahead of it has dispatched.
  const spoke = endpoint(setup, 0.1);
  setup.pipeline.submitText('Typed after speech');
  await settle();
  setup.transcriptions[0].answer('Spoken request');
  await advanceTo(setup, spoke + 800);
  assert.equal(setup.requests.length, 2);
  await advanceTo(setup, spoke + 1000);
  setup.detections[1].answer('SEND');
  await settle();
  assert.deepEqual(setup.requests.at(-1), {
    startedAt: spoke + 1000,
    utterance: 'Typed after speech',
  });
  setup.detections[2].answer('SEND');
  await finish(setup);

  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Typed request', 'Spoken request', 'Typed after speech'],
  );
});

test('Groq: pause or shutdown during the quiet wait sends nothing and leaves no timer', async () => {
  const setup = harness({ groq: true });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await advanceTo(setup, spoke + 500);
  assert.equal(setup.clock.pendingTimers, 1, 'Waiting for quiet');

  setup.controller.abort();
  await settle();
  await setup.pipeline.idle();

  assert.equal(setup.requests.length, 0);
  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.get(1), 'cancelled');
  assert.equal(setup.pipeline.failures, 0);
  assert.equal(setup.clock.pendingTimers, 0);

  // Nothing resurfaces later.
  setup.clock.advance(10_000);
  await settle();
  assert.equal(setup.requests.length, 0);
});

test('Groq: an empty transcript sends nothing and keeps its 1200 ms window', async () => {
  const setup = harness({ groq: true });
  endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('');
  await advanceTo(setup, EMPTY_QUIET_MS - 1);
  assert.equal(setup.emptyClips.length, 0);
  await advanceTo(setup, EMPTY_QUIET_MS);
  assert.equal(setup.emptyClips.length, 1);
  await finish(setup);
  assert.equal(setup.requests.length, 0);
});

test('Groq: a failed request after the wait is an ordinary error, with nothing dispatched', async () => {
  const setup = harness({
    groq: true,
    intent: () => {
      throw Error('HTTP 503');
    },
  });
  const spoke = endpoint(setup, 0.1);
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await advanceTo(setup, spoke + 800);
  await finish(setup);

  assert.equal(setup.requests.length, 1);
  assert.equal(setup.outcomes.get(1), 'error');
  assert.equal(setup.pipeline.failures, 1);
  assert.deepEqual(setup.dispatched, []);
});

/**
 * Move the controlled clock to `time` 1 ms at a time, letting woken work run
 * after each step, so that every request and dispatch happens at its exact time.
 */
async function stepTo(setup: Harness, time: number): Promise<void> {
  while (setup.clock.now() < time) {
    await advanceTo(setup, setup.clock.now() + 1);
  }
}

/**
 * Speak one utterance in parts, as the listener reports it on the controlled
 * clock. Each part is `speechMs` of speech; `pausesMs[i]` is the VAD-measured
 * silence between part i and part i + 1 (at least the 224 ms endpoint, so each
 * part is a provisional attempt). Returns when the last part ended.
 */
async function speakWithPauses(
  setup: Harness,
  pausesMs: readonly number[],
  speechMs: number,
): Promise<number> {
  let speechEnd = setup.clock.now();

  for (let part = 0; part <= pausesMs.length; part++) {
    await stepTo(setup, speechEnd + ENDPOINT_MS);
    endpoint(setup, (part + 1) / 10);
    await settle();

    if (part === pausesMs.length) {
      break;
    }

    // The next part begins after the pause, and ends speechMs later.
    await stepTo(setup, speechEnd + pausesMs[part]);
    setup.pipeline.speechResumed();
    speechEnd = speechEnd + pausesMs[part] + speechMs;
  }

  return speechEnd;
}

/** Synthetic ASR: one word per part, e.g. "w1 w2 w3" for three combined parts. */
function partWords(samples: Float32Array): string {
  return markers(samples)
    .map((marker) => `w${Math.round(marker * 10)}`)
    .join(' ');
}

// Request counts and latency on the controlled clock, ASR answering at once.
// "Discarded" requests were answered but superseded; "cancelled" ones were
// aborted while still running. Latency is final speech end → dispatch.
const pauseFixtures = [
  {
    name: 'three pauses under 800 ms',
    pausesMs: [300, 500, 700],
    expected: {
      300: {
        before: { requests: 4, discarded: 3, cancelled: 0, latencyMs: 800 },
        groq: { requests: 1, discarded: 0, cancelled: 0, latencyMs: 1100 },
      },
      700: {
        before: { requests: 4, discarded: 2, cancelled: 1, latencyMs: 924 },
        groq: { requests: 1, discarded: 0, cancelled: 0, latencyMs: 1500 },
      },
    },
  },
] as const;

for (const fixture of pauseFixtures) {
  for (const inferenceMs of [300, 700] as const) {
    test(`Groq: ${fixture.name}, ${inferenceMs} ms inference: fewer requests, same final action`, async () => {
      const results: Record<string, unknown> = {};

      for (const groq of [false, true]) {
        const setup = harness({ groq, inferenceMs, transcript: partWords });
        const finalSpeechEnd = await speakWithPauses(setup, fixture.pausesMs, 300);

        await stepTo(setup, finalSpeechEnd + 2000);
        await finish(setup);

        // One action with the whole utterance, from the final attempt only.
        assert.equal(setup.dispatched.length, 1);
        assert.equal(setup.dispatched[0].utterance, 'w1 w2 w3 w4');
        assert.equal(setup.dispatched[0].id, 4);

        results[groq ? 'groq' : 'before'] = {
          requests: setup.requests.length,
          discarded: setup.requests.filter(
            (request, index) => request.ended === 'answered' && index < setup.requests.length - 1,
          ).length,
          cancelled: setup.requests.filter((request) => request.ended === 'aborted').length,
          latencyMs: setup.dispatchedAt[0] - finalSpeechEnd,
        };
      }

      assert.deepEqual(results, fixture.expected[inferenceMs]);
    });
  }
}

test('Groq: a pause over 800 ms is sent first, then replaced by the continuation', async () => {
  // The cost of waiting: the join window becomes 800 ms plus inference time.
  // Before, a 300 ms answer had committed "w1" at 800 ms, so speech 1000 ms
  // after the first part was a second request. With Groq the first request
  // is sent at 800 ms and still running at 1000 ms, so the resumed speech
  // holds it. Its answer at 1100 ms cannot commit; the continuation replaces
  // it (already sent and answered, then discarded) and the whole utterance is
  // one request.
  const before = harness({ inferenceMs: 300, transcript: partWords });
  const beforeEnd = await speakWithPauses(before, [1000], 300);
  await stepTo(before, beforeEnd + 2000);
  await finish(before);
  assert.deepEqual(
    before.dispatched.map((entry) => entry.utterance),
    ['w1', 'w2'],
  );
  assert.deepEqual(
    before.requests.map((request) => request.ended),
    ['answered', 'answered'],
  );

  const groq = harness({ groq: true, inferenceMs: 300, transcript: partWords });
  const groqEnd = await speakWithPauses(groq, [1000], 300);
  await stepTo(groq, groqEnd + 2000);
  await finish(groq);
  assert.deepEqual(
    groq.dispatched.map((entry) => entry.utterance),
    ['w1 w2'],
  );
  assert.deepEqual(
    groq.requests.map((request) => [request.startedAt, request.ended]),
    [
      [800, 'answered'],
      [1300 + 800, 'answered'],
    ],
  );
});
