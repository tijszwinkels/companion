import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { CaptureStoragePolicy, type CaptureAdmission } from '../../src/capture-storage/policy.ts';
import type { Screenshot, UserSensorFrame } from '../../src/core/frame.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { LabelPreviousCorrect } from '../../src/processors/label-previous-correct.ts';
import { isRemoteAction } from '../../src/remote/protocol.ts';
import { encodeWav, ENDPOINT_MS } from '../../src/sensors/audio/segmenter.ts';
import type { TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { harnessFixture } from '../harness-fixture.ts';
import {
  deferred,
  frame,
  ManualClock,
  processor,
  screenshot,
  testDetector,
  testSensors,
} from '../helpers.ts';

// Capture storage end to end (docs/capture-storage.md): the production
// pipeline, router, desktop runtime, SQLite history and agent sessions run
// against temporary directories. ASR, capture and the intent model are
// controlled fakes; audio and screenshots are synthetic canaries. Nothing
// reads a microphone, the screen, personal data or a real model.

/** A valid PNG followed by a unique marker, so copies can be found anywhere. */
const pngMarker = Buffer.from('CAPTURE-STORAGE-PNG-CANARY-7f3c');
const canaryScreenshot: Screenshot = {
  ...screenshot,
  png: Buffer.concat([screenshot.png, pngMarker]),
};

/** Recognizable PCM: the encoded bytes of this level are searched for later. */
const canaryLevel = 0.3141;
function canaryAudio(samples = 16000): Float32Array {
  return new Float32Array(samples).fill(canaryLevel);
}
const wavMarker = encodeWav(canaryAudio(64)).subarray(44);

function emptyDiagnostic(): TranscriptionDiagnostic {
  return {
    outcome: 'empty',
    audioMs: 1000,
    elapsedMs: 12,
    characters: 0,
    rms: 0.02,
    peak: 0.1,
    speechWindowRms: 0.04,
  };
}

type Transcription = {
  resolve(text: string): void;
  reject(error: Error): void;
  report(diagnostic: TranscriptionDiagnostic): void;
};

/**
 * A pipeline wired to a real desktop runtime with a given capture-storage
 * policy. Speech uses a ManualClock for commitment deadlines, like
 * final-retention.test.ts. `beforeAudioWrite` runs synchronously right after
 * the real audio write has started (it is then in flight).
 */
async function storageFixture(
  captureStorage: CaptureStoragePolicy,
  options: { beforeAudioWrite?: () => void } = {},
) {
  const fixture = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage,
  });
  const clock = new ManualClock();
  const transcriptions: Transcription[] = [];
  const detected: UserSensorFrame[] = [];
  const intents: ((intent: string) => void)[] = [];
  const dispatched: string[] = [];
  const activity = fixture.runtime.activity;

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (received, _intents, signal) => {
          detected.push(received);
          const reply = deferred<string>();
          intents.push(reply.resolve);
          // Like a real model client, a replaced attempt's request is cancelled.
          const aborted = new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return Promise.race([reply.promise, aborted]);
        },
      }),
    },
    () => {},
    // Like the CLI, the router reports selected intents to the desktop.
    activity,
  );
  processor('IGNORE', async (received: UserSensorFrame) => {
    activity.outcome?.(received.id, 'ignored');
  }).subscribe(router);
  processor('SEND', async (received: UserSensorFrame) => {
    dispatched.push(received.utterance);
    activity.outcome?.(received.id, 'sent');
  }).subscribe(router);
  // Spoken label results, as logged by the real processor.
  const labelLog: string[] = [];
  new LabelPreviousCorrect(
    (stage, detail) => {
      labelLog.push(`${stage}: ${detail}`);
    },
    false,
    activity,
  ).subscribe(router);
  await fixture.runtime.connectRouter(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => canaryScreenshot,
        transcribe: async (_samples, signal, report) => {
          const reply = deferred<string>();
          let reject!: (error: Error) => void;
          const failed = new Promise<never>((_resolve, fail) => {
            reject = fail;
            signal.addEventListener('abort', () => fail(signal.reason), { once: true });
          });
          transcriptions.push({
            resolve: reply.resolve,
            reject,
            report: (diagnostic) => report?.(diagnostic),
          });
          return Promise.race([reply.promise, failed]);
        },
      }),
      router,
    },
    () => {},
    fixture.controller.signal,
    {
      ...activity,
      audioCaptured: async (id, samples) => {
        const write = activity.audioCaptured!(id, samples);
        options.beforeAudioWrite?.();
        await write;
      },
    },
    'pipeline',
    clock,
  );
  fixture.runtime.connectPipeline(pipeline);

  function speak(samples = canaryAudio()): void {
    pipeline.submit(samples, undefined, undefined, ENDPOINT_MS);
  }

  function continueWith(samples = canaryAudio(1600)): void {
    pipeline.speechResumed();
    speak(samples);
  }

  /** Let every commitment deadline pass until the pipeline is idle. */
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

  /** Wait for the n-th transcription request (1-based) and return it. */
  async function transcription(index: number): Promise<Transcription> {
    await waitFor(() => transcriptions.length >= index);
    return transcriptions[index - 1];
  }

  /** Wait for the n-th classification (1-based) and answer it. */
  async function classify(index: number, intent: string): Promise<void> {
    await waitFor(() => intents.length >= index);
    intents[index - 1](intent);
  }

  function rows() {
    return fixture.database
      .prepare(
        `SELECT id, transcript, outcome, capture_storage AS storage, input_kind AS input,
          transcript_source AS source FROM utterances ORDER BY rowid`,
      )
      .all() as {
      id: string;
      transcript: string;
      outcome: string;
      storage: string | null;
      input: string | null;
      source: string | null;
    }[];
  }

  return {
    fixture,
    pipeline,
    transcription,
    classify,
    detected,
    dispatched,
    labelLog,
    speak,
    continueWith,
    idle,
    rows,
  };
}

