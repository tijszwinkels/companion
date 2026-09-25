import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { SessionStore } from '../../src/agents/session-store.ts';
import { defaultAgentSettings, defaultClaudeCodeSettings } from '../../src/agents/settings.ts';
import type { AgentSession, ClaudeCodeSettings } from '../../src/agents/types.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { harnessFixture } from '../harness-fixture.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';

const claudeDefault = {
  ...defaultAgentSettings,
  codingDefaultHarness: 'claude-code',
  claudeCode: { executable: '/opt/claude-a', model: 'claude-sonnet-5', effort: 'medium' },
};

async function savedJson(directory: string, id: string): Promise<Record<string, unknown>> {
  const path = join(directory, '.companion-sessions', `${id}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

test('an absent harness means Pi: nothing is recorded and Pi answers', async (context) => {
  const { sessions, runs, view, directory } = await harnessFixture(context);
  const id = sessions.start(frame, signal());
  await sessions.idle();

  assert.deepEqual(
    runs.map((run) => run.harness),
    ['pi'],
  );
  assert.equal(view(id).status, 'completed');
  assert.equal(view(id).harness, undefined);
  assert.equal(view(id).claudeCode, undefined);
  assert.equal(view(id).model, defaultAgentSettings.model);

  const saved = await savedJson(directory, id);
  assert.equal('harness' in saved, false);
  assert.equal('claudeCode' in saved, false);
});

test('the coding default harness selects Claude Code with the configured model and effort', async (context) => {
  const { sessions, runs, view, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  assert.equal(runs.length, 1);
  assert.equal(runs[0].harness, 'claude-code');
  assert.deepEqual(runs[0].settings, {
    executable: '/opt/claude-a',
    model: 'claude-sonnet-5',
    effort: 'medium',
  });
  assert.equal(runs[0].resume, false);
  assert.equal(runs[0].screenshot, true, 'the speech-end screenshot reaches Claude Code');

  assert.equal(view(id).status, 'completed');
  assert.equal(view(id).harness, 'claude-code');
  assert.deepEqual(view(id).claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
  assert.equal(view(id).model, 'claude-sonnet-5');

  const saved = await savedJson(directory, id);
  assert.equal(saved.harness, 'claude-code');
  assert.deepEqual(saved.claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
});

test('an explicit harness overrides the coding default; quick questions always use Pi', async (context) => {
  const { sessions, runs, view } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const pi = sessions.start(frame, signal(), 'coding', 'pi');
  const quick = sessions.start(frame, signal(), 'quickQuestion');
  const quickClaude = sessions.start(frame, signal(), 'quickQuestion', 'claude-code');
  await sessions.idle();

  // Concurrent first turns may reach their backends in any order.
  const harnessById = new Map(runs.map((run) => [run.id, run.harness]));
  assert.equal(runs.length, 3);
  assert.equal(harnessById.get(pi), 'pi');
  assert.equal(harnessById.get(quick), 'pi');
  assert.equal(harnessById.get(quickClaude), 'pi');
  for (const id of [pi, quick, quickClaude]) {
    assert.equal(view(id).harness, undefined);
  }

  const { sessions: piDefault, runs: piRuns } = await harnessFixture(context);
  piDefault.start(frame, signal(), 'coding', 'claude-code');
  await piDefault.idle();
  assert.equal(piRuns[0].harness, 'claude-code');
  assert.equal((piRuns[0].settings as ClaudeCodeSettings).model, defaultClaudeCodeSettings.model);
});

test('Claude model and effort are captured once; the executable is read for every turn', async (context) => {
  const { sessions, runs, view, configure, open, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  // A later configuration edit changes only the executable of this conversation.
  await configure({
    ...claudeDefault,
    claudeCode: { executable: '/opt/claude-b', model: 'claude-opus-5-5', effort: 'max' },
  });
  sessions.followUp(id, 'Second turn', signal());
  await sessions.idle();
  assert.deepEqual(runs[1].settings, {
    executable: '/opt/claude-b',
    model: 'claude-sonnet-5',
    effort: 'medium',
  });
  assert.equal(runs[1].resume, true);
  assert.equal(view(id).model, 'claude-sonnet-5');

  // Close, then load in a new listener as after a restart.
  await sessions.remove(id);
  await sessions.close();
  const restarted = open();
  await restarted.loadPrevious();
  const previous = restarted.previousSnapshot().find((entry) => entry.id === id);
  assert.equal(previous?.harness, 'claude-code');
  assert.deepEqual(previous?.claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });

  await restarted.reopen(id);
  assert.equal(view(id, restarted).harness, 'claude-code');
  restarted.followUp(id, 'After restart', signal());
  await restarted.idle();
  assert.equal(runs[2].harness, 'claude-code');
  assert.equal(runs[2].resume, true);
  assert.deepEqual(runs[2].settings, {
    executable: '/opt/claude-b',
    model: 'claude-sonnet-5',
    effort: 'medium',
  });

  const saved = await savedJson(directory, id);
  assert.deepEqual(saved.claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
});

test('a Claude Code conversation without a wired backend fails visibly and never runs Pi', async (context) => {
  const { sessions, runs, view } = await harnessFixture(context, {
    configuration: claudeDefault,
    claudeCode: false,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  assert.equal(runs.length, 0);
  assert.equal(view(id).status, 'error');
  assert.match(view(id).error, /Claude Code is not available/);
  assert.equal(view(id).harness, 'claude-code', 'the harness is still recorded');

  // A follow-up fails the same way instead of falling back to Pi.
  sessions.followUp(id, 'Try again', signal());
  await sessions.idle();
  assert.equal(runs.length, 0);
  assert.equal(view(id).status, 'error');
  assert.match(view(id).error, /Claude Code is not available/);
});

test('a saved Claude Code conversation reopened without its backend fails visibly', async (context) => {
  const withClaude = await harnessFixture(context, { configuration: claudeDefault });
  const id = withClaude.sessions.start(frame, signal());
  await withClaude.sessions.idle();
  await withClaude.sessions.remove(id);
  await withClaude.sessions.close();

  const withoutClaude = await harnessFixture(context, { claudeCode: false });
  // Only the display archive moves; the other listener has no Claude Code.
  const archive = join('.companion-sessions', `${id}.json`);
  await mkdir(join(withoutClaude.directory, '.companion-sessions'), { recursive: true });
  await copyFile(join(withClaude.directory, archive), join(withoutClaude.directory, archive));

  await withoutClaude.sessions.loadPrevious();
  await withoutClaude.sessions.reopen(id);
  withoutClaude.sessions.followUp(id, 'Continue', signal());
  await withoutClaude.sessions.idle();
  assert.equal(withoutClaude.runs.length, 0);
  assert.equal(withoutClaude.view(id).status, 'error');
  assert.match(withoutClaude.view(id).error, /Claude Code is not available/);
});

test('a broken configuration fails the first turn in its own tab', async (context) => {
  const { sessions, runs, view, configure } = await harnessFixture(context);
  await configure({ ...defaultAgentSettings, codingDefaultHarness: 'codex' });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  assert.equal(runs.length, 0);
  assert.equal(view(id).status, 'error');
  assert.match(view(id).error, /codingDefaultHarness/);
});

test('Claude Code follow-ups queue in order and stop/close keep the harness', async (context) => {
  const { sessions, runs, view, script, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const entered = deferred<void>();
  const finish = deferred<void>();
  const id = sessions.start(frame, signal());
  script(id, async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;

  assert.deepEqual(sessions.followUp(id, 'First queued', signal()), {
    outcome: 'queued',
    queuePosition: 1,
  });
  assert.deepEqual(sessions.followUp(id, 'Second queued', signal()), {
    outcome: 'queued',
    queuePosition: 2,
  });
  finish.resolve();
  await sessions.idle();

  assert.deepEqual(
    runs.map((run) => [run.harness, run.text, run.resume]),
    [
      ['claude-code', frame.utterance, false],
      ['claude-code', 'First queued', true],
      ['claude-code', 'Second queued', true],
    ],
  );

  // Stop a running Claude Code turn; a queued message is cancelled with it.
  const stalled = deferred<void>();
  script(id, async (run) => {
    stalled.resolve();
    await new Promise((resolve) => run.signal.addEventListener('abort', resolve));
  });
  sessions.followUp(id, 'Long turn', signal());
  await stalled.promise;
  sessions.followUp(id, 'Never runs', signal());
  await sessions.stop(id);
  assert.equal(view(id).status, 'cancelled');
  assert.equal(runs.length, 4);
  assert.equal(view(id).messages.find((message) => message.text === 'Never runs')?.state, 'error');

  await sessions.remove(id);
  const saved = await savedJson(directory, id);
  assert.equal(saved.harness, 'claude-code');
  assert.equal(saved.status, 'cancelled');
});

test('Claude Code conversations refuse Pi model IDs and effort changes', async (context) => {
  const { sessions, view } = await harnessFixture(context, { configuration: claudeDefault });
  const id = sessions.start(frame, signal());

  // Before the first turn has read the configuration, the harness is unknown.
  await assert.rejects(sessions.setModel(id, 'configured/one', signal()), /still starting/);
  await sessions.idle();

  // A Pi model ID is never reinterpreted as a Claude model.
  await assert.rejects(
    sessions.setModel(id, 'configured/one', signal()),
    /configured\/one is not an available Claude model/,
  );
  await assert.rejects(
    sessions.setThinking(id, 'high', signal()),
    /Claude Code conversation keeps the effort chosen when it started/,
  );
  assert.equal(view(id).modelOverride, undefined);
  assert.equal(view(id).thinkingOverride, undefined);
  assert.deepEqual(view(id).claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });

  // Pi conversations keep their pickers; a Claude ID is not a Pi model.
  const pi = sessions.start(frame, signal(), 'coding', 'pi');
  await sessions.idle();
  await assert.rejects(
    sessions.setModel(pi, 'claude-opus-5-5', signal()),
    /Choose an available configured Pi model/,
  );
  await sessions.setModel(pi, 'configured/two', signal());
  assert.equal(view(pi).modelOverride, 'configured/two');
  assert.equal(view(pi).harness, undefined);
  assert.equal(view(pi).claudeCode, undefined);
  assert.deepEqual((await sessions.models(signal())).models, ['configured/one', 'configured/two']);
});

test('the store round-trips old archives and validates the harness fields', async (context) => {
  const { directory } = await harnessFixture(context);
  const store = new SessionStore(join(directory, '.companion-sessions'));
  const id = '11111111-2222-4333-8444-555555555555';
  const path = join(directory, '.companion-sessions', `${id}.json`);
  const legacy: AgentSession = {
    id,
    title: 'Old conversation',
    status: 'completed',
    model: 'openai-codex/gpt-6-astra',
    error: '',
    updatedAt: 1,
    messages: [],
  };

  // An archive written before harnesses existed stays valid and stays Pi.
  await store.save({ ...legacy });
  const restored = await store.read(id);
  assert.equal(restored.harness, undefined);
  assert.equal(restored.claudeCode, undefined);
  await store.save(restored);
  assert.equal('harness' in JSON.parse(await readFile(path, 'utf8')), false);

  // An explicit Pi harness is accepted and normalized to absence.
  await writeFile(path, JSON.stringify({ ...legacy, harness: 'pi' }));
  assert.equal((await store.read(id)).harness, undefined);

  const claudeCode = { model: 'claude-opus-5-5', effort: 'high' };
  await writeFile(path, JSON.stringify({ ...legacy, harness: 'claude-code', claudeCode }));
  const claude = await store.read(id);
  assert.equal(claude.harness, 'claude-code');
  assert.deepEqual(claude.claudeCode, claudeCode);

  const invalid: Record<string, unknown>[] = [
    { harness: 'codex' },
    { harness: 'claude-code' },
    { claudeCode },
    { harness: 'pi', claudeCode },
    { harness: 'claude-code', claudeCode: { model: 'anthropic/claude', effort: 'high' } },
    { harness: 'claude-code', claudeCode: { model: '-p', effort: 'high' } },
    { harness: 'claude-code', claudeCode: { model: 'claude opus', effort: 'high' } },
    { harness: 'claude-code', claudeCode: { model: 'claude-opus-5-5', effort: 'ultra' } },
    { harness: 'claude-code', claudeCode, modelOverride: 'configured/one' },
    { harness: 'claude-code', claudeCode, thinkingOverride: 'high' },
  ];
  for (const fields of invalid) {
    await writeFile(path, JSON.stringify({ ...legacy, ...fields }));
    await assert.rejects(store.read(id), /Invalid saved conversation/, JSON.stringify(fields));
  }
});

test('desktop clients receive the harness fields, the Claude catalogue and model choices', async (context) => {
  const { sessions } = await harnessFixture(context, { configuration: claudeDefault });
  const desktop = await desktopFixture(async () => Buffer.from(''), sessions);
  context.after(() => desktop.close());
  const id = sessions.start(frame, signal());
  await sessions.idle();

  // Updates and reconnect snapshots carry the whole view; older clients
  // simply ignore the optional fields.
  await waitFor(() =>
    desktop.messages.some(
      (message) =>
        message.type === 'agent-session' &&
        message.session?.harness === 'claude-code' &&
        message.session.claudeCode?.model === 'claude-sonnet-5',
    ),
  );
  desktop.send({ action: 'toggle-pause' });
  await desktop.reply('toggle-pause');
  await waitFor(() =>
    desktop.messages.some(
      (message) =>
        message.type === 'state' &&
        message.sessions?.[0]?.harness === 'claude-code' &&
        message.sessions[0].claudeCode?.effort === 'medium',
    ),
  );

  desktop.send({ action: 'agent-models' });
  const catalog = await desktop.reply('agent-models');
  assert.deepEqual((catalog.result as unknown as Record<string, unknown>).claudeCode, {
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    model: 'claude-sonnet-5',
    effort: 'medium',
  });

  desktop.send({ action: 'set-agent-model', id, model: 'configured/one' });
  const refused = await desktop.reply('set-agent-model');
  assert.equal(refused.type, 'error');
  assert.match(refused.message ?? '', /configured\/one is not an available Claude model/);

  desktop.send({ action: 'set-agent-model', id, model: 'claude-opus-5-5' });
  assert.equal((await desktop.reply('set-agent-model')).result, 'model-selected');
  await waitFor(() =>
    desktop.messages.some(
      (message) =>
        message.type === 'agent-session' &&
        message.session?.id === id &&
        message.session.claudeCode?.model === 'claude-opus-5-5' &&
        message.session.claudeCode.effort === 'medium',
    ),
  );
});

test('an unresolved Claude Code start retries while open but reopens as Pi', async (context) => {
  const { sessions, runs, view, configure, directory } = await harnessFixture(context);
  const broken = { ...defaultAgentSettings, claudeCode: { effort: 'ultra' } };
  await configure(broken);
  const open = sessions.start(frame, signal(), 'coding', 'claude-code');
  const closed = sessions.start(frame, signal(), 'coding', 'claude-code');
  await sessions.idle();

  for (const id of [open, closed]) {
    assert.equal(view(id).status, 'error');
    assert.match(view(id).error, /effort/);
    assert.equal(view(id).harness, undefined, 'nothing was resolved');
    assert.equal('harness' in (await savedJson(directory, id)), false);
  }
  assert.equal(runs.length, 0);
  await configure({ ...defaultAgentSettings });

  // Still open: the next turn resolves the requested harness from the file.
  sessions.followUp(open, 'Retry', signal());
  await sessions.idle();
  assert.equal(runs.at(-1)?.harness, 'claude-code');
  assert.equal(view(open).harness, 'claude-code');

  // Closed and reopened: the archive is an ordinary Pi conversation. Pi gets
  // a resume request, which a real Pi refuses visibly (it has no transcript).
  await sessions.remove(closed);
  await sessions.reopen(closed);
  sessions.followUp(closed, 'After reopen', signal());
  await sessions.idle();
  assert.equal(runs.at(-1)?.id, closed);
  assert.equal(runs.at(-1)?.harness, 'pi');
  assert.equal(runs.at(-1)?.resume, true);
  assert.equal(view(closed).harness, undefined);
});
