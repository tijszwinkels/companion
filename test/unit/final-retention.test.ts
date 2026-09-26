import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import type { UserSensorFrame } from '../../src/core/frame.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { recordingDate } from '../../src/desktop/artifacts.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { ENDPOINT_MS } from '../../src/sensors/audio/segmenter.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import {
  deferred,
  frame,
  ManualClock,
  processor,
  screenshot,
  testDetector,
  testSensors,
} from '../helpers.ts';

// Final-only retention of continued utterances (docs/speech-timing.md, D4).
// These tests run the production pipeline, router and desktop runtime against
// a disposable SQLite database and recordings directory. ASR, capture and the
// intent model are controlled promises; commitment deadlines use a ManualClock.
// No microphone, real screenshot, model or personal data is involved.

/** Recognizable synthetic audio. */
function audio(marker: number): Float32Array {
  return new Float32Array(1600).fill(marker);
}

type Answer<T> = { resolve(value: T): void; reject(error: Error): void };
type Detection = { utterance: string; resolve(intent: string): void };

/** A pipeline wired to a real desktop runtime, with every slow step controlled. */
async function chainFixture(
  options: {
    /** Capture results per call, in order; the default is the test screenshot. */
    captureFails?: number[];
    /** The router's text processor throws for these utterances. */
    dispatchFails?: string[];
  } = {},
) {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const clock = new ManualClock();
  const transcriptions: Answer<string>[] = [];
  const detections: Detection[] = [];
  const dispatched: string[] = [];
  let captures = 0;

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (frame, _intents, signal) => {
          const reply = deferred<string>();
          detections.push({ utterance: frame.utterance, resolve: reply.resolve });
          const aborted = new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return Promise.race([reply.promise, aborted]);
        },
      }),
    },
    () => {},
  );

  const outcome = fixture.runtime.activity.outcome!;
  processor('IGNORE', async (received: UserSensorFrame) => {
    outcome(received.id, 'ignored');
  }).subscribe(router);
  processor('SEND', async (received: UserSensorFrame) => {
    if (options.dispatchFails?.includes(received.utterance)) {
      throw Error('Delivery failed');
    }
    dispatched.push(received.utterance);
    outcome(received.id, 'sent');
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          captures++;
          if (options.captureFails?.includes(captures)) {
            throw Error('Focus changed');
          }
          return screenshot;
        },
        // ASR honours only pause/shutdown, like the resident worker.
        transcribe: async (_samples, signal) => {
          const reply = deferred<string>();
          let reject!: (error: Error) => void;
          const failed = new Promise<never>((_resolve, fail) => {
            reject = fail;
            signal.addEventListener('abort', () => fail(signal.reason), { once: true });
          });
          transcriptions.push({ resolve: reply.resolve, reject });
          return Promise.race([reply.promise, failed]);
        },
      }),
      router,
    },
    () => {},
    fixture.controller.signal,
    fixture.runtime.activity,
    'pipeline',
    clock,
  );

  /** Admit a segment closed by an ordinary silence endpoint. */
  function speak(marker: number): void {
    pipeline.submit(audio(marker), undefined, undefined, ENDPOINT_MS);
  }

  /** Resumed speech that the listener accepts: the newest attempt is continued. */
  function continueWith(marker: number): void {
    pipeline.speechResumed();
    speak(marker);
  }

  /** Let all deadlines pass until the pipeline is idle. */
  async function idle(): Promise<void> {
    let done = false;
    const finished = pipeline.idle().then(() => {
      done = true;
    });
    for (let round = 0; !done; round++) {
      assert.ok(round < 400, 'The pipeline settles');
      clock.advance(2000);
      await delay(5);
    }
    await finished;
  }

  function rows(): { id: string; transcript: string; outcome: string }[] {
    return fixture.database
      .prepare('SELECT id, transcript, outcome FROM utterances ORDER BY rowid')
      .all() as { id: string; transcript: string; outcome: string }[];
  }

  /** UUIDs with a recording of `kind`, across all date folders. */
  async function recorded(kind: 'audio' | 'screenshots'): Promise<string[]> {
    const ids: string[] = [];
    const data = join(fixture.directory, 'data');
    for (const day of await readdir(data).catch(() => [])) {
      for (const name of await readdir(join(data, day, kind)).catch(() => [])) {
        ids.push(name.replace(/\.(wav|png)$/, ''));
      }
    }
    return ids.sort();
  }

  function published(type: string): string[] {
    return fixture.messages
      .filter((message) => message.type === type)
      .map((message) => (type === 'activity-entry' ? message.entry!.id : message.id!));
  }

  return {
    fixture,
    clock,
    pipeline,
    transcriptions,
    detections,
    dispatched,
    speak,
    continueWith,
    idle,
    rows,
    recorded,
    published,
  };
}

