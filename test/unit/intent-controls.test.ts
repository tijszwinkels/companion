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
    assert.deepEqual(await new IntentPreferences(path).load(), {
      inference: new Set(['CUSTOM']),
      shortcut: new Set(['CUSTOM']),
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const request of [
      { name: 'IGNORE', enabled: false },
      { name: 'MISSING', enabled: false },
      { name: 'CUSTOM', enabled: 'false' },
    ]) {
      desktop.send({ action: 'set-intent-enabled', ...request });
      assert.equal((await desktop.reply('set-intent-enabled')).type, 'error');
    }
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      version: 1,
      disabledInference: ['CUSTOM'],
      disabledShortcuts: ['CUSTOM'],
    });
    desktop.send({ action: 'set-intent-enabled', name: 'CUSTOM', enabled: true });
    assert.equal((await desktop.reply('set-intent-enabled')).result, 'intent-enabled');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      version: 1,
      disabledInference: [],
      disabledShortcuts: [],
    });
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
    assert.deepEqual(await new IntentPreferences(path).load(), {
      inference: new Set(['TWO']),
      shortcut: new Set(['TWO']),
    });
    await writeFile(path, '["IGNORE"]');
    await assert.rejects(new IntentPreferences(path).load(), /Invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inference and shortcut switches independently select routes and cancel only their own delivery', async () => {
  let offered: string[] = [];
  const entered = deferred<void>();
  let hold = false;
  let deliverySignal: AbortSignal | undefined;
  let delivered = 0;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect(_frame, intents) {
          offered = intents.map((intent) => intent.name);
          return offered.includes('CUSTOM') ? 'CUSTOM' : 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  router.register({
    ...processor('CUSTOM', async (_frame, inputSignal) => {
      delivered++;
      if (hold) {
        deliverySignal = inputSignal;
        entered.resolve();
        await stopped(inputSignal);
      }
    }),
    prefixes: ['custom'],
  });

  router.setEnabled('CUSTOM', false, 'inference');
  await router.route(frame, signal());
  assert.deepEqual(offered, ['IGNORE']);
  await router.route({ ...frame, utterance: 'custom payload' }, signal());
  assert.equal(delivered, 1);
  router.setEnabled('CUSTOM', true, 'inference');
  router.setEnabled('CUSTOM', false, 'shortcut');
  await router.route({ ...frame, utterance: 'custom payload' }, signal());
  assert.equal(delivered, 1, 'Disabled shortcuts remain reserved, without falling through');
  await router.route(frame, signal());
  assert.deepEqual(offered, ['IGNORE', 'CUSTOM']);
  assert.equal(delivered, 2);

  router.setEnabled('CUSTOM', true, 'shortcut');
  hold = true;
  const pending = router.route({ ...frame, utterance: 'custom payload' }, signal());
  const rejected = assert.rejects(pending, /abort/i);
  await entered.promise;
  router.setEnabled('CUSTOM', false, 'inference');
  assert.equal(router.intentStates()[1].shortcutEnabled, true);
  assert.equal(
    deliverySignal?.aborted,
    false,
    'Disabling inference must not abort shortcut delivery',
  );
  router.setEnabled('CUSTOM', false, 'shortcut');
  await rejected;
});

test('shortcut changes do not invalidate inference, but off/on inference cannot revive a result', async () => {
  for (const disableMode of ['shortcut', 'inference'] as const) {
    const entered = deferred<void>();
    const answer = deferred<string>();
    let delivered = 0;
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
    );
    processor('IGNORE').subscribe(router);
    router.register({
      ...processor('CUSTOM', async () => {
        delivered++;
      }),
      prefixes: ['custom'],
    });
    const pending = router.route(frame, signal());
    await entered.promise;
    router.setEnabled('CUSTOM', false, disableMode);
    router.setEnabled('CUSTOM', true, disableMode);
    answer.resolve('CUSTOM');
    await pending;
    assert.equal(delivered, disableMode === 'shortcut' ? 1 : 0);
  }
});

test('socket mode controls migrate legacy choices, persist independently and reject unsupported modes', async () => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop command'));
  const path = join(dirname(desktop.socketPath), 'disabled-intents.json');
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
  router.register({ ...processor('CUSTOM'), prefixes: ['custom'] });
  router.register({ ...processor('SHORTCUT'), instruction: undefined, prefixes: ['shortcut'] });
  try {
    await writeFile(path, '["CUSTOM","UNKNOWN_OLD_MODULE"]');
    await desktop.runtime.connectRouter(router);
    assert.equal(router.intentStates()[1].inferenceEnabled, false);
    assert.equal(router.intentStates()[1].shortcutEnabled, false);
    assert.equal(await readFile(path, 'utf8'), '["CUSTOM","UNKNOWN_OLD_MODULE"]');

    desktop.send({ action: 'set-intent-enabled', name: 'CUSTOM', enabled: true, mode: 'shortcut' });
    assert.equal((await desktop.reply('set-intent-enabled')).type, 'result');
    assert.equal(router.intentStates()[1].inferenceEnabled, false);
    assert.equal(router.intentStates()[1].shortcutEnabled, true);
    const saved = await new IntentPreferences(path).load();
    assert.deepEqual([...saved.inference].sort(), ['CUSTOM', 'UNKNOWN_OLD_MODULE']);
    assert.deepEqual([...saved.shortcut], ['UNKNOWN_OLD_MODULE']);
    const before = await readFile(path, 'utf8');
    for (const request of [
      { name: 'SHORTCUT', mode: 'inference', enabled: false },
      { name: 'IGNORE', mode: 'shortcut', enabled: true },
      { name: 'CUSTOM', mode: 'both', enabled: false },
      { name: 'CUSTOM', mode: null, enabled: false },
    ]) {
      desktop.send({ action: 'set-intent-enabled', ...request });
      assert.equal((await desktop.reply('set-intent-enabled')).type, 'error');
    }
    assert.equal(await readFile(path, 'utf8'), before);
  } finally {
    await desktop.close();
  }
});
