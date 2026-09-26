import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { desktopFixture, stopped, waitFor, type DesktopMessage } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

/**
 * The remote role lets a phone gateway observe and control conversations
 * without taking over the desktop panel's selection, which drives dictation.
 * These tests use a real private socket, a synthetic agent backend and a
 * disposable session store; no model or personal data is involved.
 */

type Run = {
  request: Parameters<AgentBackend['run']>[0];
  publish: NonNullable<Parameters<AgentBackend['run']>[3]>;
  finish(): void;
};

type Message = DesktopMessage & Record<string, unknown>;

interface RemoteActions {
  sessionId: string;
  stopRunId: string;
  choices: { label: string; revision: string; available: boolean }[];
}

interface Connection {
  socket: Socket;
  messages: Message[];
  send(request: object): void;
  reply(action: string, requestId?: string): Promise<Message>;
}

async function connect(path: string): Promise<Connection> {
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
    socket,
    messages,
    send(request: object) {
      socket.write(JSON.stringify(request) + '\n');
    },
    async reply(action: string, requestId?: string) {
      const matches = (message: Message) => {
        return (
          message.action === action &&
          ['result', 'error'].includes(message.type) &&
          (requestId === undefined || message.requestId === requestId)
        );
      };
      await waitFor(() => messages.some(matches));
      const index = messages.findIndex(matches);
      return messages.splice(index, 1)[0];
    },
  };
}

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-remote-role-'));
  const runs: Run[] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'remote-role-fixture',
        label: 'Remote role fixture',
        dependencies: {},
        async run(request, runSignal, _emit, publish) {
          const done = deferred<void>();
          runs.push({ request, publish: publish!, finish: () => done.resolve() });
          await Promise.race([done.promise, stopped(runSignal)]);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
  const remote = await connect(desktop.socketPath);

  context.after(async () => {
    remote.socket.destroy();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(title: string) {
    const count = runs.length;
    const id = sessions.start({ ...frame, utterance: title }, signal());
    await waitFor(() => runs.length > count);
    return { id, run: runs.at(-1)! };
  }

  async function complete(run: Run) {
    run.publish(parseChoices(['[Tests] - Run the tests', 'No']));
    run.finish();
    await waitFor(() => sessions.interaction(run.request.id).agentAcceptsFollowUp);
  }

  async function declareRemote() {
    remote.send({ action: 'client-role', role: 'remote', requestId: 'role-1' });
    const reply = await remote.reply('client-role', 'role-1');
    assert.equal(reply.result, 'role-recorded');
  }

  return { desktop, remote, sessions, runs, start, complete, declareRemote };
}

/** Wait for the newest remote-agent-actions message and require it to match. */
async function waitForActions(
  connection: Connection,
  accept: (actions: RemoteActions) => boolean,
): Promise<RemoteActions> {
  let found: RemoteActions | undefined;

  await waitFor(() => {
    const latest = [...connection.messages]
      .reverse()
      .find((message) => message.type === 'remote-agent-actions');
    if (!latest) {
      return false;
    }
    const actions = latest.actions as unknown as RemoteActions;
    if (!accept(actions)) {
      return false;
    }
    found = actions;
    return true;
  });

  return found!;
}

test('remote selection never changes the desktop selection or speech routing', async (context) => {
  const { desktop, remote, start, declareRemote } = await fixture(context);
  const first = await start('Desktop conversation');
  const second = await start('Phone conversation');
  await declareRemote();

  desktop.send({ action: 'panel-state', id: first.id, composerFocused: true });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');

  remote.send({ action: 'panel-state', id: second.id, composerFocused: false, requestId: 'p1' });
  assert.equal((await remote.reply('panel-state', 'p1')).result, 'panel-recorded');

  const afterSelection = desktop.runtime.activity.interactionContext!();
  assert.equal(afterSelection.agentSessionId, first.id);
  assert.equal(afterSelection.agentComposerFocused, true);

  // Even a remote report that claims focus/navigation/draft fields is ignored.
  remote.send({
    action: 'panel-state',
    id: second.id,
    composerFocused: true,
    visible: true,
    navigationToken: 'phone',
    draftHost: true,
    requestId: 'p2',
  });
  assert.equal((await remote.reply('panel-state', 'p2')).result, 'panel-recorded');
  const afterClaims = desktop.runtime.activity.interactionContext!();
  assert.equal(afterClaims.agentSessionId, first.id);
  assert.equal(afterClaims.agentNavigation, undefined);

  // Disconnecting the remote panel leaves the desktop selection alone.
  remote.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(desktop.runtime.activity.interactionContext!().agentSessionId, first.id);
});

test('remote choices and stop apply only to the remote panel’s own selection', async (context) => {
  const { desktop, remote, start, complete, declareRemote, runs } = await fixture(context);
  const desktopTab = await start('Desktop conversation');
  const phoneTab = await start('Phone conversation');
  await complete(phoneTab.run);
  await declareRemote();

  desktop.send({ action: 'panel-state', id: desktopTab.id, composerFocused: false });
  await desktop.reply('panel-state');

  // Not yet selected on the phone: refused, even though the choice exists.
  const initial = await waitForActions(remote, (actions) => actions.sessionId === '');
  assert.deepEqual(initial.choices, []);
  remote.send({
    action: 'choose-agent',
    id: phoneTab.id,
    revision: 'x',
    index: 0,
    requestId: 'c0',
  });
  assert.match(String((await remote.reply('choose-agent', 'c0')).message), /no longer selected/);

  remote.send({ action: 'panel-state', id: phoneTab.id, composerFocused: false, requestId: 'p' });
  await remote.reply('panel-state', 'p');
  const actions = await waitForActions(remote, (value) => value.sessionId === phoneTab.id);
  assert.equal(actions.choices.length, 2);
  assert.equal(actions.choices[0].label, 'Tests');
  assert.equal(actions.choices[0].available, true);

  // The desktop selection is unchanged by the phone.
  assert.equal(desktop.runtime.activity.interactionContext!().agentSessionId, desktopTab.id);

  // The desktop panel cannot submit the phone-selected conversation's choice.
  desktop.send({
    action: 'choose-agent',
    id: phoneTab.id,
    revision: actions.choices[0].revision,
    index: 0,
  });
  assert.equal((await desktop.reply('choose-agent')).type, 'error');

  const runCount = runs.length;
  remote.send({
    action: 'choose-agent',
    id: phoneTab.id,
    revision: actions.choices[0].revision,
    index: 0,
    requestId: 'c1',
  });
  assert.equal((await remote.reply('choose-agent', 'c1')).result, 'submitted');
  await waitFor(() => runs.length > runCount);

  // The new turn is running; the remote panel receives its run ID and can stop it.
  const running = await waitForActions(remote, (value) => value.stopRunId !== '');
  remote.send({
    action: 'stop-agent-run',
    id: phoneTab.id,
    runId: running.stopRunId,
    requestId: 's1',
  });
  assert.equal((await remote.reply('stop-agent-run', 's1')).result, 'stopped');
});

test('desktop-only actions are refused for remote panels', async (context) => {
  const { remote, declareRemote } = await fixture(context);
  await declareRemote();

  const requests = [
    { action: 'paste', id: 'x', target: '0x1' },
    { action: 'submit-utterance', text: 'hello', target: '0x1' },
    { action: 'media-playback', playing: true },
    { action: 'composer-focus', id: '' },
    { action: 'agent-draft-result', outcome: 'inserted' },
  ];

  for (const request of requests) {
    remote.send({ ...request, requestId: `r-${request.action}` });
    const reply = await remote.reply(request.action, `r-${request.action}`);
    assert.equal(reply.type, 'error', request.action);
    assert.match(String(reply.message), /only available on the desktop/);
  }
});

test('the remote role must be declared before desktop panel reports', async (context) => {
  const { desktop, start } = await fixture(context);
  const tab = await start('Conversation');
  desktop.send({ action: 'panel-state', id: tab.id, composerFocused: false });
  await desktop.reply('panel-state');

  desktop.send({ action: 'client-role', role: 'remote' });
  assert.match(String((await desktop.reply('client-role')).message), /before reporting/);

  desktop.send({ action: 'client-role', role: 'admin' });
  assert.match(String((await desktop.reply('client-role')).message), /Expected role/);
});

test('remote panels start typed conversations in the background', async (context) => {
  const { desktop, remote, declareRemote, runs, sessions } = await fixture(context);

  desktop.send({ action: 'start-agent', text: 'Hello', profile: 'coding' });
  assert.match(String((await desktop.reply('start-agent')).message), /Only remote panels/);

  await declareRemote();
  remote.send({ action: 'start-agent', text: '   ', profile: 'coding', requestId: 'a' });
  assert.equal((await remote.reply('start-agent', 'a')).type, 'error');
  remote.send({ action: 'start-agent', text: 'Hi', profile: 'other', requestId: 'b' });
  assert.equal((await remote.reply('start-agent', 'b')).type, 'error');

  remote.send({
    action: 'start-agent',
    text: 'Summarize the synthetic notes',
    profile: 'quickQuestion',
    requestId: 'c',
  });
  const reply = await remote.reply('start-agent', 'c');
  const result = reply.result as unknown as { outcome: string; id: string };
  assert.equal(result.outcome, 'started');
  await waitFor(() => runs.length === 1);

  const session = sessions.snapshot().find((candidate) => candidate.id === result.id)!;
  assert.equal(session.openInBackground, true);
  assert.equal(session.profile, 'quickQuestion');
  assert.equal(session.messages[0].screenshot, false);
  assert.equal(runs[0].request.prompt.screenshot, undefined);
});

test('every reply echoes a bounded request ID', async (context) => {
  const { remote, declareRemote } = await fixture(context);
  await declareRemote();

  remote.send({ action: 'toggle-sounds', requestId: 'sound-1' });
  assert.equal((await remote.reply('toggle-sounds', 'sound-1')).result, 'sounds-enabled');

  remote.send({ action: 'toggle-sounds', requestId: 'x'.repeat(129) });
  const reply = await remote.reply('toggle-sounds');
  assert.equal(reply.requestId, undefined);
});

test('phone history starts and reopens never request desktop reveal', async (context) => {
  const { desktop, remote, declareRemote, sessions, runs } = await fixture(context);
  await declareRemote();

  const utteranceId = desktop.seed();
  await desktop.runtime.activity.screenshotCaptured?.(frame.id, frame.screenshot);
  desktop.runtime.activity.outcome?.(frame.id, 'ignored');
  desktop.runtime.activity.finished?.(frame.id);
  remote.send({ action: 'start-history-agent', id: utteranceId, requestId: 'history' });
  const started = await remote.reply('start-history-agent', 'history');
  assert.equal(started.result, 'started', JSON.stringify(started));
  await waitFor(() => runs.length === 1);
  const session = sessions.snapshot()[0];
  assert.equal(session.openInBackground, true);
  assert.equal(session.messages[0].screenshot, true, 'uses the existing synthetic saved frame');

  runs[0].finish();
  await waitFor(() => sessions.interaction(session.id).agentAcceptsFollowUp);
  await sessions.remove(session.id);
  remote.send({ action: 'reopen-agent', id: session.id, requestId: 'reopen' });
  assert.equal((await remote.reply('reopen-agent', 'reopen')).result, 'reopened');
  await waitFor(() => desktop.messages.some((message) => message.type === 'agent-restored'));
  const restored = desktop.messages.find((message) => message.type === 'agent-restored')!;
  assert.equal((restored as Message).reveal, false);
  assert.equal(sessions.snapshot()[0].openInBackground, true);
});
