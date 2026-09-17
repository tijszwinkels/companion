import assert from 'node:assert/strict';
import test from 'node:test';

import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import type { RunCommand } from '../../src/sensors/screen/capture.ts';
import { desktopFixture, stopped, waitFor, windowReply } from '../desktop-fixture.ts';
import { deferred, frame, screenshot } from '../helpers.ts';

test('recovery rejects an utterance whose automatic keyboard process already started', async () => {
  const typing = deferred<void>();
  const finish = deferred<void>();
  let writes = 0;
  const run: RunCommand = async (file) => {
    if (file === 'hyprctl') {
      return windowReply();
    }

    assert.equal(file, 'wtype');
    writes++;
    typing.resolve();
    await finish.promise;
    return Buffer.alloc(0);
  };
  const fixture = await desktopFixture(run);

  try {
    const id = fixture.seed();
    const processor = new SendTextToApplication(() => {}, false, run, fixture.runtime.activity);
    const automatic = processor.process(frame, fixture.controller.signal);
    await typing.promise;
    fixture.send({ action: 'paste', id, target: frame.screenshot.window.address });
    const reply = await fixture.reply('paste');
    assert.equal(reply.type, 'error');
    assert.match(reply.message!, /already being delivered/);
    assert.equal(writes, 1);

    finish.resolve();
    await automatic;
    assert.equal(fixture.database.prepare('SELECT outcome FROM utterances').get()?.outcome, 'sent');
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM paste_events').get()?.outcome,
      'error',
    );
  } finally {
    finish.resolve();
    await fixture.close();
  }
});

test('recovery arriving during automatic focus lookup wins without duplicate typing', async () => {
  const checking = deferred<void>();
  const finishCheck = deferred<void>();
  let checks = 0;
  let writes = 0;
  const run: RunCommand = async (file) => {
    if (file === 'hyprctl') {
      if (++checks === 1) {
        checking.resolve();
        await finishCheck.promise;
      }

      return windowReply();
    }

    assert.equal(file, 'wtype');
    writes++;
    return Buffer.alloc(0);
  };
  const fixture = await desktopFixture(run);

  try {
    const id = fixture.seed();
    const processor = new SendTextToApplication(() => {}, false, run, fixture.runtime.activity);
    const automatic = processor.process(frame, fixture.controller.signal);
    await checking.promise;
    fixture.send({ action: 'paste', id, target: frame.screenshot.window.address });
    await waitFor(
      () => fixture.database.prepare('SELECT count(*) AS n FROM paste_events').get()?.n === 1,
    );
    finishCheck.resolve();
    await automatic;
    assert.equal((await fixture.reply('paste')).result, 'sent');
    assert.equal(writes, 1);
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM utterances').get()?.outcome,
      'skipped',
    );
  } finally {
    finishCheck.resolve();
    await fixture.close();
  }
});

test('different utterances serialize keyboard output and check focus after waiting', async () => {
  const typing = deferred<void>();
  const finish = deferred<void>();
  let address = frame.screenshot.window.address;
  let checks = 0;
  let writes = 0;
  const run: RunCommand = async (file) => {
    if (file === 'hyprctl') {
      checks++;
      return windowReply(address);
    }

    assert.equal(file, 'wtype');
    writes++;
    typing.resolve();
    await finish.promise;
    return Buffer.alloc(0);
  };
  const fixture = await desktopFixture(run);

  try {
    const id = fixture.seed();
    fixture.send({ action: 'paste', id, target: address });
    await typing.promise;
    fixture.seed(2);
    const processor = new SendTextToApplication(() => {}, false, run, fixture.runtime.activity);
    const automatic = processor.process({ ...frame, id: 2 }, fixture.controller.signal);
    await Promise.resolve();
    assert.equal(checks, 2, 'Automatic focus lookup must wait for manual typing');
    address = '0xdef';
    finish.resolve();
    await automatic;
    assert.equal((await fixture.reply('paste')).result, 'sent');
    assert.equal(writes, 1);
    assert.equal(checks, 3);
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM utterances ORDER BY rowid DESC LIMIT 1').get()
        ?.outcome,
      'skipped',
    );
  } finally {
    finish.resolve();
    await fixture.close();
  }
});

