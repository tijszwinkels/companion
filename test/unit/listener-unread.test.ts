import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend, AgentMessageOrigin, AgentSession } from '../../src/agents/types.ts';
import { DeviceStore } from '../../src/remote/devices.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { connectPhone, freePort, type PhoneClient } from '../remote-fixture.ts';

/**
 * The listener's shared unread mark, as one table derived from the rule in
 * src/desktop/README.md ("Unread mark"):
 *
 * - A conversation is shown when a connection shows it on a visible page: the
 *   desktop selection while its connection reports `visible: true`, a pop-out
 *   window of a desktop connection that reports `visible: true`, or a remote
 *   connection's selection while it reports `visible: true` (absent counts as
 *   not visible).
 * - A successful turn sets `unread: true` when nobody shows the conversation
 *   at that moment. Errors and stops change nothing.
 * - Showing it clears the mark: selecting it while visible, or becoming
 *   visible with it selected.
 * - The mark reaches every client and is saved: it survives reload,
 *   reconnect, a listener restart and close/reopen. Closing drops every
 *   report of the conversation, so after reopening it must be reported again.
 *
 * Expected values below are computed from these rules and the case's columns
 * only (`expectedAt…`), never read back from the implementation.
 *
 * Every case runs against a real listener control socket, the real gateway,
 * a synthetic agent backend and a temporary session store.
 */

// ---- The table's columns -------------------------------------------------------

type Outcome = 'success' | 'error' | 'cancelled';

/**
 * One client of a case. `desktop` is a sidebar panel (its own main view),
 * `popout` a native host showing the conversation in a pop-out window beside
 * the compact rail, `remote` a phone or browser through the gateway.
 * `visible: undefined` is a remote client that never reports visibility.
 */
interface Viewer {
  kind: 'desktop' | 'popout' | 'remote';
  visible: boolean | undefined;
}

interface ViewerColumn {
  name: string;
  viewers: Viewer[];
}

type Next =
  'select' | 'become visible' | 'reload' | 'reconnect' | 'listener restart' | 'close and reopen';

const outcomes: Outcome[] = ['success', 'error', 'cancelled'];

const viewerColumns: ViewerColumn[] = [
  { name: 'nobody', viewers: [] },
  { name: 'desktop visible', viewers: [{ kind: 'desktop', visible: true }] },
  { name: 'desktop hidden', viewers: [{ kind: 'desktop', visible: false }] },
  { name: 'pop-out window', viewers: [{ kind: 'popout', visible: true }] },
  { name: 'remote visible', viewers: [{ kind: 'remote', visible: true }] },
  { name: 'remote not visible', viewers: [{ kind: 'remote', visible: false }] },
  { name: 'remote not reporting', viewers: [{ kind: 'remote', visible: undefined }] },
  {
    name: 'two clients, one visible (desktop visible, remote not)',
    viewers: [
      { kind: 'desktop', visible: true },
      { kind: 'remote', visible: false },
    ],
  },
  {
    name: 'two clients, one visible (two remotes)',
    viewers: [
      { kind: 'remote', visible: false },
      { kind: 'remote', visible: true },
    ],
  },
];

const nextSteps: Next[] = [
  'select',
  'become visible',
  'reload',
  'reconnect',
  'listener restart',
  'close and reopen',
];

// ---- Expected values, from the rule only ------------------------------------------

/** Whether some viewer shows conversation X: it selected X and its page is visible. */
function shownBy(viewers: Viewer[], selection: 'X' | 'Y'): boolean {
  return selection === 'X' && viewers.some((viewer) => viewer.visible === true);
}

/**
 * For `select`, each viewer looks at another conversation (Y) when the turn
 * ends and then selects X. For every other next step it looks at X.
 */
function selectionAtCompletion(next: Next): 'X' | 'Y' {
  return next === 'select' ? 'Y' : 'X';
}