type ChainFixture = Awaited<ReturnType<typeof chainFixture>>;

/**
 * Attempt 1 is transcribed and recorded, and its inference is pending when the
 * user resumes speaking: it is superseded with a row, WAV and PNG of its own.
 */
async function supersededAttempt(setup: ChainFixture, text = 'Open the'): Promise<string> {
  setup.speak(0.1);
  await waitFor(() => setup.transcriptions.length === 1);
  setup.transcriptions[0].resolve(text);
  await waitFor(() => setup.detections.length === 1);

  const row = setup.rows()[0];
  assert.equal(row.transcript, text);
  assert.deepEqual(await setup.recorded('audio'), [row.id]);
  assert.deepEqual(await setup.recorded('screenshots'), [row.id]);

  setup.continueWith(0.2);
  return row.id;
}

test('a continued utterance keeps only its final record, recordings and Activity card', async () => {
  const setup = await chainFixture();
  try {
    const first = await supersededAttempt(setup);
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('Open the browser');
    await waitFor(() => setup.detections.length === 2);
    setup.detections[1].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('history-deleted').length === 1);

    const rows = setup.rows();
    assert.equal(rows.length, 1, 'One record for the whole utterance');
    const final = rows[0];
    assert.deepEqual(
      { transcript: final.transcript, outcome: final.outcome },
      { transcript: 'Open the browser', outcome: 'sent' },
    );
    assert.notEqual(final.id, first);
    assert.deepEqual(await setup.recorded('audio'), [final.id]);
    assert.deepEqual(await setup.recorded('screenshots'), [final.id]);

    assert.deepEqual(setup.published('activity-entry'), [final.id], 'No superseded card');
    assert.deepEqual(setup.published('history-deleted'), [first]);
    assert.deepEqual(setup.dispatched, ['Open the browser']);
  } finally {
    await setup.fixture.close();
  }
});

test('repeated continuations retire every superseded attempt once the last one is recorded', async () => {
  const setup = await chainFixture();
  try {
    const first = await supersededAttempt(setup, 'One');
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('One two');
    await waitFor(() => setup.detections.length === 2);
    const second = setup.rows()[1].id;

    setup.continueWith(0.3);
    await waitFor(() => setup.transcriptions.length === 3);
    setup.transcriptions[2].resolve('One two three');
    await waitFor(() => setup.detections.length === 3);
    setup.detections[2].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('history-deleted').length === 2);

    const rows = setup.rows();
    assert.deepEqual(
      rows.map((row) => row.transcript),
      ['One two three'],
    );
    assert.deepEqual(setup.published('history-deleted').sort(), [first, second].sort());
    assert.deepEqual(await setup.recorded('audio'), [rows[0].id]);
  } finally {
    await setup.fixture.close();
  }
});

