import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { LabelPreviousCorrect } from '../../src/processors/label-previous-correct.ts';
import { LabelPreviousIncorrect } from '../../src/processors/label-previous-incorrect.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { frame, screenshot, signal, testDetector, testSensors } from '../helpers.ts';

test('sensor input saves the exact PNG before inference; bare feedback commands update only their target', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const directory = dirname(fixture.socketPath);
  const activity = fixture.runtime.activity;
  let utterance = 'Ordinary speech';
  let detections = 0;
  let originalId = '';
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect(input, intents) {
          detections++;
          assert.deepEqual(
            intents.map((intent) => intent.name),
            ['IGNORE'],
          );
          assert.equal(input.screenshot, screenshot);
          const row = fixture.database
            .prepare('SELECT * FROM utterances ORDER BY rowid DESC LIMIT 1')
            .get()!;
          originalId = String(row.id);
          assert.equal(row.recognized_intent, null);
          assert.deepEqual(
            await readFile(join(directory, String(row.screenshot_path))),
            screenshot.png,
          );
          return 'IGNORE';
        },
      }),
    },
    () => {},
    activity,
  );
  new Ignore(() => {}, activity).subscribe(router);
  new LabelPreviousCorrect(() => {}, false, activity).subscribe(router);
  new LabelPreviousIncorrect(() => {}, false, activity).subscribe(router);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({ capture: async () => screenshot, transcribe: async () => utterance }),
      router,
    },
    () => {},
    fixture.controller.signal,
    activity,
  );

  try {
    pipeline.submit(new Float32Array(16000));
    await pipeline.idle();
    assert.equal(
      fixture.database.prepare('SELECT count(*) AS count FROM intent_feedback').get()?.count,
      0,
    );

    // Successive corrections must keep targeting the original speech. Include
    // ASR punctuation/case and the spelling in the original feature request.
    for (const [text, correct] of [
      ['LABEL PREVIOUS CORRECT.', true],
      ['label previous incorrect', false],
      ['label previous correct', true],
      ['label previous incorrent', false],
    ] as const) {
      utterance = text;
      pipeline.submit(new Float32Array(16000));
      await pipeline.idle();
      const labels = fixture.database.prepare('SELECT * FROM intent_feedback').all();
      assert.deepEqual(
        labels.map((row) => ({ ...row })),
        [
          {
            id: originalId,
            correct: Number(correct),
            recognized_intent: 'IGNORE',
            actual_intent: correct ? 'IGNORE' : null,
          },
        ],
      );
    }

    assert.equal(detections, 1);
    assert.equal(pipeline.failures, 0);
    const rows = fixture.database.prepare('SELECT * FROM utterances ORDER BY rowid').all();
    assert.equal(rows[0].recognized_intent, 'IGNORE');
    assert.equal(rows[0].outcome, 'ignored');
    assert.deepEqual(
      rows.slice(1).map((row) => row.outcome),
      ['labeled', 'labeled', 'labeled', 'labeled'],
    );

    for (const row of rows) {
      const path = join(directory, String(row.screenshot_path));
      assert.ok(path.endsWith(`/screenshots/${row.id}.png`));
      assert.deepEqual(await readFile(path), screenshot.png);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await fixture.close();
  }
});