function expectedAtCompletion(outcome: Outcome, viewers: Viewer[], next: Next): boolean {
  return outcome === 'success' && !shownBy(viewers, selectionAtCompletion(next));
}

function expectedAfterNext(outcome: Outcome, viewers: Viewer[], next: Next): boolean {
  const mark = expectedAtCompletion(outcome, viewers, next);

  if (next === 'select') {
    // Selecting X clears it if the selecting page is visible.
    return mark && !viewers.some((viewer) => viewer.visible === true);
  }
  if (next === 'become visible') {
    // Every viewer becomes visible with X selected.
    return mark && viewers.length === 0;
  }
  if (next === 'reload') {
    // A reloaded page starts on the conversation list: it selects nothing.
    return mark;
  }
  if (next === 'reconnect') {
    // The same reports again: shown now exactly when shown at completion.
    return mark && !shownBy(viewers, 'X');
  }
  // Restart and close/reopen keep the saved mark (checked right after the
  // reopen); nobody can show a closed conversation.
  return mark;
}

// ---- Fixture ----------------------------------------------------------------------

interface Run {
  request: Parameters<AgentBackend['run']>[0];
  finish(): void;
  fail(error: Error): void;
}

type Message = Record<string, any>;

/** A listener (runtime + sessions) and a gateway on one session directory. */
async function startListener(directory: string, runs: Run[]) {
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'unread-fixture',
        label: 'Unread fixture',
        dependencies: {},
        async run(request, runSignal) {
          let finish!: () => void;
          let fail!: (error: Error) => void;
          const done = new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
          runs.push({ request, finish, fail });
          await Promise.race([done, stopped(runSignal)]);
        },
      },
    },
    () => {},
    directory,
  );
  await sessions.loadPrevious();

  const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const gateway = new Gateway({
    host: '127.0.0.1',
    port,
    origins: [origin],
    stateDirectory: join(directory, 'remote-state'),
    controlSocket: desktop.socketPath,
    sessionsDirectory: join(directory, '.companion-sessions'),
    appDirectory: join(directory, 'no-app'),
    log: () => {},
    revocationCheckMilliseconds: 50,
  });
  await gateway.start();

  return {
    sessions,
    desktop,
    url: `ws://127.0.0.1:${port}/api/socket`,
    origin,
    async close() {
      await gateway.close();
      // Closes the sessions too, which waits for unread saves.
      await desktop.close();
    },
  };
}

type Listener = Awaited<ReturnType<typeof startListener>>;

/** The newest `unread` a client received for conversation `id`. */
function latestUnread(messages: Message[], id: string): boolean | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'agent-session' || message.type === 'agent-restored') {
      if (message.session.id === id) {
        return message.session.unread;
      }
    }
    if (message.type === 'state' && Array.isArray(message.sessions)) {
      const session = message.sessions.find((entry: AgentSession) => entry.id === id);
      if (session) {
        return session.unread;
      }
    }
  }
  return undefined;
}

/** `unread` of `id` in a client's first state message (its connect snapshot). */
function snapshotUnread(messages: Message[], id: string): boolean | undefined {
  const state = messages.find((message) => message.type === 'state');
  return state?.sessions?.find((entry: AgentSession) => entry.id === id)?.unread;
}

/** A connected client of one viewer, speaking its real protocol. */
interface Client {
  viewer: Viewer;
  /** Report the page: conversation id (or empty) and, where known, visibility. */
  report(id: string, visible: boolean | undefined): Promise<void>;
  /** Listener messages received, unwrapped from the gateway envelope. */
  messages(): Message[];
  close(): Promise<void>;
}

let requestNumber = 0;

