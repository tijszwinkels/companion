// Per-view choice and stop controls (`agent-view-actions`).
//
// Every conversation a desktop connection shows (its main view while it owns
// the panel selection, and its own visible pop-out windows) keeps its own
// choices and stop control, whichever view is the voice target. The singular
// `agent-actions` stays the voice projection and the voice target rules stay
// as they are. These tests drive the real desktop runtime over its real
// socket with real AgentSessions and a scripted backend. No microphone,
// screenshot, model provider or native window is involved.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentActions } from '../../src/agents/choice-intents.ts';
import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { desktopOnlyEvents, remoteEvents } from '../../src/remote/protocol.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

type Run = {
  request: Parameters<AgentBackend['run']>[0];
  signal: AbortSignal;
  publish: NonNullable<Parameters<AgentBackend['run']>[3]>;
  finish(): void;
};

type Message = Record<string, unknown> & { type: string; action?: string };

/** One socket connection with its received lines, like a second native host. */
interface Connection {
  socket: Socket;
  messages: Message[];
  send(request: object): void;
  reply(action: string): Promise<Message>;
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
    async reply(action: string) {
      const matches = (message: Message) => {
        return message.action === action && ['result', 'error'].includes(message.type);
      };
      await waitFor(() => messages.some(matches));
      const index = messages.findIndex(matches);
      return messages.splice(index, 1)[0];
    },
  };
}

interface Popout {
  id: string;
  active: boolean;
  composerFocused: boolean;
}

function window(id: string, active = false): Popout {
  return { id, active, composerFocused: false };
}

/** All view projections a connection received, oldest first. */
function viewProjections(messages: Message[]): AgentActions[][] {
  return messages
    .filter((message) => message.type === 'agent-view-actions')
    .map((message) => message.actions as AgentActions[]);
}

/** The newest view projection, keyed by conversation ID. */
function latestView(messages: Message[]): Map<string, AgentActions> | undefined {
  const latest = viewProjections(messages).at(-1);
  if (!latest) {
    return undefined;
  }
  return new Map(latest.map((actions) => [actions.sessionId, actions]));
}

/** The newest singular voice projection, from an event or a state snapshot. */
function latestVoice(messages: Message[]): AgentActions | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type === 'agent-actions') {
      return message.actions as AgentActions;
    }
    if (message.type === 'state' && message.agentActions) {
      return message.agentActions as AgentActions;
    }
  }
  return undefined;
}

/** Wait until the newest view projection satisfies `accept`, and return it. */
async function waitForView(
  messages: Message[],
  accept: (view: Map<string, AgentActions>) => boolean,
): Promise<Map<string, AgentActions>> {
  let found: Map<string, AgentActions> | undefined;
  await waitFor(() => {
    const view = latestView(messages);
    if (!view || !accept(view)) {
      return false;
    }
    found = view;
    return true;
  });
  return found!;
}

/** Three real conversations with finished turns and their own choice sets. */
async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-view-choices-'));
  const runs: Run[] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'view-choices-fixture',
        label: 'View choices fixture',
        dependencies: {},
        async run(request, runSignal, _emit, publish) {
          const done = deferred<void>();
          runs.push({
            request,
            signal: runSignal,
            publish: publish!,
            finish: () => done.resolve(),
          });
          await Promise.race([done.promise, stopped(runSignal)]);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
  // The fixture's own connection is native host A; record what it receives.
  const host = desktop.messages as unknown as Message[];

  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(title: string) {
    const count = runs.length;
    const id = sessions.start({ ...frame, utterance: title }, signal());
    await waitFor(() => runs.length > count);
    return { id, run: runs.at(-1)! };
  }

  async function complete(run: Run, options: string[]) {
    run.publish(parseChoices(options));
    run.finish();
    await waitFor(() => sessions.interaction(run.request.id).agentAcceptsFollowUp);
  }

  const a = await start('Conversation A');
  await complete(a.run, ['Alpha', 'Apple']);
  const b = await start('Conversation B');
  await complete(b.run, ['Bravo']);
  const c = await start('Conversation C');
  await complete(c.run, ['Charlie']);

  /** Host A's native report: main view `id` plus its visible windows. */
  async function report(id: string, popouts: Popout[], rail = 'full'): Promise<void> {
    desktop.send({
      action: 'panel-state',
      id,
      composerFocused: false,
      visible: true,
      draftHost: true,
      popoutHost: true,
      rail,
      popouts,
    });
    assert.equal((await desktop.reply('panel-state')).type, 'result');
  }

  function voiceTarget(): string {
    return desktop.runtime.activity.interactionContext!().agentSessionId;
  }

  function revision(id: string): string {
    return sessions.interaction(id).agentChoices!.revision;
  }

  return { desktop, host, sessions, runs, start, complete, a, b, c, report, voiceTarget, revision };
}

