import assert from 'node:assert/strict';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { deferred, processor, screenshot, signal, testDetector, testSensors } from '../helpers.ts';
import type { Transcript } from '../../src/core/activity.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import type { InteractionContext } from '../../src/core/frame.ts';

test('sidebar context is captured at speech end before delayed transcription', async () => {
  const waiting = deferred<string>();
  let current: InteractionContext = {
    agentSessionId: 'first',
    agentComposerFocused: true,
    revision: 1,
  };
  let received: InteractionContext | undefined;
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE', async (frame) => {
    received = frame.interaction;
  }).subscribe(router);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({ capture: async () => screenshot, transcribe: async () => waiting.promise }),
      router,
    },
    () => {},
    signal(),
    { interactionContext: () => ({ ...current }) },
  );
  pipeline.submit(new Float32Array(16000));
  current = { agentSessionId: 'second', agentComposerFocused: true, revision: 2 };
  waiting.resolve('Please continue');
  await pipeline.idle();
  assert.deepEqual(received, { agentSessionId: 'first', agentComposerFocused: true, revision: 1 });
});

test('capture happens at submission, processing remains FIFO, and queue is bounded', async () => {
  const waiting = deferred<string>();
  const delivered: number[] = [];
  const events: string[] = [];
  let captures = 0;
  let transcripts = 0;

  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE', async (frame) => {
    delivered.push(frame.id);
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          captures++;
          return screenshot;
        },
        transcribe: async () => (++transcripts === 1 ? waiting.promise : 'speech'),
      }),
      router,
    },
    (stage) => {
      events.push(stage);
    },
    signal(),
  );

  // Hold the first transcription open while new utterances keep arriving.
  assert.equal(pipeline.submit(new Float32Array(16000)), true);
  assert.equal(pipeline.submit(new Float32Array(16000)), true);
  assert.equal(pipeline.submit(new Float32Array(16000)), true);
  assert.equal(pipeline.submit(new Float32Array(16000)), false);
  assert.equal(captures, 3);
  assert.equal(transcripts, 1);

  // Once ASR is released, the worker must deliver accepted frames in order.
  waiting.resolve('first');
  await pipeline.idle();

  assert.deepEqual(delivered, [1, 2, 3]);
  assert.ok(events.includes('dropped'));
});

test('capture failure discards its frame and the next utterance still runs', async () => {
  let captures = 0;
  let detections = 0;

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          detections++;
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          if (++captures === 1) {
            throw Error('Focus changed');
          }
          return screenshot;
        },
        transcribe: async () => 'hello',
      }),
      router,
    },
    () => {},
    signal(),
  );

  pipeline.submit(new Float32Array(16000));
  await pipeline.idle();

  pipeline.submit(new Float32Array(16000));
  await pipeline.idle();

  assert.equal(pipeline.failures, 1);
  assert.equal(detections, 1);
});

test('shutdown during ASR discards the result and pending audio without dispatch', async () => {
  const controller = new AbortController();
  const waiting = deferred<string>();

  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Dispatched after stop') }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({ capture: async () => screenshot, transcribe: async () => waiting.promise }),
      router,
    },
    () => {},
    controller.signal,
  );

  const samples = new Float32Array(16000).fill(0.2);
  pipeline.submit(samples);
  pipeline.submit(new Float32Array(16000));

  // Simulate ASR resolving just after a requested stop: its text must be ignored.
  controller.abort();
  waiting.resolve('late transcript');
  await pipeline.idle();

  assert.ok(samples.every((sample) => sample === 0));
  assert.equal(pipeline.failures, 0);
});

test('capture failure still records the transcript and observed application before the error', async () => {
  const recorded: Transcript[] = [];
  const outcomes: string[] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({ detect: async () => assert.fail('Invalid screenshot was routed') }),
    },
    () => {},
  );
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async (_signal, observed) => {
          observed?.(screenshot.window);
          throw Error('Screenshot failed');
        },
        transcribe: async () => 'Recover this speech',
      }),
      router,
    },
    () => {},
    signal(),
    {
      transcribed: (transcript) => recorded.push(transcript),
      outcome: (_id, outcome) => outcomes.push(outcome),
    },
  );

  pipeline.submit(new Float32Array(16000));
  await pipeline.idle();
  assert.equal(recorded[0].utterance, 'Recover this speech');
  assert.deepEqual(recorded[0].application, screenshot.window);
  assert.deepEqual(outcomes, ['error']);
});

for (const source of ['manual', 'media'] as const) {
  test(`${source} pause cancels in-flight and queued delivery; resuming accepts only new speech`, async () => {
    const pause = new PauseControl();
    const waiting = deferred<string>();
    const delivered: number[] = [];
    const outcomes: string[] = [];
    let calls = 0;
    const router = new UserSensorRouter(
      { detector: testDetector({ detect: async () => 'IGNORE' }) },
      () => {},
    );
    processor('IGNORE', async (frame) => {
      delivered.push(frame.id);
    }).subscribe(router);
    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => screenshot,
          transcribe: async () => (++calls === 1 ? waiting.promise : 'New speech'),
        }),
        router,
      },
      () => {},
      signal(),
      {
        outcome: (_id, outcome) => outcomes.push(outcome),
      },
    );

    pipeline.submit(new Float32Array(16000), pause.signal);
    pipeline.submit(new Float32Array(16000), pause.signal);
    if (source === 'manual') {
      pause.toggle();
      pause.toggle();
    } else {
      pause.setMediaPlaying(true);
      pause.setMediaPlaying(false);
    }
    waiting.resolve('Stale speech');
    await pipeline.idle();
    assert.deepEqual(delivered, []);
    assert.deepEqual(outcomes, ['cancelled', 'cancelled']);
    assert.equal(calls, 1);

    pipeline.submit(new Float32Array(16000), pause.signal);
    await pipeline.idle();
    assert.deepEqual(delivered, [3]);
    assert.equal(pipeline.failures, 0);
  });
}
