import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import type { UserSensorFrame } from '../../src/core/frame.ts';
import { ManualClock, processor, screenshot, testDetector, testSensors } from '../helpers.ts';

/**
 * One microphone behaves exactly as on the base revision.
 *
 * Purpose: the pipeline now keeps its continuation state (the newest and the
 * held attempt) per microphone. With only the computer's microphone, every
 * call names that one microphone, and nothing may change. This test drives
 * the pipeline through fixed scripts in the order the listener calls it
 * (submit, speechResumed, speechDiscarded, typed text, pause) on a controlled
 * clock, and records everything observable: the pipeline's log, Activity
 * callbacks, ASR inputs, inference requests and dispatches, each with the
 * controlled time. The record is compared with the one the same scripts
 * produced on the base revision (dd0b6bf), stored in
 * test/fixtures/pipeline-one-microphone-trace.json.
 *
 * The scripts use only calls that existed on the base revision, so the same
 * file runs there unchanged. Set COMPANION_WRITE_TRACE=1 to record it again;
 * only ever do that on a revision whose behavior is the reference.
 */

const tracePath = new URL('../fixtures/pipeline-one-microphone-trace.json', import.meta.url);

/** One step of a script, in the order the listener and the user cause them. */
type Step =
  | { submit: number; samples?: number; trailingSilenceMs?: number; leadIn?: number }
  | { resumed: true }
  | { discarded: true; burstTrailingSilenceMs?: number }
  | { text: string }
  | { advance: number }
  | { pause: true };

/** Time resolution of the recorded trace, in milliseconds of the controlled clock. */
const resolutionMs = 10;

/** Recognizable audio: every sample of a segment carries the same marker value. */
function audio(marker: number, samples = 1600): Float32Array {
  return new Float32Array(samples).fill(marker);
}

