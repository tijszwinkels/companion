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

test('Stop is scoped to the shown run, and unscoped only once controls arrived', async () => {
  const { store, bridge, messages } = harness();
  // The conversation names its run before the controls report arrives.
  const running = session(sessionA, 'Question A', { status: 'running', runId: 'run-1' });
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, running) });
  await settle();
  assert.equal(lastStatus(messages).running, true);
  assert.deepEqual(await ask((answer) => bridge.stop(sessionA, answer)), { accepted: true });
  assert.equal(store.pending[0].action, 'stop-agent-run');
  assert.deepEqual(store.pending[0].parameters, { id: sessionA, runId: 'run-1' });

  // A run without an ID: no Stop until the listener reported the controls,
  // since "no run ID" may only mean "not reported yet".
  const unnamed = session(sessionA, 'Question A', { status: 'running' });
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, unnamed) });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.stop(sessionA, answer)), { accepted: false });
  assert.equal(store.pending.length, 1);
  await settle();
  assert.match(lastStatus(messages).inputError ?? '', /controls have not arrived/);
  store.update({ actions: { sessionId: sessionA, stopRunId: '', choices: [] } });
  assert.deepEqual(await ask((answer) => bridge.stop(sessionA, answer)), { accepted: true });
  assert.equal(store.pending[1].action, 'stop-agent');
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
  store.update({ actions: { sessionId: sessionA, stopRunId: '', choices: [] } });
  const running = session(sessionA, 'Question A', { status: 'running' });
  store.update({ sessions: new Map(store.state.sessions).set(sessionA, running) });
  await settle();
  assert.deepEqual(await ask((answer) => bridge.stop(sessionA, answer)), { accepted: true });

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
