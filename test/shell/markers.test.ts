import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSession } from '../../src/agents/types.ts';

/**
 * The conversation list's markers (working, answer not seen) and the page's
 * visible report, checked with the rows of the README's three tables
 * (integrations/shell/README.md, "Markers": marker source, visible report,
 * fallback for an older listener) against the real phone Store, unchanged,
 * fed the events the remote role sends, and read through the list's own
 * derivation (`listEntries`). The browser suites (list.test.ts,
 * shared-unread.test.ts) check what a browser can time through the real
 * gateway and listener; this one also covers the orderings they cannot:
 * snapshots after reconnecting, a refused report, a cover and a selection
 * changing in one event.
 *
 * The Store runs in Node with stand-ins for the few browser objects it
 * touches (history, storage, visibility and its event); no network is used.
 * The Connection's `request` is replaced to record the `panel-state`
 * reports the Store sends.
 */

// ---- Browser stand-ins, before the Store is loaded ---------------------------------

const memory = new Map<string, string>();
const page = { visibilityState: 'visible' as 'visible' | 'hidden' };
/** The Stores' `visibilitychange` listeners (the Connection's too). */
const visibilityListeners: (() => void)[] = [];

/** The page becomes hidden or visible: the browser's event, as a tab switch fires it. */
function setVisibility(state: 'visible' | 'hidden'): void {
  page.visibilityState = state;
  for (const listener of visibilityListeners) {
    listener();
  }
}

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
      // A modal's release goes Back over its entry; nothing to do here.
      back() {},
    },
  },
  document: {
    addEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') {
        visibilityListeners.push(listener);
      }
    },
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

/** A conversation as an older listener sends it: without `unread`. */
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

/** A conversation as a listener with the shared mark sends it: always with `unread`. */
function marked(
  id: string,
  status: Status,
  unread: boolean,
  completedTurnId?: string,
): AgentSession {
  return { ...session(id, status, completedTurnId), unread };
}

/** The Store's private event entry points, as the Connection calls them. */
interface StoreInternals {
  apply(event: unknown): void;
  online(): void;
  connectionChanged(state: unknown): void;
}

/** One `panel-state` report as the Store sent it. */
interface Report {
  id: string;
  visible?: boolean;
}

/**
 * Make the Store's connection "online" and record its `panel-state` reports
 * (nothing is sent anywhere). `refuseNext` makes the next request fail
 * with that message, as a refusal by the gateway would; `refuseVisible`
 * refuses every report with `visible`, as a gateway older than the shared
 * mark does.
 */
function recordReports(store: InstanceType<typeof Store>) {
  const reports: Report[] = [];
  const control = { refuseNext: '', refuseVisible: false, refuseAll: false };
  const connection = store.connection as unknown as {
    request(action: string, parameters: Record<string, unknown>): Promise<unknown>;
  };
  connection.request = async (action, parameters) => {
    if (control.refuseNext) {
      const message = control.refuseNext;
      control.refuseNext = '';
      throw Error(message);
    }
    if (control.refuseAll) {
      throw Error('Too many requests');
    }
    if (control.refuseVisible && 'visible' in parameters) {
      throw Error('Unknown field: visible');
    }
    if (action === 'panel-state') {
      reports.push({ ...(parameters as unknown as Report) });
    }
    return {};
  };
  internals(store).connectionChanged({
    status: 'online',
    message: '',
    retryAt: 0,
    deviceName: 'Browser',
  });
  return { reports, control };
}

/**
 * Let a rejected request's handler and the Store's deferred visible check
 * run, and `milliseconds` more of the mocked clock pass (the Store tries a
 * refused report again after a second).
 */
