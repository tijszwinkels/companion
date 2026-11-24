import assert from 'node:assert/strict';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ManualClock, processor, screenshot, testDetector, testSensors } from '../helpers.ts';

/**
 * Continuation per microphone (src/sensors/audio/README.md, "Rules:
 * continuation per microphone"), as one table derived from those rules.
 *
 * Two microphones, A and B, feed one pipeline. Each script calls the
 * pipeline in the order the two listeners would (submit, speechResumed,
 * speechDiscarded, each naming its microphone), plus typed text, on a
 * controlled clock. Inference answers at once, so every spoken decision
 * commits at its floor: 800 ms after the speech ended, which is 576 ms after
 * a segment closed by the 224 ms endpoint. Each row states the rule it
 * checks and the dispatches it expects, with their times (10 ms resolution).
 *
 * Audio carries a marker per microphone and segment; the test recogniser
 * turns markers into words (0.1 → a1, 0.2 → a2, …, 0.5 → b1, 0.6 → b2, …),
 * so a merge reads as "a1 a2". The single-microphone cases are the
 * reference test (pipeline-one-microphone-reference.test.ts).
 */

type Microphone = 'A' | 'B';

type Step =
  | { submit: Microphone; marker: number }
  | { resumed: Microphone }
  | { discarded: Microphone; burstTrailingSilenceMs?: number }
  | { text: string }
  | { at: number };

interface Row {
  rule: string;
  steps: Step[];
  /** Expected dispatches, `@<ms> <utterance>`, in order. */
  dispatched: string[];
}

const resolutionMs = 10;

const words: Record<number, string> = {
  1: 'a1',
  2: 'a2',
  3: 'a3',
  5: 'b1',
  6: 'b2',
  7: 'b3',
  8: 'b4',
};

function audio(marker: number): Float32Array {
  return new Float32Array(1600).fill(marker);
}

