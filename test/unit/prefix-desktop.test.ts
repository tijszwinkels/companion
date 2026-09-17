import assert from 'node:assert/strict';
import test from 'node:test';

import { UserSensorRouter } from '../../src/core/router.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import type { RunCommand } from '../../src/sensors/screen/capture.ts';
import { desktopFixture, stopped, windowReply } from '../desktop-fixture.ts';
import { deferred, frame, screenshot } from '../helpers.ts';

function shortcuts(fixture: Awaited<ReturnType<typeof desktopFixture>>, run: RunCommand) {
  const activity = fixture.runtime.activity;
  const router = new UserSensorRouter(
    { detect: async () => assert.fail('Explicit shortcut must not call the LLM') },
    () => {},
    activity,
  );
  new SendTextToApplication(() => {}, false, run, activity).subscribe(router);
  new EnterTextToApplication(() => {}, false, run, activity).subscribe(router);
  return router;
}

for (const prefix of ['insert', 'enter']) {
  test(`${prefix} records the original transcript, resolved intent, and actual delivery`, async () => {
    const keys: string[][] = [];
    const run: RunCommand = async (file, args) => {
      if (file === 'hyprctl') {
        return windowReply();
      }
      keys.push(args);
      return Buffer.alloc(0);
    };
    const fixture = await desktopFixture(run);
    const utterance = `${prefix} Hello world`;
    const pipeline = new SensorPipeline(
      { capture: async () => screenshot, transcribe: async () => utterance },
      shortcuts(fixture, run),
      () => {},
      fixture.controller.signal,
      fixture.runtime.activity,
    );

    try {
      pipeline.submit(new Float32Array(16000));
      await pipeline.idle();
      const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
      assert.equal(row.transcript, utterance);
      assert.equal(
        row.recognized_intent,
        prefix === 'insert' ? 'SEND_TEXT_TO_APPLICATION' : 'ENTER_TEXT_TO_APPLICATION',
      );
      assert.equal(row.outcome, 'sent');
      assert.equal(typeof row.delivery_started_at, 'number');
      assert.deepEqual(
        keys,
        prefix === 'insert'
          ? [['--', 'Hello world']]
          : [
              ['--', 'Hello world'],
              ['-k', 'Return'],
            ],
      );
    } finally {
      fixture.controller.abort();
      await pipeline.idle();
      await fixture.close();
    }
  });
}

test('bare shortcut history has a skipped outcome without a delivery marker', async () => {
  const run: RunCommand = async () => assert.fail('Empty command must not access the desktop');
  const fixture = await desktopFixture(run);

  try {
    fixture.runtime.activity.transcribed?.({ ...frame, utterance: 'Enter.' });
    await shortcuts(fixture, run).route(
      { ...frame, utterance: 'Enter.' },
      fixture.controller.signal,
    );
    const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
    assert.equal(row.recognized_intent, 'ENTER_TEXT_TO_APPLICATION');
    assert.equal(row.outcome, 'skipped');
    assert.equal(row.delivery_started_at, null);
  } finally {
    await fixture.close();
  }
});

test('Enter owns the keyboard until Return completes, excluding recovery and later insertion', async () => {
  const pressingEnter = deferred<void>();
  const releaseEnter = deferred<void>();
  const keys: string[][] = [];
  const run: RunCommand = async (file, args) => {
    if (file === 'hyprctl') {
      return windowReply();
    }
    keys.push(args);
    if (args[0] === '-k') {
      pressingEnter.resolve();
      await releaseEnter.promise;
    }
    return Buffer.alloc(0);
  };
  const fixture = await desktopFixture(run);

  try {
    const id = fixture.seed();
    const router = shortcuts(fixture, run);
    const first = router.route({ ...frame, utterance: 'enter First' }, fixture.controller.signal);
    await pressingEnter.promise;
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM utterances').get()?.outcome,
      'delivering',
    );

    fixture.send({ action: 'paste', id, target: screenshot.window.address });
    assert.match((await fixture.reply('paste')).message!, /already being delivered/);
    fixture.seed(2);
    const second = router.route(
      { ...frame, id: 2, utterance: 'insert Second' },
      fixture.controller.signal,
    );
    await Promise.resolve();
    assert.deepEqual(keys, [
      ['--', 'First'],
      ['-k', 'Return'],
    ]);

    releaseEnter.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(keys, [
      ['--', 'First'],
      ['-k', 'Return'],
      ['--', 'Second'],
    ]);
    const rows = fixture.database.prepare('SELECT outcome FROM utterances').all();
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['sent', 'sent'],
    );
  } finally {
    releaseEnter.resolve();
    await fixture.close();
  }
});

test('pausing between text and Enter records interrupted delivery and never presses Return', async () => {
  const checkingAgain = deferred<void>();
  let checks = 0;
  const keys: string[][] = [];
  const run: RunCommand = async (file, args, signal) => {
    if (file === 'hyprctl') {
      if (++checks === 2) {
        checkingAgain.resolve();
        return stopped(signal);
      }
      return windowReply();
    }
    keys.push(args);
    return Buffer.alloc(0);
  };
  const fixture = await desktopFixture(run);
  const pipeline = new SensorPipeline(
    { capture: async () => screenshot, transcribe: async () => 'enter Hello' },
    shortcuts(fixture, run),
    () => {},
    fixture.controller.signal,
    fixture.runtime.activity,
  );

  try {
    pipeline.submit(new Float32Array(16000), fixture.pause.signal);
    await checkingAgain.promise;
    fixture.pause.toggle();
    await pipeline.idle();
    const row = fixture.database.prepare('SELECT * FROM utterances').get()!;
    assert.equal(row.outcome, 'interrupted');
    assert.equal(typeof row.delivery_started_at, 'number');
    assert.deepEqual(keys, [['--', 'Hello']]);
  } finally {
    fixture.controller.abort();
    await pipeline.idle();
    await fixture.close();
  }
});