/** Decode the marker sequence of a (possibly combined) buffer, e.g. [0.1, 0.2]. */
function markers(samples: Float32Array): number[] {
  const values: number[] = [];

  for (const sample of samples) {
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

/**
 * Transcripts by the markers they contain: 0.5 transcribes empty (an
 * unreadable fragment), everything else as words naming its markers.
 */
function transcriptFor(samples: Float32Array): string {
  const parts = markers(samples).filter((marker) => marker !== 0);
  if (parts.length === 1 && parts[0] === 0.5) {
    return '';
  }
  return parts.map((marker) => `words${Math.round(marker * 10)}`).join(' ');
}

/** Run one script and return everything it caused, in order, with clock times. */
async function runScript(steps: Step[]): Promise<string[]> {
  const clock = new ManualClock();
  const controller = new AbortController();
  const trace: string[] = [];
  const at = () => `@${clock.now()}`;

  // Inference answers 150 ms after it starts, on the controlled clock.
  const detect = (frame: UserSensorFrame, signal: AbortSignal) => {
    trace.push(`${at()} detect ${frame.id} ${JSON.stringify(frame.utterance)}`);
    return new Promise<string>((resolve, reject) => {
      const aborted = () => {
        cancel();
        trace.push(`${at()} detect-aborted ${frame.id}`);
        reject(signal.reason);
      };
      const cancel = clock.schedule(() => {
        signal.removeEventListener('abort', aborted);
        resolve('SEND');
      }, 150);
      signal.addEventListener('abort', aborted, { once: true });
    });
  };

  const router = new UserSensorRouter(
    {
      detector: testDetector({ detect: async (frame, _intents, signal) => detect(frame, signal) }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  processor('SEND', async (frame) => {
    trace.push(`${at()} dispatch ${frame.id} ${JSON.stringify(frame.utterance)}`);
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (samples) => {
          trace.push(`${at()} asr ${JSON.stringify(markers(samples))}`);
          return transcriptFor(samples);
        },
      }),
      router,
    },
    (stage, detail, id) => {
      // Wall-clock durations differ between runs; keep the stage and frame.
      const stable =
        stage === 'done' || stage === 'transcript' ? detail.replace(/\d+ ms/, 'N ms') : detail;
      trace.push(`${at()} log ${stage} ${id ?? '-'} ${stable}`);
    },
    controller.signal,
    {
      processing: (id) => trace.push(`${at()} processing ${id}`),
      transcribed: (transcript) =>
        trace.push(
          `${at()} transcribed ${transcript.id} ${JSON.stringify(transcript.utterance)} ${transcript.source ?? ''}`,
        ),
      audioCaptured: async (id, samples) => {
        trace.push(`${at()} audio ${id} ${JSON.stringify(markers(samples))}`);
      },
      emptyAudioCaptured: async (clip) => {
        trace.push(`${at()} empty-clip ${clip.id}`);
        return 'clip';
      },
      outcome: (id, outcome) => trace.push(`${at()} outcome ${id} ${outcome}`),
      attemptSuperseded: (id) => trace.push(`${at()} superseded ${id}`),
      continuationSettled: (finalId, supersededIds) =>
        trace.push(`${at()} settled ${finalId} replacing ${supersededIds.join(',')}`),
      finished: (id) => trace.push(`${at()} finished ${id}`),
    },
    'pipeline',
    clock,
  );

  /**
   * Move the clock in steps of `resolutionMs`, letting woken work run after
   * each, so every recorded time is exact to that resolution.
   */
  async function advance(milliseconds: number): Promise<void> {
    for (let moved = 0; moved < milliseconds; moved += resolutionMs) {
      clock.advance(Math.min(resolutionMs, milliseconds - moved));
      await settle();
    }
  }

  for (const step of steps) {
    trace.push(`${at()} step ${JSON.stringify(step)}`);

    if ('submit' in step) {
      const admitted = pipeline.submit(
        audio(step.submit, step.samples),
        undefined,
        step.leadIn ? audio(0, step.leadIn) : undefined,
        step.trailingSilenceMs ?? 224,
      );
      trace.push(`${at()} admitted ${admitted}`);
    } else if ('resumed' in step) {
      pipeline.speechResumed();
    } else if ('discarded' in step) {
      pipeline.speechDiscarded(step.burstTrailingSilenceMs);
    } else if ('text' in step) {
      trace.push(`${at()} text-admitted ${pipeline.submitText(step.text)}`);
    } else if ('advance' in step) {
      await advance(step.advance);
    } else {
      controller.abort();
    }

    await settle();
  }

  // Let every remaining deadline pass, then wait for the pipeline to finish.
  let idle = false;
  const idled = pipeline.idle().then(() => {
    idle = true;
  });
  for (let round = 0; !idle && round < 1000; round++) {
    await advance(resolutionMs);
  }
  await idled;
  trace.push(`${at()} idle failures=${pipeline.failures} timers=${clock.pendingTimers}`);

  return trace;
}

/** Fixed single-microphone scripts covering every continuation path. */
const scripts: Record<string, Step[]> = {
  'one utterance': [{ submit: 0.1 }, { advance: 1000 }],
  'resumed during inference merges': [
    { submit: 0.1 },
    { advance: 100 },
    { resumed: true },
    { advance: 300 },
    { submit: 0.2, leadIn: 320 },
    { advance: 1000 },
  ],
  'resumed after the floor is a new request': [
    { submit: 0.1 },
    { advance: 900 },
    { resumed: true },
    { advance: 300 },
    { submit: 0.2 },
    { advance: 1000 },
  ],
  'rejected burst restarts the floor': [
    { submit: 0.1 },
    { advance: 400 },
    { resumed: true },
    { advance: 100 },
    { discarded: true, burstTrailingSilenceMs: 64 },
    { advance: 1000 },
  ],
  'listening ended during a hold': [
    { submit: 0.1 },
    { advance: 300 },
    { resumed: true },
    { advance: 2000 },
    { discarded: true },
    { advance: 1000 },
  ],
  'typed input during an open candidate': [
    { submit: 0.1 },
    { advance: 300 },
    { resumed: true },
    { advance: 100 },
    { text: 'typed words' },
    { advance: 300 },
    { submit: 0.2 },
    { advance: 1000 },
  ],
  'full queue drops and later speech does not skip it': [
    { submit: 0.1 },
    { submit: 0.2 },
    { submit: 0.3 },
    { submit: 0.4 },
    { resumed: true },
    { submit: 0.6 },
    { advance: 3000 },
  ],
  'a waiting attempt is replaced in place': [
    { submit: 0.1 },
    { submit: 0.2 },
    { resumed: true },
    { submit: 0.3 },
    { advance: 3000 },
  ],
  'unreadable fragment continues': [
    { submit: 0.5 },
    { advance: 600 },
    { resumed: true },
    { advance: 200 },
    { submit: 0.2 },
    { advance: 2000 },
  ],
  'a continuation over 60 seconds is a new request': [
    { submit: 0.1, samples: 16000 * 59 },
    { advance: 100 },
    { resumed: true },
    { submit: 0.2, samples: 32000 },
    { advance: 2000 },
  ],
  'pause during a hold': [
    { submit: 0.1 },
    { advance: 200 },
    { resumed: true },
    { advance: 100 },
    { pause: true },
    { discarded: true },
  ],
  'repeated pauses keep merging': [
    { submit: 0.1 },
    { advance: 100 },
    { resumed: true },
    { submit: 0.2 },
    { advance: 100 },
    { resumed: true },
    { submit: 0.3 },
    { advance: 2000 },
  ],
};

test('one microphone: the pipeline behaves exactly as on the base revision', async () => {
  const recorded: Record<string, string[]> = {};
  for (const [name, steps] of Object.entries(scripts)) {
    recorded[name] = await runScript(steps);
  }

  if (process.env.COMPANION_WRITE_TRACE === '1') {
    await writeFile(tracePath, JSON.stringify(recorded, null, 2) + '\n');
  }

  const reference = JSON.parse(await readFile(tracePath, 'utf8')) as Record<string, string[]>;
  assert.deepEqual(Object.keys(recorded), Object.keys(reference));
  for (const name of Object.keys(reference)) {
    assert.deepEqual(recorded[name], reference[name], `Script "${name}" differs from the base`);
  }
});