test('earlier independent and historical records, including old superseded rows, are untouched', async () => {
  const setup = await chainFixture();
  try {
    // A historical superseded row with recordings, written by an earlier run.
    const historical = '00000000-0000-4000-8000-000000000001';
    const observedAt = Date.now() - 86_400_000;
    const writer = new DatabaseSync(join(setup.fixture.directory, 'utterances.sqlite'));
    writer
      .prepare(
        "INSERT INTO utterances (id, observed_at, transcript, outcome) VALUES (?, ?, 'Old part', 'superseded')",
      )
      .run(historical, observedAt);
    writer.close();
    const day = join(setup.fixture.directory, 'data', recordingDate(observedAt));
    await mkdir(join(day, 'audio'), { recursive: true });
    await mkdir(join(day, 'screenshots'), { recursive: true });
    await writeFile(join(day, 'audio', `${historical}.wav`), 'old');
    await writeFile(join(day, 'screenshots', `${historical}.png`), 'old');

    // An independent request that is ignored, before the continued utterance.
    setup.speak(0.05);
    await waitFor(() => setup.transcriptions.length === 1);
    setup.transcriptions[0].resolve('Background chatter');
    await waitFor(() => setup.detections.length === 1);
    setup.detections[0].resolve('IGNORE');
    await setup.idle();

    // Now a continued utterance, with one superseded attempt.
    setup.speak(0.1);
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('Open the');
    await waitFor(() => setup.detections.length === 2);
    setup.continueWith(0.2);
    await waitFor(() => setup.transcriptions.length === 3);
    setup.transcriptions[2].resolve('Open the browser');
    await waitFor(() => setup.detections.length === 3);
    setup.detections[2].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('history-deleted').length === 1);

    assert.deepEqual(
      setup.rows().map((row) => [row.transcript, row.outcome]),
      [
        ['Old part', 'superseded'],
        ['Background chatter', 'ignored'],
        ['Open the browser', 'sent'],
      ],
    );
    assert.ok((await setup.recorded('audio')).includes(historical));
    assert.ok((await setup.recorded('screenshots')).includes(historical));
    assert.equal((await setup.recorded('audio')).length, 3);
  } finally {
    await setup.fixture.close();
  }
});

test('an empty combined transcript keeps the earlier words in the final record (D2)', async () => {
  const setup = await chainFixture();
  try {
    const first = await supersededAttempt(setup, 'Open the browser');
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('');
    await waitFor(() => setup.detections.length === 2);
    setup.detections[1].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('history-deleted').length === 1);

    const rows = setup.rows();
    assert.deepEqual(
      rows.map((row) => [row.transcript, row.outcome]),
      [['Open the browser', 'sent']],
    );
    assert.notEqual(rows[0].id, first, 'The combined attempt owns the record');
    assert.deepEqual(await setup.recorded('audio'), [rows[0].id]);
  } finally {
    await setup.fixture.close();
  }
});

test('a failed final dispatch is still the one record: its error outcome is kept', async () => {
  const setup = await chainFixture({ dispatchFails: ['Open the browser'] });
  try {
    const first = await supersededAttempt(setup);
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('Open the browser');
    await waitFor(() => setup.detections.length === 2);
    setup.detections[1].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('history-deleted').length === 1);

    assert.deepEqual(
      setup.rows().map((row) => [row.transcript, row.outcome]),
      [['Open the browser', 'error']],
    );
    assert.deepEqual(setup.published('history-deleted'), [first]);
    assert.equal(setup.published('activity-entry').length, 1);
  } finally {
    await setup.fixture.close();
  }
});

test('without a fully recorded final attempt, superseded attempts are kept and shown', async (context) => {
  await context.test('the final ASR request fails', async () => {
    const setup = await chainFixture();
    try {
      const first = await supersededAttempt(setup);
      await waitFor(() => setup.transcriptions.length === 2);
      setup.transcriptions[1].reject(Error('ASR worker failed'));
      await setup.idle();
      await delay(20);

      assert.deepEqual(
        setup.rows().map((row) => [row.id, row.outcome]),
        [[first, 'superseded']],
      );
      assert.deepEqual(setup.published('activity-entry'), [first]);
      assert.deepEqual(setup.published('history-deleted'), []);
      assert.deepEqual(await setup.recorded('audio'), [first]);
    } finally {
      await setup.fixture.close();
    }
  });

  await context.test('the final attempt has no screenshot', async () => {
    const setup = await chainFixture({ captureFails: [2] });
    try {
      const first = await supersededAttempt(setup);
      await waitFor(() => setup.transcriptions.length === 2);
      setup.transcriptions[1].resolve('Open the browser');
      await setup.idle();
      await delay(20);

      assert.deepEqual(
        setup.rows().map((row) => [row.transcript, row.outcome]),
        [
          ['Open the', 'superseded'],
          ['Open the browser', 'error'],
        ],
      );
      assert.deepEqual(setup.published('history-deleted'), []);
      assert.ok(setup.published('activity-entry').includes(first));
    } finally {
      await setup.fixture.close();
    }
  });

  await context.test('pause cancels the final attempt before its transcript', async () => {
    const setup = await chainFixture();
    try {
      const first = await supersededAttempt(setup);
      await waitFor(() => setup.transcriptions.length === 2);
      setup.fixture.controller.abort();
      await setup.pipeline.idle();
      await delay(20);

      assert.deepEqual(
        setup.rows().map((row) => [row.id, row.outcome]),
        [[first, 'superseded']],
      );
      assert.deepEqual(setup.published('activity-entry'), [first]);
    } finally {
      await setup.fixture.close();
    }
  });
});