async function settle(
  context: { mock: { timers: { tick(milliseconds: number): void } } },
  milliseconds = 0,
) {
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(0);
  await Promise.resolve();
  if (milliseconds > 0) {
    context.mock.timers.tick(milliseconds);
    await Promise.resolve();
  }
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

test('fallback for an older listener: each row of its table, in one sequence', () => {
  // Conversations without `unread` (`session()`): the Store's own rule.
  page.visibilityState = 'visible';
  // The shell's settings screen covers the selected conversation while
  // `settingsShown` (the Store's `selectionShown` option, as main.tsx sets it).
  let settingsShown = false;
  const store = new Store({ activity: false, selectionShown: () => !settingsShown });
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

  // The settings screen covers the selected conversation: a completed turn
  // there is set; going back (the gear opens the shown conversation) clears.
  settingsShown = true;
  update(store, session('a', 'completed', 'a4'));
  assert.deepEqual(marks(store), { a: 'U', b: 'W' }, 'covered by the settings screen');
  settingsShown = false;
  store.open('a');
  assert.deepEqual(marks(store), { a: '', b: 'W' }, 'back from the settings screen');

  // Selected underneath the settings screen (a conversation started from
  // Activity, selected when its start is answered): its unseen answer keeps
  // the mark until it is shown.
  settingsShown = true;
  update(store, session('a', 'completed', 'a5'));
  store.open('b');
  store.open('a');
  assert.deepEqual(marks(store), { a: 'U', b: 'W' }, 'selected underneath the settings screen');
  settingsShown = false;
  store.open('a');
  assert.deepEqual(marks(store), { a: '', b: 'W' }, 'shown at last');

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

// ---- Marker source ------------------------------------------------------------------

test('marker source: the listener’s mark wherever a conversation carries it', () => {
  page.visibilityState = 'visible';
  const store = new Store({ activity: false });
  const { reports } = recordReports(store);
  internals(store).online();

  // Listener sends `unread: true` / `false`: shown / not shown, whatever the
  // page's own rule says (a first snapshot would mark both completed ones).
  snapshot(store, [
    marked('a', 'completed', false, 'a1'),
    marked('b', 'completed', true, 'b1'),
    marked('c', 'running', false),
  ]);
  assert.deepEqual(marks(store), { a: '', b: 'U', c: 'W' }, 'as the listener sends it');

  // Showing a conversation does not clear its mark by itself: the page
  // reports it as visible and the listener clears it.
  store.open('b');
  assert.deepEqual(reports.at(-1), { id: 'b', visible: true });
  assert.equal(marks(store).b, 'U', 'still marked until the listener says otherwise');
  update(store, marked('b', 'completed', false, 'b1'));
  assert.equal(marks(store).b, '', 'cleared by the listener');

  // A turn completes while another conversation is shown: the listener sets
  // the mark; the page's own toast announces it.
  update(store, marked('a', 'completed', true, 'a2'));
  internals(store).apply({ type: 'agent-turn-completed', id: 'a' });
  assert.equal(marks(store).a, 'U', 'not shown: marked');
  assert.ok(store.state.toasts.some((toast) => toast.text === 'Conversation a — answer ready'));

  // A turn completes in the shown conversation, page visible: not marked,
  // no toast.
  const toasts = store.state.toasts.length;
  update(store, marked('b', 'completed', false, 'b2'));
  internals(store).apply({ type: 'agent-turn-completed', id: 'b' });
  assert.equal(marks(store).b, '', 'shown: not marked');
  assert.equal(store.state.toasts.length, toasts, 'no toast');

  // Read on another device: the listener's update clears it here.
  update(store, marked('a', 'completed', false, 'a2'));
  assert.equal(marks(store).a, '', 'read elsewhere');

  // A conversation started elsewhere, still running: not marked (the own
  // rule would mark a new arrival).
  update(store, marked('d', 'running', false));
  assert.equal(marks(store).d, 'W', 'started elsewhere');

  // Reopened elsewhere: the saved mark, until a device shows it.
  internals(store).apply({ type: 'agent-removed', id: 'a' });
  internals(store).apply({ type: 'agent-restored', session: marked('a', 'completed', true, 'a3') });
  assert.equal(marks(store).a, 'U', 'reopened elsewhere with its saved mark');

  // Reopened from this page's Previous sessions: selected (and reported
  // visible); the saved mark shows until the listener clears it.
  internals(store).apply({ type: 'agent-removed', id: 'c' });
  store.revealNextRestore = 'c';
  internals(store).apply({ type: 'agent-restored', session: marked('c', 'completed', true, 'c1') });
  assert.equal(store.state.selected, 'c');
  assert.deepEqual(reports.at(-1), { id: 'c', visible: true }, 'reported as shown');
  update(store, marked('c', 'completed', false, 'c1'));
  assert.equal(marks(store).c, '', 'reopened here: cleared by the listener');

  // Reconnect: as the reconnect snapshot sends it, also for changes made
  // while offline (a read elsewhere, a turn completed meanwhile).
  internals(store).online();
  snapshot(store, [
    marked('a', 'completed', false, 'a3'),
    marked('b', 'completed', true, 'b3'),
    marked('c', 'completed', false, 'c1'),
    marked('d', 'completed', true, 'd1'),
  ]);
  assert.deepEqual(marks(store), { a: '', b: 'U', c: '', d: 'U' }, 'reconnect');

  // Reload: a new page (a new Store) shows what the listener sends; an
  // answer completed before stays marked until shown.
  const reloaded = new Store({ activity: false });
  recordReports(reloaded);
  internals(reloaded).online();
  snapshot(reloaded, [marked('a', 'completed', false, 'a3'), marked('b', 'completed', true, 'b3')]);
  assert.deepEqual(marks(reloaded), { a: '', b: 'U' }, 'reload');
});

test('marker source: told apart per conversation, by the field alone', () => {
  page.visibilityState = 'visible';
  const store = new Store({ activity: false });
  recordReports(store);
  internals(store).online();

  // An older listener (no field): the own rule marks the completed one on
  // the first snapshot; one that carries the field is the listener's.
  snapshot(store, [session('old', 'completed', 'o1'), marked('new', 'completed', false, 'n1')]);
  assert.deepEqual(marks(store), { old: 'U', new: '' });

  // The field arrives later for the old one: from then on it is the
  // listener's mark; without it again, the own rule's.
  update(store, marked('old', 'completed', false, 'o1'));
  assert.equal(marks(store).old, '', 'listener says read');
  update(store, session('old', 'completed', 'o1'));
  assert.equal(marks(store).old, 'U', 'own rule again: its unseen answer');
});

// ---- Visible report -----------------------------------------------------------------

test('visible report: each row of the README table', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  page.visibilityState = 'visible';

  // The shell's covers, as main.tsx wires them: the settings screen and the
  // Activity column over the chat in a narrow window.
  let settingsShown = false;
  let overlay = false;
  const store = new Store({
    activity: false,
    selectionShown: () => !settingsShown && !overlay,
  });
  const { reports, control } = recordReports(store);
  const covers = (change: () => void) => {
    change();
    store.selectionShownChanged();
  };
  /** The reports sent since the last call. */
  let seen = 0;
  const sent = () => {
    const fresh = reports.slice(seen);
    seen = reports.length;
    return fresh;
  };

  const conversations = [
    marked('a', 'completed', false, 'a1'),
    marked('b', 'completed', false, 'b1'),
    marked('c', 'running', false),
  ];

  // visible | none | first snapshot after connecting → {"", false}
  internals(store).online();
  snapshot(store, conversations);
  assert.deepEqual(sent(), [{ id: '', visible: false }], 'first snapshot');

  // visible | none | tab hidden, then visible again → nothing
  setVisibility('hidden');
  setVisibility('visible');
  await settle(context);
  assert.deepEqual(sent(), [], 'nothing selected: visibility changes nothing');

  // visible | none | select A → {A, true} at once
  store.open('a');
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'select A');

  // visible | A, shown | select A again → nothing
  store.open('a');
  await settle(context);
  assert.deepEqual(sent(), [], 'select A again');

  // visible | A, shown | select B → {B, true} at once
  store.open('b');
  assert.deepEqual(sent(), [{ id: 'b', visible: true }], 'select B');
  store.open('a');
  sent();

  // visible | A, shown | the gear shows the settings screen → {A, false} at once
  covers(() => (settingsShown = true));
  assert.deepEqual(sent(), [{ id: 'a', visible: false }], 'settings over A');

  // visible | A, behind the settings screen | the gear again → {A, true}
  // after the click (Workspace: settings hidden, then the shown page opened)
  covers(() => (settingsShown = false));
  store.open('a');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'back with the gear');

  // visible | A, behind the settings screen | browser Back to B → {B, true}
  // only. The settings screen hears popstate first (main.tsx), the Store's
  // navigation second, in one event.
  covers(() => (settingsShown = true));
  sent();
  covers(() => (settingsShown = false));
  store.open('b');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'b', visible: true }], 'Back to B: never A visible');

  // visible | A, behind the settings screen | B chosen in the list → {B, true}
  // only (the list leaves the settings screen, then opens B).
  store.open('a');
  covers(() => (settingsShown = true));
  sent();
  covers(() => (settingsShown = false));
  store.open('b');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'b', visible: true }], 'B from the list: never A visible');

  // visible | A, behind the settings screen | a started conversation C is
  // selected underneath → {C, false}
  store.open('a');
  covers(() => (settingsShown = true));
  sent();
  store.open('c');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'c', visible: false }], 'C underneath the settings screen');
  covers(() => (settingsShown = false));
  store.open('a');
  await settle(context);
  sent();

  // visible | A, shown, narrow window | the Activity column is shown over it
  // → {A, false} at once; hidden again → {A, true}
  covers(() => (overlay = true));
  assert.deepEqual(sent(), [{ id: 'a', visible: false }], 'narrow column over A');
  covers(() => (overlay = false));
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'column hidden');

  // visible | A, shown, column beside it (wide) | window narrowed under
  // 640 px, then widened → {A, false}, then {A, true}. (The workspace turns
  // the window width into `overlay`; it tells the Store only on a change.)
  covers(() => (overlay = true));
  covers(() => (overlay = false));
  await settle(context);
  assert.deepEqual(
    sent(),
    [
      { id: 'a', visible: false },
      { id: 'a', visible: true },
    ],
    'narrowed and widened',
  );

  // visible | A, shown, column hidden or beside it | window resized without
  // changing the cover, a divider dragged → nothing (no change is told; a
  // check without a change sends nothing either)
  for (let step = 0; step < 20; step++) {
    store.selectionShownChanged();
  }
  await settle(context);
  assert.deepEqual(sent(), [], 'no change, no report');

  // visible | A, shown | tab hidden, then visible again → {A, false} at
  // once, then {A, true}
  setVisibility('hidden');
  assert.deepEqual(sent(), [{ id: 'a', visible: false }], 'hidden');
  setVisibility('visible');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'visible again');

  // hidden | A | a reconnect → {A, false} after the new snapshot
  setVisibility('hidden');
  sent();
  internals(store).online();
  assert.deepEqual(sent(), [], 'nothing before the snapshot');
  snapshot(store, conversations);
  assert.deepEqual(sent(), [{ id: 'a', visible: false }], 'reconnect while hidden');
  setVisibility('visible');
  await settle(context);
  sent();

  // visible | A, shown | a reconnect → {A, true} after the new snapshot
  internals(store).online();
  snapshot(store, conversations);
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'reconnect while visible');

  // visible | A, shown | A closed elsewhere → {"", false}
  internals(store).apply({ type: 'agent-removed', id: 'a' });
  assert.deepEqual(sent(), [{ id: '', visible: false }], 'closed while shown');

  // visible | none (A was closed) | A reopened and selected again →
  // {A, true} again (the listener dropped its report with the close)
  internals(store).apply({
    type: 'agent-restored',
    session: marked('a', 'completed', false, 'a1'),
  });
  sent();
  store.open('a');
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'reopened and shown');

  // visible | B, shown; its report refused (rate) | a second later →
  // {B, true} again
  control.refuseNext = 'Too many requests';
  store.open('b');
  await settle(context);
  assert.deepEqual(sent(), [], 'refused: nothing recorded');
  await settle(context, 1000);
  assert.deepEqual(sent(), [{ id: 'b', visible: true }], 'sent again a second later');

  // hidden | B; {B, false} refused (rate) | a second later → {B, false}
  // again: a page that became hidden is never left counted as visible.
  control.refuseNext = 'Too many requests';
  setVisibility('hidden');
  await settle(context);
  assert.deepEqual(sent(), [], 'the withdrawal refused');
  await settle(context, 1000);
  assert.deepEqual(sent(), [{ id: 'b', visible: false }], 'withdrawn a second later');
  setVisibility('visible');
  await settle(context);
  sent();

  // Refused again and again: tried five more times, a second apart, then
  // no more until a change; a change is still reported.
  let attempts = 0;
  const counting = store.connection as unknown as {
    request(action: string, parameters: Record<string, unknown>): Promise<unknown>;
  };
  const recording = counting.request;
  counting.request = (action, parameters) => {
    attempts += 1;
    return recording(action, parameters);
  };
  control.refuseAll = true;
  store.open('a');
  for (let second = 0; second < 10; second++) {
    await settle(context, 1000);
  }
  assert.equal(attempts, 6, 'the report and five more attempts');
  store.open('b');
  await settle(context);
  assert.equal(attempts, 7, 'a change is still reported');
  control.refuseAll = false;
  counting.request = recording;
  await settle(context, 1000);
  store.open('a');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'a', visible: true }], 'accepted again');
  store.open('b');
  sent();

  // A report refused while the conversation was closed meanwhile (another
  // device closed B just as this page selected it): the close reports that
  // nothing is shown, so the earlier selection is not left counted.
  store.open('c');
  sent();
  control.refuseNext = 'Unknown conversation';
  store.open('b');
  internals(store).apply({ type: 'agent-removed', id: 'b' });
  await settle(context, 1000);
  assert.deepEqual(sent(), [{ id: '', visible: false }], 'closed while its report was refused');

  // visible | A, shown; gateway without `visible` | the refusal arrives →
  // {A} alone, from then on (until the next connection)
  control.refuseVisible = true;
  store.open('a');
  await settle(context);
  assert.deepEqual(sent(), [{ id: 'a' }], 'the selection alone');
  store.open('c');
  assert.deepEqual(sent(), [{ id: 'c' }], 'still the selection alone');
  setVisibility('hidden');
  setVisibility('visible');
  await settle(context, 1000);
  assert.deepEqual(sent(), [], 'visibility is not reported to it');
  control.refuseVisible = false;
  internals(store).online();
  snapshot(store, [marked('a', 'completed', false, 'a1'), marked('c', 'running', false)]);
  assert.deepEqual(sent(), [{ id: 'c', visible: true }], 'a new connection tries `visible` again');
});

