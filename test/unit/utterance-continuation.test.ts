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
  SHORTCUT_QUIET_MS,
  UtteranceSupersededError,
} from '../../src/core/utterance-continuation.ts';
import { ENDPOINT_MS } from '../../src/sensors/audio/segmenter.ts';
import type { TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import { deferred, processor, screenshot, testDetector, testSensors } from '../helpers.ts';

// These tests drive the pipeline's continuation interface directly, in the
// order the listener calls it: submit (provisional endpoint), speechResumed
// (a new VAD candidate), then submit (accepted) or speechDiscarded (rejected).
// Transcription and inference are controlled promises, so every race is
// reproduced deterministically without audio devices or models.

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
  } = {},
) {
  const controller = new AbortController();
  const events: string[] = [];
  const outcomes = new Map<number, UtteranceOutcome>();
  const transcribed = new Map<number, string>();
  const audioSaved = new Map<number, number[]>();
  const emptyClips: number[][] = [];
  const dispatched: { id: number; utterance: string }[] = [];
  const asrSignals: AbortSignal[] = [];
  const asrInputs: number[][] = [];
  const detectSignals: AbortSignal[] = [];
  const logs: { stage: string; detail: string; id?: number }[] = [];

  const transcriptions: {
    samples: number[];
    answer: (text: string, diagnostic?: TranscriptionDiagnostic) => void;
  }[] = [];
  const detections: { utterance: string; answer: (intent: string) => void }[] = [];
  let dispatchGate: Promise<void> | undefined;

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (frame, _intents, signal) => {
          detectSignals.push(signal);
          const known = options.intent?.(frame);
          if (known) {
            return known;
          }

          const reply = deferred<string>();
          detections.push({ utterance: frame.utterance, answer: reply.resolve });
          if (options.ignoresAbort) {
            return reply.promise;
          }
          const aborted = new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return Promise.race([reply.promise, aborted]);
        },
      }),
    },
    () => {},
  );

  processor('IGNORE').subscribe(router);
  const send = processor('SEND', async (frame) => {
    events.push(`dispatch ${frame.id}`);
    dispatched.push({ id: frame.id, utterance: frame.utterance });
    await dispatchGate;
  });
  if (options.prefixes) {
    Object.assign(send, { prefixes: options.prefixes, acceptsEmptyPrefix: true });
  }
  send.subscribe(router);

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
      finished: (id) => {
        events.push(`finished ${id}`);
      },
    },
  );

  return {
    pipeline,
    controller,
    events,
    outcomes,
    transcribed,
    audioSaved,
    emptyClips,
    dispatched,
    asrSignals,
    asrInputs,
    detectSignals,
    transcriptions,
    detections,
    logs,
    holdDispatch(gate: Promise<void>) {
      dispatchGate = gate;
    },
  };
}

test('the provisional endpoint is the smallest whole-frame silence of at least 200 ms', () => {
  assert.equal(ENDPOINT_MS, 224);
  assert.equal(SHORTCUT_QUIET_MS, 800 - 224);
  assert.equal(MAX_UTTERANCE_SAMPLES, 16000 * 30);
  assert.ok(EMPTY_QUIET_MS > SHORTCUT_QUIET_MS);
});

test('an attempt commits at once for inference and is final afterwards', async () => {
  const attempt = new ProvisionalAttempt();
  await attempt.commit('inference', new AbortController().signal);

  assert.equal(attempt.committed, true);
  assert.equal(attempt.hold(), false, 'Speech after commitment is a new request');
  assert.equal(attempt.supersede(), false);
  assert.equal(attempt.signal.aborted, false);
});

test('a hold delays commitment until released, and supersession rejects it', async () => {
  const released = new ProvisionalAttempt();
  assert.equal(released.hold(), true);
  let committed = false;
  const waiting = released.commit('inference', new AbortController().signal).then(() => {
    committed = true;
  });

  await settle();
  assert.equal(committed, false);
  released.release();
  await waiting;
  assert.equal(committed, true);

  const replaced = new ProvisionalAttempt();
  replaced.hold();
  const rejected = replaced.commit('inference', new AbortController().signal);
  await settle();
  assert.equal(replaced.supersede(), true);
  await assert.rejects(rejected, UtteranceSupersededError);
  assert.equal(replaced.committed, false);
  assert.equal(replaced.hold(), false);
});

