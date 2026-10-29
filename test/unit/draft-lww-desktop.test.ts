import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

/**
 * The listener's draft map over the real desktop control socket: trusted
 * editors (draft hosts) write and receive drafts, the last write received
 * wins, editors do not get their own edit back as a change, a newly attached
 * editor reads a snapshot, remote panels can neither write nor see drafts,
 * and a confirmed send clears a draft only while it still equals the sent
 * text. Synthetic sessions only.
 */

type Message = Record<string, any>;

/** Another connection to the same control socket, like a second UI. */
async function connect(path: string) {
  const socket = createConnection(path);
  const messages: Message[] = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(socket, 'connect');
  return {
    messages,
    send(request: object) {
      socket.write(JSON.stringify(request) + '\n');
    },
    async reply(action: string) {
      const matches = (message: Message) =>
        message.action === action && ['result', 'error'].includes(message.type);
      await waitFor(() => messages.some(matches), 2000);
      return messages.splice(messages.findIndex(matches), 1)[0];
    },
    drafts() {
      return messages.filter((message) => message.type === 'draft');
    },
    close() {
      socket.destroy();
    },
  };
}

test('one listener draft map: last write wins, no echo, snapshot, trusted editors only', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-draft-lww-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  const prompts: string[] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'draft-lww-fixture',
        label: 'Draft LWW fixture',
        dependencies: {},
        async run(request) {
          prompts.push(request.prompt.text);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
  const second = await connect(desktop.socketPath);
  const remote = await connect(desktop.socketPath);
  context.after(async () => {
    second.close();
    remote.close();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  const a = sessions.start({ ...frame, utterance: 'Conversation A' }, signal());
  const b = sessions.start({ ...frame, utterance: 'Conversation B' }, signal());
  await sessions.idle();
  const turns = prompts.length;

  // A panel that is not a draft host cannot write drafts.
  desktop.send({ action: 'draft-set', id: a, text: 'nope', editId: 'x1' });
  assert.match(
    String(((await desktop.reply('draft-set')) as Message).message),
    /Only a desktop editor/,
  );

  // Two trusted editors (e.g. the sidebar UI and another UI instance).
  desktop.send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  assert.equal(((await desktop.reply('panel-state')) as Message).result, 'panel-recorded');
  second.send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  assert.equal((await second.reply('panel-state')).result, 'panel-recorded');

  // A remote panel (the phone gateway) declares its role first.
  remote.send({ action: 'client-role', role: 'remote' });
  assert.equal((await remote.reply('client-role')).result, 'role-recorded');

  // Editor 1 writes A: it gets its edit ID back (and ignores it); editor 2
  // receives the change to show.
  desktop.send({ action: 'draft-set', id: a, text: 'Hello from one', editId: 'e1' });
  const accepted = ((await desktop.reply('draft-set')) as Message).result;
  assert.equal(accepted.accepted, true);
  await waitFor(() => second.drafts().length === 1);
  assert.deepEqual(
    [second.drafts()[0].id, second.drafts()[0].text, second.drafts()[0].editId],
    [a, 'Hello from one', undefined],
  );
  const own = (desktop.messages as Message[]).filter((message) => message.type === 'draft');
  assert.equal(own.length, 1);
  assert.equal(own[0].editId, 'e1', 'the writer can recognise its own edit');

  // The last write received wins, whichever editor wrote it.
  second.send({ action: 'draft-set', id: a, text: 'Overwritten by two', editId: 's1' });
  assert.equal((await second.reply('draft-set')).result.accepted, true);
  desktop.send({ action: 'draft-set', id: a, text: 'Back to one', editId: 'e2' });
  assert.equal(((await desktop.reply('draft-set')) as Message).result.accepted, true);
  await waitFor(() => second.drafts().at(-1)?.text === 'Back to one');

  // B is separate; unknown conversations are refused without an entry.
  desktop.send({ action: 'draft-set', id: b, text: 'B words', editId: 'e3' });
  assert.equal(((await desktop.reply('draft-set')) as Message).result.accepted, true);
  desktop.send({ action: 'draft-set', id: 'not-a-session', text: 'ghost', editId: 'e4' });
  assert.deepEqual(((await desktop.reply('draft-set')) as Message).result, {
    accepted: false,
    reason: 'unknown conversation',
  });

  // Claiming to record does not lift the editing bound for a panel that is
  // not recording into that conversation.
  desktop.send({
    action: 'draft-set',
    id: b,
    text: 'x'.repeat(16_001),
    editId: 'e6',
    recording: true,
  });
  assert.equal(((await desktop.reply('draft-set')) as Message).result.accepted, false);

  // A newly attached editor reads every draft once.
  const third = await connect(desktop.socketPath);
  context.after(() => third.close());
  third.send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  assert.equal((await third.reply('panel-state')).result, 'panel-recorded');
  await waitFor(() => third.messages.some((message) => message.type === 'draft-snapshot'));
  const snapshot = third.messages.find((message) => message.type === 'draft-snapshot')!;
  assert.deepEqual(
    snapshot.drafts.map((entry: Message) => [entry.id, entry.text]).sort(),
    [
      [a, 'Back to one'],
      [b, 'B words'],
    ].sort(),
  );

  // The remote panel can neither write nor see drafts.
  remote.send({ action: 'draft-set', id: a, text: 'remote', editId: 'r1' });
  assert.match(String((await remote.reply('draft-set')).message), /only available on the desktop/);
  assert.equal(
    remote.messages.some(
      (message) => message.type === 'draft' || message.type === 'draft-snapshot',
    ),
    false,
  );
  assert.equal(
    remote.messages.some((message) => JSON.stringify(message).includes('Back to one')),
    false,
    'no draft body reaches a remote panel',
  );

  // Draft writes never start a turn.
  assert.equal(prompts.length, turns);

  // A confirmed send clears the draft only while it equals the sent text.
  desktop.send({ action: 'send-agent', id: b, text: 'Something else' });
  assert.equal(((await desktop.reply('send-agent')) as Message).result, 'submitted');
  await sessions.idle();
  desktop.send({ action: 'draft-set', id: b, text: 'B words', editId: 'e5' });
  await desktop.reply('draft-set');
  assert.equal(
    third.messages.filter((message) => message.type === 'draft' && message.id === b).at(-1)?.text,
    'B words',
  );
  desktop.send({ action: 'send-agent', id: b, text: 'B words' });
  assert.equal(((await desktop.reply('send-agent')) as Message).result, 'submitted');
  await waitFor(() =>
    third.messages.some(
      (message) => message.type === 'draft' && message.id === b && message.text === '',
    ),
  );
  await sessions.idle();
  assert.ok(prompts.includes('B words'));
});