test('visible report on the phone: a sheet, menu or the screenshot viewer covers the page', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  page.visibilityState = 'visible';
  // The phone panel's Store: no `selectionShown` option.
  const store = new Store({ activity: false });
  const { reports } = recordReports(store);
  internals(store).online();
  snapshot(store, [marked('a', 'completed', false, 'a1')]);
  store.open('a');
  assert.deepEqual(reports.at(-1), { id: 'a', visible: true });

  // visible | A, shown; phone | a modal opens → {A, false} at once; closed →
  // {A, true}. (Modal.tsx registers every sheet, menu and the viewer.)
  const modal = store.navigation.openModal(() => {});
  assert.deepEqual(reports.at(-1), { id: 'a', visible: false }, 'covered by a modal');
  modal.release();
  await settle(context);
  assert.deepEqual(reports.at(-1), { id: 'a', visible: true }, 'the modal closed');

  // The limit page closes every open modal (it takes the input).
  let closed = false;
  store.navigation.openModal(() => {
    closed = true;
  });
  internals(store).connectionChanged({
    status: 'limited',
    message: '',
    retryAt: 0,
    deviceName: 'Phone',
    limit: 'device',
  });
  assert.equal(closed, true, 'the open modal was closed');
  assert.equal(store.navigation.modalOpen, false);
});