test('shortcut commitment waits for the quiet window, restarted by a released hold', async () => {
  const attempt = new ProvisionalAttempt(60);
  const started = performance.now();

  await attempt.commit('shortcut', new AbortController().signal);
  assert.ok(performance.now() - started >= 55, 'Waits for the quiet window');

  const restarted = new ProvisionalAttempt(60);
  await new Promise((resolve) => setTimeout(resolve, 40));
  restarted.hold();
  const commit = restarted.commit('shortcut', new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const releasedAt = performance.now();
  restarted.release();
  await commit;
  assert.ok(performance.now() - releasedAt >= 55, 'The rejected burst restarts the window');
});

test('cancellation rejects a commitment waiting on a hold without leaving timers', async () => {
  const attempt = new ProvisionalAttempt();
  const controller = new AbortController();
  attempt.hold();
  const commit = attempt.commit('shortcut', controller.signal);

  controller.abort(Error('Paused'));
  await assert.rejects(commit, /Paused/);
  assert.equal(attempt.committed, false);
});

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
  await setup.pipeline.idle();

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
  await settle();
  assert.deepEqual(setup.transcriptions[2].samples, [0.3]);
  setup.transcriptions[2].answer('Next');
  await settle();
  setup.detections[2].answer('SEND');
  await setup.pipeline.idle();
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
  await setup.pipeline.idle();
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
});

test('a rejected burst releases the held attempt without repeating any work', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  setup.pipeline.speechResumed();
  setup.detections[0].answer('SEND');
  await settle();
  assert.deepEqual(setup.dispatched, [], 'Inference completed, but the hold prevents dispatch');

  setup.pipeline.speechDiscarded();
  await setup.pipeline.idle();
  assert.deepEqual(setup.dispatched, [{ id: 1, utterance: 'Open the browser' }]);
  assert.equal(setup.transcriptions.length, 1);
  assert.equal(setup.detections.length, 1);
});

test('speech detected in the same tick as inference completion still holds dispatch', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the');
  await settle();

  // The router's continuation has not run yet when the listener reports speech.
  setup.detections[0].answer('SEND');
  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();

  assert.deepEqual(setup.dispatched, [], 'No stale dispatch');
  assert.equal(setup.outcomes.get(1), 'superseded');
  setup.transcriptions[1].answer('Open the browser');
  await settle();
  setup.detections[1].answer('SEND');
  await setup.pipeline.idle();
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
  await settle();
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
  await setup.pipeline.idle();
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
  await settle();
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
  }
  await setup.pipeline.idle();

  assert.deepEqual(setup.asrInputs, [[0.1], [0.2], [0.3, 0.4]], 'Job 3 never reached ASR');
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.id),
    [1, 2, 4],
  );
  assert.ok(setup.logs.some((entry) => entry.stage === 'dropped' && entry.id === 5));
});

test('repeated pauses keep merging the whole utterance until it commits', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('One');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  setup.transcriptions[1].answer('One two');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.3));
  await settle();
  assert.deepEqual(setup.transcriptions[2].samples, [0.1, 0.2, 0.3]);
  setup.transcriptions[2].answer('One two three');
  await settle();
  setup.detections.at(-1)!.answer('SEND');
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, [{ id: 3, utterance: 'One two three' }]);
  assert.deepEqual([setup.outcomes.get(1), setup.outcomes.get(2)], ['superseded', 'superseded']);
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
  await setup.pipeline.idle();
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'Open the browser' }]);
  assert.ok(setup.logs.some((entry) => entry.stage === 'fallback' && entry.id === 2));
});

test('an empty first attempt has no fallback and is still filtered', async () => {
  const setup = harness({ transcript: () => '' });
  setup.pipeline.submit(audio(0.1));
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, []);
  assert.deepEqual(setup.emptyClips, [[0.1]]);
  assert.ok(setup.logs.some((entry) => entry.stage === 'filtered'));
});

test('an unreadable fragment stays continuable and is retranscribed with its continuation', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();

  // The decoder cannot read the first fragment alone. Nothing is filtered or
  // retained yet: speech may still resume within the legacy quiet window.
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
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'How do I get to Dublin' }]);
  assert.deepEqual(setup.emptyClips, [], 'A superseded fragment is not retained as empty');
});

test('a continuation beyond the 30-second cap becomes a separate request', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1, MAX_UTTERANCE_SAMPLES - 1000));
  await settle();
  setup.transcriptions[0].answer('Long dictation');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2, 2000));
  await settle();
  assert.equal(setup.detectSignals[0].aborted, false);

  setup.detections[0].answer('SEND');
  await settle();
  setup.transcriptions[1].answer('More');
  await settle();
  setup.detections[1].answer('SEND');
  await setup.pipeline.idle();

  assert.deepEqual(setup.asrInputs, [[0.1], [0.2]]);
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Long dictation', 'More'],
  );
});