async function desktopClient(listener: Listener, viewer: Viewer): Promise<Client> {
  const socket: Socket = createConnection(listener.desktop.socketPath);
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
  socket.on('error', () => {});
  await once(socket, 'connect');
  await waitFor(() => messages.some((message) => message.type === 'state'));

  return {
    viewer,
    async report(id, visible) {
      const requestId = `report-${++requestNumber}`;
      let report: Record<string, unknown>;
      if (viewer.kind === 'desktop') {
        // A sidebar panel reports its main view. This one keeps the id even
        // while hidden, so only `visible` can tell it is not shown.
        report = { id, composerFocused: false, keyboardFocused: false, visible };
      } else {
        // A pop-out host: the main view is empty (compact rail beside a
        // popped selection) and the conversation is in its own window.
        report = {
          id: '',
          composerFocused: false,
          keyboardFocused: false,
          visible,
          popoutHost: true,
          rail: 'compact',
          popouts: id ? [{ id, active: false, composerFocused: false }] : [],
        };
      }
      socket.write(
        JSON.stringify({
          action: 'panel-state',
          requestId,
          navigationToken: `token-${requestId}`,
          ...report,
        }) + '\n',
      );
      await waitFor(() => messages.some((message) => message.requestId === requestId));
      const reply = messages.find((message) => message.requestId === requestId)!;
      assert.equal(reply.result, 'panel-recorded', JSON.stringify(reply));
    },
    messages: () => messages,
    async close() {
      socket.destroy();
      await once(socket, 'close');
    },
  };
}

async function remoteClient(listener: Listener, viewer: Viewer, token: string): Promise<Client> {
  // Incremental, like the current phone app.
  const phone: PhoneClient = await connectPhone(listener.url, token, listener.origin, true);
  await phone.engine('state');
  const engineMessages = () =>
    phone.messages
      .filter((message) => message.type === 'engine')
      .map((message) => (message as { message: Message }).message);

  return {
    viewer,
    async report(id, visible) {
      const requestId = `report-${++requestNumber}`;
      phone.send({
        action: 'panel-state',
        requestId,
        id,
        ...(visible === undefined ? {} : { visible }),
      });
      const reply = await phone.reply(requestId);
      assert.equal(reply.type, 'result', JSON.stringify(reply));
    },
    messages: engineMessages,
    async close() {
      phone.socket.close();
      await phone.closed;
    },
  };
}

async function connect(listener: Listener, viewer: Viewer, token: string): Promise<Client> {
  if (viewer.kind === 'remote') {
    return remoteClient(listener, viewer, token);
  }
  return desktopClient(listener, viewer);
}

/** A temporary session directory with one paired remote device. */
async function setupCase() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-unread-'));
  const devices = new DeviceStore(join(directory, 'remote-state'));
  const { code } = await devices.createPairingCode();
  const paired = await devices.redeemPairingCode(code, 'Synthetic browser');
  assert.ok(paired.ok);
  return { directory, token: paired.token };
}

function unreadOf(sessions: AgentSessions, id: string): boolean | undefined {
  return sessions.snapshot().find((session) => session.id === id)?.unread;
}

async function startTurn(sessions: AgentSessions, runs: Run[], utterance: string) {
  const count = runs.length;
  const id = sessions.start({ ...frame, utterance }, signal());
  await waitFor(() => runs.length > count);
  return { id, run: runs.at(-1)! };
}

async function turnEnded(sessions: AgentSessions, id: string): Promise<void> {
  await waitFor(() => sessions.interaction(id).agentAcceptsFollowUp === true, 3000);
}

async function endTurn(
  sessions: AgentSessions,
  run: Run,
  id: string,
  outcome: Outcome,
): Promise<void> {
  if (outcome === 'success') {
    run.finish();
  } else if (outcome === 'error') {
    run.fail(Error('Synthetic failure'));
  } else {
    await sessions.stop(id);
  }
  await turnEnded(sessions, id);

  const status = sessions.snapshot().find((session) => session.id === id)?.status;
  const expectedStatus = { success: 'completed', error: 'error', cancelled: 'cancelled' }[outcome];
  assert.equal(status, expectedStatus);
}

// ---- The table --------------------------------------------------------------------