test('feedback survives restart and uses insertion order, without jumping over an unclassified utterance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-feedback-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);

  try {
    await history.open();
    history.add({ ...frame, observedAt: 5000 });
    history.setIntent(1, 'SEND_TEXT_TO_APPLICATION');
    history.setOutcome(1, 'skipped');
    const original = history.snapshot()[0];
    history.finish(1);
    history.close();
    await history.open();

    history.add({ ...frame, observedAt: 1000, utterance: 'label previous incorrect' });
    history.setIntent(1, 'LABEL_PREVIOUS_INCORRECT');
    assert.equal(history.labelPrevious(1, false), original.id);
    history.setOutcome(1, 'labeled');
    history.finish(1);

    history.add({ ...frame, id: 2, utterance: 'Capture failed' });
    history.setOutcome(2, 'error');
    history.finish(2);
    history.add({ ...frame, id: 3, utterance: 'label previous correct' });
    history.setIntent(3, 'LABEL_PREVIOUS_CORRECT');
    assert.equal(history.labelPrevious(3, true), undefined);
    history.finish(3);
    history.close();
    await history.open();

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        database
          .prepare('SELECT * FROM intent_feedback')
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: original.id,
            correct: 0,
            recognized_intent: 'SEND_TEXT_TO_APPLICATION',
            actual_intent: null,
          },
        ],
      );
      assert.equal(history.find(original.id)?.outcome, 'skipped');
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('feedback skips missing targets, extra text, disabled commands, preview, and cancellation', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const activity = fixture.runtime.activity;
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Feedback called the LLM') }) },
    () => {},
    activity,
  );
  new LabelPreviousCorrect(() => {}, false, activity).subscribe(router);
  new LabelPreviousIncorrect(() => {}, true, activity).subscribe(router);

  try {
    // First ever utterance has no target and must create no feedback row.
    fixture.seed(1);
    await router.route({ ...frame, utterance: 'label previous correct' }, signal());
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM utterances').get()?.outcome,
      'skipped',
    );
    activity.finished?.(1);

    fixture.seed(2);
    activity.intentRecognized?.(2, 'IGNORE');
    activity.outcome?.(2, 'ignored');
    activity.finished?.(2);

    fixture.seed(3);
    await router.route(
      { ...frame, id: 3, utterance: 'label previous correct means feedback' },
      signal(),
    );
    activity.finished?.(3);

    fixture.seed(4);
    await router.route({ ...frame, id: 4, utterance: 'label previous incorrect' }, signal());
    activity.finished?.(4);

    router.setEnabled('LABEL_PREVIOUS_CORRECT', false);
    fixture.seed(5);
    await router.route({ ...frame, id: 5, utterance: 'label previous correct' }, signal());
    activity.finished?.(5);

    router.setEnabled('LABEL_PREVIOUS_CORRECT', true);
    fixture.seed(6);
    await assert.rejects(
      router.route({ ...frame, id: 6, utterance: 'label previous correct' }, AbortSignal.abort()),
    );
    activity.finished?.(6);

    assert.equal(
      fixture.database.prepare('SELECT count(*) AS count FROM intent_feedback').get()?.count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('screenshots use the observation local date, with missing images represented by null', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-screenshots-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);

  try {
    await history.open();
    const observedAt = new Date(2026, 8, 19, 23, 59).getTime();
    history.add({ ...frame, observedAt });
    const entry = history.snapshot()[0];
    await history.saveScreenshot(1, screenshot);
    history.finish(1);
    history.add({ ...frame, id: 2 });
    history.setOutcome(2, 'error');
    history.finish(2);

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = database.prepare('SELECT screenshot_path FROM utterances ORDER BY rowid').all();
      assert.equal(rows[0].screenshot_path, `data/2026-09-19/screenshots/${entry.id}.png`);
      assert.equal(rows[1].screenshot_path, null);
      assert.deepEqual(
        await readFile(join(directory, String(rows[0].screenshot_path))),
        screenshot.png,
      );
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('screenshot write failure retains text and prevents inference with an unsaved image', async () => {
  const fixture = await desktopFixture(async () => Buffer.alloc(0));
  const directory = dirname(fixture.socketPath);
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => assert.fail('Unsaved image reached inference'),
      }),
    },
    () => {},
  );
  new Ignore(() => {}).subscribe(router);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({ capture: async () => screenshot, transcribe: async () => 'Keep this text' }),
      router,
    },
    () => {},
    fixture.controller.signal,
    fixture.runtime.activity,
  );

  try {
    await writeFile(join(directory, 'data'), 'Block creation of the screenshot directory');
    pipeline.submit(new Float32Array(16000));
    await pipeline.idle();
    const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
    assert.equal(row.transcript, 'Keep this text');
    assert.equal(row.screenshot_path, null);
    assert.equal(row.recognized_intent, null);
    assert.equal(row.outcome, 'error');
    assert.equal(pipeline.failures, 1);
  } finally {
    await fixture.close();
  }
});
