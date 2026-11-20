import assert from 'node:assert/strict';
import test from 'node:test';

import { historyPage, type HistoryPage } from '../../src/agents/history-pages.ts';
import { chatMessage, type AgentSession } from '../../src/agents/types.ts';
import type { Store } from '../../integrations/mobile/src/store.ts';
import { pageToAsk, pulledBack } from '../../integrations/session-apps/chat/Chat.tsx';
import type { ChatStatus, HostMessage } from '../../integrations/session-apps/chat/protocol.ts';
import { GatewayChatBridge } from '../../integrations/shell/src/bridge.ts';
import { ResidentHistory, type PageRequest } from '../../integrations/shell/src/history.ts';

/**
 * Type-checked with integrations/shell/tsconfig.json (`npm run check`), which
 * declares the shared plain ES modules; the root configuration excludes it.
 *
 * The browser shell's bridge and resident history model in Node, without a
 * browser or gateway: a small stand-in for the phone Store records the
 * requests the bridge makes and lets each test decide when (and how) they
 * are answered. These cover orderings a browser test cannot time reliably;
 * test/shell/shell.test.ts covers the real page, gateway and listener.
 */

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

interface Pending {
  action: string;
  parameters: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function session(id: string, text: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: id,
    title: text,
    status: 'completed',
    model: 'synthetic/model',
    error: '',
    messages: [chatMessage(id + '-question', 'user', text)],
    updatedAt: 1,
    toolEpoch: 'epoch-' + id,
    ...overrides,
  };
}

/** The parts of the phone Store the bridge uses, with controllable requests. */
class FakeStore {
  state = {
    connection: { status: 'online', message: '', retryAt: 0, deviceName: 'Synthetic' },
    // Undefined until the first snapshot, as in the phone Store.
    engine: undefined as object | undefined,
    sessions: new Map<string, AgentSession>(),
    selected: '',
    sends: new Map<string, { pending: boolean; error: string }>(),
    actions: undefined as unknown,
  };
  readonly pending: Pending[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, string>();
  readonly connection = {
    request: (action: string, parameters: Record<string, unknown>) =>
      this.request(action, parameters),
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(change: Partial<FakeStore['state']>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }

  draft(id: string): string {
    return this.drafts.get(id) ?? '';
  }

  setDraft(id: string, text: string): void {
    this.drafts.set(id, text);
    this.update({});
  }

  // Listener drafts (Store.draftUnsaved and the rest): set by a test, else none.
  readonly unsaved = new Map<string, string>();
  readonly sources = new Map<string, string>();
  readonly savedOrDiscarded: string[] = [];

  draftUnsaved(id: string): string {
    return this.unsaved.get(id) ?? '';
  }

  draftSource(id: string): string {
    return this.sources.get(id) ?? '';
  }

  saveUnsavedDraft(id: string): boolean {
    this.savedOrDiscarded.push('save ' + id);
    return this.unsaved.delete(id);
  }

  discardUnsavedDraft(id: string): boolean {
    this.savedOrDiscarded.push('discard ' + id);
    return this.unsaved.delete(id);
  }

  open(id: string): void {
    this.update({ selected: id });
  }

  request(action: string, parameters: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.push({ action, parameters, resolve, reject });
    });
  }

  /** As Store.sendDraft: pending at once, the draft cleared on success. */
  async sendDraft(id: string): Promise<void> {
    const text = this.draft(id);
    this.update({ sends: new Map(this.state.sends).set(id, { pending: true, error: '' }) });
    try {
      await this.request('send-agent', { id, text });
      if (this.draft(id) === text) {
        this.setDraft(id, '');
      }
      const sends = new Map(this.state.sends);
      sends.delete(id);
      this.update({ sends });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ sends: new Map(this.state.sends).set(id, { pending: false, error: message }) });
    }
  }
}

/** A bridge over a FakeStore with the page's messages decoded in order. */
function harness() {
  const store = new FakeStore();
  store.state.sessions.set(sessionA, session(sessionA, 'Question A'));
  store.state.sessions.set(sessionB, session(sessionB, 'Question B'));
  store.state.selected = sessionA;
  const bridge = new GatewayChatBridge(store as unknown as Store, {
    visibleIndexes: () => [],
    topIndex: () => -1,
  });
  const messages: HostMessage[] = [];
  bridge.message.connect((json) => messages.push(JSON.parse(json) as HostMessage));
  bridge.ready('synthetic-document');
  // The connection's first snapshot.
  store.update({ engine: { paused: false } });
  return { store, bridge, messages };
}

/** Let queued deliveries and the bridge's 0 ms and 30 ms timers run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function lastStatus(messages: HostMessage[]): ChatStatus {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'status') {
      return message.status;
    }
  }
  throw Error('No status message');
}

/** Ask the bridge and decode its answer. */
function ask(call: (callback: (answer: string) => void) => void): Promise<{ accepted: boolean }> {
  return new Promise((resolve) => call((answer) => resolve(JSON.parse(answer))));
}

test('messages are numbered without gaps and ready() resends everything in full', async () => {
  const { bridge, messages } = harness();
  await settle();
  assert.ok(messages.length >= 2);
  messages.forEach((message, index) => assert.equal(message.seq, index + 1));
  const first = messages[0];
  assert.equal(first.type, 'rows');
  assert.equal(first.type === 'rows' && first.full, true);

  const before = messages.length;
  bridge.ready('synthetic-document');
  await settle();
  const again = messages.slice(before);
  assert.equal(again[0].type, 'rows');
  assert.equal(again[0].type === 'rows' && again[0].full, true);
  assert.equal(again[0].seq, before + 1);
  assert.equal(again[1].type, 'status');
});

/**
 * The page's latest status once it satisfies `check`: waits for the state
 * the test means instead of a fixed pause (bounded, so a missing status fails).
 */
