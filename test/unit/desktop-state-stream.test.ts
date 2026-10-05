// Desktop state stream: large open-conversation snapshots, update bursts and
// per-connection backpressure. Everything here is synthetic: temporary
// sockets, generated text and a temporary database; no personal sessions.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage } from '../../src/agents/types.ts';
import type { Activity } from '../../src/core/activity.ts';
import {
  DesktopServer,
  maximumBacklogBytes,
  maximumStallMilliseconds,
  type OutboundLimits,
  type SnapshotOptions,
} from '../../src/desktop/server.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

/** The observed live size: ~791 KB, almost all of it open-conversation text. */
const openConversationCharacters = 791_000;

type Message = Record<string, unknown> & { type: string };

/** A real socket client that parses complete lines and counts raw bytes. */
interface StreamClient {
  socket: Socket;
  messages: Message[];
  /** Raw bytes received on this connection, including partial lines. */
  bytes(): number;
  /** An unterminated line remains when the connection ended mid-frame. */
  partial(): string;
  closed(): boolean;
}

async function connect(path: string): Promise<StreamClient> {
  const socket = createConnection(path);
  const messages: Message[] = [];
  let buffered = '';
  let received = 0;
  let ended = false;

  socket.on('data', (chunk: Buffer) => {
    received += chunk.length;
    buffered += chunk.toString('utf8');

    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    ended = true;
  });
  await once(socket, 'connect');

  return {
    socket,
    messages,
    bytes: () => received,
    partial: () => buffered,
    closed: () => ended,
  };
}

/**
 * A DesktopServer whose snapshot mirrors the real shape: small activity fields
 * plus (only when requested) a large conversation array. `published` counts
 * ordered events emitted before the snapshot was taken, which lets a client
 * prove that no state overtook, or was overtaken by, an event it reflects.
 */
async function streamServer(context: TestContext, limits?: OutboundLimits) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-state-stream-'));
  const path = join(directory, 'control.sock');
  const conversation = 'x'.repeat(openConversationCharacters);
  let published = 0;
  let revision = 0;
  const disconnected = new Set<number>();

  const server = new DesktopServer(
    path,
    (options: SnapshotOptions) => ({
      protocol: 1,
      revision,
      published,
      ...(options.sessions ? { sessions: [{ id: 'synthetic', messages: conversation }] } : {}),
    }),
    async () => 'ok',
    (clientId) => disconnected.add(clientId),
    limits,
  );
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    path,
    server,
    /** Connection IDs the server has closed (a paused client cannot see EOF). */
    disconnected,
    /** A state change: the snapshot's revision increases. */
    broadcast() {
      revision++;
      server.broadcast();
    },
    /** An ordered event carrying its own sequence number. */
    publish(size = 0) {
      published++;
      server.publish({ type: 'event', seq: published, padding: 'e'.repeat(size) });
    },
    get published() {
      return published;
    },
    get revision() {
      return revision;
    },
  };
}

/**
 * Check the ordering contract of one connection's stream: events arrive
 * complete and in sequence, and each state reflects exactly the events that
 * arrived before it (so no stale snapshot follows a newer event, and no event
 * is reordered before or after a snapshot that already reflects it).
 */
function assertOrdered(messages: Message[], label: string): void {
  let eventsSeen = 0;
  let lastRevision = -1;

  for (const message of messages) {
    if (message.type === 'event') {
      assert.equal(message.seq, eventsSeen + 1, `${label}: events arrive once and in order`);
      eventsSeen++;
    } else if (message.type === 'state') {
      assert.equal(message.published, eventsSeen, `${label}: state reflects preceding events`);
      assert.ok((message.revision as number) > lastRevision, `${label}: states never regress`);
      lastRevision = message.revision as number;
    }
  }
}

function states(client: StreamClient): Message[] {
  return client.messages.filter((message) => message.type === 'state');
}