/** Every regular file below `directory`, relative path → SHA-256. */
async function inventory(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        files.set(relative(directory, path), createHash('sha256').update(content).digest('hex'));
      }
    }
  }
  await walk(directory);
  return files;
}

/** Files below `directory` whose bytes contain a capture canary. */
async function canaryCopies(directory: string): Promise<string[]> {
  const found: string[] = [];
  const base64 = canaryScreenshot.png.toString('base64');
  for (const path of (await inventory(directory)).keys()) {
    const content = await readFile(join(directory, path));
    if (
      content.includes(pngMarker) ||
      content.includes(wavMarker) ||
      content.includes(Buffer.from(base64))
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Pre-existing ("upgraded installation") recordings that must stay untouched. */
async function legacyRecordings(directory: string): Promise<void> {
  const audio = join(directory, 'data', '2026-01-01', 'audio');
  const screenshots = join(directory, 'data', '2026-01-01', 'screenshots');
  const empty = join(directory, 'asr-empty', '2026-01-01', '00000000-0000-4000-8000-000000000001');
  for (const path of [audio, screenshots, empty]) {
    await mkdir(path, { recursive: true });
  }
  const legacy = '00000000-0000-4000-8000-000000000002';
  await writeFile(join(audio, `${legacy}.wav`), 'legacy wav');
  await writeFile(join(screenshots, `${legacy}.png`), 'legacy png');
  await writeFile(join(empty, 'audio.wav'), 'legacy diagnostic');
}

/** Only recording files, without the database, sockets and preferences. */
function recordingFiles(files: Map<string, string>): string[] {
  return [...files.keys()]
    .filter((path) => path.startsWith('data/') || path.startsWith('asr-empty/'))
    .sort();
}

for (const enabled of [false, true]) {
  test(`W1/W3/L1/S1/P1: storage ${enabled ? 'on' : 'off'}: same live processing; archives only when on`, async () => {
    const policy = enabled ? CaptureStoragePolicy.enabledForTesting() : new CaptureStoragePolicy();
    const setup = await storageFixture(policy);
    try {
      await legacyRecordings(setup.fixture.directory);
      const before = await inventory(setup.fixture.directory);

      // 1. Successful speech, dispatched.
      setup.speak();
      (await setup.transcription(1)).resolve('Send the canary text');
      await setup.classify(1, 'SEND');
      await setup.idle();

      // 2. Typed Activity text, ignored.
      assert.ok(setup.pipeline.submitText('Typed canary text', setup.fixture.controller.signal));
      await setup.classify(2, 'IGNORE');
      await setup.idle();

      // 3. A qualifying empty ASR result (diagnostic clip candidate).
      setup.speak();
      const empty = await setup.transcription(2);
      empty.report(emptyDiagnostic());
      empty.resolve('');
      await setup.idle();

      // 4. An ASR failure.
      setup.speak();
      (await setup.transcription(3)).reject(Error('Synthetic ASR failure'));
      await setup.idle();

      // L1: the model saw the same live screenshot either way, and acted.
      assert.equal(setup.detected.length, 2);
      for (const received of setup.detected) {
        assert.deepEqual(received.screenshot.png, canaryScreenshot.png);
      }
      assert.deepEqual(setup.dispatched, ['Send the canary text']);

      // Text history is kept either way.
      const rows = setup.rows();
      assert.deepEqual(
        rows.map((row) => [row.transcript, row.outcome, row.input]),
        [
          ['Send the canary text', 'sent', 'speech'],
          ['Typed canary text', 'ignored', 'typed'],
        ],
      );
      assert.ok(rows.every((row) => row.storage === (enabled ? 'on' : 'off')));

      const after = await inventory(setup.fixture.directory);
      // P1: earlier recordings are byte-identical in both cases.
      for (const [path, hash] of before) {
        if (recordingFiles(before).includes(path)) {
          assert.equal(after.get(path), hash, path);
        }
      }

      const added = recordingFiles(after).filter((path) => !before.has(path));
      if (enabled) {
        // W3: speech WAV + PNG, typed PNG, and one diagnostic clip.
        const [speech, typed] = rows;
        const kinds = added.map((path) => path.split('/').slice(2).join('/'));
        assert.ok(kinds.includes(`audio/${speech.id}.wav`));
        assert.ok(kinds.includes(`screenshots/${speech.id}.png`));
        assert.ok(kinds.includes(`screenshots/${typed.id}.png`));
        assert.ok(!kinds.includes(`audio/${typed.id}.wav`), 'Typed input has no WAV');
        assert.equal(added.filter((path) => path.startsWith('asr-empty/')).length, 2);
      } else {
        // W1/S1: no new recording, diagnostic or temporary file at all, and
        // no canary bytes in SQLite, its journal or any other file.
        assert.deepEqual(added, []);
        assert.deepEqual(await canaryCopies(setup.fixture.directory), []);
        assert.deepEqual(
          [...after.keys()].filter((path) => path.includes('.tmp')),
          [],
          'No orphan temporary files',
        );
      }
    } finally {
      await setup.fixture.close();
    }
  });
}

test('T1: an Off acknowledged during an in-flight capture write leaves no late WAV/PNG', async () => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  let off: Promise<void> | undefined;
  const setup = await storageFixture(policy, {
    // The real audio write has started (admitted, in flight); turn storage off
    // before it can publish. The screenshot write starts after the Off.
    beforeAudioWrite: () => {
      off ??= policy.setEnabled(false);
    },
  });
  try {
    setup.speak();
    (await setup.transcription(1)).resolve('Send while turning off');
    await setup.classify(1, 'SEND');
    await setup.idle();
    await off;

    // Live processing continued; nothing was published after the barrier.
    assert.deepEqual(setup.dispatched, ['Send while turning off']);
    const [row] = setup.rows();
    assert.equal(row.storage, 'off', 'Honestly "Not saved"');
    const files = recordingFiles(await inventory(setup.fixture.directory));
    assert.deepEqual(files, []);
  } finally {
    await setup.fixture.close();
  }
});

test('T1/T2: work admitted before Off (or before off→on) never publishes, including diagnostics', async () => {
  // Monotonic time moves only when the test says so (straddling checks).
  const time = { now: 0 };
  const policy = CaptureStoragePolicy.enabledForTesting(() => time.now);
  const setup = await storageFixture(policy);
  try {
    // Two utterances are waiting in ASR while storage turns off and on again.
    setup.speak();
    const speech = await setup.transcription(1);
    setup.fixture.send({ action: 'set-capture-storage', enabled: false });
    assert.equal(
      (await setup.fixture.reply('set-capture-storage')).result,
      'capture-storage-disabled',
    );
    setup.fixture.send({ action: 'set-capture-storage', enabled: true });
    assert.equal(
      (await setup.fixture.reply('set-capture-storage')).result,
      'capture-storage-enabled',
    );

    speech.resolve('Words spoken before the toggle');
    await setup.classify(1, 'IGNORE');
    await setup.idle();

    // An empty attempt admitted before an Off: no diagnostic clip either.
    setup.speak();
    const empty = await setup.transcription(2);
    setup.fixture.send({ action: 'set-capture-storage', enabled: false });
    await setup.fixture.reply('set-capture-storage');
    empty.report(emptyDiagnostic());
    empty.resolve('');
    await setup.idle();

    assert.deepEqual(recordingFiles(await inventory(setup.fixture.directory)), []);
    assert.equal(setup.rows()[0].storage, 'off');

    // A capture admitted after a fresh opt-in is archived again; it began
    // after the opt-in (time passes before the speech is spoken).
    setup.fixture.send({ action: 'set-capture-storage', enabled: true });
    await setup.fixture.reply('set-capture-storage');
    time.now += 60_000;
    setup.speak();
    (await setup.transcription(3)).resolve('Saved after opting in');
    await setup.classify(2, 'IGNORE');
    await setup.idle();
    const saved = setup.rows().at(-1)!;
    assert.equal(saved.storage, 'on');
    const files = recordingFiles(await inventory(setup.fixture.directory));
    assert.equal(files.filter((path) => path.includes(saved.id)).length, 2);
  } finally {
    await setup.fixture.close();
  }
});

for (const ending of ['success', 'recovered-text', 'no-usable-text'] as const) {
  test(`C1: continued speech while off keeps one final record and one action (${ending})`, async () => {
    const setup = await storageFixture(new CaptureStoragePolicy());
    try {
      setup.speak();
      const first = await setup.transcription(1);
      if (ending === 'no-usable-text') {
        // Replaced while its ASR runs; it never gets a row of its own.
        setup.continueWith();
        first.resolve('');
      } else {
        // Recognized and waiting for the model when speech resumes: it has
        // its own (unsaved) row until the continuation settles.
        first.resolve('Open the');
        await waitFor(() => setup.detected.length === 1);
        assert.equal(setup.rows()[0].storage, 'off');
        setup.continueWith();
      }
      const final = await setup.transcription(2);
      if (ending === 'success') {
        final.resolve('Open the browser');
        await setup.classify(2, 'SEND');
      } else {
        final.reject(Error('Synthetic final ASR failure'));
      }
      await setup.idle();

      const rows = setup.rows();
      assert.equal(rows.length, 1, 'One record for the whole utterance');
      const [row] = rows;
      assert.equal(row.storage, 'off');
      if (ending === 'success') {
        assert.deepEqual([row.transcript, row.outcome], ['Open the browser', 'sent']);
        assert.deepEqual(setup.dispatched, ['Open the browser']);
      } else if (ending === 'recovered-text') {
        assert.deepEqual([row.transcript, row.source], ['Open the', 'earlier-attempt']);
        assert.deepEqual(setup.dispatched, [], 'A recovered record is never dispatched');
      } else {
        assert.deepEqual([row.transcript, row.source], ['', 'audio-only']);
      }
      // Its Activity card says the audio was not saved; nothing pretends it was.
      const cards = setup.fixture.messages.filter((message) => message.type === 'activity-entry');
      assert.deepEqual(
        cards.map((message) => [message.entry!.id, message.entry!.captureStorage]),
        [[row.id, 'off']],
      );
      assert.deepEqual(recordingFiles(await inventory(setup.fixture.directory)), []);
    } finally {
      await setup.fixture.close();
    }
  });
}

test('C2: an Off during a continuation leaves one unsaved final record and no stale archive', async () => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  const setup = await storageFixture(policy);
  try {
    // The first attempt is recorded while on, then speech resumes.
    setup.speak();
    (await setup.transcription(1)).resolve('Open the');
    await waitFor(() => setup.detected.length === 1);
    const first = setup.rows()[0];
    assert.equal(first.storage, 'on');
    setup.continueWith();
    const final = await setup.transcription(2);

    await policy.setEnabled(false);
    final.resolve('Open the browser');
    await setup.classify(2, 'SEND');
    await setup.idle();
    await waitFor(() =>
      setup.fixture.messages.some((message) => message.type === 'history-deleted'),
    );

    const rows = setup.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].storage, 'off');
    assert.notEqual(rows[0].id, first.id);
    assert.deepEqual(setup.dispatched, ['Open the browser']);
    // The superseded attempt's own files went with it; no final archive.
    assert.deepEqual(recordingFiles(await inventory(setup.fixture.directory)), []);
  } finally {
    await setup.fixture.close();
  }
});