for (const outcome of outcomes) {
  for (const column of viewerColumns) {
    for (const next of nextSteps) {
      const name = `unread: ${outcome} × ${column.name} × ${next}`;

      test(name, async (context) => {
        const { directory, token } = await setupCase();
        const runs: Run[] = [];
        let listener = await startListener(directory, runs);
        let listenerOpen = true;
        context.after(async () => {
          if (listenerOpen) {
            await listener.close();
          }
          await rm(directory, { recursive: true, force: true });
        });
        let sessions = listener.sessions;

        // Y: another conversation to look at, finished and read.
        const other = await startTurn(sessions, runs, 'Other conversation');
        other.run.finish();
        await turnEnded(sessions, other.id);

        const { id, run } = await startTurn(sessions, runs, 'Conversation under test');
        const ids = { X: id, Y: other.id };

        // The viewers connect and report what they show when the turn ends.
        let clients: Client[] = [];
        for (const viewer of column.viewers) {
          clients.push(await connect(listener, viewer, token));
        }
        const atCompletion = ids[selectionAtCompletion(next)];
        for (const client of clients) {
          await client.report(atCompletion, client.viewer.visible);
        }

        await endTurn(sessions, run, id, outcome);
        const mark = expectedAtCompletion(outcome, column.viewers, next);
        assert.equal(unreadOf(sessions, id), mark, 'listener mark when the turn ends');
        for (const client of clients) {
          // Every client, desktop or remote, received the mark.
          await waitFor(() => latestUnread(client.messages(), id) === mark);
        }

        const expected = expectedAfterNext(outcome, column.viewers, next);

        if (next === 'select') {
          for (const client of clients) {
            await client.report(id, client.viewer.visible);
          }
        }

        if (next === 'become visible') {
          for (const client of clients) {
            await client.report(id, true);
          }
        }

        if (next === 'reload' || next === 'reconnect') {
          const reconnected: Client[] = [];
          for (const client of clients) {
            await client.close();
            const fresh = await connect(listener, client.viewer, token);
            // The connect snapshot already carries the saved mark.
            assert.equal(snapshotUnread(fresh.messages(), id), mark, 'snapshot after reconnect');
            const selection = next === 'reload' ? '' : id;
            await fresh.report(selection, client.viewer.visible);
            reconnected.push(fresh);
          }
          // Nobody connected before: a first client sees the mark too.
          if (clients.length === 0) {
            const observer = await connect(listener, { kind: 'desktop', visible: false }, token);
            assert.equal(snapshotUnread(observer.messages(), id), mark);
            reconnected.push(observer);
          }
          clients = reconnected;
        }

        if (next === 'listener restart') {
          // Every connection goes with the listener.
          await listener.close();
          listener = await startListener(directory, runs);
          sessions = listener.sessions;

          const previous = sessions.previousSnapshot().find((entry) => entry.id === id);
          assert.equal(previous?.unread, mark, 'Previous sessions after restart');
          const observer = await connect(listener, { kind: 'desktop', visible: false }, token);
          const state = observer.messages().find((message) => message.type === 'state')!;
          const listed = state.previousSessions.find((entry: AgentSession) => entry.id === id);
          assert.equal(listed.unread, mark, 'previousSessions in a new snapshot');

          await sessions.reopen(id, false);
          clients = [observer];
        }

        if (next === 'close and reopen') {
          await sessions.remove(id);
          const previous = sessions.previousSnapshot().find((entry) => entry.id === id);
          assert.equal(previous?.unread, mark, 'Previous sessions after close');

          await sessions.reopen(id, false);
          assert.equal(unreadOf(sessions, id), expected, 'restored mark');

          // Reports made before the close do not show the reopened
          // conversation: a successful turn now leaves it unread, whoever
          // showed it before.
          const runsBefore = runs.length;
          sessions.followUp(id, 'After reopening', signal());
          await waitFor(() => runs.length > runsBefore);
          await endTurn(sessions, runs.at(-1)!, id, 'success');
          assert.equal(unreadOf(sessions, id), true, 'stale reports do not show it');
          return;
        }

        assert.equal(unreadOf(sessions, id), expected, `listener mark after ${next}`);
        for (const client of clients) {
          await waitFor(() => latestUnread(client.messages(), id) === expected);
        }

        // Saved: after shutdown (which waits for pending saves) the archive
        // agrees with the live mark.
        listenerOpen = false;
        await listener.close();
        const saved = JSON.parse(
          await readFile(join(directory, '.companion-sessions', `${id}.json`), 'utf8'),
        );
        assert.equal(saved.unread === true, expected, 'saved mark');
      });
    }
  }
}

