import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import type { AgentSessions } from '../../src/agents/sessions.ts';
import { callTool, harnessFixture } from '../harness-fixture.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { deferred, frame, screenshot, signal } from '../helpers.ts';

const timer = {
  afterSeconds: 60,
  label: 'Synthetic follow-up',
  message: 'Reassess synthetic work',
};

function sessionStore(sessions: AgentSessions): SessionStore {
  return (sessions as unknown as { store: SessionStore }).store;
}

async function media(directory: string) {
  const files = await readdir(directory, { recursive: true });
  return Promise.all(
    files
      .filter((name) => /\.(png|wav)$/.test(name))
      .sort()
      .map(async (name) => [name, (await readFile(join(directory, name))).toString('hex')]),
  );
}

for (const harness of ['pi', 'claude-code'] as const) {
  for (const enabled of [false, true]) {
    test(`${harness}: wake restore preserves capture fields and media across ${enabled ? 'on→off' : 'off→on'}`, async (t) => {
      let now = Date.now();
      const policy = new CaptureStoragePolicy();
      await policy.setEnabled(enabled);
      const f = await harnessFixture(t, {
        captureStorage: policy,
        wakeClock: () => now,
        configuration: { ...defaultAgentSettings, model: 'configured/one' },
      });
      const owner = f.sessions.start(
        { ...frame, storage: policy.admit() },
        signal(),
        'coding',
        harness,
      );
      f.script(owner, async (run) => {
        await callTool(run, 'companion_wake_schedule', timer);
      });
      await f.sessions.idle();
      assert.deepEqual(f.runs[0].png, screenshot.png, 'live input survives either archive choice');
      const original = f.view(owner).messages[0];
      assert.equal(original.screenshotSaved, enabled ? undefined : false);
      assert.equal(!!original.screenshotUrl, enabled);
      const before = await media(f.directory);
      assert.equal(before.length, enabled ? 1 : 0);
      await f.sessions.close();

      const restored = f.open();
      await restored.loadPrevious();
      const events: unknown[] = [];
      restored.subscribe((event) => events.push(event));
      const store = sessionStore(restored);
      const read = store.read.bind(store);
      const entered = deferred<void>();
      const release = deferred<void>();
      store.read = async (id) => {
        const view = await read(id);
        entered.resolve();
        await release.promise;
        return view;
      };
      now += 60_000;
      const ticking = restored.wakes.tick();
      await entered.promise;
      await policy.setEnabled(!enabled);
      release.resolve();
      await ticking;
      await restored.idle();
      assert.equal(f.runs.length, 2);
      assert.equal(f.runs[1].id, owner);
      assert.equal(f.runs[1].screenshot, false);
      assert.equal(f.runs[1].png, undefined);
      assert.match(f.runs[1].text, /scheduled wake/);
      assert.equal(restored.wakes.list(owner, 1)[0].state, 'completed');
      assert.deepEqual(
        await media(f.directory),
        before,
        'wake neither archives nor changes original media',
      );
      const question = f.view(owner, restored).messages[0];
      assert.equal(question.screenshotSaved, enabled ? undefined : false);
      assert.equal(
        !!question.screenshotUrl,
        enabled,
        'off-period message never borrows an old PNG',
      );
      const saved = JSON.parse(
        await readFile(join(f.directory, '.companion-sessions', `${owner}.json`), 'utf8'),
      );
      assert.equal(saved.messages[0].screenshotSaved, enabled ? undefined : false);
      assert.equal(saved.wakes, undefined, 'timer projection stays out of ordinary history');
      assert.ok(
        events.some(
          (event) =>
            (event as { type: string; reveal?: boolean }).type === 'agent-restored' &&
            (event as { reveal?: boolean }).reveal === false,
        ),
      );
      assert.equal(policy.enabled, !enabled, 'background restore cannot replace the shared policy');
    });
  }
}

