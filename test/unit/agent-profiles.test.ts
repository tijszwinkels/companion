import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultAgentSettings,
  defaultQuickQuestionSettings,
  loadAgentSettings,
} from '../../src/agents/settings.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { deferred, frame, signal } from '../helpers.ts';

async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-profiles-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'companion-agent.json') };
}

test('one config selects coding and quick-question models and preserves existing user edits', async (context) => {
  const { directory, path } = await fixture(context);
  assert.deepEqual(await loadAgentSettings(directory), defaultAgentSettings);
  const initialized = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(initialized.quickQuestion, defaultQuickQuestionSettings);

  const legacy = JSON.stringify({
    ...defaultAgentSettings,
    executable: '/custom/pi',
    thinking: 'low',
  });
  await writeFile(path, legacy);
  assert.deepEqual(await loadAgentSettings(directory, 'quickQuestion'), {
    executable: '/custom/pi',
    ...defaultQuickQuestionSettings,
  });
  assert.equal((await loadAgentSettings(directory)).thinking, 'low');
  assert.equal(
    await readFile(path, 'utf8'),
    legacy,
    'Reading never rewrites existing configuration',
  );

  await writeFile(
    path,
    JSON.stringify({
      ...defaultAgentSettings,
      quickQuestion: { model: 'my-local/other-qwen', thinking: 'minimal' },
    }),
  );
  assert.deepEqual(await loadAgentSettings(directory, 'quickQuestion'), {
    executable: 'pi',
    model: 'my-local/other-qwen',
    thinking: 'minimal',
  });
  assert.deepEqual(await loadAgentSettings(directory), defaultAgentSettings);
  for (const quickQuestion of [
    null,
    [],
    'qwen',
    { model: '' },
    { model: 'missing-provider' },
    { thinking: 'typo' },
    { executable: 'other-pi' },
  ]) {
    await writeFile(path, JSON.stringify({ ...defaultAgentSettings, quickQuestion }));
    await assert.rejects(loadAgentSettings(directory, 'quickQuestion'), /quickQuestion/);
  }
});

test('quick conversations retain their profile across queued turns, process restart and reopening', async (context) => {
  const { directory, path } = await fixture(context);
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const entered = deferred<void>();
  const finish = deferred<void>();
  const backend: AgentBackend = {
    id: 'profiles',
    label: 'Profile fixture',
    dependencies: {},
    async run(request) {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await finish.promise;
      }
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => finish.resolve());
  context.after(() => sessions.close());
  const id = sessions.start(frame, signal(), 'quickQuestion');
  await entered.promise;
  sessions.followUp(id, 'Queued follow-up', signal());
  finish.resolve();
  await sessions.idle();
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every((request) => request.settings.model === defaultQuickQuestionSettings.model),
  );
  assert.equal(requests[1].resume, true);
  assert.equal(sessions.snapshot()[0].profile, 'quickQuestion');
  await sessions.remove(id);
  await sessions.close();

  const restarted = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => restarted.close());
  await restarted.loadPrevious();
  await restarted.reopen(id);
  restarted.followUp(id, 'Reopened follow-up', signal());
  await restarted.idle();
  assert.equal(requests.at(-1)?.settings.model, defaultQuickQuestionSettings.model);
  assert.equal(requests.at(-1)?.id, id);

  // Settings edits still take effect per turn within the conversation's profile.
  await writeFile(
    path,
    JSON.stringify({ ...defaultAgentSettings, quickQuestion: { model: 'local/changed' } }),
  );
  restarted.followUp(id, 'Apply configuration edit', signal());
  await restarted.idle();
  assert.equal(requests.at(-1)?.settings.model, 'local/changed');
  restarted.start(frame, signal());
  await restarted.idle();
  assert.equal(requests.at(-1)?.settings.model, defaultAgentSettings.model);
});

test('old archived conversations retain coding settings; invalid stored profiles fail clearly', async (context) => {
  const { directory } = await fixture(context);
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const backend: AgentBackend = {
    id: 'profiles',
    label: 'Profiles',
    dependencies: {},
    async run(request) {
      requests.push(request);
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => sessions.close());
  const id = sessions.start(frame, signal());
  await sessions.idle();
  await sessions.remove(id);
  const store = new SessionStore(join(directory, '.companion-sessions'));
  const saved = await store.read(id);
  delete saved.profile;
  await store.save(saved);
  await sessions.reopen(id);
  sessions.followUp(id, 'Legacy follow-up', signal());
  await sessions.idle();
  assert.equal(requests.at(-1)?.settings.model, defaultAgentSettings.model);
  const savedPath = join(directory, '.companion-sessions', `${id}.json`);
  await writeFile(savedPath, JSON.stringify({ ...saved, profile: 'unknown' }));
  await assert.rejects(store.read(id), /Invalid saved conversation/);
});

test('quick-question preview and cancellation never launch an agent', async (context) => {
  const { directory } = await fixture(context);
  const backend: AgentBackend = {
    id: 'profiles',
    label: 'Profiles',
    dependencies: {},
    async run() {
      assert.fail('Preview launched an agent');
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => sessions.close());
  const preview = new QuickQuestion({ sessions }, () => {}, true);
  await preview.process(frame, signal());
  await assert.rejects(preview.process(frame, AbortSignal.abort()));
  assert.deepEqual(sessions.snapshot(), []);
});
