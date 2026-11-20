import assert from 'node:assert/strict';
import test from 'node:test';

import { historyPage, type HistoryPage } from '../../src/agents/history-pages.ts';
import { chatMessage, type AgentSession } from '../../src/agents/types.ts';
import type { Store } from '../../integrations/mobile/src/store.ts';
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
