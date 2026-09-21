import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { encodeWav } from '../../src/sensors/audio/segmenter.ts';
import { desktopFixture, findArtifact } from '../desktop-fixture.ts';
import { deferred, frame, screenshot, signal, testDetector, testSensors } from '../helpers.ts';

test('WAV storage uses the observation date and survives restart; text-only records have no audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-audio-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1]);

  try {
    await history.open();
    history.add({ ...frame, observedAt: new Date(2026, 8, 19, 23, 59).getTime() });
    const original = history.snapshot()[0];
    await history.saveAudio(frame.id, samples);
    history.setOutcome(frame.id, 'ignored');
    history.finish(frame.id);
    history.add({ ...frame, id: 2, utterance: 'Supplied text without audio' });
    history.finish(2);
    history.close();
    await history.open();

    const database = new DatabaseSync(path, { readOnly: true });

    try {
      const rows = database.prepare('SELECT * FROM utterances ORDER BY rowid').all();
      assert.ok(rows.every((row) => !('audio_path' in row)));
      const audioDirectory = join(directory, 'data/2026-09-19/audio');
      assert.deepEqual(await readdir(audioDirectory), [`${original.id}.wav`]);
      const wav = await readFile(join(audioDirectory, `${original.id}.wav`));
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.readUInt32LE(40), 10);
      assert.deepEqual(
        [0, 1, 2, 3, 4].map((index) => wav.readInt16LE(44 + index * 2)),
        [-32768, -16384, 0, 16384, 32767],
      );
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('screen capture failure still saves the speech for its transcript before clearing the samples', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const samples = new Float32Array(16000).fill(0.2);
  const expected = encodeWav(samples);
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => assert.fail('Capture failure reached inference'),
      }),
    },
    () => {},
  );
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          throw Error('Focus changed');
        },
        transcribe: async () => 'Keep the speech even without an image',
      }),
      router,
    },
    () => {},
    signal(),
    fixture.runtime.activity,
  );

  try {
    pipeline.submit(samples);
    await pipeline.idle();
    const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
    assert.equal(row.outcome, 'error');
    assert.equal('screenshot_path' in row, false);
    assert.deepEqual(
      await readFile(await findArtifact(dirname(fixture.socketPath), String(row.id), 'audio')),
      expected,
    );
    assert.ok(samples.every((sample) => sample === 0));
  } finally {
    await fixture.close();
  }
});

test('cancellation waits for audio storage before clearing samples and never dispatches the saved utterance', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const samples = new Float32Array(16000).fill(0.2);
  const expected = encodeWav(samples);
  const writing = deferred<void>();
  const release = deferred<void>();
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => assert.fail('Cancelled speech reached inference'),
      }),
    },
    () => {},
  );
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => 'Late transcript',
      }),
      router,
    },
    () => {},
    fixture.controller.signal,
    {
      ...fixture.runtime.activity,
      async audioCaptured(id, input) {
        writing.resolve();
        await release.promise;
        await fixture.runtime.activity.audioCaptured!(id, input);
      },
    },
  );

  try {
    pipeline.submit(samples);
    await writing.promise;
    fixture.controller.abort();
    assert.ok(samples.some((sample) => sample !== 0));
    release.resolve();
    await pipeline.idle();
    assert.ok(samples.every((sample) => sample === 0));
    assert.equal(pipeline.failures, 0);
    const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
    assert.equal(row.outcome, 'cancelled');
    assert.equal(row.recognized_intent, null);
    assert.deepEqual(
      await readFile(await findArtifact(dirname(fixture.socketPath), String(row.id), 'audio')),
      expected,
    );
  } finally {
    release.resolve();
    await pipeline.idle();
    await fixture.close();
  }
});

