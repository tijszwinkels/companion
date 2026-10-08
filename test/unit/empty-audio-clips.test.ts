import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { recordingDate } from '../../src/desktop/artifacts.ts';
import { saveEmptyAudioClip } from '../../src/desktop/empty-audio-clips.ts';
import { encodeWav } from '../../src/sensors/audio/segmenter.ts';
import type { TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { deferred, screenshot, signal, testDetector, testSensors } from '../helpers.ts';

function diagnostic(overrides: Partial<TranscriptionDiagnostic> = {}): TranscriptionDiagnostic {
  return {
    outcome: 'empty',
    audioMs: 1000,
    elapsedMs: 12,
    characters: 0,
    rms: 0.02,
    peak: 0.1,
    speechWindowRms: 0.04,
    ...overrides,
  };
}

function noRouting(): UserSensorRouter {
  return new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Empty audio reached routing') }) },
    () => {},
  );
}

test('empty ASR clips publish private PCM16 audio and matching metadata in the observation date bucket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-empty-audio-'));
  const observedAt = new Date(2026, 8, 23, 23, 59).getTime();
  const samples = new Float32Array(16000).fill(0.1);
  const report = diagnostic();

  try {
    const id = await saveEmptyAudioClip(
      directory,
      {
        id: 66,
        observedAt,
        samples,
        diagnostic: report,
      },
      () => true,
    );
    const parent = join(directory, 'asr-empty/2026-09-23');
    const clipDirectory = join(parent, id!);
    assert.match(id!, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.deepEqual(await readdir(parent), [id!], 'No unpublished temporary directory remains');
    assert.deepEqual((await readdir(clipDirectory)).sort(), ['audio.wav', 'metadata.json']);
    assert.deepEqual(await readFile(join(clipDirectory, 'audio.wav')), encodeWav(samples));
    assert.deepEqual(JSON.parse(await readFile(join(clipDirectory, 'metadata.json'), 'utf8')), {
      version: 1,
      id,
      frameId: 66,
      observedAt,
      sampleRate: 16000,
      channels: 1,
      diagnostic: report,
    });
    assert.equal((await stat(clipDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(clipDirectory, 'audio.wav'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(clipDirectory, 'metadata.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline saves eligible empty audio through the desktop even when screen capture fails', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const samples = new Float32Array(16000).fill(0.1);
  const expected = encodeWav(samples);
  const savedLogs: string[] = [];
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          throw Error('Synthetic capture failure');
        },
        transcribe: async (_samples, _signal, observe) => {
          observe?.(diagnostic());
          return '';
        },
      }),
      router: noRouting(),
    },
    (stage, detail, id) => {
      if (stage === 'asr-recorded') {
        assert.equal(id, 1);
        savedLogs.push(detail);
      }
    },
    fixture.controller.signal,
    fixture.runtime.activity,
  );

  try {
    pipeline.submit(samples);
    await pipeline.idle();
    const days = await readdir(join(fixture.directory, 'asr-empty'));
    assert.equal(days.length, 1);
    const parent = join(fixture.directory, 'asr-empty', days[0]);
    const ids = await readdir(parent);
    assert.equal(ids.length, 1);
    const metadata = JSON.parse(await readFile(join(parent, ids[0], 'metadata.json'), 'utf8'));
    assert.equal(metadata.id, ids[0]);
    assert.equal(metadata.frameId, 1);
    assert.equal(metadata.diagnostic.outcome, 'empty');
    assert.equal(parent, join(fixture.directory, 'asr-empty', recordingDate(metadata.observedAt)));
    assert.deepEqual(await readFile(join(parent, ids[0], 'audio.wav')), expected);
    assert.deepEqual(savedLogs, [`Empty transcript audio saved (${ids[0]})`]);
    await assert.rejects(readdir(join(fixture.directory, 'data')), { code: 'ENOENT' });
    assert.deepEqual(fixture.database.prepare('SELECT id FROM utterances').all(), []);
    assert.ok(samples.every((sample) => sample === 0));
    assert.equal(pipeline.failures, 0);
  } finally {
    await fixture.close();
  }
});

