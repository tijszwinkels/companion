import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { desktopFixture, findArtifact, windowReply } from '../desktop-fixture.ts';
import { deferred, processor, screenshot, testDetector, testSensors } from '../helpers.ts';

test('typed utterances share speech FIFO, shortcuts, inference, history and screenshot storage without ASR or audio', async () => {
  const setup = await desktopFixture(async () => windowReply());
  const spoken = deferred<string>();
  const delivered: string[] = [];
  const inferred: string[] = [];
  let transcriptions = 0;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (frame) => {
          inferred.push(frame.utterance);
          return 'IGNORE';
        },
      }),
    },
    () => {},
    setup.runtime.activity,
  );
  const ignore = processor('IGNORE', async (frame) => {
    delivered.push(frame.utterance);
    setup.runtime.activity.outcome?.(frame.id, 'ignored');
  });
  ignore.prefixes = ['ignore'];
  ignore.subscribe(router);
  const pipeline = new SensorPipeline(
    {
      router,
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => {
          transcriptions++;
          return spoken.promise;
        },
      }),
    },
    () => {},
    setup.controller.signal,
    setup.runtime.activity,
  );
  try {
    await setup.runtime.connectRouter(router);
    setup.runtime.connectPipeline(pipeline);
    pipeline.submit(new Float32Array(2048));
    setup.pause.toggle(); // Explicit text is still usable with a paused microphone.
    setup.send({ action: 'submit-utterance', text: 'ignore typed shortcut', target: '0xabc' });
    assert.equal((await setup.reply('submit-utterance')).result, 'queued');
    setup.send({ action: 'submit-utterance', text: 'typed inference', target: '0xabc' });
    assert.equal((await setup.reply('submit-utterance')).result, 'queued');
    setup.send({ action: 'submit-utterance', text: 'overflow', target: '0xabc' });
    assert.match((await setup.reply('submit-utterance')).message!, /queue is full/);
    spoken.resolve('spoken first');
    await pipeline.idle();
    assert.equal(transcriptions, 1);
    assert.deepEqual(delivered, ['spoken first', 'typed shortcut', 'typed inference']);
    assert.deepEqual(inferred, ['spoken first', 'typed inference']);
    const rows = setup.database
      .prepare(
        'SELECT id, transcript AS utterance, recognized_intent, outcome FROM utterances ORDER BY rowid',
      )
      .all();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.utterance),
      ['spoken first', 'ignore typed shortcut', 'typed inference'],
    );
    for (const row of rows) {
      assert.equal(row.recognized_intent, 'IGNORE');
      assert.equal(row.outcome, 'ignored');
      await findArtifact(setup.directory, row.id as string, 'screenshots');
    }
    const days = await readdir(join(setup.directory, 'data'));
    const wavs = (
      await Promise.all(days.map((day) => readdir(join(setup.directory, 'data', day, 'audio'))))
    ).flat();
    assert.deepEqual(wavs, [`${rows[0].id}.wav`]);
  } finally {
    spoken.resolve('cleanup');
    await pipeline.idle();
    await setup.close();
  }
});

test('typed input rejects invalid text and focused Companion, and a changed capture target never routes', async () => {
  const setup = await desktopFixture(async () => windowReply());
  let routed = 0;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          routed++;
          return 'IGNORE';
        },
      }),
    },
    () => {},
    setup.runtime.activity,
  );
  processor('IGNORE').subscribe(router);
  const pipeline = new SensorPipeline(
    {
      router,
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => assert.fail('No ASR for typed text'),
      }),
    },
    () => {},
    setup.controller.signal,
    setup.runtime.activity,
  );
  try {
    setup.runtime.connectPipeline(pipeline);
    for (const text of ['', '   ', 'x'.repeat(8001)]) {
      setup.send({ action: 'submit-utterance', text, target: '0xabc' });
      const refusal = await setup.reply('submit-utterance');
      assert.equal(refusal.type, 'error');
      assert.match(refusal.message!, /1 and 8000 characters/);
    }
    setup.send({ action: 'panel-state', id: '', composerFocused: false, keyboardFocused: true });
    await setup.reply('panel-state');
    setup.send({ action: 'submit-utterance', text: 'retained draft', target: '0xabc' });
    assert.match((await setup.reply('submit-utterance')).message!, /Release Companion/);
    setup.send({ action: 'panel-state', id: '', composerFocused: false, keyboardFocused: false });
    setup.send({ action: 'submit-utterance', text: 'focus changed', target: '0x999' });
    assert.equal((await setup.reply('submit-utterance')).result, 'queued');
    // The longest typed utterance fits the desktop socket's framing even
    // when every character needs a six-character JSON escape.
    const longest = '\u0001'.repeat(8000);
    setup.send({ action: 'submit-utterance', text: longest, target: '0x999' });
    assert.equal((await setup.reply('submit-utterance')).result, 'queued');
    await pipeline.idle();
    assert.equal(routed, 0);
    const rows = setup.database
      .prepare('SELECT transcript AS utterance, outcome FROM utterances ORDER BY rowid')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { utterance: 'focus changed', outcome: 'error' },
      { utterance: longest, outcome: 'error' },
    ]);
  } finally {
    await pipeline.idle();
    await setup.close();
  }
});