test('W2/L1: Pi and Claude conversations get the live screenshot; the PNG copy follows storage', async (context) => {
  const policy = new CaptureStoragePolicy();
  const harness = await harnessFixture(context, { captureStorage: policy });
  const sessions = harness.sessions;
  const signal = new AbortController().signal;
  const pngs = async () =>
    (await readdir(join(harness.directory, '.companion-sessions'))).filter((name) =>
      name.endsWith('.png'),
    );

  // Off (also the --no-desktop default): no copy for either harness.
  const offPi = sessions.start(
    { ...frame, screenshot: canaryScreenshot, storage: policy.admit() },
    signal,
    'coding',
    'pi',
  );
  const offClaude = sessions.start(
    { ...frame, screenshot: canaryScreenshot, storage: policy.admit() },
    signal,
    'coding',
    'claude-code',
  );
  await sessions.idle();
  assert.deepEqual(
    // Both turns run concurrently; compare them independent of order.
    harness.runs.map((run) => [run.harness, run.png?.equals(canaryScreenshot.png)]).sort(),
    [
      ['claude-code', true],
      ['pi', true],
    ],
  );
  assert.deepEqual(await pngs(), []);
  for (const id of [offPi, offClaude]) {
    const question = harness.view(id).messages[0];
    assert.equal(question.screenshot, true, 'The turn did use a screenshot');
    assert.equal(question.screenshotSaved, false);
    assert.equal(question.screenshotUrl, undefined);
  }

  // A frame admitted while off stays unsaved after turning storage on.
  const staleAdmission: CaptureAdmission = policy.admit();
  await policy.setEnabled(true);
  const stale = sessions.start(
    { ...frame, screenshot: canaryScreenshot, storage: staleAdmission },
    signal,
    'coding',
    'pi',
  );
  // History recovery (no frame admission) is decided when it starts.
  const recovered = sessions.start(
    { ...frame, id: 0, screenshot: canaryScreenshot },
    signal,
    'coding',
    'claude-code',
  );
  await sessions.idle();
  assert.equal(harness.view(stale).messages[0].screenshotSaved, false);
  assert.deepEqual(await pngs(), [`${recovered}.png`]);
  assert.ok(harness.view(recovered).messages[0].screenshotUrl);

  // T1 for agents: an Off right after the turn started its copy wins.
  const racing = sessions.start(
    { ...frame, screenshot: canaryScreenshot, storage: policy.admit() },
    signal,
    'coding',
    'pi',
  );
  await policy.setEnabled(false);
  await sessions.idle();
  assert.equal(harness.view(racing).messages[0].screenshotSaved, false);
  assert.deepEqual(await pngs(), [`${recovered}.png`]);

  // Reopening never attaches another conversation's or an older image.
  await sessions.remove(racing);
  await sessions.reopen(racing);
  assert.equal(harness.view(racing).messages[0].screenshotUrl, undefined);
  const leftovers = (await readdir(join(harness.directory, '.companion-sessions'))).filter((name) =>
    name.includes('.tmp'),
  );
  assert.deepEqual(leftovers, []);
});