for (const failedRecording of ['audio', 'screenshots'] as const) {
  test(`${failedRecording} failure still waits for and preserves the other recording`, async () => {
    const fixture = await desktopFixture(async () => Buffer.alloc(0));
    const activity = fixture.runtime.activity;
    const samples = new Float32Array(16000).fill(0.2);
    const expectedAudio = encodeWav(samples);
    const writing = deferred<void>();
    const release = deferred<void>();
    let finished = false;

    // Delay the healthy recording after the other write rejects. Early return
    // would clear samples and release SQLite while that recording still needs it.
    async function write(kind: 'audio' | 'screenshots', save: () => Promise<void>): Promise<void> {
      if (kind === failedRecording) {
        throw Error(`Cannot write ${kind}`);
      }
      writing.resolve();
      await release.promise;
      await save();
    }

    const router = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async () => assert.fail('Storage error reached inference'),
        }),
      },
      () => {},
    );
    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => screenshot,
          transcribe: async () => 'Keep available input',
        }),
        router,
      },
      () => {},
      fixture.controller.signal,
      {
        ...activity,
        audioCaptured: (id, input) => write('audio', () => activity.audioCaptured!(id, input)),
        screenshotCaptured: (id, input) =>
          write('screenshots', () => activity.screenshotCaptured!(id, input)),
        finished(id) {
          finished = true;
          activity.finished?.(id);
        },
      },
    );

    try {
      pipeline.submit(samples);
      await writing.promise;
      await nextTurn();
      assert.equal(finished, false);
      assert.ok(samples.some((sample) => sample !== 0));
      release.resolve();
      await pipeline.idle();

      const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
      assert.equal(row.outcome, 'error');
      assert.equal(row.recognized_intent, null);
      assert.equal(pipeline.failures, 1);
      assert.equal(finished, true);
      assert.ok(samples.every((sample) => sample === 0));

      const savedRecording = failedRecording === 'audio' ? 'screenshots' : 'audio';
      const path = await findArtifact(dirname(fixture.socketPath), String(row.id), savedRecording);
      assert.deepEqual(
        await readFile(path),
        savedRecording === 'audio' ? expectedAudio : screenshot.png,
      );
    } finally {
      release.resolve();
      await pipeline.idle();
      await fixture.close();
    }
  });
}

test('migration removes old path columns while preserving recorded files, utterances, and feedback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-audio-migration-'));
  const path = join(directory, 'utterances.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE utterances (
      id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, transcript TEXT NOT NULL,
      application TEXT, window_title TEXT, window_address TEXT, recognized_intent TEXT,
      outcome TEXT NOT NULL DEFAULT 'processing', completed_at INTEGER,
      delivery_started_at INTEGER, legacy_outcome TEXT, screenshot_path TEXT, audio_path TEXT
    );
    CREATE TABLE intent_feedback (
      id TEXT PRIMARY KEY NOT NULL REFERENCES utterances(id),
      correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
      recognized_intent TEXT NOT NULL, actual_intent TEXT DEFAULT NULL
    );
    INSERT INTO utterances (id, observed_at, transcript, recognized_intent, outcome, screenshot_path)
      VALUES ('old', 1, 'Earlier speech', 'IGNORE', 'ignored', 'data/2026-09-19/screenshots/old.png');
    INSERT INTO intent_feedback VALUES ('old', 1, 'IGNORE', 'IGNORE');
    PRAGMA user_version = 3;
  `);
  old.close();
  const screenshotDirectory = join(directory, 'data/2026-09-19/screenshots');
  const audioDirectory = join(directory, 'data/2026-09-19/audio');
  await mkdir(screenshotDirectory, { recursive: true });
  await mkdir(audioDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, 'old.png'), screenshot.png);
  const audio = encodeWav(new Float32Array([0.25, -0.25]));
  await writeFile(join(audioDirectory, 'old.wav'), audio);
  const history = new UtteranceHistory(path);

  try {
    await history.open();
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 5);
      const row = database.prepare('SELECT * FROM utterances').get()!;
      assert.equal(row.transcript, 'Earlier speech');
      assert.equal('screenshot_path' in row, false);
      assert.equal('audio_path' in row, false);
      assert.deepEqual(await readFile(join(screenshotDirectory, 'old.png')), screenshot.png);
      assert.deepEqual(await readFile(join(audioDirectory, 'old.wav')), audio);
      assert.deepEqual(
        { ...database.prepare('SELECT * FROM intent_feedback').get() },
        {
          id: 'old',
          correct: 1,
          recognized_intent: 'IGNORE',
          actual_intent: 'IGNORE',
        },
      );
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
