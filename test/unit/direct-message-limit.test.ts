import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';

import {
  MAX_DIRECT_USER_MESSAGE_LENGTH,
  MAX_RELAYED_MESSAGE_LENGTH,
} from '../../src/agents/message-limits.ts';
import { scheduleDeadline } from '../../src/agents/wakes/types.ts';
import type { AgentMessageOrigin } from '../../src/agents/types.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { callTool, harnessFixture, toolRefusal } from '../harness-fixture.ts';

/**
 * The person at the desktop may send 8000 characters; every relayed sender
 * (agent tools, external socket, wakes, phone/remote panels) keeps 4000.
 * Synthetic backends and temporary directories only.
 */

const agentOrigin: AgentMessageOrigin = {
  kind: 'agent',
  sessionId: '00000000-0000-4000-8000-000000000001',
  title: 'Sender',
  depth: 1,
};
const externalOrigin: AgentMessageOrigin = {
  kind: 'external',
  title: 'MM test',
  requestId: 'request',
  depth: 1,
};

test('the bounds are 8000 for direct input and 4000 for relayed senders', () => {
  assert.equal(MAX_DIRECT_USER_MESSAGE_LENGTH, 8000);
  assert.equal(MAX_RELAYED_MESSAGE_LENGTH, 4000);
});

test('follow-ups accept 8000 characters from the user and 4000 from any origin', async (context) => {
  const { sessions, view } = await harnessFixture(context);
  const id = sessions.start(frame, signal());
  await sessions.idle();

  assert.equal(sessions.followUp(id, 'u'.repeat(8000), signal()).outcome, 'started');
  for (const text of ['', '  ', 'v'.repeat(8001)]) {
    assert.throws(() => sessions.followUp(id, text, signal()), /1–8000 characters/);
  }

  // Relayed senders queue behind the running turn with the original bound.
  for (const origin of [agentOrigin, externalOrigin]) {
    assert.equal(sessions.followUp(id, 'a'.repeat(4000), signal(), origin).outcome, 'queued');
    assert.throws(
      () => sessions.followUp(id, 'b'.repeat(4001), signal(), origin),
      /1–4000 characters/,
    );
  }
  await sessions.idle();

  // Refusals leave no message behind; the accepted ones are kept whole.
  const lengths = view(id)
    .messages.filter((message) => message.kind === 'user')
    .map((message) => message.text.length);
  assert.deepEqual(lengths, [frame.utterance.length, 8000, 4000, 4000]);
});

test('remote starts, agent tools and wakes keep the 4000-character bound', async (context) => {
  const { sessions, script } = await harnessFixture(context);
  assert.ok(sessions.startRemote('r'.repeat(4000), 'coding', signal()));
  assert.throws(
    () => sessions.startRemote('r'.repeat(4001), 'coding', signal()),
    /1 and 4000 characters/,
  );

  const target = sessions.start(frame, signal());
  await sessions.idle();
  const caller = sessions.start(frame, signal());
  const refusals: string[] = [];
  script(caller, async (run) => {
    await callTool(run, 'companion_session_send', { id: target, text: 's'.repeat(4000) });
    refusals.push(
      await toolRefusal(run, 'companion_session_send', { id: target, text: 's'.repeat(4001) }),
    );
    refusals.push(await toolRefusal(run, 'companion_session_start', { text: 't'.repeat(4001) }));
  });
  await sessions.idle();
  assert.equal(refusals.length, 2);
  for (const refusal of refusals) {
    assert.match(refusal, /4000/);
  }

  const wake = { label: 'Later', afterSeconds: 60 };
  assert.ok(scheduleDeadline({ ...wake, message: 'w'.repeat(4000) }, Date.now()));
  assert.throws(
    () => scheduleDeadline({ ...wake, message: 'w'.repeat(4001) }, Date.now()),
    /message \(1–4000\)/,
  );
});

test('the desktop socket carries 8000-character composer messages but remote panels keep 4000', async (context) => {
  const { sessions, view } = await harnessFixture(context);
  const desktop = await desktopFixture(async () => Buffer.alloc(0), sessions);
  context.after(() => desktop.close());
  const id = sessions.start(frame, signal());
  await sessions.idle();

  // Every character of the longest message needs a six-character escape.
  const escaped = '\u0001'.repeat(8000);
  desktop.send({ action: 'send-agent', id, text: escaped });
  assert.equal((await desktop.reply('send-agent')).result, 'submitted');
  desktop.send({ action: 'send-agent', id, text: 'x'.repeat(8001) });
  assert.match((await desktop.reply('send-agent')).message!, /1–8000 characters/);
  await sessions.idle();

  // A phone gateway declares the remote role on its own connection.
  const remote = await desktopClient(desktop.socketPath);
  context.after(() => remote.close());
  remote.send({ action: 'client-role', role: 'remote', requestId: 'role' });
  assert.equal((await remote.reply('client-role')).result, 'role-recorded');
  remote.send({ action: 'send-agent', id, text: 'p'.repeat(4001) });
  assert.match(String((await remote.reply('send-agent')).message), /1–4000 characters/);
  remote.send({ action: 'send-agent', id, text: 'p'.repeat(4000) });
  assert.equal((await remote.reply('send-agent')).result, 'submitted');
  // New-session defaults are a desktop-only setting.
  remote.send({ action: 'coding-defaults' });
  assert.match(String((await remote.reply('coding-defaults')).message), /only available/);
  await sessions.idle();

  const questions = view(id).messages.filter((message) => message.kind === 'user');
  assert.deepEqual(
    questions.map((message) => message.text.length),
    [frame.utterance.length, 8000, 4000],
  );
  assert.equal(questions[1].text, escaped, 'Escaped text arrives unchanged');
});

/** A second plain connection to the desktop socket. */
async function desktopClient(path: string) {
  const socket = createConnection(path);
  const messages: Record<string, unknown>[] = [];
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
    send(request: object) {
      socket.write(JSON.stringify(request) + '\n');
    },
    async reply(action: string) {
      const matches = (message: Record<string, unknown>) =>
        message.action === action && ['result', 'error'].includes(message.type as string);
      await waitFor(() => messages.some(matches));
      return messages.splice(messages.findIndex(matches), 1)[0];
    },
    async close() {
      socket.destroy();
    },
  };
}