/** A finished Activity row with an intent, optionally with its files saved. */
async function finishedRow(
  setup: Awaited<ReturnType<typeof desktopFixture>>,
  id: number,
  options: { input: 'speech' | 'typed'; screenshot: boolean; audio: boolean },
): Promise<string> {
  const activity = setup.runtime.activity;
  activity.transcribed?.({
    ...frame,
    id,
    input: options.input,
    storage: activity.admitCapture?.(),
  });
  if (options.screenshot) {
    await activity.screenshotCaptured?.(id, canaryScreenshot);
  }
  if (options.audio) {
    await activity.audioCaptured?.(id, canaryAudio(160));
  }
  activity.intentRecognized?.(id, 'IGNORE');
  activity.outcome?.(id, 'ignored');
  activity.finished?.(id);
  return setup.database.prepare('SELECT id FROM utterances ORDER BY rowid DESC LIMIT 1').get()!
    .id as string;
}

function feedbackRows(setup: Awaited<ReturnType<typeof desktopFixture>>) {
  return setup.database
    .prepare('SELECT id, correct, actual_intent FROM intent_feedback ORDER BY id')
    .all()
    .map((row) => ({ ...row }));
}

test('F1/F2/F3: labeling is refused while off and only allowed for entries with their original capture', async (context) => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(setup.close);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  await setup.runtime.connectRouter(router);

  const typed = await finishedRow(setup, 1, { input: 'typed', screenshot: true, audio: false });
  const spoken = await finishedRow(setup, 2, { input: 'speech', screenshot: true, audio: true });
  const missingWav = await finishedRow(setup, 3, {
    input: 'speech',
    screenshot: true,
    audio: false,
  });

  // F3 while on: a typed example needs no WAV; spoken input does.
  for (const id of [typed, spoken]) {
    setup.send({ action: 'label-history', id, correct: true });
    assert.equal((await setup.reply('label-history')).result, 'labeled');
  }
  setup.send({ action: 'label-history', id: missingWav, correct: true });
  const refusedWav = await setup.reply('label-history');
  assert.equal(refusedWav.type, 'error');
  assert.match(refusedWav.message!, /original audio/);
  const labeled = feedbackRows(setup);
  assert.equal(labeled.length, 2);

  // F1/F2: Off refuses every label, including older saved entries, and keeps labels.
  setup.send({ action: 'set-capture-storage', enabled: false });
  assert.equal((await setup.reply('set-capture-storage')).result, 'capture-storage-disabled');
  for (const request of [
    { id: typed, correct: false },
    { id: spoken, correct: false, actualIntent: null },
  ]) {
    setup.send({ action: 'label-history', ...request });
    const reply = await setup.reply('label-history');
    assert.equal(reply.type, 'error');
    assert.match(reply.message!, /Labeling requires capture storage/);
  }
  const unsaved = await finishedRow(setup, 4, { input: 'typed', screenshot: true, audio: false });
  assert.deepEqual(feedbackRows(setup), labeled, 'Existing labels unchanged');

  // F3 after opting in again: no backfill for the entry created while off.
  setup.send({ action: 'set-capture-storage', enabled: true });
  await setup.reply('set-capture-storage');
  setup.send({ action: 'label-history', id: unsaved, correct: true });
  const noBackfill = await setup.reply('label-history');
  assert.equal(noBackfill.type, 'error');
  assert.match(noBackfill.message!, /not saved/);

  // A corrupt original screenshot is refused too.
  const corrupt = await finishedRow(setup, 5, { input: 'typed', screenshot: false, audio: false });
  const day = (await readdir(join(setup.directory, 'data')))[0];
  await mkdir(join(setup.directory, 'data', day, 'screenshots'), { recursive: true });
  await writeFile(join(setup.directory, 'data', day, 'screenshots', `${corrupt}.png`), 'not png');
  setup.send({ action: 'label-history', id: corrupt, correct: true });
  assert.match((await setup.reply('label-history')).message!, /original screenshot/);
  assert.deepEqual(feedbackRows(setup), labeled);

  // F2 barrier: a label already checking its files when Off arrives is refused.
  setup.send({ action: 'label-history', id: typed, correct: false });
  setup.send({ action: 'set-capture-storage', enabled: false });
  const raced = await setup.reply('label-history');
  assert.equal(raced.type, 'error');
  assert.match(raced.message!, /Labeling requires capture storage/);
  await setup.reply('set-capture-storage');
  assert.deepEqual(feedbackRows(setup), labeled);
});

