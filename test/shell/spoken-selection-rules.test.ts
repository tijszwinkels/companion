/**
 * The shell's rule for spoken navigation (integrations/shell/README.md,
 * "Rule: spoken navigation"; src/listen/spoken-selection.ts), as a table of
 * cases against a stand-in for the phone Store's state. The end-to-end
 * behaviour is in spoken-navigation.test.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Store } from '../../integrations/mobile/src/store.ts';
import type { AgentSelectMessage } from '../../src/remote/protocol.ts';
import {
  isAgentSelect,
  SpokenSelection,
} from '../../integrations/shell/src/listen/spoken-selection.ts';

const x = '00000000-0000-4000-8000-000000000001';
const y = '00000000-0000-4000-8000-000000000002';
const z = '00000000-0000-4000-8000-000000000003';

/** A stand-in for the Store: its state, its subscribers and what was opened. */
function fakeStore(state: { selected: string; showingPrevious?: boolean; listed?: string[] }) {
  const listeners = new Set<() => void>();
  const value = {
    state: {
      connection: { status: 'online' },
      selected: state.selected,
      showingPrevious: state.showingPrevious ?? false,
      orderRevision: 'order-1',
      sessions: new Map((state.listed ?? [x, y, z]).map((id) => [id, { id }])),
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(id: string) {
      value.state.selected = id;
      for (const listener of listeners) {
        listener();
      }
    },
    /** A conversation appears in the list. */
    list(id: string) {
      value.state.sessions.set(id, { id });
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return value;
}

const cases: {
  name: string;
  shown: { selected: string; showingPrevious?: boolean; listed?: string[] };
  message: AgentSelectMessage;
  opened: string[];
}[] = [
  {
    name: 'go-to while the tab still shows what it showed: selects',
    shown: { selected: y },
    message: { type: 'agent-select', id: z, from: y, orderRevision: 'order-1' },
    opened: [z],
  },
  {
    name: 'go-to from no conversation (Activity): selects',
    shown: { selected: '' },
    message: { type: 'agent-select', id: x, from: '', orderRevision: 'order-1' },
    opened: [x],
  },
  {
    name: 'go-to after the tab moved on: refused',
    shown: { selected: x },
    message: { type: 'agent-select', id: z, from: y, orderRevision: 'order-1' },
    opened: [],
  },
  {
    name: 'go-to while Previous sessions is shown, from a conversation: refused',
    shown: { selected: '', showingPrevious: true },
    message: { type: 'agent-select', id: z, from: y, orderRevision: 'order-1' },
    opened: [],
  },
  {
    name: 'go-to after the order changed: refused',
    shown: { selected: y },
    message: { type: 'agent-select', id: z, from: y, orderRevision: 'order-0' },
    opened: [],
  },
  {
    name: 'go-to a conversation no longer listed: refused',
    shown: { selected: y, listed: [x, y] },
    message: { type: 'agent-select', id: z, from: y, orderRevision: 'order-1' },
    opened: [],
  },
  {
    name: 'started, already listed: selects',
    shown: { selected: y },
    message: { type: 'agent-select', id: z, from: y, started: true },
    opened: [z],
  },
  {
    name: 'started after the tab moved on: not selected',
    shown: { selected: x },
    message: { type: 'agent-select', id: z, from: y, started: true },
    opened: [],
  },
];

for (const row of cases) {
  test(`spoken selection: ${row.name}`, () => {
    const store = fakeStore(row.shown);
    const opened: string[] = [];
    const selection = new SpokenSelection({
      store: store as unknown as Store,
      open: (id) => opened.push(id),
    });
    selection.received(row.message);
    assert.deepEqual(opened, row.opened);
  });
}

test('spoken selection: a started conversation listed a moment later is selected then', () => {
  const store = fakeStore({ selected: y, listed: [x, y] });
  const opened: string[] = [];
  const selection = new SpokenSelection({
    store: store as unknown as Store,
    open: (id) => {
      opened.push(id);
      store.open(id);
    },
  });
  selection.received({ type: 'agent-select', id: z, from: y, started: true });
  assert.deepEqual(opened, []);
  store.list(z);
  assert.deepEqual(opened, [z]);
});

test('spoken selection: only well-formed agent-select messages are taken', () => {
  assert.equal(isAgentSelect({ type: 'agent-select', id: x, from: '', orderRevision: 'r' }), true);
  assert.equal(isAgentSelect({ type: 'agent-select', id: x, from: '', started: true }), true);
  assert.equal(isAgentSelect({ type: 'agent-select', id: x, from: '' }), false);
  assert.equal(
    isAgentSelect({ type: 'agent-select', id: x, from: '', started: true, orderRevision: 'r' }),
    false,
  );
  assert.equal(
    isAgentSelect({ type: 'agent-select', id: '', from: '', orderRevision: 'r' }),
    false,
  );
  assert.equal(isAgentSelect({ type: 'audio-ended', id: x, from: '', orderRevision: 'r' }), false);
});