test('each shown conversation keeps its own choices while the voice target moves', async (context) => {
  const f = await fixture(context);

  // Main view A and an active window B: speech goes to the window.
  await f.report(f.a.id, [window(f.b.id, true)]);
  assert.equal(f.voiceTarget(), f.b.id);
  let view = await waitForView(f.host, (entries) => entries.size === 2);
  assert.deepEqual(
    view.get(f.a.id)!.choices.map((choice) => [choice.label, choice.revision, choice.available]),
    [
      ['Alpha', f.revision(f.a.id), true],
      ['Apple', f.revision(f.a.id), true],
    ],
  );
  assert.deepEqual(
    view.get(f.b.id)!.choices.map((choice) => choice.label),
    ['Bravo'],
  );
  // The view projection never claims a label is speakable.
  for (const actions of view.values()) {
    for (const choice of actions.choices) {
      assert.equal(choice.voiceAvailable, false);
      assert.equal(choice.voiceReason, '');
      assert.equal(choice.sessionId, actions.sessionId);
    }
  }
  // The singular voice projection still follows the voice target only.
  await waitFor(() => latestVoice(f.host)?.sessionId === f.b.id);
  assert.equal(latestVoice(f.host)!.choices[0].voiceAvailable, true);

  // The window loses focus to another application: speech moves to the
  // sidebar conversation, and both views keep exactly the same controls.
  const projections = viewProjections(f.host).length;
  await f.report(f.a.id, [window(f.b.id, false)]);
  assert.equal(f.voiceTarget(), f.a.id);
  await waitFor(() => latestVoice(f.host)?.sessionId === f.a.id);
  view = latestView(f.host)!;
  assert.equal(viewProjections(f.host).length, projections, 'No resend without a change');
  assert.deepEqual([...view.keys()].sort(), [f.a.id, f.b.id].sort());
  assert.equal(view.get(f.b.id)!.choices[0].label, 'Bravo');

  // Hiding the main view (compact rail, nothing selected) keeps the window's
  // controls; the lone window beside the compact rail becomes the target.
  await f.report('', [window(f.b.id, false)], 'compact');
  assert.equal(f.voiceTarget(), f.b.id);
  view = await waitForView(f.host, (entries) => entries.size === 1);
  assert.equal(view.get(f.b.id)!.choices[0].label, 'Bravo');
});