async function statusWhere(
  messages: HostMessage[],
  check: (status: ChatStatus) => boolean,
): Promise<ChatStatus> {
  const until = Date.now() + 2000;
  for (;;) {
    const statuses = messages.filter((message) => message.type === 'status');
    const latest = statuses[statuses.length - 1];
    if (latest && latest.type === 'status' && check(latest.status)) {
      return latest.status;
    }
    if (Date.now() > until) {
      throw Error('The expected status never reached the page');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('listener drafts reach the page: unsaved text, the agent source with Clear, Save, Discard and Close', async () => {
  const { store, bridge, messages } = harness();

  // Without listener drafts (the Store reports none) the status is as before.
  let status = await statusWhere(messages, (candidate) => candidate.sessionId === sessionA);
  assert.equal(status.draftUnsaved, '');
  assert.equal(status.draft!.source, '');
  assert.equal('clearable' in status.draft!, false, 'no Clear without an agent source');

  // An agent's unedited proposal: its source, and Clear.
  store.sources.set(sessionA, 'Planner');
  store.update({});
  status = await statusWhere(messages, (candidate) => candidate.draft!.source === 'Planner');
  assert.equal(status.draft!.clearable, true);

  // Unsaved text: its reason; Close is refused (page and list) until it is
  // saved or discarded.
  store.sources.delete(sessionA);
  store.unsaved.set(sessionA, 'Companion is not connected; your text is not saved yet.');
  store.update({});
  status = await statusWhere(messages, (candidate) => candidate.draftUnsaved !== '');
  assert.equal(status.draftUnsaved, 'Companion is not connected; your text is not saved yet.');
  assert.equal(status.draft!.source, '');
  assert.equal('clearable' in status.draft!, false);
  assert.equal(bridge.canClose(sessionA), false);
  assert.equal(bridge.canClose(sessionB), true);
  assert.deepEqual(await ask((callback) => bridge.closeSession(sessionA, callback)), {
    accepted: false,
  });
  assert.equal(store.pending.filter((request) => request.action === 'close-agent').length, 0);

  // Save and Discard act only on the shown conversation.
  assert.deepEqual(await ask((callback) => bridge.saveDraft(sessionB, callback)), {
    accepted: false,
  });
  assert.deepEqual(await ask((callback) => bridge.saveDraft(sessionA, callback)), {
    accepted: true,
  });
  store.unsaved.set(sessionA, 'refused');
  assert.deepEqual(await ask((callback) => bridge.discardUnsavedDraft(sessionA, callback)), {
    accepted: true,
  });
  assert.deepEqual(store.savedOrDiscarded, ['save ' + sessionA, 'discard ' + sessionA]);
  assert.equal(bridge.canClose(sessionA), true);
});

test('a send based on an older draft revision is refused (no second send)', async () => {
  const { store, bridge, messages } = harness();
  await settle();
  const base = lastStatus(messages).draft!.revision;
  assert.deepEqual(
    await ask((answer) => bridge.editDraft(sessionA, base, 'Send me once', 12, answer)),
    { accepted: true },
  );
  assert.deepEqual(await ask((answer) => bridge.send(sessionA, base, 'Send me once', answer)), {
    accepted: true,
  });
  assert.equal(store.pending.length, 1);

  // The send is answered: the draft is cleared and its revision advances,
  // but the page has not seen that status yet when a second Enter arrives.
  store.pending[0].resolve('submitted');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.draft(sessionA), '');
  assert.deepEqual(await ask((answer) => bridge.send(sessionA, base, 'Send me once', answer)), {
    accepted: false,
  });
  assert.equal(store.pending.length, 1);
  assert.equal(store.draft(sessionA), '');
  await settle();
  assert.equal(lastStatus(messages).draft!.revision, base + 1);
});

test('switching conversations sends the new rows together with their status', async () => {
  const { store, messages } = harness();
  await settle();
  const before = messages.length;
  store.open(sessionB);
  await Promise.resolve();
  await Promise.resolve();
  const after = messages.slice(before);
  assert.ok(after.length >= 2);
  assert.equal(after[0].type, 'rows');
  assert.equal(after[0].type === 'rows' && after[0].sessionId, sessionB);
  assert.equal(after[0].type === 'rows' && after[0].full, true);
  assert.equal(after[1].type, 'status');
  assert.equal(after[1].type === 'status' && after[1].status.sessionId, sessionB);
});

test('a pending choice holds sends back, also across navigation, until it settles', async () => {
  const { store, bridge, messages } = harness();
  store.update({
    actions: {
      sessionId: sessionA,
      stopRunId: '',
      choices: [
        {
          sessionId: sessionA,
          revision: 'choice-1',
          index: 0,
          label: 'Yes',
          description: 'Go ahead',
          available: true,
          voiceAvailable: false,
          voiceReason: '',
        },
      ],
    },
  });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.choose(sessionA, 'choice-1', 0, answer)), {
    accepted: true,
  });
  assert.equal(store.pending.length, 1);
  assert.equal(store.pending[0].action, 'choose-agent');

  store.open('');
  store.open(sessionA);
  await settle();
  const status = lastStatus(messages);
  assert.equal(status.pendingChoice, true);
  assert.equal(status.canSend, false);
  const base = status.draft!.revision;
  bridge.editDraft(sessionA, base, 'Not now', 7);
  assert.deepEqual(await ask((answer) => bridge.send(sessionA, base, 'Not now', answer)), {
    accepted: false,
  });

  store.pending[0].resolve('chosen');
  await settle();
  assert.equal(lastStatus(messages).pendingChoice, false);
  assert.equal(lastStatus(messages).canSend, true);
});