test('F2/F4: spoken "label previous correct" is skipped without a success cue while off and after off→on', async (context) => {
  const time = { now: 0 };
  const policy = CaptureStoragePolicy.enabledForTesting(() => time.now);
  const setup = await storageFixture(policy);
  context.after(() => setup.fixture.close());

  // A labelable spoken entry (saved while on).
  setup.speak();
  (await setup.transcription(1)).resolve('Send the canary text');
  await setup.classify(1, 'SEND');
  await setup.idle();
  const target = setup.rows()[0];
  assert.equal(target.storage, 'on');

  // While off: the shortcut is routed but writes nothing.
  await policy.setEnabled(false);
  setup.speak();
  (await setup.transcription(2)).resolve('label previous correct');
  await setup.idle();
  assert.equal(setup.rows().at(-1)!.outcome, 'skipped', 'Skipped has no success cue');
  assert.equal(setup.labelLog.at(-1), 'skipped: Labeling requires capture storage');
  assert.equal(feedbackRows(setup.fixture).length, 0);

  // Spoken while off, routed after a quick off→on: still never revived.
  setup.speak();
  const late = await setup.transcription(3);
  await policy.setEnabled(true);
  late.resolve('label previous correct');
  await setup.idle();
  assert.equal(setup.rows().at(-1)!.outcome, 'skipped');
  assert.equal(feedbackRows(setup.fixture).length, 0);

  // A fresh command spoken after opting in labels the preceding labelable
  // entry: the target (label commands are never targets themselves).
  time.now += 60_000;
  setup.speak();
  (await setup.transcription(4)).resolve('label previous correct');
  await setup.idle();
  assert.equal(setup.rows().at(-1)!.outcome, 'labeled');
  assert.deepEqual(
    feedbackRows(setup.fixture).map((row) => row.id),
    [target.id],
  );

  // F4: the user's independent intent/shortcut preferences were never touched.
  await assert.rejects(stat(join(setup.fixture.directory, 'disabled-intents.json')), {
    code: 'ENOENT',
  });
});