// ---- Cases the columns above cannot express ------------------------------------------

test('unread: an error or a stop after an unread success keeps the mark', async (context) => {
  const { directory } = await setupCase();
  const runs: Run[] = [];
  const listener = await startListener(directory, runs);
  context.after(async () => {
    await listener.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions = listener.sessions;

  const { id, run } = await startTurn(sessions, runs, 'Unread first');
  await endTurn(sessions, run, id, 'success');
  assert.equal(unreadOf(sessions, id), true);

  for (const outcome of ['error', 'cancelled'] as const) {
    const runsBefore = runs.length;
    sessions.followUp(id, `Then ${outcome}`, signal());
    await waitFor(() => runs.length > runsBefore);
    await endTurn(sessions, runs.at(-1)!, id, outcome);
    assert.equal(unreadOf(sessions, id), true, `after ${outcome}`);
  }
});

test('unread: turns started by another agent or an external sender follow the same rule', async (context) => {
  const { directory, token } = await setupCase();
  const runs: Run[] = [];
  const listener = await startListener(directory, runs);
  context.after(async () => {
    await listener.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions = listener.sessions;
  const origins: AgentMessageOrigin[] = [
    { kind: 'agent', sessionId: '00000000-0000-4000-8000-000000000001', title: 'Sender', depth: 1 },
    { kind: 'external', title: 'Synthetic sender', requestId: 'request', depth: 1 },
  ];

  const { id, run } = await startTurn(sessions, runs, 'Started by the person');
  await endTurn(sessions, run, id, 'success');
  const phone = await connect(listener, { kind: 'remote', visible: true }, token);

  for (const origin of origins) {
    // Nobody shows it: the agent's or sender's turn leaves it unread.
    await phone.report('', true);
    let runsBefore = runs.length;
    sessions.followUp(id, `From ${origin.kind}`, signal(), origin);
    await waitFor(() => runs.length > runsBefore);
    await endTurn(sessions, runs.at(-1)!, id, 'success');
    assert.equal(unreadOf(sessions, id), true, `${origin.kind}: nobody shows it`);

    // Shown on a visible page: reading clears it, and the same kind of turn
    // then leaves it read.
    await phone.report(id, true);
    assert.equal(unreadOf(sessions, id), false);
    runsBefore = runs.length;
    sessions.followUp(id, `Again from ${origin.kind}`, signal(), origin);
    await waitFor(() => runs.length > runsBefore);
    await endTurn(sessions, runs.at(-1)!, id, 'success');
    assert.equal(unreadOf(sessions, id), false, `${origin.kind}: shown`);
  }
});

test('unread: an old saved conversation loads as read; only a saved true is unread', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-unread-archive-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, '.companion-sessions');
  await mkdir(archive, { recursive: true });

  const saved: Record<string, unknown> = {
    'aaaaaaaa-0000-4000-8000-000000000001': undefined,
    'aaaaaaaa-0000-4000-8000-000000000002': 'yes',
    'aaaaaaaa-0000-4000-8000-000000000003': true,
    'aaaaaaaa-0000-4000-8000-000000000004': false,
  };
  for (const [id, unread] of Object.entries(saved)) {
    // The format written before this change, plus the field when given.
    const conversation: Record<string, unknown> = {
      id,
      title: 'Saved conversation',
      status: 'completed',
      model: 'local/qwen-synthetic',
      error: '',
      updatedAt: 1,
      messages: [
        {
          id: 'user',
          kind: 'user',
          text: 'Hello',
          input: '',
          toolName: '',
          state: 'done',
          screenshot: false,
        },
      ],
    };
    if (unread !== undefined) {
      conversation.unread = unread;
    }
    await writeFile(join(archive, `${id}.json`), JSON.stringify(conversation));
  }

  const runs: Run[] = [];
  const listener = await startListener(directory, runs);
  context.after(() => listener.close());
  const sessions = listener.sessions;

  const expected: Record<string, boolean> = {
    'aaaaaaaa-0000-4000-8000-000000000001': false,
    'aaaaaaaa-0000-4000-8000-000000000002': false,
    'aaaaaaaa-0000-4000-8000-000000000003': true,
    'aaaaaaaa-0000-4000-8000-000000000004': false,
  };
  for (const [id, unread] of Object.entries(expected)) {
    assert.equal(sessions.previousSnapshot().find((entry) => entry.id === id)?.unread, unread);
    await sessions.reopen(id, false);
    assert.equal(unreadOf(sessions, id), unread, `reopened ${id}`);
  }
});

test('unread: a client that ignores the new fields keeps working', async (context) => {
  const { directory, token } = await setupCase();
  const runs: Run[] = [];
  const listener = await startListener(directory, runs);
  context.after(async () => {
    await listener.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions = listener.sessions;
  const { id, run } = await startTurn(sessions, runs, 'Old client');

  // An older phone app: full snapshots, `{id}` reports without `visible`.
  const phone = await connectPhone(listener.url, token, listener.origin);
  await phone.engine('state');
  phone.send({ action: 'panel-state', requestId: 'old-report', id });
  assert.equal((await phone.reply('old-report')).type, 'result');
  // Its controls still follow its selection.
  await phone.engine('remote-agent-actions', (message) => message.actions.sessionId === id);
  // Its requests are unaffected; it simply never reads a conversation.
  run.finish();
  await turnEnded(sessions, id);
  assert.equal(unreadOf(sessions, id), true);

  // An older desktop panel: no `visible`, legacy single-view report.
  const desktop = await desktopClient(listener, { kind: 'desktop', visible: undefined });
  await desktop.report(id, undefined);
  assert.equal(unreadOf(sessions, id), true, 'a report without visible never reads');
  phone.socket.close();
  await phone.closed;
});

test('unread: visible must be a boolean, at the gateway and at the listener', async (context) => {
  const { directory, token } = await setupCase();
  const runs: Run[] = [];
  const listener = await startListener(directory, runs);
  context.after(async () => {
    await listener.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { id } = await startTurn(listener.sessions, runs, 'Validation');

  const phone = await connectPhone(listener.url, token, listener.origin, true);
  await phone.engine('state');
  for (const visible of ['yes', 1, null]) {
    const requestId = `bad-${String(visible)}`;
    phone.send({ action: 'panel-state', requestId, id, visible });
    const reply = await phone.reply(requestId);
    assert.equal(reply.type, 'error');
    assert.match((reply as { message: string }).message, /visible/);
  }

  // A remote-role connection that bypasses the gateway is refused too.
  const socket = createConnection(listener.desktop.socketPath);
  const lines: Message[] = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(socket, 'connect');
  socket.write(JSON.stringify({ action: 'client-role', role: 'remote', requestId: 'role' }) + '\n');
  socket.write(
    JSON.stringify({ action: 'panel-state', requestId: 'bad', id, visible: 'yes' }) + '\n',
  );
  await waitFor(() => lines.some((line) => line.requestId === 'bad'));
  const reply = lines.find((line) => line.requestId === 'bad')!;
  assert.equal(reply.type, 'error');
  assert.match(reply.message, /visible/);
  socket.destroy();
});