test('after reconnecting nothing is admitted until the new snapshot arrived', async () => {
  const { store, bridge, messages } = harness();
  await settle();
  assert.equal(lastStatus(messages).online, true);

  store.update({ connection: { ...store.state.connection, status: 'reconnecting' } });
  // Authenticated again, but the listener's snapshot is still on its way:
  // the shown conversation may be stale.
  store.update({ connection: { ...store.state.connection, status: 'online' } });
  await settle();
  assert.equal(lastStatus(messages).online, false);
  assert.deepEqual(await ask((answer) => bridge.closeSession(sessionA, answer)), {
    accepted: false,
  });
  assert.equal(store.pending.length, 0);

  // The snapshot replaces the engine state (the Store ignores partial ones
  // before it).
  store.update({ engine: { paused: false } });
  await settle();
  assert.equal(lastStatus(messages).online, true);
  assert.deepEqual(await ask((answer) => bridge.closeSession(sessionA, answer)), {
    accepted: true,
  });
  assert.equal(store.pending[0].action, 'close-agent');
});

test('signing out forgets input held for the previous pairing', async () => {
  const { store, bridge, messages } = harness();
  await settle();
  const base = lastStatus(messages).draft!.revision;
  // Text longer than the bridge accepts stays only in the page's editor and
  // holds the conversation open.
  const refused = await ask((answer) =>
    bridge.editDraft(sessionA, base, 'x'.repeat(20_000), 0, answer),
  );
  assert.equal(refused.accepted, false);
  assert.deepEqual(await ask((answer) => bridge.closeSession(sessionA, answer)), {
    accepted: false,
  });

  store.update({
    connection: { ...store.state.connection, status: 'unpaired' },
    selected: '',
    engine: undefined,
  });
  store.update({ connection: { ...store.state.connection, status: 'online' } });
  store.update({ engine: { paused: false }, selected: sessionA });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.closeSession(sessionA, answer)), {
    accepted: true,
  });
});

test('the same conversation reopened in a new lifetime is replaced like a switch', async () => {
  const { store, messages } = harness();
  await settle();
  const before = messages.length;
  // A reconnect snapshot: same ID, closed and reopened elsewhere meanwhile.
  const reopened = session(sessionA, 'Question A again', { toolEpoch: 'epoch-reopened' });
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, reopened) });
  await Promise.resolve();
  await Promise.resolve();
  const after = messages.slice(before);
  assert.ok(after.length >= 2);
  assert.equal(after[0].type, 'rows');
  assert.equal(after[0].type === 'rows' && after[0].full, true);
  assert.equal(after[1].type, 'status');
});

/**
 * The browser's Stop rule, as one table. The rule (integrations/shell/README.md):
 *
 * 1. The browser never sends the unscoped `stop-agent`.
 * 2. A Stop it sends is `stop-agent-run` naming the run that Stop was
 *    rendered for: the `stopRunId` of the status the page showed.
 * 3. It is sent only while connected (after the connection's new snapshot)
 *    and while that run is still the run the conversation names; otherwise
 *    nothing is sent.
 * 4. The page shows the per-run Stop exactly when the conversation names a
 *    run (`stopRunId` set) and the footer Stop when it runs without one; the
 *    footer Stop sends nothing.
 *
 * Each case says what the listener reports before the page renders, what
 * happens between rendering and the click, which Stop the page shows and
 * the one request the rule allows (or none). The expectations follow from
 * the rule alone.
 */
type StopEvent =
  /** The listener publishes the conversation (a run ID only while named). */
  | { conversation: 'running' | 'completed' | 'cancelled'; runId?: string }
  /** The listener's controls report for this browser. */
  | { controls: string }
  /** The connection drops and authenticates again, before its new snapshot. */
  | { reconnect: true }
  /** The new connection's snapshot, showing the conversation like this. */
  | { snapshot: 'running' | 'completed' | 'cancelled'; runId?: string };

interface StopCase {
  name: string;
  /** The conversation in this browser's first snapshot. */
  first: { status: 'running' | 'completed'; runId?: string };
  beforeRender: StopEvent[];
  /** The Stop the page shows (rule 4). */
  shown: 'per-run' | 'footer' | 'none';
  betweenRenderAndClick: StopEvent[];
  /** The run ID of the one `stop-agent-run` sent, or null for nothing. */
  expected: string | null;
}

const stopCases: StopCase[] = [
  {
    name: 'a named run: the per-run Stop names it',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [],
    expected: 'run-1',
  },
  {
    name: 'a named run with the controls report naming it too',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [{ controls: 'run-1' }],
    shown: 'per-run',
    betweenRenderAndClick: [],
    expected: 'run-1',
  },
  {
    name: 'the run changes between rendering and the click',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ conversation: 'running', runId: 'run-2' }],
    expected: null,
  },
  {
    name: 'the Stop rendered for the new run names the new run',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [{ conversation: 'running', runId: 'run-2' }],
    shown: 'per-run',
    betweenRenderAndClick: [],
    expected: 'run-2',
  },
  {
    name: 'an ending turn: its run ID is withdrawn after rendering, still running',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ conversation: 'running' }, { controls: '' }],
    expected: null,
  },
  {
    name: 'an ending turn rendered after its run ID was withdrawn: footer Stop',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [{ conversation: 'running' }, { controls: '' }],
    shown: 'footer',
    betweenRenderAndClick: [],
    expected: null,
  },
  {
    name: 'the first snapshot already shows an ending turn, then the controls arrive',
    first: { status: 'running' },
    beforeRender: [],
    shown: 'footer',
    betweenRenderAndClick: [{ controls: '' }],
    expected: null,
  },
  {
    name: 'a conversation that never names its run (footer Stop)',
    first: { status: 'running' },
    beforeRender: [{ controls: '' }],
    shown: 'footer',
    betweenRenderAndClick: [],
    expected: null,
  },
  {
    name: 'reconnect: clicked before the new snapshot',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ reconnect: true }],
    expected: null,
  },
  {
    name: 'reconnect: the new snapshot shows the same run',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ reconnect: true }, { snapshot: 'running', runId: 'run-1' }],
    expected: 'run-1',
  },
  {
    name: 'reconnect: the new snapshot shows a follow-up run',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ reconnect: true }, { snapshot: 'running', runId: 'run-2' }],
    expected: null,
  },
  {
    name: 'another client stops the run meanwhile',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [{ conversation: 'running' }, { conversation: 'cancelled' }],
    expected: null,
  },
  {
    name: 'a follow-up starts meanwhile',
    first: { status: 'running', runId: 'run-1' },
    beforeRender: [],
    shown: 'per-run',
    betweenRenderAndClick: [
      { conversation: 'completed' },
      { conversation: 'running', runId: 'run-2' },
      { controls: 'run-2' },
    ],
    expected: null,
  },
  {
    name: 'a finished conversation shows no Stop',
    first: { status: 'completed' },
    beforeRender: [],
    shown: 'none',
    betweenRenderAndClick: [],
    expected: null,
  },
];