test('typed input is a boundary and never waits for speech holds or quiet windows', async () => {
  const setup = harness({ prefixes: ['insert'] });
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  // Typed text is admitted after the provisional attempt. Speech after it
  // cannot reach back past the typed request.
  setup.pipeline.submitText('insert typed words');
  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  setup.detections[0].answer('SEND');
  await settle();
  assert.notEqual(setup.outcomes.get(1), 'superseded');

  const typedStarted = performance.now();
  await settle();
  assert.equal(setup.dispatched[1]?.utterance, 'typed words');
  assert.ok(performance.now() - typedStarted < SHORTCUT_QUIET_MS / 2, 'Typed prefix is immediate');

  setup.transcriptions[1].answer('Something else');
  await settle();
  setup.detections[1].answer('SEND');
  await setup.pipeline.idle();
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.utterance),
    ['Open the browser', 'typed words', 'Something else'],
  );
});

test('a spoken prefix waits for the legacy quiet window, so a paused command merges', async () => {
  const setup = harness({ prefixes: ['go to session'] });
  setup.pipeline.submit(audio(0.1));
  await settle();
  const answered = performance.now();
  setup.transcriptions[0].answer('Go to session.');
  await settle();
  assert.deepEqual(setup.dispatched, [], 'The bare prefix does not dispatch at once');

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  setup.transcriptions[1].answer('Go to session three.');
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'three.' }]);
  assert.equal(setup.outcomes.get(1), 'superseded');
  assert.ok(performance.now() - answered >= SHORTCUT_QUIET_MS - 20);
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
    await settle();
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
    await setup.pipeline.idle();

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

test('the shortcut quiet window is never a grace period for the cancelled inference', async () => {
  const setup = harness({ prefixes: ['go to session'] });
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Go to');
  await settle();

  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  assert.equal(setup.detectSignals[0].aborted, true, 'Cancelled before the new attempt routes');

  const routed = performance.now();
  setup.transcriptions[1].answer('Go to session three');
  await settle();

  // The combined attempt waits in its 576 ms window with no dispatch at all.
  assert.deepEqual(setup.dispatched, []);
  assert.equal(setup.outcomes.get(1), 'superseded');

  await setup.pipeline.idle();
  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'three' }]);
  assert.ok(performance.now() - routed >= SHORTCUT_QUIET_MS - 50);
  assert.equal(setup.detections.length, 1, 'The shortcut needs no new inference');
});

test('when commitment wins the race, the resumed speech is a new request', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('Open the browser');
  await settle();

  // Inference completes and the router commits before the listener reports speech.
  setup.detections[0].answer('SEND');
  await settle();
  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();

  assert.equal(setup.logs.filter((entry) => entry.stage === 'hold').length, 0);
  assert.deepEqual(setup.transcriptions[1].samples, [0.2], 'Never merged after commitment');
  setup.transcriptions[1].answer('and close it');
  await settle();
  setup.detections[1].answer('SEND');
  await setup.pipeline.idle();
  assert.deepEqual(
    setup.dispatched.map((entry) => entry.id),
    [1, 2],
  );
});

test('a paused listener releases an empty attempt waiting in its quiet window', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('');
  await settle();
  assert.deepEqual(setup.emptyClips, [], 'Still inside the quiet window');

  const paused = performance.now();
  setup.controller.abort();
  await setup.pipeline.idle();

  assert.ok(performance.now() - paused < SHORTCUT_QUIET_MS / 2, 'Pause ends the wait at once');
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
  await setup.pipeline.idle();

  assert.deepEqual(setup.emptyClips, [[0.1, 0.2]], 'The superseded fragment is not retained');
  assert.deepEqual(setup.dispatched, []);
});

test('an unreadable fragment stays continuable beyond the shortcut window', async () => {
  const setup = harness();
  setup.pipeline.submit(audio(0.1));
  await settle();
  setup.transcriptions[0].answer('');

  // Speech resumes after the 576 ms shortcut window, within EMPTY_QUIET_MS.
  await new Promise((resolve) => setTimeout(resolve, SHORTCUT_QUIET_MS + 150));
  assert.equal(
    setup.logs.some((entry) => entry.stage === 'filtered'),
    false,
  );
  setup.pipeline.speechResumed();
  setup.pipeline.submit(audio(0.2));
  await settle();
  assert.deepEqual(setup.transcriptions[1].samples, [0.1, 0.2]);
  setup.transcriptions[1].answer('How do I get to Dublin');
  await settle();
  setup.detections[0].answer('SEND');
  await setup.pipeline.idle();

  assert.deepEqual(setup.dispatched, [{ id: 2, utterance: 'How do I get to Dublin' }]);
  assert.deepEqual(setup.emptyClips, []);
});
