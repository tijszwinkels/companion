import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import registerSessionName, { sessionNameTool } from '../../src/agents/session-name-tool.ts';
import { parseSessionName } from '../../src/agents/session-name.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend, SessionEvent } from '../../src/agents/types.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

test('the naming tool wraps Pi native naming and contains first-turn emoji guidance', async () => {
  let registered: ReturnType<typeof sessionNameTool> | undefined;
  let name = '';
  registerSessionName({
    registerTool: (tool) => {
      registered = tool;
    },
    setSessionName: (title) => {
      name = title;
    },
  });
  assert.ok(registered);
  assert.match(registered.promptGuidelines[0], /first turn/);
  assert.match(registered.promptGuidelines[0], /emoji/);
  const result = await registered.execute('name', { title: ' 🐛 Login fix ' }, signal());
  assert.equal(name, '🐛 Login fix');
  assert.equal('details' in result, false, 'The host reads native state, not custom metadata');
  await assert.rejects(registered.execute('cancel', { title: 'Not applied' }, AbortSignal.abort()));
  assert.equal(name, '🐛 Login fix');
  assert.equal(parseSessionName('🙂'.repeat(40)), '🙂'.repeat(40));
  for (const value of ['', ' ', null, 1, 'x'.repeat(41), 'Two\nlines', 'A\u0000name']) {
    assert.throws(() => parseSessionName(value));
  }
});

test('names publish immediately, persist on close, and ignore callbacks from finished turns', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-name-'));
  const done = deferred<void>();
  let rename: NonNullable<Parameters<AgentBackend['run']>[4]> | undefined;
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'name-fixture',
        label: 'Name fixture',
        dependencies: {},
        async run(_request, signal, _emit, _choices, name) {
          rename = name;
          await Promise.race([done.promise, stopped(signal)]);
        },
      },
    },
    () => {},
    directory,
  );
  context.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: SessionEvent[] = [];
  sessions.subscribe((event) => events.push(event));
  const id = sessions.start(frame, signal());
  await waitFor(() => rename !== undefined);
  rename!('🌱 Garden ideas');
  assert.ok(
    events.some(
      (event) => event.type === 'agent-session' && event.session.title === '🌱 Garden ideas',
    ),
  );
  assert.equal(sessions.snapshot()[0].id, id);
  done.resolve();
  await sessions.idle();
  rename!('Stale callback');
  assert.equal(sessions.snapshot()[0].title, '🌱 Garden ideas');
  await sessions.remove(id);
  assert.equal(sessions.previousSnapshot()[0].title, '🌱 Garden ideas');
  await sessions.reopen(id);
  assert.equal(sessions.snapshot()[0].title, '🌱 Garden ideas');
});

test('each successful queued turn chimes once; snapshots and reopened sessions never chime', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-completion-'));
  const turns: (() => void)[] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'completion-fixture',
        label: 'Completion fixture',
        dependencies: {},
        async run(request, signal) {
          const done = deferred<void>();
          turns.push(() => done.resolve());
          await Promise.race([done.promise, stopped(signal)]);
          if (request.prompt.text === 'Failed turn') {
            throw Error('Model failure');
          }
        },
      },
    },
    () => {},
    directory,
  );
  const played: string[] = [];
  const desktop = await desktopFixture(
    async (command, args) => {
      assert.equal(command, 'pw-play');
      played.push(basename(args[0]));
      return Buffer.alloc(0);
    },
    sessions,
    { sounds: true },
  );
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const completed: string[] = [];
  sessions.subscribe((event) => {
    if (event.type === 'agent-turn-completed') {
      completed.push(event.turnId);
    }
  });
  const id = sessions.start(frame, signal());
  sessions.followUp(id, 'Queued follow-up', signal());
  await waitFor(() => turns.length === 1);
  assert.equal(sessions.snapshot()[0].completedTurnId, undefined);
  turns[0]();
  await waitFor(() => turns.length === 2 && played.length === 1);
  assert.equal(sessions.snapshot()[0].completedTurnId, completed[0]);
  assert.equal(sessions.snapshot()[0].status, 'running');
  turns[1]();
  await sessions.idle();
  await waitFor(() => played.length === 2);
  assert.deepEqual(played, ['agent-completed.wav', 'agent-completed.wav']);
  assert.equal(new Set(completed).size, 2);
  assert.equal(sessions.snapshot()[0].completedTurnId, completed[1]);
  await sessions.remove(id);
  await sessions.reopen(id);
  assert.equal(sessions.snapshot()[0].completedTurnId, undefined);
  assert.equal(played.length, 2);

  sessions.followUp(id, 'Stopped', signal());
  await waitFor(() => turns.length === 3);
  await sessions.stop(id);
  assert.equal(sessions.snapshot()[0].completedTurnId, undefined);
  assert.equal(played.length, 2);
  desktop.send({ action: 'toggle-sounds' });
  await desktop.reply('toggle-sounds');
  sessions.followUp(id, 'Muted successful turn', signal());
  await waitFor(() => turns.length === 4);
  turns[3]();
  await sessions.idle();
  assert.equal(completed.length, 3);
  assert.equal(played.length, 2);
  desktop.send({ action: 'toggle-sounds' });
  await desktop.reply('toggle-sounds');
  sessions.followUp(id, 'Failed turn', signal());
  await waitFor(() => turns.length === 5);
  turns[4]();
  await sessions.idle();
  assert.equal(sessions.snapshot()[0].status, 'error');
  assert.equal(sessions.snapshot()[0].completedTurnId, completed[2]);
  assert.equal(completed.length, 3);
  assert.equal(played.length, 2);
});