test('pause after the final attempt is recorded keeps its cancelled record only', async () => {
  const setup = await chainFixture();
  try {
    const first = await supersededAttempt(setup);
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('Open the browser');
    await waitFor(() => setup.detections.length === 2);

    setup.fixture.controller.abort();
    await setup.pipeline.idle();
    await waitFor(() => setup.published('history-deleted').length === 1);

    assert.deepEqual(
      setup.rows().map((row) => [row.transcript, row.outcome]),
      [['Open the browser', 'cancelled']],
    );
    assert.deepEqual(setup.published('history-deleted'), [first]);
    assert.deepEqual(setup.dispatched, []);
  } finally {
    await setup.fixture.close();
  }
});

test('a superseded attempt whose recordings cannot be removed is kept and shown', async () => {
  const setup = await chainFixture();
  const day = join(setup.fixture.directory, 'data', recordingDate(Date.now()), 'audio');
  try {
    const first = await supersededAttempt(setup);
    await waitFor(() => setup.transcriptions.length === 2);
    setup.transcriptions[1].resolve('Open the browser');
    await waitFor(() => setup.detections.length === 2);

    // The final WAV is already published; now make the folder read-only.
    await chmod(day, 0o500);
    setup.detections[1].resolve('SEND');
    await setup.idle();
    await waitFor(() => setup.published('activity-entry').includes(first));

    assert.deepEqual(
      setup.rows().map((row) => [row.transcript, row.outcome]),
      [
        ['Open the', 'superseded'],
        ['Open the browser', 'sent'],
      ],
    );
    assert.deepEqual(setup.published('history-deleted'), [], 'No removal is reported');
  } finally {
    await chmod(day, 0o700);
    await setup.fixture.close();
  }
});

// ---------------------------------------------------------------------------
// UtteranceHistory.retireSuperseded on its own
// ---------------------------------------------------------------------------

test('retirement is limited to finished, unreferenced superseded rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-retention-'));
  const history = new UtteranceHistory(join(directory, 'utterances.sqlite'));
  await history.open();
  try {
    const record = async (frameId: number, outcome: 'superseded' | 'ignored') => {
      history.add({ ...frame, id: frameId, utterance: `Attempt ${frameId}` });
      await history.saveAudio(frameId, audio(0.1));
      await history.saveScreenshot(frameId, screenshot);
      history.setOutcome(frameId, outcome);
      return history.entryId(frameId)!;
    };

    const active = await record(1, 'superseded');
    await assert.rejects(history.retireSuperseded(active), /finished superseded/);
    history.finish(1);

    const ignored = await record(2, 'ignored');
    history.finish(2);
    await assert.rejects(history.retireSuperseded(ignored), /finished superseded/);

    const pasted = await record(3, 'superseded');
    history.finish(3);
    history.finishPaste(history.beginPaste(pasted, '0xabc'), 'sent', 'editor');
    await assert.rejects(history.retireSuperseded(pasted), /pasted or labeled/);

    const labeled = await record(4, 'superseded');
    history.setIntent(4, 'SEND');
    history.finish(4);
    history.label(labeled, true);
    await assert.rejects(history.retireSuperseded(labeled), /pasted or labeled/);

    // The first attempt, now finished, is retired with its recordings.
    await history.retireSuperseded(active);
    assert.equal(history.find(active), undefined);
    assert.deepEqual(
      [ignored, pasted, labeled].map((id) => history.find(id)?.id),
      [ignored, pasted, labeled],
    );

    // A late write for a finished frame cannot recreate a record or file.
    assert.equal(await history.saveAudio(1, audio(0.2)), false);
    assert.equal(await history.saveScreenshot(1, screenshot), false);
    const data = join(directory, 'data', recordingDate(frame.observedAt));
    const wavs = await readdir(join(data, 'audio'));
    assert.equal(wavs.includes(`${active}.wav`), false);
    assert.equal(wavs.length, 3);
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