/** Apply one listener or connection event to the stand-in Store. */
function applyStopEvent(store: FakeStore, event: StopEvent): void {
  if ('conversation' in event || 'snapshot' in event) {
    const status = 'conversation' in event ? event.conversation : event.snapshot;
    const changed = session(sessionA, 'Question A', { status: status, runId: event.runId });
    const sessions = new Map(store.state.sessions).set(sessionA, changed);
    if ('snapshot' in event) {
      // A snapshot replaces the engine state too (see the reconnect test).
      store.update({ sessions: sessions, engine: { paused: false } });
    } else {
      store.update({ sessions: sessions });
    }
    return;
  }
  if ('controls' in event) {
    store.update({ actions: { sessionId: sessionA, stopRunId: event.controls, choices: [] } });
    return;
  }
  store.update({ connection: { ...store.state.connection, status: 'reconnecting' } });
  store.update({ connection: { ...store.state.connection, status: 'online' } });
}

for (const stopCase of stopCases) {
  test(`Stop rule: ${stopCase.name}`, async () => {
    const store = new FakeStore();
    const first = session(sessionA, 'Question A', {
      status: stopCase.first.status,
      runId: stopCase.first.runId,
    });
    store.state.sessions.set(sessionA, first);
    store.state.selected = sessionA;
    const bridge = new GatewayChatBridge(store as unknown as Store, {
      visibleIndexes: () => [],
      topIndex: () => -1,
    });
    const messages: HostMessage[] = [];
    bridge.message.connect((json) => messages.push(JSON.parse(json) as HostMessage));
    bridge.ready('synthetic-document');
    store.update({ engine: { paused: false } });
    for (const event of stopCase.beforeRender) {
      applyStopEvent(store, event);
    }
    await settle();

    // What the page renders (Chat.tsx): the per-run Stop for `stopRunId`,
    // else the footer Stop while running.
    const rendered = lastStatus(messages);
    let shown: StopCase['shown'] = 'none';
    if (rendered.stopRunId) {
      shown = 'per-run';
    } else if (rendered.running) {
      shown = 'footer';
    }
    assert.equal(shown, stopCase.shown);

    for (const event of stopCase.betweenRenderAndClick) {
      applyStopEvent(store, event);
    }
    if (shown === 'per-run') {
      bridge.stopRun(sessionA, rendered.stopRunId!);
    } else if (shown === 'footer') {
      bridge.stop(sessionA);
    }
    await settle();

    const stops = store.pending.filter((request) => request.action.startsWith('stop-agent'));
    if (stopCase.expected === null) {
      assert.deepEqual(stops, []);
    } else {
      assert.equal(stops.length, 1);
      assert.equal(stops[0].action, 'stop-agent-run');
      assert.deepEqual(stops[0].parameters, { id: sessionA, runId: stopCase.expected });
    }
    if (shown === 'footer') {
      assert.match(lastStatus(messages).inputError ?? '', /Stop is not available/);
    }
  });
}

test('notices and pending choices end with the conversation lifetime', async () => {
  const { store, bridge, messages } = harness();
  store.update({
    actions: {
      sessionId: sessionA,
      stopRunId: '',
      choices: [
        {
          sessionId: sessionA,
          revision: 'choice-1',
          index: 0,
          label: 'Yes',
          description: 'Go ahead',
          available: true,
          voiceAvailable: false,
          voiceReason: '',
        },
      ],
    },
  });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.choose(sessionA, 'choice-1', 0, answer)), {
    accepted: true,
  });
  // A notice of this lifetime, shown before the conversation is reopened.
  bridge.classicView();
  await settle();
  assert.equal(lastStatus(messages).pendingChoice, true);
  assert.match(lastStatus(messages).inputError ?? '', /not available in the browser/);

  // Closed and reopened elsewhere under the same ID (a new tool epoch).
  const reopened = session(sessionA, 'Question A again', { toolEpoch: 'epoch-reopened' });
  store.update({
    sessions: new Map(store.state.sessions).set(sessionA, reopened),
    actions: undefined,
  });
  await settle();
  let status = lastStatus(messages);
  assert.equal(status.inputError, '');
  assert.equal(status.pendingChoice, false);
  assert.equal(status.canSend, true);

  // The old lifetime's choice fails late: no notice in the new lifetime.
  store.pending[0].reject(Error('This choice is no longer offered'));
  await settle();
  status = lastStatus(messages);
  assert.equal(status.inputError, '');
});

