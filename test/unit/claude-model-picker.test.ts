import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { claudeCodeModelCatalog, claudeCodeModelChoices } from '../../src/agents/claude/models.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { defaultAgentSettings, defaultClaudeCodeSettings } from '../../src/agents/settings.ts';
import type { ClaudeCodeSettings } from '../../src/agents/types.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { harnessFixture } from '../harness-fixture.ts';

// Synthetic conversations only: scripted backends, temporary directories. No
// real Claude Code process runs. The real CLI's resume-with-another-model
// behaviour is documented in src/agents/claude/README.md.

const claudeDefault = {
  ...defaultAgentSettings,
  codingDefaultHarness: 'claude-code',
  claudeCode: { executable: '/opt/claude-a', model: 'claude-sonnet-5', effort: 'medium' },
};

async function savedJson(directory: string, id: string): Promise<Record<string, unknown>> {
  const path = join(directory, '.companion-sessions', `${id}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function claudeSettings(settings: unknown): ClaudeCodeSettings {
  return settings as ClaudeCodeSettings;
}

test('the Claude catalogue is a fixed list of exact IDs plus the configured default', () => {
  assert.deepEqual(claudeCodeModelChoices, [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]);
  assert.ok(Object.isFrozen(claudeCodeModelChoices));
  assert.deepEqual(claudeCodeModelCatalog('claude-opus-5-5'), claudeCodeModelChoices);
  assert.deepEqual(claudeCodeModelCatalog('claude-opus-4-8'), [
    ...claudeCodeModelChoices,
    'claude-opus-4-8',
  ]);
});

test('a chosen Claude model runs the next turn in the same conversation with the same effort', async (context) => {
  const { sessions, runs, view, open, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  await sessions.setModel(id, 'claude-opus-5-5', signal());
  assert.deepEqual(view(id).claudeCode, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(view(id).model, 'claude-sonnet-5', 'model still names the last turn');
  assert.equal(view(id).harness, 'claude-code');
  assert.equal(view(id).modelOverride, undefined, 'never stored as a Pi override');

  // The archive keeps the older {model, effort} shape, now with the choice.
  const saved = await savedJson(directory, id);
  assert.deepEqual(saved.claudeCode, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal('modelOverride' in saved, false);

  sessions.followUp(id, 'Second turn', signal());
  await sessions.idle();
  assert.equal(runs[1].harness, 'claude-code');
  assert.equal(runs[1].id, id, 'the same Companion UUID and native Claude session');
  assert.equal(runs[1].resume, true);
  assert.deepEqual(runs[1].settings, {
    executable: '/opt/claude-a',
    model: 'claude-opus-5-5',
    effort: 'medium',
  });
  assert.equal(runs[1].previousModel, 'claude-sonnet-5');
  assert.equal(view(id).model, 'claude-opus-5-5');

  // Only the first turn after the switch reports a previous model.
  sessions.followUp(id, 'Third turn', signal());
  await sessions.idle();
  assert.equal(claudeSettings(runs[2].settings).model, 'claude-opus-5-5');
  assert.equal(runs[2].previousModel, undefined);

  // The choice survives closing and a listener restart.
  await sessions.remove(id);
  await sessions.close();
  const restarted = open();
  await restarted.loadPrevious();
  await restarted.reopen(id);
  assert.deepEqual(view(id, restarted).claudeCode, { model: 'claude-opus-5-5', effort: 'medium' });
  await restarted.setModel(id, 'claude-haiku-4-5-20251001', signal());
  restarted.followUp(id, 'After restart', signal());
  await restarted.idle();
  assert.equal(runs[3].resume, true);
  assert.equal(claudeSettings(runs[3].settings).model, 'claude-haiku-4-5-20251001');
  assert.equal(claudeSettings(runs[3].settings).effort, 'medium');
  assert.equal(runs[3].previousModel, 'claude-opus-5-5');
});

test('invalid Claude model choices fail visibly and change nothing', async (context) => {
  const { sessions, runs, view, configure, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();
  const before = await savedJson(directory, id);

  // Exact IDs only: no aliases, trimming, case folding, Pi IDs or unknowns.
  const invalid = [
    'opus',
    'sonnet',
    ' claude-opus-5-5',
    'claude-opus-5-5 ',
    'CLAUDE-OPUS-5-5',
    'anthropic/claude-opus-5-5',
    'configured/one',
    'claude-bogus-9',
    '--model',
  ];
  for (const model of invalid) {
    await assert.rejects(
      sessions.setModel(id, model, signal()),
      /is not an available Claude model\. Choose one of: claude-fable-5-1, claude-opus-5-5/,
      JSON.stringify(model),
    );
  }
  await assert.rejects(sessions.setModel(id, '', signal()), /Choose a Claude model/);
  assert.deepEqual(view(id).claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
  assert.deepEqual(await savedJson(directory, id), before);

  // The conversation's current model is always a valid (unchanged) choice.
  await sessions.setModel(id, 'claude-sonnet-5', signal());

  // The configured default is selectable even when it is not in the list.
  await configure({
    ...claudeDefault,
    claudeCode: { ...claudeDefault.claudeCode, model: 'claude-opus-4-8', effort: 'max' },
  });
  await sessions.setModel(id, 'claude-opus-4-8', signal());
  assert.deepEqual(
    view(id).claudeCode,
    { model: 'claude-opus-4-8', effort: 'medium' },
    'the conversation keeps its own effort, not the configured one',
  );

  sessions.followUp(id, 'Next', signal());
  await sessions.idle();
  assert.equal(claudeSettings(runs[1].settings).model, 'claude-opus-4-8');
  assert.equal(claudeSettings(runs[1].settings).effort, 'medium');
});

test('a choice during a running turn applies to the next queued turn only', async (context) => {
  const { sessions, runs, view, script } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  const entered = deferred<void>();
  const finish = deferred<void>();
  script(id, async () => {
    entered.resolve();
    await finish.promise;
  });
  sessions.followUp(id, 'Running', signal());
  await entered.promise;
  sessions.followUp(id, 'Queued before the choice', signal());

  await sessions.setModel(id, 'claude-opus-5-5', signal());
  assert.equal(view(id).model, 'claude-sonnet-5', 'the running turn keeps its model');
  finish.resolve();
  await sessions.idle();

  assert.deepEqual(
    runs.map((run) => [run.text, claudeSettings(run.settings).model, run.previousModel]),
    [
      [frame.utterance, 'claude-sonnet-5', undefined],
      ['Running', 'claude-sonnet-5', undefined],
      // Queued turns use the choice present when each turn begins.
      ['Queued before the choice', 'claude-opus-5-5', 'claude-sonnet-5'],
    ],
  );
});

test('a failed Claude choice rolls back before the queued turn starts; concurrent choices are refused', async (context) => {
  const { sessions, runs, view, script, directory } = await harnessFixture(context, {
    configuration: claudeDefault,
  });
  const id = sessions.start(frame, signal());
  await sessions.idle();

  const entered = deferred<void>();
  const finish = deferred<void>();
  const pendingWrite = deferred<void>();
  const failWrite = deferred<void>();
  script(id, async () => {
    entered.resolve();
    await finish.promise;
  });

  // Fault the filesystem replacement once, keeping the real ordered queue.
  const replace = SessionStore.prototype['replace'];
  let intercepted = false;
  context.mock.method(
    SessionStore.prototype as unknown as { replace: typeof replace },
    'replace',
    async function (this: SessionStore, path: string, content: string | Buffer) {
      if (
        !intercepted &&
        typeof content === 'string' &&
        JSON.parse(content).claudeCode?.model === 'claude-opus-5-5'
      ) {
        intercepted = true;
        pendingWrite.resolve();
        await failWrite.promise;
        throw Error('Synthetic transient write failure');
      }
      return replace.call(this, path, content);
    },
  );
  context.after(() => {
    failWrite.resolve();
    finish.resolve();
  });

  sessions.followUp(id, 'Running', signal());
  await entered.promise;
  const change = assert.rejects(
    sessions.setModel(id, 'claude-opus-5-5', signal()),
    /Synthetic transient write failure/,
  );
  await pendingWrite.promise;
  await assert.rejects(
    sessions.setModel(id, 'claude-haiku-4-5-20251001', signal()),
    /already being changed/,
  );
  sessions.followUp(id, 'Queued during the save', signal());
  finish.resolve();
  failWrite.resolve();
  await change;
  await sessions.idle();

  assert.equal(claudeSettings(runs.at(-1)!.settings).model, 'claude-sonnet-5');
  assert.equal(runs.at(-1)!.text, 'Queued during the save');
  assert.equal(runs.at(-1)!.previousModel, undefined);
  assert.deepEqual(view(id).claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
  const stored = await new SessionStore(join(directory, '.companion-sessions')).read(id);
  assert.deepEqual(stored.claudeCode, { model: 'claude-sonnet-5', effort: 'medium' });
});

test('an older archive without any choice keeps working and accepts one', async (context) => {
  const { sessions, runs, view, directory } = await harnessFixture(context);
  const store = new SessionStore(join(directory, '.companion-sessions'));
  const id = '11111111-2222-4333-8444-555555555555';
  // The shape written before the picker existed: the model captured at creation.
  await store.save({
    id,
    title: 'Older Claude conversation',
    status: 'completed',
    model: 'claude-sonnet-5',
    profile: 'coding',
    harness: 'claude-code',
    claudeCode: { model: 'claude-sonnet-5', effort: 'high' },
    error: '',
    messages: [],
    updatedAt: 1,
  });
  await sessions.loadPrevious();
  await sessions.reopen(id);

  sessions.followUp(id, 'Unchanged', signal());
  await sessions.idle();
  assert.equal(claudeSettings(runs[0].settings).model, 'claude-sonnet-5');
  assert.equal(runs[0].previousModel, undefined);

  await sessions.setModel(id, 'claude-fable-5-1', signal());
  sessions.followUp(id, 'Switched', signal());
  await sessions.idle();
  assert.deepEqual(runs[1].settings, {
    executable: defaultClaudeCodeSettings.executable,
    model: 'claude-fable-5-1',
    effort: 'high',
  });
  assert.equal(runs[1].previousModel, 'claude-sonnet-5');
  assert.equal(view(id).model, 'claude-fable-5-1');
});