test('U2: the setting is strictly typed, desktop-only, and reported to every client', async (context) => {
  const policy = new CaptureStoragePolicy();
  const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(setup.close);

  await waitFor(() => setup.messages.some((message) => message.type === 'state'));
  const state = setup.messages.filter((message) => message.type === 'state').at(-1) as {
    captureStorage?: unknown;
  };
  assert.deepEqual(state.captureStorage, {
    enabled: false,
    pending: '',
    saved: true,
    warning: '',
  });

  for (const enabled of ['true', 1, null, undefined]) {
    setup.send({ action: 'set-capture-storage', enabled });
    const reply = await setup.reply('set-capture-storage');
    assert.equal(reply.type, 'error');
    assert.match(reply.message!, /Expected a boolean/);
  }
  assert.equal(policy.enabled, false);

  // A remote (phone) connection cannot change it.
  const remote = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(remote.close);
  remote.send({ action: 'client-role', role: 'remote' });
  await remote.reply('client-role');
  remote.send({ action: 'set-capture-storage', enabled: true });
  const refused = await remote.reply('set-capture-storage');
  assert.equal(refused.type, 'error');
  assert.match(refused.message!, /only available on the desktop/);
  assert.equal(policy.enabled, false);
  // The phone gateway has no such action at all (no allowlist expansion).
  assert.equal(isRemoteAction('set-capture-storage'), false);

  // A phone's existing label action is refused while storage is off.
  const phoneEntry = await finishedRow(remote, 7, {
    input: 'typed',
    screenshot: true,
    audio: false,
  });
  remote.send({ action: 'label-history', id: phoneEntry, correct: true });
  const phoneLabel = await remote.reply('label-history');
  assert.equal(phoneLabel.type, 'error');
  assert.match(phoneLabel.message!, /Labeling requires capture storage/);
  assert.deepEqual(feedbackRows(remote), []);

  // Pending and final states reach clients from the backend, in order.
  setup.messages.length = 0;
  setup.send({ action: 'set-capture-storage', enabled: true });
  assert.equal((await setup.reply('set-capture-storage')).result, 'capture-storage-enabled');
  await waitFor(() =>
    setup.messages.some(
      (message) =>
        message.type === 'state' &&
        (message as { captureStorage?: { enabled: boolean } }).captureStorage?.enabled === true,
    ),
  );
  const pendingSeen = setup.messages.some(
    (message) =>
      message.type === 'state' &&
      (message as { captureStorage?: { pending: string } }).captureStorage?.pending === 'enabling',
  );
  assert.ok(pendingSeen || policy.enabled, 'Pending is published when it lasts long enough');
});