test('a non-target view submits its own current choice once and stops its own run', async (context) => {
  const f = await fixture(context);
  await f.report(f.a.id, [window(f.b.id, true)]);
  assert.equal(f.voiceTarget(), f.b.id);
  const view = await waitForView(f.host, (entries) => entries.size === 2);
  const choice = view.get(f.a.id)!.choices[1];

  // Click "Apple" in the sidebar while speech goes to the window.
  const before = f.runs.length;
  f.desktop.send({
    action: 'choose-agent',
    id: f.a.id,
    revision: choice.revision,
    index: choice.index,
  });
  assert.equal((await f.desktop.reply('choose-agent')).result, 'submitted');
  await waitFor(() => f.runs.length === before + 1);
  const turn = f.runs.at(-1)!;
  assert.equal(turn.request.id, f.a.id);
  assert.equal(turn.request.prompt.text, 'Apple');

  // The same click again is refused: the set expired with the new turn.
  f.desktop.send({
    action: 'choose-agent',
    id: f.a.id,
    revision: choice.revision,
    index: choice.index,
  });
  assert.equal((await f.desktop.reply('choose-agent')).type, 'error');
  assert.equal(f.runs.length, before + 1);

  // The sidebar now shows its own running turn's stop control; the voice
  // target and the window's choices are unchanged.
  const running = await waitForView(f.host, (entries) => entries.get(f.a.id)!.stopRunId !== '');
  assert.equal(running.get(f.a.id)!.choices.length, 0);
  assert.equal(running.get(f.b.id)!.choices[0].label, 'Bravo');
  assert.equal(f.voiceTarget(), f.b.id);
  assert.equal(latestVoice(f.host)!.stopRunId, '');

  f.desktop.send({
    action: 'stop-agent-run',
    id: f.a.id,
    runId: running.get(f.a.id)!.stopRunId,
  });
  assert.equal((await f.desktop.reply('stop-agent-run')).result, 'stopped');
  assert.equal(turn.signal.aborted, true);
  await waitForView(f.host, (entries) => entries.get(f.a.id)!.stopRunId === '');
});

test('replacement, clearing, busy turns and global capacity update each view truthfully', async (context) => {
  const f = await fixture(context);
  await f.report(f.a.id, [window(f.b.id, true)]);
  await waitForView(f.host, (entries) => entries.size === 2);

  // A new turn in the non-target sidebar conversation: busy, then replaced.
  f.sessions.followUp(f.a.id, 'Another question', signal());
  await waitFor(() => f.runs.length === 4);
  const turn = f.runs.at(-1)!;
  turn.publish(parseChoices(['Again']));
  let view = await waitForView(f.host, (entries) => entries.get(f.a.id)!.choices.length === 1);
  const busy = view.get(f.a.id)!.choices[0];
  assert.equal(busy.label, 'Again');
  assert.equal(busy.available, false);
  assert.equal(busy.voiceAvailable, false);
  assert.match(busy.voiceReason, /finishes/);
  assert.notEqual(view.get(f.a.id)!.stopRunId, '');

  // Clearing removes the choices; finishing the turn ends the stop control.
  turn.publish([]);
  view = await waitForView(f.host, (entries) => entries.get(f.a.id)!.choices.length === 0);
  turn.finish();
  view = await waitForView(f.host, (entries) => entries.get(f.a.id)!.stopRunId === '');
  assert.deepEqual(view.get(f.a.id)!.choices, []);

  // Ten running conversations elsewhere make the window's choice unavailable,
  // with the running-limit reason, even though nothing changed in B itself.
  const others = [];
  for (let index = 0; index < 10; index++) {
    others.push(await f.start(`Other ${index}`));
  }
  view = await waitForView(
    f.host,
    (entries) => entries.get(f.b.id)!.choices[0].available === false,
  );
  assert.match(view.get(f.b.id)!.choices[0].voiceReason, /10 questions/);
  f.desktop.send({
    action: 'choose-agent',
    id: f.b.id,
    revision: f.revision(f.b.id),
    index: 0,
  });
  assert.match(String((await f.desktop.reply('choose-agent')).message), /10 questions/);

  // A free slot makes it available again.
  await f.sessions.stop(others[0].id);
  view = await waitForView(f.host, (entries) => entries.get(f.b.id)!.choices[0].available === true);
  assert.equal(view.get(f.b.id)!.choices[0].voiceReason, '');
});