test('an uncertain send stays visible next to other notices', async () => {
  const { store, bridge, messages } = harness();
  await settle();
  const base = lastStatus(messages).draft!.revision;
  bridge.editDraft(sessionA, base, 'Maybe sent', 10);
  bridge.send(sessionA, base, 'Maybe sent');
  await settle();
  bridge.classicView();
  store.pending[0].reject(Error('The connection dropped before Companion answered.'));
  await settle();
  const notice = lastStatus(messages).inputError ?? '';
  assert.match(notice, /^The connection dropped before Companion answered\./);
  assert.match(notice, /not available in the browser/);
  assert.equal(store.draft(sessionA), 'Maybe sent');
});

test('a request failing after sign-out leaves no notice for the next pairing', async () => {
  const { store, bridge, messages } = harness();
  const running = session(sessionA, 'Question A', { status: 'running', runId: 'run-1' });
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, running) });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.stopRun(sessionA, 'run-1', answer)), {
    accepted: true,
  });

  // Sign-out rejects the outstanding request after clearing private state.
  store.update({
    connection: { ...store.state.connection, status: 'unpaired' },
    selected: '',
    engine: undefined,
    actions: undefined,
  });
  store.pending[0].reject(Error('The connection dropped before Companion answered.'));
  await settle();
  store.update({ connection: { ...store.state.connection, status: 'online' } });
  store.update({ engine: { paused: false }, selected: sessionA });
  await settle();
  assert.equal(lastStatus(messages).inputError, '');
});

/** A conversation of `total` rows and a host serving its real pages. */
function pagedConversation(total: number) {
  const messages = [];
  for (let index = 0; index < total; index++) {
    messages.push(chatMessage('row-' + index, 'assistant', 'Row ' + index));
  }
  const full = session(sessionA, 'Paged', { messages });
  const live = historyPage(full, 1);
  const shown: AgentSession = { ...full, messages: live.messages, history: live.history };
  const requests: PageRequest[] = [];
  let failNext = false;
  let changes = 0;
  const history = new ResidentHistory({
    async requestPage(request): Promise<HistoryPage> {
      requests.push(request);
      if (failNext) {
        failNext = false;
        throw Error('Synthetic page failure');
      }
      return historyPage(full, 1, request.direction, {
        index: request.index,
        offset: request.offset,
      });
    },
    visibleKeys: () => ({}),
    topKey: () => '',
    changed: () => {
      changes++;
    },
  });
  history.setOnline(true);
  history.show(shown);
  return {
    history,
    requests,
    failNextRequest() {
      failNext = true;
    },
    changes: () => changes,
  };
}