test('pause and mute controls take effect on the same connection during a paste', async () => {
  const typing = deferred<void>();
  const finish = deferred<void>();
  const fixture = await desktopFixture(async (file) => {
    if (file === 'hyprctl') {
      return windowReply();
    }

    assert.equal(file, 'wtype');
    typing.resolve();
    await finish.promise;
    return Buffer.alloc(0);
  });

  try {
    fixture.send({ action: 'toggle-sounds' });
    assert.equal((await fixture.reply('toggle-sounds')).result, 'sounds-enabled');
    fixture.send({ action: 'paste', id: fixture.seed(), target: frame.screenshot.window.address });
    await typing.promise;
    fixture.send({ action: 'toggle-pause' });
    fixture.send({ action: 'toggle-sounds' });
    assert.equal((await fixture.reply('toggle-pause')).result, 'paused');
    assert.equal((await fixture.reply('toggle-sounds')).result, 'sounds-muted');
    assert.equal(fixture.pause.paused, true);
    assert.equal(
      fixture.database.prepare('SELECT outcome FROM paste_events').get()?.outcome,
      'pending',
    );
    finish.resolve();
    assert.equal((await fixture.reply('paste')).result, 'sent');
  } finally {
    finish.resolve();
    await fixture.close();
  }
});

test('the initial recovery focus lookup times out and leaves controls responsive', async () => {
  const checking = deferred<void>();
  const fixture = await desktopFixture(async (file, _args, signal) => {
    assert.equal(file, 'hyprctl');
    checking.resolve();
    return stopped(signal);
  });

  try {
    fixture.send({ action: 'paste', id: fixture.seed(), target: frame.screenshot.window.address });
    await checking.promise;
    fixture.send({ action: 'toggle-pause' });
    assert.equal((await fixture.reply('toggle-pause')).result, 'paused');
    assert.equal((await fixture.reply('paste', 6500)).type, 'error');
    const row = fixture.database
      .prepare('SELECT outcome, delivery_started_at FROM paste_events')
      .get();
    assert.equal(row?.outcome, 'error');
    assert.equal(row?.delivery_started_at, null);
  } finally {
    await fixture.close();
  }
});

for (const duringTyping of [false, true]) {
  test(`manual shutdown ${duringTyping ? 'during' : 'before'} typing records delivery uncertainty accurately`, async () => {
    const blocked = deferred<void>();
    const fixture = await desktopFixture(async (file, _args, signal) => {
      if (file === 'hyprctl' && duringTyping) {
        return windowReply();
      }

      assert.equal(file, duringTyping ? 'wtype' : 'hyprctl');
      blocked.resolve();
      return stopped(signal);
    });

    try {
      fixture.send({
        action: 'paste',
        id: fixture.seed(),
        target: frame.screenshot.window.address,
      });
      await blocked.promise;
      fixture.controller.abort();
      assert.equal((await fixture.reply('paste')).type, 'error');
      const row = fixture.database
        .prepare('SELECT outcome, delivery_started_at, target_application FROM paste_events')
        .get();
      assert.equal(row?.outcome, duringTyping ? 'interrupted' : 'cancelled');
      assert.equal(row?.delivery_started_at !== null, duringTyping);

      if (duringTyping) {
        assert.equal(row?.target_application, 'fixture');
      }
    } finally {
      await fixture.close();
    }
  });
}

test('pausing automatic typing records interrupted through the pipeline instead of cancelled', async () => {
  const typing = deferred<void>();
  const run: RunCommand = async (file, _args, signal) => {
    if (file === 'hyprctl') {
      return windowReply();
    }

    assert.equal(file, 'wtype');
    typing.resolve();
    return stopped(signal);
  };
  const fixture = await desktopFixture(run);
  const router = new UserSensorRouter(
    { detect: async () => 'SEND_TEXT_TO_APPLICATION' },
    () => {},
    fixture.runtime.activity,
  );
  new SendTextToApplication(() => {}, false, run, fixture.runtime.activity).subscribe(router);
  new Ignore(() => {}, fixture.runtime.activity).subscribe(router);
  const pipeline = new SensorPipeline(
    { capture: async () => screenshot, transcribe: async () => 'Fixture text' },
    router,
    () => {},
    fixture.controller.signal,
    fixture.runtime.activity,
  );

  try {
    pipeline.submit(new Float32Array(16000), fixture.pause.signal);
    await typing.promise;
    fixture.pause.toggle();
    await pipeline.idle();
    const row = fixture.database
      .prepare('SELECT outcome, recognized_intent, delivery_started_at FROM utterances')
      .get();
    assert.equal(row?.outcome, 'interrupted');
    assert.equal(row?.recognized_intent, 'SEND_TEXT_TO_APPLICATION');
    assert.equal(typeof row?.delivery_started_at, 'number');
  } finally {
    fixture.controller.abort();
    await pipeline.idle();
    await fixture.close();
  }
});
