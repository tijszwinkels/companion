import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { UserSensorRouter } from '../../src/core/router.ts';
import { IntentPreferences } from '../../src/desktop/intent-preferences.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, processor, signal, testDetector } from '../helpers.ts';

test('disabled prefixes are consumed, disabled intents leave the prompt, and IGNORE stays available', async () => {
  let inference = 0;
  let delivered = 0;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect(_frame, intents) {
          inference++;
          assert.deepEqual(
            intents.map((intent) => intent.name),
            ['IGNORE'],
          );
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  router.register({
    ...processor('INSERT', async () => {
      delivered++;
    }),
    prefixes: ['insert'],
  });
  router.register({
    ...processor('CODE', async () => {
      delivered++;
    }),
    prefixes: ['insert code'],
  });
  router.setEnabled('CODE', false);
  await router.route({ ...frame, utterance: 'insert code hello' }, signal());
  assert.equal(delivered, 0, 'A disabled longer prefix cannot invoke the shorter prefix');
  router.setEnabled('INSERT', false);
  await router.route({ ...frame, utterance: 'insert hello' }, signal());
  assert.equal(inference, 0, 'Disabled explicit commands never fall back to inference');
  await router.route(frame, signal());
  assert.equal(inference, 1);
  assert.equal(delivered, 0);
  assert.throws(() => router.setEnabled('IGNORE', false), /fallback/);
  assert.throws(() => router.setEnabled('MISSING', false), /Unknown/);
  router.setEnabled('INSERT', true);
  await router.route({ ...frame, utterance: 'insert hello' }, signal());
  assert.equal(delivered, 1);
});

test('switching off and on during inference cannot revive the old result', async () => {
  const entered = deferred<void>();
  const answer = deferred<string>();
  const outcomes: string[] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          entered.resolve();
          return answer.promise;
        },
      }),
    },
    () => {},
    {
      outcome: (_id, outcome) => {
        outcomes.push(outcome);
      },
    },
  );
  processor('IGNORE').subscribe(router);
  processor('CUSTOM', async () => assert.fail('Disabled result dispatched')).subscribe(router);
  const pending = router.route(frame, signal());
  await entered.promise;
  router.setEnabled('CUSTOM', false);
  router.setEnabled('CUSTOM', true);
  answer.resolve('CUSTOM');
  assert.equal(await pending, 'CUSTOM');
  assert.deepEqual(outcomes, ['skipped']);
});

test('switching off cancels a processor already waiting to deliver', async () => {
  const entered = deferred<void>();
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  router.register({
    ...processor('INSERT', async (_frame, inputSignal) => {
      entered.resolve();
      await stopped(inputSignal);
    }),
    prefixes: ['insert'],
  });
  const pending = router.route({ ...frame, utterance: 'insert hello' }, signal());
  const rejected = assert.rejects(pending, /abort/i);
  await entered.promise;
  router.setEnabled('INSERT', false);
  await rejected;
});

test('live inventory distinguishes context eligibility, prefix-only commands and disabled state', () => {
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  router.register({
    ...processor('CONTEXT'),
    prefixes: ['message'],
    availableForInference: (context) => Boolean(context.interaction?.agentComposerFocused),
    availableForPrefix: (context) => Boolean(context.interaction?.agentSessionId),
  });
  assert.equal(router.intentStates()[0].inferenceAvailable, false);
  assert.equal(router.intentStates()[0].prefixAvailable, false);
  const interaction = { agentSessionId: 'selected', agentComposerFocused: false, revision: 1 };
  assert.equal(router.intentStates({ interaction })[0].prefixAvailable, true);
  assert.equal(router.intentStates({ interaction })[0].inferenceAvailable, false);
  assert.equal(
    router.intentStates({ interaction: { ...interaction, agentComposerFocused: true } })[0]
      .inferenceAvailable,
    true,
  );
  router.register({ ...processor('ENTER'), instruction: undefined, prefixes: ['enter'] });
  assert.equal(router.intentStates()[1].inferenceAvailable, false);
  assert.equal(router.intentStates()[1].prefixAvailable, true);
  router.setEnabled('CONTEXT', false);
  assert.equal(router.intentStates({ interaction })[0].enabled, false);
});

test('private socket switches the actual router, broadcasts state, rejects invalid controls and saves preferences', async () => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop command'));
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  processor('CUSTOM', async () => assert.fail('Disabled action dispatched')).subscribe(router);
  try {
    await desktop.runtime.connectRouter(router);
    await waitFor(() => desktop.messages.some((message) => message.intents?.length === 2));
    desktop.send({ action: 'set-intent-enabled', name: 'CUSTOM', enabled: false });
    assert.equal((await desktop.reply('set-intent-enabled')).result, 'intent-disabled');
    assert.equal(router.intentStates()[1].enabled, false);
    assert.ok(
      desktop.messages.some((message) =>
        message.intents?.some((intent) => intent.name === 'CUSTOM' && !intent.enabled),
      ),
    );
    const path = join(dirname(desktop.socketPath), 'disabled-intents.json');
    assert.deepEqual(await new IntentPreferences(path).load(), new Set(['CUSTOM']));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const request of [
      { name: 'IGNORE', enabled: false },
      { name: 'MISSING', enabled: false },
      { name: 'CUSTOM', enabled: 'false' },
    ]) {
      desktop.send({ action: 'set-intent-enabled', ...request });
      assert.equal((await desktop.reply('set-intent-enabled')).type, 'error');
    }
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ['CUSTOM']);
    desktop.send({ action: 'set-intent-enabled', name: 'CUSTOM', enabled: true });
    assert.equal((await desktop.reply('set-intent-enabled')).result, 'intent-enabled');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  } finally {
    await desktop.close();
  }
});

test('preferences serialize writes, survive reload and reject malformed saved state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-intent-preferences-'));
  const path = join(directory, 'disabled-intents.json');
  try {
    const preferences = new IntentPreferences(path);
    await preferences.load();
    const applied: string[] = [];
    await Promise.all([
      preferences.setEnabled('ONE', false, () => {
        applied.push('ONE off');
      }),
      preferences.setEnabled('TWO', false, () => {
        applied.push('TWO off');
      }),
      preferences.setEnabled('ONE', true, () => {
        applied.push('ONE on');
      }),
    ]);
    assert.deepEqual(applied, ['ONE off', 'TWO off', 'ONE on']);
    assert.deepEqual(await new IntentPreferences(path).load(), new Set(['TWO']));
    await writeFile(path, '["IGNORE"]');
    await assert.rejects(new IntentPreferences(path).load(), /Invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