test('a normally reading client survives the completion burst with ~0.8 MB conversations', async (context) => {
  // Reproduces the observed disconnect: activity callbacks broadcast in
  // successive microtasks during routing, and the old 2 MiB check destroyed
  // the socket before the activity-entry event, mid-frame.
  const setup = await streamServer(context);
  const client = await connect(setup.path);
  await waitFor(() => states(client).length === 1);

  setup.broadcast(); // intentRecognized
  await Promise.resolve();
  setup.broadcast(); // outcome
  await Promise.resolve();
  setup.broadcast(); // transcriptionCleanup
  await Promise.resolve();
  setup.publish(); // activity-entry
  await Promise.resolve();
  setup.broadcast(); // finished

  await waitFor(() => states(client).at(-1)?.revision === setup.revision);
  await delay(50);

  assert.equal(client.closed(), false, 'The connection stays open');
  assert.equal(client.partial(), '', 'No frame is cut off');
  assert.equal(client.messages.filter((message) => message.type === 'event').length, 1);
  assertOrdered(client.messages, 'reader');

  // Superseded snapshots are not all written: the burst costs fewer frames.
  assert.ok(states(client).length < 5, `${states(client).length} state frames`);
});

test('slow and fast clients have independent pressure, bounded coalescing and stable final state', async (context) => {
  const setup = await streamServer(context);
  const slow = await connect(setup.path);
  const fast = await connect(setup.path);
  await waitFor(() => states(slow).length === 1 && states(fast).length === 1);

  // The slow client stops reading entirely while bursts continue.
  slow.socket.pause();

  for (let round = 0; round < 40; round++) {
    setup.broadcast();
    await Promise.resolve();
    setup.publish(64);
    await Promise.resolve();
    setup.broadcast();
  }

  // The fast client is not held back by the stalled one.
  await waitFor(() => states(fast).at(-1)?.revision === setup.revision, 5000);
  assertOrdered(fast.messages, 'fast');
  assert.equal(fast.messages.filter((message) => message.type === 'event').length, 40);

  // 80 snapshots of ~0.8 MB (~63 MB) were produced for a client that read
  // none of them. It remains connected; its pending state was coalesced.
  assert.equal(slow.closed(), false);
  const receivedWhilePaused = slow.bytes();

  slow.socket.resume();
  await waitFor(() => states(slow).at(-1)?.revision === setup.revision, 5000);
  await delay(50);

  assert.equal(slow.closed(), false);
  assertOrdered(slow.messages, 'slow');
  assert.equal(slow.messages.filter((message) => message.type === 'event').length, 40);
  assert.ok(states(slow).length <= 4, `${states(slow).length} coalesced state frames`);
  assert.ok(
    slow.bytes() - receivedWhilePaused < 4 * openConversationCharacters,
    'Resuming delivers the latest state, not every superseded copy',
  );
});

test('ordered replies and navigation are queued behind pending state, never dropped or reordered', async (context) => {
  const setup = await streamServer(context);
  const client = await connect(setup.path);
  await waitFor(() => states(client).length === 1);
  client.socket.pause();

  setup.broadcast();
  setup.broadcast();
  const clientId = 1;
  assert.equal(
    setup.server.publishTo(clientId, { type: 'agent-select', id: 'target', token: 'owner' }),
    true,
    'Accepted into the live connection stream',
  );
  client.socket.write('{"action":"toggle-pause"}\n');
  await delay(20);
  setup.broadcast();

  client.socket.resume();
  await waitFor(() => client.messages.some((message) => message.type === 'result'));
  await waitFor(() => states(client).at(-1)?.revision === setup.revision);

  const types = client.messages.map((message) => message.type);
  const select = types.indexOf('agent-select');
  const result = types.indexOf('result');
  assert.ok(select > 0 && result > select, types.join(','));
  assert.equal(types.at(-1), 'state', 'The newest state follows the reply');
  assert.equal(setup.server.publishTo(99, { type: 'agent-select' }), false, 'Unknown client');
});