/** Run `action` and wait until the model reported a change. */
async function changed(model: ReturnType<typeof pagedConversation>, action: () => void) {
  const before = model.changes();
  action();
  for (let attempt = 0; attempt < 100 && model.changes() === before; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function texts(history: ResidentHistory): string[] {
  return history.rows().map((row) => row.message.text);
}

test('history pages join contiguously, stay within three pages and continue newer', async () => {
  const model = pagedConversation(1200);
  const { history } = model;
  assert.equal(history.rows().length, 200);
  assert.equal(texts(history)[0], 'Row 1000');

  // Older pages above the live window, until the bound detaches the view.
  for (let page = 0; page < 4; page++) {
    history.setFollowing(false);
    await changed(model, () => history.loadOlder());
  }
  let status = history.status();
  assert.equal(status.detached, true);
  assert.equal(status.atLatest, false);
  assert.ok(history.rows().length <= 600);
  assert.equal(texts(history)[0], 'Row 200');
  assert.equal(texts(history).at(-1), 'Row 799');
  for (let index = 1; index < history.rows().length; index++) {
    assert.equal(texts(history)[index], 'Row ' + (200 + index));
  }

  // A failed newer page is not requested again by scrolling, only by Retry.
  model.failNextRequest();
  await changed(model, () => history.continueNewer());
  assert.equal(model.requests.length, 5);
  assert.equal(history.status().error, 'Synthetic page failure');
  assert.equal(history.status().canRetry, true);
  history.continueNewer();
  history.setFollowing(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(model.requests.length, 5);

  await changed(model, () => history.retry());
  assert.equal(model.requests.length, 6);
  assert.equal(model.requests[5].direction, 'after');
  assert.equal(model.requests[5].index, 800);
  // That page reaches the live window: the transcript continues into it.
  status = history.status();
  assert.equal(status.error, '');
  assert.equal(status.detached, false);
  assert.equal(texts(history).at(-1), 'Row 1199');
  assert.ok(history.rows().length <= 600);

  history.latest();
  assert.equal(history.rows().length, 200);
  assert.equal(history.status().atLatest, true);
});

test('a page that answers a superseded view is dropped', async () => {
  const model = pagedConversation(600);
  const { history } = model;
  history.loadOlder();
  // Back to the live end before the page arrives: it must not be applied.
  history.latest();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(model.requests.length, 1);
  assert.equal(history.rows().length, 200);
  assert.equal(history.status().pending, false);
});

/**
 * The footer Stop's notice ("Stop is not available for this turn") belongs
 * to the turn it was pressed in: it goes when that turn is over, however the
 * listener reports that. Each case starts with the footer Stop pressed in a
 * turn that names no run (the turn after `turn-1`).
 */
const stopNoticeCases: {
  name: string;
  next: Partial<AgentSession>[];
  /** Whether the notice is still shown afterwards. */
  shown: boolean;
}[] = [
  { name: 'the same turn keeps running', next: [{ status: 'running' }], shown: true },
  {
    name: 'a follow-up run starts (the conversation names a run)',
    next: [{ status: 'running', runId: 'run-2' }],
    shown: false,
  },
  {
    name: 'the turn ends and a follow-up starts that names no run',
    next: [{ status: 'completed', completedTurnId: 'turn-2' }, { status: 'running' }],
    shown: false,
  },
  {
    name: 'the turn completes and the next unnamed turn is the first update seen',
    next: [{ status: 'running', completedTurnId: 'turn-2' }],
    shown: false,
  },
  { name: 'another client stops the turn', next: [{ status: 'cancelled' }], shown: false },
];

for (const noticeCase of stopNoticeCases) {
  test(`footer Stop notice: ${noticeCase.name}`, async () => {
    const { store, bridge, messages } = harness();
    const unnamed = session(sessionA, 'Question A', {
      status: 'running',
      completedTurnId: 'turn-1',
    });
    store.update({ sessions: new Map(store.state.sessions).set(sessionA, unnamed) });
    await settle();
    bridge.stop(sessionA);
    await settle();
    assert.match(lastStatus(messages).inputError ?? '', /Stop is not available/);

    for (const change of noticeCase.next) {
      const next = session(sessionA, 'Question A', { completedTurnId: 'turn-1', ...change });
      store.update({ sessions: new Map(store.state.sessions).set(sessionA, next) });
    }
    await settle();
    const notice = lastStatus(messages).inputError ?? '';
    assert.equal(/Stop is not available/.test(notice), noticeCase.shown, notice);
    assert.deepEqual(
      store.pending.filter((request) => request.action.startsWith('stop-agent')),
      [],
    );
  });
}

test("the page's request for a newer page is never repeated after a failure", async () => {
  const { store, bridge, messages } = harness();
  // 1000 rows: the live window holds the newest 200, pages hold 200 each.
  const rows = [];
  for (let index = 0; index < 1000; index++) {
    rows.push(chatMessage('row-' + index, 'assistant', 'Row ' + index));
  }
  const full = session(sessionA, 'Paged', { messages: rows });
  const live = historyPage(full, 1);
  store.update({
    sessions: new Map(store.state.sessions).set(sessionA, {
      ...full,
      messages: live.messages,
      history: live.history,
    }),
  });
  await settle();

  /** Answer every outstanding page request with the real page. */
  async function answerPages(): Promise<void> {
    for (const request of store.pending.splice(0)) {
      const parameters = request.parameters as unknown as PageRequest;
      request.resolve(
        historyPage(full, 1, parameters.direction, {
          index: parameters.index,
          offset: parameters.offset,
        }),
      );
    }
    await settle();
  }
  // Every page request the bridge makes, in order.
  const pageRequests: PageRequest[] = [];
  const request = store.request.bind(store);
  store.request = (action, parameters) => {
    if (action === 'agent-history-page') {
      pageRequests.push(parameters as unknown as PageRequest);
    }
    return request(action, parameters);
  };

  // Live: there is nothing newer to ask for.
  bridge.history(sessionA, 'newer');
  await settle();
  assert.equal(pageRequests.length, 0);

  // Four older pages detach the view (rows 0–599 resident at most).
  for (let page = 0; page < 4; page++) {
    bridge.following(sessionA, false);
    bridge.history(sessionA, 'older');
    await settle();
    await answerPages();
  }
  assert.equal(lastStatus(messages).history?.detached, true);
  assert.equal(pageRequests.length, 4);

  // The page asks twice while the first newer page is pending: one request.
  bridge.history(sessionA, 'newer');
  bridge.history(sessionA, 'newer');
  await settle();
  assert.equal(pageRequests.length, 5);
  assert.equal(pageRequests[4].direction, 'after');

  // It fails: the page's next request sends nothing, only Retry does.
  store.pending.splice(0)[0].reject(Error('Synthetic page failure'));
  await settle();
  assert.equal(lastStatus(messages).history?.error, 'Synthetic page failure');
  bridge.history(sessionA, 'newer');
  await settle();
  assert.equal(pageRequests.length, 5);
  bridge.history(sessionA, 'retry');
  await settle();
  assert.equal(pageRequests.length, 6);
  assert.equal(pageRequests[5].direction, 'after');
  assert.equal(pageRequests[5].index, pageRequests[4].index);
});

test('a page that arrives reaches the page as rows before the status that ends loading', async () => {
  const { store, bridge, messages } = harness();
  // 1000 rows: the live window holds the newest 200, pages hold 200 each.
  const rows = [];
  for (let index = 0; index < 1000; index++) {
    rows.push(chatMessage('row-' + index, 'assistant', 'Row ' + index));
  }
  const full = session(sessionA, 'Paged', { messages: rows });
  const live = historyPage(full, 1);
  store.update({
    sessions: new Map(store.state.sessions).set(sessionA, {
      ...full,
      messages: live.messages,
      history: live.history,
    }),
  });
  await settle();

  bridge.following(sessionA, false);
  bridge.history(sessionA, 'older');
  await settle();
  assert.equal(lastStatus(messages).history?.pending, true);
  const from = messages.length;
  const request = store.pending.splice(0)[0];
  const parameters = request.parameters as unknown as PageRequest;
  request.resolve(
    historyPage(full, 1, parameters.direction, {
      index: parameters.index,
      offset: parameters.offset,
    }),
  );
  await settle();

  // The first message after the answer that says loading ended comes after
  // the rows message carrying the new rows (Row 600 is the new first row).
  const after = messages.slice(from);
  const settled = after.findIndex(
    (message) => message.type === 'status' && message.status.history?.pending === false,
  );
  const newRows = after.findIndex(
    (message) => message.type === 'rows' && message.order.some((key) => key.includes('row-600')),
  );
  assert.ok(settled >= 0, 'loading ended');
  assert.ok(newRows >= 0 && newRows < settled, 'the rows came first');
});

/**
 * The chat page's paging rule counts every scroll except the page's own and
 * the browser pulling the view back into a scroll range that shrank
 * (Chat.tsx `pulledBack`). Each case: the position and largest position at
 * the previous scroll event, then at this one (CSS pixels, fractional as at
 * a fractional device scale), and whether it is a pull-back.
 */
const pullBackCases: {
  name: string;
  previous: { top: number; maximumTop: number };
  current: { top: number; maximumTop: number };
  pulledBack: boolean;
}[] = [
  {
    name: 'the transcript grows 200 px taller at the very end',
    previous: { top: 1200, maximumTop: 1200 },
    current: { top: 1000, maximumTop: 1000 },
    pulledBack: true,
  },
  {
    name: 'half a pixel pulled back at a fractional position',
    previous: { top: 600.5, maximumTop: 650 },
    current: { top: 600, maximumTop: 600 },
    pulledBack: true,
  },
  {
    name: 'the reader scrolls up 1 px at the very end',
    previous: { top: 1200, maximumTop: 1200 },
    current: { top: 1199, maximumTop: 1200 },
    pulledBack: false,
  },
  {
    name: 'the reader scrolls up 3 px at the very end',
    previous: { top: 1200, maximumTop: 1200 },
    current: { top: 1197, maximumTop: 1200 },
    pulledBack: false,
  },
  {
    name: 'the range shrinks and the reader lands 1 px before its new end',
    previous: { top: 900, maximumTop: 900 },
    current: { top: 799, maximumTop: 800 },
    pulledBack: false,
  },
  {
    name: 'pulled back half a pixel, the whole-pixel range unchanged',
    previous: { top: 800, maximumTop: 800 },
    current: { top: 799.5, maximumTop: 800 },
    pulledBack: true,
  },
  {
    name: 'the reader scrolls up 1 px from the end, the range unchanged',
    previous: { top: 800, maximumTop: 800 },
    current: { top: 799, maximumTop: 800 },
    pulledBack: false,
  },
  {
    name: 'pulled back to a fractional end just under the whole-pixel one',
    previous: { top: 900, maximumTop: 900 },
    current: { top: 799.6, maximumTop: 800 },
    pulledBack: true,
  },
  {
    name: 'the range shrinks and the reader lands 3 px before its new end',
    previous: { top: 900, maximumTop: 900 },
    current: { top: 797, maximumTop: 800 },
    pulledBack: false,
  },
  {
    name: 'the range shrinks while the reader is far above its end',
    previous: { top: 300, maximumTop: 900 },
    current: { top: 250, maximumTop: 800 },
    pulledBack: false,
  },
  {
    name: 'the reader scrolls down to the end',
    previous: { top: 1000, maximumTop: 1200 },
    current: { top: 1200, maximumTop: 1200 },
    pulledBack: false,
  },
];

for (const pullBackCase of pullBackCases) {
  test(`pull-back: ${pullBackCase.name}`, () => {
    assert.equal(pulledBack(pullBackCase.previous, pullBackCase.current), pullBackCase.pulledBack);
  });
}

test('a failed page request leaves queued rows to their 30 ms coalescing', async () => {
  const { store, bridge, messages } = harness();
  const rows = [];
  for (let index = 0; index < 600; index++) {
    rows.push(chatMessage('row-' + index, 'assistant', 'Row ' + index));
  }
  const full = session(sessionA, 'Paged', { messages: rows });
  const live = historyPage(full, 1);
  const shown = { ...full, messages: live.messages, history: live.history };
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, shown) });
  await settle();
  bridge.following(sessionA, false);
  bridge.history(sessionA, 'older');
  await settle();

  // The newest row's text grows (as an answer streams), then the page
  // request fails before 30 ms passed.
  const grown = shown.messages.map((message) => {
    if (message.id === 'row-599') {
      return { ...message, text: 'Row 599, streamed further' };
    }
    return message;
  });
  store.update({
    sessions: new Map(store.state.sessions).set(sessionA, { ...shown, messages: grown }),
  });
  const from = messages.length;
  store.pending.splice(0)[0].reject(Error('Synthetic page failure'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    messages.slice(from).some((message) => message.type === 'rows'),
    false,
    'no rows sent at once',
  );
  await settle();
  // The streamed text goes out with the 30 ms timer.
  const sent = messages.slice(from).filter((message) => message.type === 'rows');
  assert.equal(sent.length, 1);
  const delivered = sent[0];
  assert.ok(delivered.type === 'rows');
  assert.deepEqual(
    delivered.changed.map((row) => row.text),
    ['Row 599, streamed further'],
  );
  assert.equal(lastStatus(messages).history?.error, 'Synthetic page failure');

  // A scroll that goes on before the page has shown the failure asks for
  // the previous page again: nothing is sent. Only Retry repeats it.
  bridge.history(sessionA, 'older');
  await settle();
  assert.equal(store.pending.length, 0, 'not repeated by scrolling');
  bridge.history(sessionA, 'retry');
  await settle();
  assert.equal(store.pending.length, 1, 'repeated by Retry');
  assert.equal(store.pending[0].action, 'agent-history-page');
});

test('a page refused because it would trim visible rows leaves queued rows to their coalescing', async () => {
  const store = new FakeStore();
  const rows = [];
  for (let index = 0; index < 1000; index++) {
    rows.push(chatMessage('row-' + index, 'assistant', 'Row ' + index));
  }
  const full = session(sessionA, 'Paged', { messages: rows });
  const live = historyPage(full, 1);
  const shown = { ...full, messages: live.messages, history: live.history };
  store.state.sessions.set(sessionA, shown);
  store.state.selected = sessionA;
  // The reader sees every row: trimming any of them is refused.
  const bridge = new GatewayChatBridge(store as unknown as Store, {
    visibleIndexes: () => [...Array(1000).keys()],
    topIndex: () => 0,
  });
  const messages: HostMessage[] = [];
  bridge.message.connect((json) => messages.push(JSON.parse(json) as HostMessage));
  bridge.ready('synthetic-document');
  store.update({ engine: { paused: false } });
  await settle();

  /** Ask for the previous page and answer it with the real one. */
  async function older(): Promise<void> {
    bridge.history(sessionA, 'older');
    await settle();
    const request = store.pending.splice(0)[0];
    const parameters = request.parameters as unknown as PageRequest;
    request.resolve(
      historyPage(full, 1, parameters.direction, {
        index: parameters.index,
        offset: parameters.offset,
      }),
    );
  }

  // Two older pages fit within three pages; the third would need trimming.
  bridge.following(sessionA, false);
  await older();
  await settle();
  await older();
  await settle();
  assert.ok(messages.some((message) => message.type === 'rows'));
  bridge.history(sessionA, 'older');
  await settle();
  const request = store.pending.splice(0)[0];
  const parameters = request.parameters as unknown as PageRequest;

  // The newest row's text grows (as an answer streams), then the third page
  // arrives and is refused.
  const latest = store.state.sessions.get(sessionA)!;
  const grown = latest.messages.map((message) => {
    if (message.id === 'row-999') {
      return { ...message, text: 'Row 999, streamed further' };
    }
    return message;
  });
  store.update({
    sessions: new Map(store.state.sessions).set(sessionA, { ...latest, messages: grown }),
  });
  const from = messages.length;
  request.resolve(
    historyPage(full, 1, parameters.direction, {
      index: parameters.index,
      offset: parameters.offset,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    messages.slice(from).some((message) => message.type === 'rows'),
    false,
    'no rows sent at once',
  );
  await settle();
  const sent = messages.slice(from).filter((message) => message.type === 'rows');
  // The streamed text goes out with the 30 ms timer; the refused page's
  // rows (Row 200–399) never do.
  assert.equal(sent.length, 1);
  const delivered = sent[0];
  assert.ok(delivered.type === 'rows');
  assert.deepEqual(
    delivered.changed.map((row) => row.text),
    ['Row 999, streamed further'],
  );
  assert.equal(
    delivered.order.some((key) => key.includes('row-399')),
    false,
  );
});

/**
 * The paging rule's decision for one scroll the reader made (Chat.tsx
 * `pageToAsk`), in a 600 px viewport. The Chromium table in shell.test.ts
 * tests the same rule through real input; this covers transcripts too short
 * for a browser test to reach, where both edges are within one viewport.
 */
const pageToAskCases: {
  name: string;
  top: number;
  maximumTop: number;
  towardEnd: boolean;
  hasOlder: boolean;
  detached: boolean;
  expected: 'older' | 'newer' | null;
}[] = [
  {
    name: 'near the top',
    top: 300,
    maximumTop: 9000,
    towardEnd: false,
    hasOlder: true,
    detached: true,
    expected: 'older',
  },
  {
    name: 'near the top, nothing older',
    top: 300,
    maximumTop: 9000,
    towardEnd: false,
    hasOlder: false,
    detached: true,
    expected: null,
  },
  {
    name: 'exactly one viewport below the top',
    top: 600,
    maximumTop: 9000,
    towardEnd: false,
    hasOlder: true,
    detached: true,
    expected: 'older',
  },
  {
    name: 'just over one viewport below the top',
    top: 601,
    maximumTop: 9000,
    towardEnd: false,
    hasOlder: true,
    detached: true,
    expected: null,
  },
  {
    name: 'exactly one viewport above the end',
    top: 1400,
    maximumTop: 2000,
    towardEnd: true,
    hasOlder: true,
    detached: true,
    expected: 'newer',
  },
  {
    name: 'just over one viewport above the end',
    top: 1399,
    maximumTop: 2000,
    towardEnd: true,
    hasOlder: true,
    detached: true,
    expected: null,
  },
  {
    name: 'in the middle',
    top: 4000,
    maximumTop: 9000,
    towardEnd: true,
    hasOlder: true,
    detached: true,
    expected: null,
  },
  {
    name: 'near the end of a detached snapshot',
    top: 8700,
    maximumTop: 9000,
    towardEnd: true,
    hasOlder: true,
    detached: true,
    expected: 'newer',
  },
  {
    name: 'near the end, moving up',
    top: 8700,
    maximumTop: 9000,
    towardEnd: false,
    hasOlder: true,
    detached: true,
    expected: 'newer',
  },
  {
    name: 'near the end of the live rows',
    top: 8700,
    maximumTop: 9000,
    towardEnd: true,
    hasOlder: true,
    detached: false,
    expected: null,
  },
  {
    name: 'short snapshot, moving toward the end',
    top: 300,
    maximumTop: 300,
    towardEnd: true,
    hasOlder: true,
    detached: true,
    expected: 'newer',
  },
  {
    name: 'short snapshot, moving toward the start',
    top: 295,
    maximumTop: 300,
    towardEnd: false,
    hasOlder: true,
    detached: true,
    expected: 'older',
  },
  {
    name: 'short snapshot, nothing older, moving up',
    top: 100,
    maximumTop: 300,
    towardEnd: false,
    hasOlder: false,
    detached: true,
    expected: 'newer',
  },
  {
    name: 'short live rows, moving toward the end',
    top: 300,
    maximumTop: 300,
    towardEnd: true,
    hasOlder: true,
    detached: false,
    expected: 'older',
  },
];

for (const pagingCase of pageToAskCases) {
  test(`page to ask: ${pagingCase.name}`, () => {
    const scroll = {
      top: pagingCase.top,
      maximumTop: pagingCase.maximumTop,
      viewportHeight: 600,
      towardEnd: pagingCase.towardEnd,
    };
    const history = { hasOlder: pagingCase.hasOlder, detached: pagingCase.detached };
    assert.equal(pageToAsk(scroll, history), pagingCase.expected);
  });
}