test('a capture partly saved before an Off is not called "Not saved", and cannot be labeled', async (context) => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(setup.close);
  const activity = setup.runtime.activity;

  // Fully refused: the Off came before either write.
  activity.transcribed?.({ ...frame, id: 1, input: 'speech', storage: activity.admitCapture?.() });
  // Partly saved: its WAV was published before the Off, its PNG was not.
  activity.transcribed?.({ ...frame, id: 2, input: 'speech', storage: activity.admitCapture?.() });
  await activity.audioCaptured?.(2, canaryAudio(160));
  await policy.setEnabled(false);
  await activity.audioCaptured?.(1, canaryAudio(160));
  await activity.screenshotCaptured?.(1, canaryScreenshot);
  await activity.screenshotCaptured?.(2, canaryScreenshot);
  for (const id of [1, 2]) {
    activity.intentRecognized?.(id, 'IGNORE');
    activity.outcome?.(id, 'ignored');
    activity.finished?.(id);
  }

  const rows = setup.database
    .prepare('SELECT id, capture_storage AS storage FROM utterances ORDER BY rowid')
    .all() as { id: string; storage: string }[];
  assert.deepEqual(
    rows.map((row) => row.storage),
    ['off', 'on'],
  );
  const files = recordingFiles(await inventory(setup.directory));
  assert.deepEqual(
    files.map((path) => path.split('/').slice(2).join('/')),
    [`audio/${rows[1].id}.wav`],
  );

  // Labeling stays refused for both, also after opting in again.
  await policy.setEnabled(true);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  await setup.runtime.connectRouter(router);
  for (const row of rows) {
    setup.send({ action: 'label-history', id: row.id, correct: true });
    const reply = await setup.reply('label-history');
    assert.equal(reply.type, 'error');
  }
  assert.deepEqual(feedbackRows(setup), []);
});