test('a stalled client is disconnected by its backlog bound without affecting other clients', async (context) => {
  const setup = await streamServer(context, {
    backlogBytes: 1024 * 1024,
    stallMilliseconds: maximumStallMilliseconds,
  });
  const stalled = await connect(setup.path);
  const reader = await connect(setup.path);
  await waitFor(() => states(stalled).length === 1 && states(reader).length === 1);
  stalled.socket.pause();

  // Ordered events cannot be coalesced; 3 MB of them exceed the 1 MiB bound
  // for the client that reads nothing. Spread over event-loop turns, the
  // reading client drains between them and never approaches the bound.
  for (let index = 0; index < 30; index++) {
    setup.publish(100_000);
    await delay(2);
  }

  // Connection 1 is the stalled client, 2 the reader.
  await waitFor(() => setup.disconnected.has(1));
  await waitFor(() => reader.messages.filter((message) => message.type === 'event').length === 30);
  assert.equal(setup.disconnected.has(2), false);
  assert.equal(reader.closed(), false);
  assertOrdered(reader.messages, 'reader');
});

test('a client that does not drain within the stall bound is disconnected; readers are not', async (context) => {
  const setup = await streamServer(context, {
    backlogBytes: maximumBacklogBytes,
    stallMilliseconds: 200,
  });
  const stalled = await connect(setup.path);
  const reader = await connect(setup.path);
  await waitFor(() => states(stalled).length === 1 && states(reader).length === 1);
  stalled.socket.pause();

  setup.broadcast();
  setup.broadcast();
  await delay(400);
  assert.equal(setup.disconnected.has(1), true, 'The stalled client was released');
  assert.equal(setup.disconnected.has(2), false);
  assert.equal(reader.closed(), false);
  assert.equal(states(reader).at(-1)?.revision, setup.revision);
});

test('one message larger than the backlog bound is still delivered on an idle connection', async (context) => {
  const setup = await streamServer(context, {
    backlogBytes: 64 * 1024,
    stallMilliseconds: maximumStallMilliseconds,
  });
  const client = await connect(setup.path);

  // The ~0.8 MB connect snapshot already exceeds the 64 KiB backlog bound.
  await waitFor(() => states(client).length === 1);
  setup.publish(2 * 1024 * 1024);
  await waitFor(() => client.messages.some((message) => message.type === 'event'));
  assert.equal(client.closed(), false);
});

test('incremental connections omit conversations from routine state; reconnects hydrate fully', async (context) => {
  const setup = await streamServer(context);
  const legacy = await connect(setup.path);
  const incremental = await connect(setup.path);
  await waitFor(() => states(legacy).length === 1 && states(incremental).length === 1);
  assert.ok(states(incremental)[0].sessions, 'Connect snapshots are complete');

  setup.server.enableIncrementalSessions(2);
  const before = incremental.bytes();
  const legacyBefore = legacy.bytes();

  for (let index = 0; index < 7; index++) {
    setup.broadcast();
    await Promise.resolve();
  }
  await waitFor(() => states(incremental).at(-1)?.revision === setup.revision);
  await waitFor(() => states(legacy).at(-1)?.revision === setup.revision);

  const routine = states(incremental).slice(1);
  assert.ok(routine.length >= 1);
  assert.ok(routine.every((message) => !('sessions' in message)));
  const incrementalBytes = incremental.bytes() - before;
  const legacyBytes = legacy.bytes() - legacyBefore;
  assert.ok(incrementalBytes < 1000, `${incrementalBytes} bytes for activity-only updates`);
  assert.ok(legacyBytes > openConversationCharacters, 'Older adapters still get full state');
  context.diagnostic(
    `7 activity broadcasts: incremental ${incrementalBytes} B, legacy ${legacyBytes} B`,
  );

  // A new connection (for example after a drop) starts from a full snapshot.
  incremental.socket.destroy();
  const reconnected = await connect(setup.path);
  await waitFor(() => states(reconnected).length === 1);
  assert.ok(states(reconnected)[0].sessions);
});

test('shutdown with queued lines and a stalled client completes promptly', async (context) => {
  const setup = await streamServer(context);
  const client = await connect(setup.path);
  await waitFor(() => states(client).length === 1);
  client.socket.pause();

  for (let index = 0; index < 10; index++) {
    setup.broadcast();
    setup.publish(1000);
  }

  const started = Date.now();
  await setup.server.close();
  assert.ok(Date.now() - started < 1000);
  client.socket.resume();
  await waitFor(() => client.closed());
});