test('duration and energy gates retain only confirmed empty ASR responses', async () => {
  const cases: { name: string; report?: TranscriptionDiagnostic; retained: boolean }[] = [
    {
      name: 'at duration and energy floors',
      report: diagnostic({ audioMs: 128, speechWindowRms: 0.0005 }),
      retained: true,
    },
    { name: 'too short', report: diagnostic({ audioMs: 127 }), retained: false },
    { name: 'too quiet', report: diagnostic({ speechWindowRms: 0.000499 }), retained: false },
    { name: 'silence guard', report: diagnostic({ outcome: 'silence' }), retained: false },
    {
      name: 'punctuation only',
      report: diagnostic({ outcome: 'punctuation', characters: 3 }),
      retained: false,
    },
    { name: 'worker error', report: diagnostic({ outcome: 'error' }), retained: false },
    { name: 'unconfirmed empty', retained: false },
  ];

  for (const entry of cases) {
    let saved = 0;
    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => screenshot,
          transcribe: async (_samples, _signal, observe) => {
            if (entry.report) {
              observe?.(entry.report);
            }
            return '';
          },
        }),
        router: noRouting(),
      },
      () => {},
      signal(),
      {
        emptyAudioCaptured: async () => {
          saved++;
          return 'synthetic-clip';
        },
        transcribed: () => assert.fail('Empty audio created transcript history'),
        screenshotCaptured: async () => assert.fail('Empty audio saved a screenshot'),
      },
    );
    pipeline.submit(new Float32Array(16000).fill(0.1));
    await pipeline.idle();
    assert.equal(saved, entry.retained ? 1 : 0, entry.name);
  }
});

test('cancellation and idle wait for empty audio storage before clearing samples', async () => {
  const writing = deferred<void>();
  const release = deferred<void>();
  const controller = new AbortController();
  const samples = new Float32Array(16000).fill(0.1);
  let finished = false;
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (_samples, _signal, observe) => {
          observe?.(diagnostic());
          return '';
        },
      }),
      router: noRouting(),
    },
    () => {},
    controller.signal,
    {
      emptyAudioCaptured: async (clip) => {
        writing.resolve();
        await release.promise;
        assert.equal(clip.samples, samples);
        assert.ok(clip.samples.some((sample) => sample !== 0));
        return 'synthetic-clip';
      },
      finished: () => {
        finished = true;
      },
    },
  );

  try {
    pipeline.submit(samples);
    await writing.promise;
    controller.abort();
    await nextTurn();
    assert.equal(finished, false);
    assert.ok(samples.some((sample) => sample !== 0));
    release.resolve();
    await pipeline.idle();
    assert.equal(finished, true);
    assert.ok(samples.every((sample) => sample === 0));
    assert.equal(pipeline.failures, 0);
  } finally {
    release.resolve();
    await pipeline.idle();
  }
});

test('empty recording failure reports the storage stage and does not block the next job', async () => {
  let attempts = 0;
  const errors: string[] = [];
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (_samples, _signal, observe) => {
          observe?.(diagnostic());
          return '';
        },
      }),
      router: noRouting(),
    },
    (stage, detail) => {
      if (stage === 'error') {
        errors.push(detail);
      }
    },
    signal(),
    {
      emptyAudioCaptured: async () => {
        attempts++;
        if (attempts === 1) {
          throw Error('Synthetic disk failure');
        }
        return 'second-clip';
      },
    },
  );
  const first = new Float32Array(16000).fill(0.1);
  const second = first.slice();
  pipeline.submit(first);
  pipeline.submit(second);
  await pipeline.idle();
  assert.equal(attempts, 2);
  assert.equal(pipeline.failures, 1);
  assert.deepEqual(errors, ['recording: Synthetic disk failure']);
  assert.ok(first.every((sample) => sample === 0));
  assert.ok(second.every((sample) => sample === 0));
});