test('revoked screenshot publication, ordinary FIFO and queued wake keep the shared capture policy', async (t) => {
  let now = Date.now();
  const policy = CaptureStoragePolicy.enabledForTesting();
  const f = await harnessFixture(t, {
    captureStorage: policy,
    wakeClock: () => now,
    configuration: { ...defaultAgentSettings, model: 'configured/one' },
  });
  const store = sessionStore(f.sessions);
  const save = store.screenshot.bind(store);
  const entered = deferred<void>();
  const release = deferred<void>();
  store.screenshot = async (...args) => {
    entered.resolve();
    await release.promise;
    return save(...args);
  };
  const owner = f.sessions.start({ ...frame, storage: policy.admit() }, signal(), 'coding', 'pi');
  f.script(owner, async (run) => {
    await callTool(run, 'companion_wake_schedule', timer);
  });
  await entered.promise;
  const off = policy.setEnabled(false);
  release.resolve();
  await off;
  await policy.setEnabled(true);
  await f.sessions.idle();
  assert.equal(f.view(owner).messages[0].screenshotSaved, false);
  assert.deepEqual(await media(f.directory), []);
  assert.deepEqual(f.runs[0].png, screenshot.png);

  const ordinary = deferred<void>();
  f.script(owner, async () => {
    await ordinary.promise;
  });
  f.sessions.followUp(owner, 'Ordinary reply before due', signal());
  now += 60_000;
  await f.sessions.wakes.tick();
  assert.equal(f.sessions.wakes.list(owner)[0].state, 'waiting');
  await policy.setEnabled(false);
  ordinary.resolve();
  await f.sessions.idle();
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.deepEqual(
    f.runs.map((run) => run.screenshot),
    [true, false, false],
  );
  assert.deepEqual(await media(f.directory), []);
  assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'completed');
  assert.equal(f.view(owner).messages[0].screenshotSaved, false);
});

test('desktop label refusal while capture is off coexists with pending-wake cancellation', async (t) => {
  let now = Date.now();
  const policy = CaptureStoragePolicy.enabledForTesting();
  const f = await harnessFixture(t, {
    captureStorage: policy,
    wakeClock: () => now,
    configuration: { ...defaultAgentSettings, model: 'configured/one' },
  });
  const desktop = await desktopFixture(async () => Buffer.alloc(0), f.sessions, {
    captureStorage: policy,
  });
  t.after(desktop.close);
  const activity = desktop.runtime.activity;
  activity.transcribed?.({ ...frame, input: 'typed', storage: policy.admit() });
  await activity.screenshotCaptured?.(frame.id, screenshot);
  activity.intentRecognized?.(frame.id, 'IGNORE');
  activity.outcome?.(frame.id, 'ignored');
  activity.finished?.(frame.id);
  const entry = desktop.database.prepare('SELECT id FROM utterances').get() as { id: string };
  const owner = f.sessions.startRemote('Synthetic owner', 'coding', signal());
  f.script(owner, async (run) => {
    await callTool(run, 'companion_wake_schedule', timer);
  });
  await f.sessions.idle();
  const pending = f.sessions.wakes.list(owner)[0];
  desktop.send({ action: 'set-capture-storage', enabled: false });
  assert.equal((await desktop.reply('set-capture-storage')).result, 'capture-storage-disabled');
  desktop.send({ action: 'label-history', id: entry.id, correct: true });
  const refused = await desktop.reply('label-history');
  assert.equal(refused.type, 'error');
  assert.match(refused.message!, /capture storage/i);
  desktop.send({ action: 'cancel-agent-wake', id: owner, timerId: pending.id });
  assert.equal((await desktop.reply('cancel-agent-wake')).result, 'cancelled');
  now += 60_000;
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.runs.length, 1);
  assert.equal(policy.enabled, false);
  assert.equal(
    (
      desktop.database.prepare('SELECT count(*) AS total FROM intent_feedback').get() as {
        total: number;
      }
    ).total,
    0,
  );
});
