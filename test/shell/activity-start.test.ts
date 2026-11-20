import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSession } from '../../src/agents/types.ts';

/**
 * Selecting a conversation started from the Activity column
 * (integrations/shell/src/activity/select-started.ts), checked with the
 * cases of its rule in the README's "Start a conversation": selected once
 * listed, unless what is shown changed at any moment since Start, against
 * the real phone Store. The browser suite (activity.test.ts) checks the
 * plain case through the real gateway; this one also covers the orderings a
 * browser cannot time: a selection made and undone while the start is on
 * its way, an answer before or after the conversation's event, a failure,
 * sign-out and a conversation that never appears.
 *
 * The Store runs in Node with stand-ins for the few browser objects it
 * touches (history, storage, visibility); no network is used.
 */

// ---- Browser stand-ins, before the Store is loaded ---------------------------------

const memory = new Map<string, string>();

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
    visibilityState: 'visible',
  },
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

const { Store } = await import('../../integrations/mobile/src/store.ts');
const { StartedSelection, waitMilliseconds } =
  await import('../../integrations/shell/src/activity/select-started.ts');

// ---- Helpers ----------------------------------------------------------------------

interface StoreInternals {
  apply(event: unknown): void;
  online(): void;
  connectionChanged(state: unknown): void;
}

function session(id: string): AgentSession {
  return {
    id,
    title: `Conversation ${id}`,
    status: 'completed',
    model: 'synthetic',
    error: '',
    messages: [],
    updatedAt: 0,
  } as unknown as AgentSession;
}

/** A paired, connected Store with conversations A and B, showing A. */
function connectedStore() {
  const store = new Store({ activity: false });
  const internals = store as unknown as StoreInternals;
  internals.online();
  internals.connectionChanged({ status: 'online', message: '', retryAt: 0, deviceName: '' });
  internals.apply({
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
    sessions: [session('A'), session('B')],
    sessionOrderRevision: 'revision',
    sessionControlsAvailable: true,
    previousSessions: [],
    intents: [],
  });
  store.open('A');

  /** Count Store.open calls for the started conversation. */
  let opens = 0;
  const open = store.open.bind(store);
  store.open = (id: string) => {
    if (id === 'C') {
      opens++;
    }
    open(id);
  };

  return {
    store,
    /** The started conversation C arrives in the list (its event). */
    listed(): void {
      internals.apply({ type: 'agent-session', session: session('C') });
    },
    signOut(): void {
      internals.connectionChanged({ status: 'unpaired', message: '', retryAt: 0, deviceName: '' });
    },
    opens: () => opens,
  };
}

// ---- The cases ----------------------------------------------------------------------

test('started conversation: selected once listed, unless what is shown changed meanwhile', () => {
  // Answered first, listed later: selected when it is listed.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    selection.started('C');
    assert.equal(page.store.state.selected, 'A', 'not listed yet');
    page.listed();
    assert.equal(page.store.state.selected, 'C', 'answered, then listed');
    assert.equal(page.opens(), 1);
    // Done: a later change does not select it again.
    page.store.open('B');
    page.listed();
    assert.equal(page.store.state.selected, 'B');
    assert.equal(page.opens(), 1);
  }

  // Listed before the answer: selected at the answer.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    page.listed();
    selection.started('C');
    assert.equal(page.store.state.selected, 'C', 'listed, then answered');
  }

  // The reader selected B while the start was on its way: not selected.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    page.store.open('B');
    selection.started('C');
    page.listed();
    assert.equal(page.store.state.selected, 'B', 'another selection');
    assert.equal(page.opens(), 0);
  }

  // The reader selected B and returned to A meanwhile: not selected either.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    page.store.open('B');
    page.store.open('A');
    selection.started('C');
    page.listed();
    assert.equal(page.store.state.selected, 'A', 'selected and returned');
    assert.equal(page.opens(), 0);
  }

  // The reader navigated after the answer, before the conversation was listed.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    selection.started('C');
    page.store.open('B');
    page.listed();
    assert.equal(page.store.state.selected, 'B', 'selected after the answer');
    assert.equal(page.opens(), 0);
  }

  // The start failed (or named no conversation): nothing is selected later.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    selection.cancel();
    page.listed();
    assert.equal(page.store.state.selected, 'A', 'failed start');
    assert.equal(page.opens(), 0);
  }

  // Signed out while waiting: nothing is selected for the next pairing.
  {
    const page = connectedStore();
    const selection = new StartedSelection(page.store);
    selection.started('C');
    page.signOut();
    page.listed();
    assert.equal(page.opens(), 0, 'sign-out');
  }
});

test('started conversation: waiting ends after the deadline', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const page = connectedStore();
  const selection = new StartedSelection(page.store);
  selection.started('C');
  context.mock.timers.tick(waitMilliseconds);
  page.listed();
  assert.equal(page.store.state.selected, 'A', 'listed after the deadline');
  assert.equal(page.opens(), 0);
});