test('views retract on close, window removal and another host taking the panel selection', async (context) => {
  const f = await fixture(context);
  await f.report(f.a.id, [window(f.b.id, true), window(f.c.id)]);
  await waitForView(f.host, (entries) => entries.size === 3);

  // Closing the window's conversation removes its entry at once.
  await f.sessions.remove(f.c.id);
  await waitForView(f.host, (entries) => entries.size === 2 && !entries.has(f.c.id));

  // Closing a window keeps the conversation open but no longer shown there.
  await f.report(f.a.id, []);
  await waitForView(f.host, (entries) => entries.size === 1 && entries.has(f.a.id));

  // A second native host selects B in its main view: it now owns the panel
  // selection, so host A's main entry is retracted and A cannot click it.
  const other = await connect(f.desktop.socketPath);
  context.after(async () => {
    other.socket.destroy();
  });
  other.send({ action: 'panel-state', id: f.b.id, composerFocused: false, visible: true });
  assert.equal((await other.reply('panel-state')).type, 'result');
  await waitForView(other.messages, (entries) => entries.size === 1 && entries.has(f.b.id));
  await waitForView(f.host, (entries) => entries.size === 0);
  assert.equal(f.voiceTarget(), f.b.id);
  f.desktop.send({ action: 'choose-agent', id: f.a.id, revision: f.revision(f.a.id), index: 0 });
  assert.match(String((await f.desktop.reply('choose-agent')).message), /no longer selected/);

  // Host B disconnecting leaves host A's (empty) projection alone.
  const projections = viewProjections(f.host).length;
  other.socket.destroy();
  await waitFor(() => f.voiceTarget() === '');
  assert.equal(viewProjections(f.host).length, projections);
});

test('the first desktop report sends a projection, even an empty one', async (context) => {
  const f = await fixture(context);
  assert.equal(viewProjections(f.host).length, 0, 'Nothing before a desktop report');

  // A legacy report (no pop-out capability) with nothing selected.
  f.desktop.send({ action: 'panel-state', id: '', composerFocused: false });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  await waitFor(() => viewProjections(f.host).length === 1);
  assert.deepEqual(viewProjections(f.host)[0], []);

  // Its selected main conversation then appears, exactly like the voice target.
  f.desktop.send({ action: 'panel-state', id: f.a.id, composerFocused: false });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  const view = await waitForView(f.host, (entries) => entries.has(f.a.id));
  assert.equal(view.size, 1);
  assert.equal(f.voiceTarget(), f.a.id);
});

test('remote connections never receive view controls', async (context) => {
  const f = await fixture(context);
  await f.report(f.a.id, [window(f.b.id, true)]);

  // The phone gateway forwards only declared remote events.
  assert.equal(remoteEvents.has('agent-view-actions'), false);
  assert.equal(desktopOnlyEvents.has('agent-view-actions'), true);

  const remote = await connect(f.desktop.socketPath);
  context.after(async () => {
    remote.socket.destroy();
  });
  remote.send({ action: 'client-role', role: 'remote' });
  assert.equal((await remote.reply('client-role')).result, 'role-recorded');
  remote.send({ action: 'panel-state', id: f.c.id, composerFocused: false });
  assert.equal((await remote.reply('panel-state')).result, 'panel-recorded');
  await waitFor(() =>
    remote.messages.some(
      (message) =>
        message.type === 'remote-agent-actions' &&
        (message.actions as AgentActions).sessionId === f.c.id,
    ),
  );

  // Desktop changes after the remote joined still reach only the desktop.
  const before = f.runs.length;
  f.sessions.followUp(f.a.id, 'Desktop question', signal());
  await waitForView(f.host, (entries) => entries.get(f.a.id)!.stopRunId !== '');
  // The turn is busy before its backend run starts; finish that run itself.
  await waitFor(() => f.runs.length === before + 1);
  f.runs.at(-1)!.finish();
  await waitForView(f.host, (entries) => entries.get(f.a.id)!.stopRunId === '');
  assert.equal(viewProjections(remote.messages).length, 0);
  // Its own selection does not change the desktop's voice target.
  assert.equal(f.voiceTarget(), f.b.id);
});
