import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSession } from '../../src/agents/types.ts';

/**
 * The conversation list's markers (working, answer not seen), checked with
 * the rows of the README's "Markers" table (integrations/shell/README.md)
 * against the real phone Store, unchanged, fed the events the remote role
 * sends, and read through the list's own derivation (`listEntries`). The
 * browser suite (list.test.ts) checks the same rows that a browser can
 * time through the real gateway; this one also covers the orderings it
 * cannot: a hidden page, and snapshots after reconnecting.
 *
 * The Store runs in Node with stand-ins for the few browser objects it
 * touches (history, storage, visibility); no network is used.
 */

// ---- Browser stand-ins, before the Store is loaded ---------------------------------

const memory = new Map<string, string>();
const page = { visibilityState: 'visible' as 'visible' | 'hidden' };

Object.assign(globalThis, {
  window: {
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:1' },
    history: {
      state: null as unknown,
      replaceState(state: unknown) {
        this.state = state;
      },
      pushState(state: unknown) {
        this.state = state;
      },
    },
  },
  document: {
    addEventListener() {},
    get visibilityState() {
      return page.visibilityState;
    },
  },
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

const { Store } = await import('../../integrations/mobile/src/store.ts');
const { listEntries } = await import('../../integrations/shell/src/list/entries.ts');

// ---- Helpers ----------------------------------------------------------------------

type Status = AgentSession['status'];

function session(id: string, status: Status, completedTurnId?: string): AgentSession {
  return {
    id,
    title: `Conversation ${id}`,
    status,
    model: 'synthetic',
    error: '',
    messages: [],
    updatedAt: 0,
    completedTurnId,
  } as AgentSession;
}

/** The Store's private event entry points, as the Connection calls them. */
interface StoreInternals {
  apply(event: unknown): void;
  online(): void;
  connectionChanged(state: unknown): void;
}

function internals(store: InstanceType<typeof Store>): StoreInternals {
  return store as unknown as StoreInternals;
}

function snapshot(store: InstanceType<typeof Store>, sessions: AgentSession[]): void {
  internals(store).apply({
    type: 'state',
    protocol: 1,
    ready: true,
    paused: false,
    pauseReason: '',
    soundsEnabled: false,
    processing: 0,
    preview: false,
    history: [],
    activitySessionId: 'run',
    activityHistoryCount: 0,
    sessions,
    sessionOrderRevision: `revision-${sessions.map((entry) => entry.id).join('')}`,
    sessionControlsAvailable: true,
    previousSessions: [],
    intents: [],
  });
}

function update(store: InstanceType<typeof Store>, changed: AgentSession): void {
  internals(store).apply({ type: 'agent-session', session: changed });
}

/** The list's markers per conversation: "U" unread, "W" working. */
function marks(store: InstanceType<typeof Store>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of listEntries(store.state)) {
    let mark = '';
    if (entry.unread) {
      mark += 'U';
    }
    if (entry.working) {
      mark += 'W';
    }
    result[entry.id] = mark;
  }
  return result;
}

// ---- The table --------------------------------------------------------------------

test('markers: each row of the README table, in one sequence against the real Store', () => {
  page.visibilityState = 'visible';
  const store = new Store({ activity: false });
  internals(store).online();

  // First snapshot after loading: every conversation whose latest turn
  // completed is unread (none is shown yet); running ones are working.
  snapshot(store, [session('a', 'completed', 'a1'), session('b', 'running')]);
  assert.deepEqual(marks(store), { a: 'U', b: 'W' }, 'first snapshot');

  // Selecting clears; selecting again while shown clears again.
  store.open('a');
  assert.deepEqual(marks(store), { a: '', b: 'W' }, 'selected');

  // A turn completes in the shown conversation, page visible: not set.
  update(store, session('a', 'running'));
  assert.deepEqual(marks(store), { a: 'W', b: 'W' }, 'a turn starts: working');
  update(store, session('a', 'completed', 'a2'));
  assert.deepEqual(marks(store), { a: '', b: 'W' }, 'shown, visible');

  // The same with the page hidden (another tab in front): set; selecting
  // the shown conversation again clears it.
  page.visibilityState = 'hidden';
  update(store, session('a', 'completed', 'a3'));
  assert.deepEqual(marks(store), { a: 'U', b: 'W' }, 'shown, hidden page');
  page.visibilityState = 'visible';
  store.open('a');
  assert.deepEqual(marks(store), { a: '', b: 'W' }, 'selected again');

  // A turn completes in a conversation that is not shown: set, no longer working.
  update(store, session('b', 'completed', 'b1'));
  assert.deepEqual(marks(store), { a: '', b: 'U' }, 'not shown');

  // A stopped or failed turn: not set.
  update(store, session('c', 'running'));
  store.open('c');
  store.open('a');
  update(store, session('c', 'cancelled'));
  update(store, session('a', 'error'));
  assert.deepEqual(marks(store), { a: '', b: 'U', c: '' }, 'stopped and failed');

  // A conversation this page has not seen arrives in an event: set.
  update(store, session('d', 'running'));
  assert.deepEqual(marks(store).d, 'UW', 'new arrival');

  // Closed: cleared with it.
  internals(store).apply({ type: 'agent-removed', id: 'd' });
  assert.equal(marks(store).d, undefined, 'closed');
  assert.equal(store.state.unread.has('d'), false);

  // Seen before, reopened elsewhere: not set.
  internals(store).apply({ type: 'agent-restored', session: session('d', 'completed') });
  assert.deepEqual(marks(store).d, '', 'reopened elsewhere');

  // Reopened from this page's Previous sessions: selected, not set.
  internals(store).apply({ type: 'agent-removed', id: 'c' });
  store.revealNextRestore = 'c';
  internals(store).apply({ type: 'agent-restored', session: session('c', 'completed') });
  assert.equal(store.state.selected, 'c');
  assert.deepEqual(marks(store).c, '', 'reopened here');

  // While offline: b (unread) is closed elsewhere; c (shown, page visible)
  // completes a turn; e starts and is still running; f starts and
  // completes; g starts, completes and runs a follow-up. The reconnect
  // snapshot is judged by the same rule as events: a completed turn new to
  // this page sets the mark unless its conversation is shown on a visible
  // page, whatever the conversation's current status.
  internals(store).online();
  snapshot(store, [
    session('a', 'error'),
    session('c', 'completed', 'c1'),
    session('d', 'completed'),
    session('e', 'running'),
    session('f', 'completed', 'f1'),
    session('g', 'running', 'g1'),
  ]);
  assert.equal(store.state.selected, 'c');
  assert.deepEqual(
    marks(store),
    { a: '', c: '', d: '', e: 'W', f: 'U', g: 'UW' },
    'reconnect snapshot',
  );

  // b, closed while offline, kept its mark in the Store: reopened elsewhere
  // without a new turn, its answer is still unseen and the mark shows again.
  internals(store).apply({ type: 'agent-restored', session: session('b', 'completed', 'b1') });
  assert.equal(marks(store).b, 'U', 'closed while offline, reopened');

  // Sign-out: all cleared.
  internals(store).connectionChanged({
    status: 'unpaired',
    message: '',
    retryAt: 0,
    deviceName: '',
  });
  assert.equal(store.state.unread.size, 0, 'sign-out');
});