/** Real listener runtime with synthetic open conversations of ~0.8 MB total. */
async function runtimeWithOpenConversations(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-state-runtime-'));
  const perConversation = Math.ceil(openConversationCharacters / 10);
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'state-stream-fixture',
        label: 'State stream fixture',
        dependencies: {},
        async run(request, _signal, emit) {
          emit(chatMessage(`answer-${request.id}`, 'assistant', 'a'.repeat(perConversation)));
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  const ids: string[] = [];
  // At most four turns run at once; start the ten conversations in turn.
  for (let index = 0; index < 10; index++) {
    ids.push(sessions.start(frame, signal()));
    await sessions.idle();
  }

  return { desktop, sessions, ids };
}

/** One utterance's activity callbacks, separated by microtasks like routing. */
async function completionBurst(activity: Activity, id: number): Promise<void> {
  activity.speechChanged?.(true);
  await Promise.resolve();
  activity.speechChanged?.(false);
  await Promise.resolve();
  activity.processing?.(id);
  await Promise.resolve();
  activity.transcribed?.({ ...frame, id });
  await Promise.resolve();
  activity.intentRecognized?.(id, 'IGNORE');
  await Promise.resolve();
  activity.outcome?.(id, 'ignored');
  await Promise.resolve();
  activity.finished?.(id);
}

test('activity-only updates do not resend open conversations to incremental clients', async (context) => {
  const { desktop, sessions, ids } = await runtimeWithOpenConversations(context);
  const legacy = desktop.client;
  const client = await connect(desktop.socketPath);
  context.after(() => client.socket.destroy());
  await waitFor(() => states(client).length >= 1);

  const hydration = states(client).at(-1)!;
  assert.equal((hydration.sessions as unknown[]).length, 10);
  assert.ok(client.bytes() > openConversationCharacters, 'Connect hydration is complete');

  client.socket.write(
    JSON.stringify({
      action: 'panel-state',
      id: '',
      composerFocused: false,
      incrementalSessions: true,
    }) + '\n',
  );
  await waitFor(() => client.messages.some((message) => message.action === 'panel-state'));

  const clientBefore = client.bytes();
  const legacyStates = desktop.messages.filter((message) => message.type === 'state').length;
  let legacyBytes = 0;
  legacy.on('data', (chunk: string) => {
    legacyBytes += Buffer.byteLength(chunk);
  });

  for (let utterance = 1; utterance <= 3; utterance++) {
    await completionBurst(desktop.runtime.activity, 1000 + utterance);
  }
  await waitFor(
    () => client.messages.filter((message) => message.type === 'activity-entry').length === 3,
  );
  await waitFor(() => states(client).at(-1)?.processing === 0);
  await waitFor(
    () => desktop.messages.filter((message) => message.type === 'activity-entry').length === 3,
  );
  await delay(50);

  const activityBytes = client.bytes() - clientBefore;
  const routine = states(client).filter((message) => message !== hydration);
  assert.ok(routine.length >= 3);
  for (const message of routine) {
    assert.equal('sessions' in message, false);
    assert.equal('previousSessions' in message, false);
    assert.equal('sessionOrderRevision' in message, false);
    assert.ok(Array.isArray(message.history), 'Activity fields remain complete');
  }
  assert.ok(
    activityBytes < 100_000,
    `${activityBytes} bytes for three utterances (conversations are ~0.8 MB)`,
  );
  assert.equal(client.closed(), false);
  assert.equal(client.partial(), '');

  // Older adapters keep full snapshots and also stay connected.
  assert.ok(desktop.messages.filter((message) => message.type === 'state').length > legacyStates);
  assert.ok(desktop.messages.filter((message) => message.type === 'state').at(-1)!.sessions);
  assert.equal(legacy.destroyed, false);
  context.diagnostic(`3 utterance bursts: incremental ${activityBytes} B, legacy ${legacyBytes} B`);

  // Conversation changes still arrive, as ordered incremental events.
  sessions.followUp(ids[3], 'Synthetic follow-up', signal());
  await sessions.idle();
  await waitFor(() =>
    client.messages.some(
      (message) =>
        message.type === 'agent-session' &&
        (message.session as { id: string }).id === ids[3] &&
        (message.session as { messages: { text: string }[] }).messages.some(
          (entry) => entry.text === 'Synthetic follow-up',
        ),
    ),
  );
  const moved = sessions.order();
  sessions.move(ids[3], ids[0], moved.revision);
  await waitFor(() =>
    client.messages.some(
      (message) => message.type === 'agent-order' && message.revision === sessions.order().revision,
    ),
  );
});

test('navigation reaches a busy incremental UI in order; a reconnect refuses the stale token', async (context) => {
  const { desktop, ids } = await runtimeWithOpenConversations(context);
  const client = await connect(desktop.socketPath);
  context.after(() => client.socket.destroy());
  await waitFor(() => states(client).length >= 1);

  client.socket.write(
    JSON.stringify({
      action: 'panel-state',
      id: '',
      composerFocused: false,
      visible: true,
      navigationToken: 'owner-token',
      incrementalSessions: true,
    }) + '\n',
  );
  await waitFor(() => client.messages.some((message) => message.action === 'panel-state'));
  const captured = desktop.runtime.activity.interactionContext!();
  assert.equal(captured.agentNavigation?.token, 'owner-token');

  // The UI is busy (not reading) while a legacy observer and it receive
  // a completion burst; the selection still arrives, after those states.
  client.socket.pause();
  await completionBurst(desktop.runtime.activity, 2001);
  assert.equal(desktop.runtime.activity.selectSession!(captured, 2), true);
  desktop.runtime.activity.speechChanged?.(true);
  client.socket.resume();

  await waitFor(() => client.messages.some((message) => message.type === 'agent-select'));
  const select = client.messages.find((message) => message.type === 'agent-select')!;
  assert.equal(select.id, ids[2]);
  assert.equal(select.token, 'owner-token');
  await waitFor(() => states(client).at(-1)?.speaking === true);
  assert.equal(client.closed(), false);

  // After the connection is lost, the captured token no longer selects.
  client.socket.destroy();
  await waitFor(() => desktop.runtime.activity.interactionContext!().agentNavigation === undefined);
  assert.equal(desktop.runtime.activity.selectSession!(captured, 2), false);
  const reconnected = await connect(desktop.socketPath);
  context.after(() => reconnected.socket.destroy());
  await waitFor(() => states(reconnected).length >= 1);
  assert.equal(desktop.runtime.activity.selectSession!(captured, 2), false);
  await delay(50);
  assert.equal(
    reconnected.messages.some((message) => message.type === 'agent-select'),
    false,
    'No stale command is replayed to another UI connection',
  );
});

test('panel-state rejects a malformed incrementalSessions capability', async (context) => {
  const { desktop } = await runtimeWithOpenConversations(context);
  desktop.send({ action: 'panel-state', id: '', composerFocused: false, incrementalSessions: 1 });
  assert.equal((await desktop.reply('panel-state')).type, 'error');
});

test('a late delta for a closed conversation is not published, so no tab is resurrected', async (context) => {
  const { desktop, sessions, ids } = await runtimeWithOpenConversations(context);
  const client = await connect(desktop.socketPath);
  context.after(() => client.socket.destroy());
  await waitFor(() => states(client).length >= 1);

  // White-box: keep the running session so its flush can be forced after
  // close, as a delayed model-choice rollback or timer could do.
  const running = (sessions as unknown as { sessions: Map<string, unknown> }).sessions.get(ids[0]);
  await sessions.remove(ids[0]);
  await waitFor(() =>
    client.messages.some((message) => message.type === 'agent-removed' && message.id === ids[0]),
  );
  const removedAt = client.messages.length;

  (sessions as unknown as { flush(session: unknown): void }).flush(running);
  desktop.runtime.activity.speechChanged?.(true);
  await waitFor(() => states(client).at(-1)?.speaking === true);

  const late = client.messages
    .slice(removedAt)
    .filter(
      (message) =>
        message.type === 'agent-session' && (message.session as { id: string }).id === ids[0],
    );
  assert.deepEqual(late, []);
});