function transcriptFor(samples: Float32Array): string {
  const found: string[] = [];
  for (const sample of samples) {
    const marker = Math.round(sample * 10);
    const word = words[marker];
    if (word && found.at(-1) !== word) {
      found.push(word);
    }
  }
  return found.join(' ');
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const table: Row[] = [
  {
    rule: 'speech resuming on A while B is silent continues A',
    steps: [
      { submit: 'A', marker: 0.1 },
      { at: 300 },
      { resumed: 'A' },
      { at: 400 },
      { submit: 'A', marker: 0.2 },
    ],
    dispatched: ['@980 a1 a2'],
  },
  {
    rule: 'speech resuming on A while B is speaking continues A; B becomes its own request',
    steps: [
      { submit: 'A', marker: 0.1 },
      { at: 100 },
      { resumed: 'B' },
      { at: 300 },
      { resumed: 'A' },
      { at: 400 },
      { submit: 'A', marker: 0.2 },
      { at: 500 },
      { submit: 'B', marker: 0.5 },
    ],
    dispatched: ['@980 a1 a2', '@1080 b1'],
  },
  {
    rule: "speech resuming on A while B holds an attempt continues A and leaves B's hold",
    steps: [
      { submit: 'B', marker: 0.5 },
      { at: 50 },
      { submit: 'A', marker: 0.1 },
      { at: 200 },
      { resumed: 'B' },
      { at: 300 },
      { resumed: 'A' },
      { at: 400 },
      { submit: 'A', marker: 0.2 },
      // B's hold delays its attempt (and, one queue, everything behind it)
      // until B's candidate is resolved: a burst, 64 ms before 1500.
      { at: 1500 },
      { discarded: 'B', burstTrailingSilenceMs: 64 },
    ],
    dispatched: ['@2240 b1', '@2240 a1 a2'],
  },
  {
    rule: "a rejected burst on A restarts A's floor only",
    steps: [
      { submit: 'B', marker: 0.5 },
      { submit: 'A', marker: 0.1 },
      { at: 300 },
      { resumed: 'A' },
      { at: 400 },
      { discarded: 'A', burstTrailingSilenceMs: 64 },
    ],
    dispatched: ['@580 b1', '@1140 a1'],
  },
  {
    rule: 'a hold on A does not delay B; a period that ends on A keeps its deadline',
    steps: [
      { submit: 'B', marker: 0.5 },
      { submit: 'A', marker: 0.1 },
      { at: 100 },
      { resumed: 'A' },
      { at: 1000 },
      { discarded: 'A' },
    ],
    dispatched: ['@580 b1', '@1000 a1'],
  },
  {
    rule: "a period that ends on B releases only B's hold",
    steps: [
      { submit: 'A', marker: 0.1 },
      { submit: 'B', marker: 0.5 },
      { at: 100 },
      { resumed: 'A' },
      { resumed: 'B' },
      { at: 200 },
      { discarded: 'B' },
      { at: 300 },
      { submit: 'A', marker: 0.2 },
    ],
    dispatched: ['@880 a1 a2', '@880 b1'],
  },
  {
    rule: "speech from B is not a boundary for A; A's continuation runs before B's waiting utterance",
    steps: [
      { submit: 'A', marker: 0.1 },
      { at: 100 },
      { submit: 'B', marker: 0.5 },
      { at: 200 },
      { resumed: 'A' },
      { at: 300 },
      { submit: 'A', marker: 0.2 },
    ],
    dispatched: ['@880 a1 a2', '@880 b1'],
  },
  {
    rule: "speech on B never holds or joins A's attempt",
    steps: [
      { submit: 'A', marker: 0.1 },
      { at: 100 },
      { resumed: 'B' },
      { at: 700 },
      { submit: 'B', marker: 0.5 },
    ],
    dispatched: ['@580 a1', '@1280 b1'],
  },
  {
    rule: 'typed input is a boundary for every microphone and releases every hold',
    steps: [
      { submit: 'A', marker: 0.1 },
      { submit: 'B', marker: 0.5 },
      { at: 100 },
      { resumed: 'A' },
      { resumed: 'B' },
      { at: 200 },
      { text: 'typed words' },
      // Both candidates are still open, yet both attempts dispatch at their
      // own floor (576 ms): the text released the holds. The candidates then
      // close as speech: new requests, never merged.
      { at: 590 },
      { submit: 'A', marker: 0.2 },
      { submit: 'B', marker: 0.6 },
    ],
    dispatched: ['@580 a1', '@580 b1', '@580 typed words', '@1170 a2', '@1170 b2'],
  },
  {
    rule: 'a dropped utterance is a boundary for its own microphone only',
    steps: [
      { submit: 'B', marker: 0.5 },
      { submit: 'A', marker: 0.1 },
      { submit: 'B', marker: 0.6 },
      // The queue is full (one active, two waiting): B's third is dropped.
      { submit: 'B', marker: 0.7 },
      { at: 100 },
      { resumed: 'A' },
      { at: 200 },
      { submit: 'A', marker: 0.2 },
      { resumed: 'B' },
      { at: 700 },
      { submit: 'B', marker: 0.8 },
    ],
    dispatched: ['@580 b1', '@780 a1 a2', '@780 b2', '@1280 b4'],
  },
];

/** Run one row's script; return the dispatches with their times. */
async function run(steps: Step[]): Promise<{ dispatched: string[]; failures: number }> {
  const clock = new ManualClock();
  const controller = new AbortController();
  const dispatched: string[] = [];

  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'SEND' }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  processor('SEND', async (frame) => {
    dispatched.push(`@${clock.now()} ${frame.utterance}`);
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (samples) => transcriptFor(samples),
      }),
      router,
    },
    (stage, detail, id) => {
      if (process.env.DEBUG_PIPELINE) {
        console.log(clock.now(), stage, detail, id);
      }
    },
    controller.signal,
    {},
    'pipeline',
    clock,
  );

  async function advanceTo(time: number): Promise<void> {
    while (clock.now() < time) {
      clock.advance(Math.min(resolutionMs, time - clock.now()));
      await settle();
    }
  }

  for (const step of steps) {
    if ('at' in step) {
      await advanceTo(step.at);
    } else if ('submit' in step) {
      pipeline.submit(
        audio(step.marker),
        undefined,
        undefined,
        224,
        undefined,
        undefined,
        step.submit,
      );
    } else if ('resumed' in step) {
      pipeline.speechResumed(step.resumed);
    } else if ('discarded' in step) {
      pipeline.speechDiscarded(step.burstTrailingSilenceMs, step.discarded);
    } else {
      pipeline.submitText(step.text);
    }
    await settle();
  }

  // Let every remaining deadline pass, then wait for the queue to drain.
  let idle = false;
  const idled = pipeline.idle().then(() => {
    idle = true;
  });
  while (!idle && clock.now() < 10_000) {
    await advanceTo(clock.now() + resolutionMs);
  }
  await idled;
  assert.equal(clock.pendingTimers, 0, 'No commitment timer outlives its attempt');

  return { dispatched, failures: pipeline.failures };
}

for (const row of table) {
  test(`two microphones: ${row.rule}`, async () => {
    const result = await run(row.steps);
    assert.deepEqual(result.dispatched, row.dispatched);
    assert.equal(result.failures, 0);
  });
}
