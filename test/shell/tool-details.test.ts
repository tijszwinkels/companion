import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentMessage, type AgentSession } from '../../src/agents/types.ts';
import type { Store } from '../../integrations/mobile/src/store.ts';
import type {
  ChatRow,
  ChatToolDetails,
  HostMessage,
} from '../../integrations/session-apps/chat/protocol.ts';
import { GatewayChatBridge } from '../../integrations/shell/src/bridge.ts';
import {
  toolPageDeadlineMilliseconds,
  toolTexts,
} from '../../integrations/shell/src/tools/tool-details.ts';

/**
 * The tool-details rule (integrations/shell/README.md, "Tool details") as
 * one table of cases, run through the real bridge (GatewayChatBridge and
 * ./tools/tool-details.ts) with a stand-in for the phone Store whose
 * requests each case answers itself. What a case checks is what the page
 * receives (`ChatRow.tools` of the group's row) and which `agent-tool-page`
 * requests left. Each step waits for the state it means, never for a fixed
 * time. The real page, gateway and listener are in tool-details-browser.test.ts.
 */

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';
const groupId = 'group-1';

interface Pending {
  action: string;
  parameters: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function toolGroup(count: number, revision: string, state = 'done'): AgentMessage {
  return {
    ...chatMessage(groupId, 'tool', ''),
    toolName: 'bash',
    state: state as AgentMessage['state'],
    toolGroup: { count, revision },
  };
}

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: id,
    title: 'Conversation ' + id.slice(0, 1),
    status: 'completed',
    model: 'synthetic/model',
    error: '',
    messages: [chatMessage(id + '-question', 'user', 'Fix it'), toolGroup(2, 'r1')],
    updatedAt: 1,
    toolEpoch: 'epoch-1',
    ...overrides,
  };
}

/** The parts of the phone Store the bridge uses, with controllable requests. */
class FakeStore {
  state = {
    connection: { status: 'online', message: '', retryAt: 0, deviceName: 'Synthetic' },
    engine: undefined as object | undefined,
    sessions: new Map<string, AgentSession>(),
    selected: '',
    sends: new Map<string, { pending: boolean; error: string }>(),
    actions: undefined as unknown,
  };
  readonly pending: Pending[] = [];
  private readonly listeners = new Set<() => void>();
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

  draft(): string {
    return '';
  }

  setDraft(): void {}

  // Listener drafts (Store.draftUnsaved, Store.draftSource): none here.
  draftUnsaved(): string {
    return '';
  }

  draftSource(): string {
    return '';
  }

  open(id: string): void {
    this.update({ selected: id });
  }

  request(action: string, parameters: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.push({ action, parameters, resolve, reject });
    });
  }

  /** Replace one conversation, as an `agent-session` event does. */
  put(value: AgentSession): void {
    const sessions = new Map(this.state.sessions);
    sessions.set(value.id, value);
    this.update({ sessions });
  }
}

/** A tool page as the listener answers `request`. */
function page(
  request: Pending,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...request.parameters,
    callRevision: 'call-' + String(request.parameters.index),
    text: text,
    state: 'done',
    next: null,
    ...overrides,
  };
}

/** The bridge, its stand-in Store and the page's view of the rows. */
class Harness {
  readonly store = new FakeStore();
  readonly bridge: GatewayChatBridge;
  private readonly rows = new Map<string, ChatRow>();

  constructor() {
    this.store.state.sessions.set(sessionA, session(sessionA));
    this.store.state.sessions.set(sessionB, session(sessionB, { toolEpoch: 'epoch-b' }));
    this.store.state.selected = sessionA;
    this.bridge = new GatewayChatBridge(this.store as unknown as Store, {
      visibleIndexes: () => [],
      topIndex: () => -1,
    });
    this.bridge.message.connect((json) => {
      const message = JSON.parse(json) as HostMessage;
      if (message.type !== 'rows') {
        return;
      }
      if (message.full) {
        this.rows.clear();
      }
      for (const row of message.changed) {
        this.rows.set(row.key, row);
      }
      for (const key of [...this.rows.keys()]) {
        if (!message.order.includes(key)) {
          this.rows.delete(key);
        }
      }
    });
    this.bridge.ready('synthetic-document');
    // The connection's first snapshot: requests are admitted.
    this.store.update({ engine: { paused: false } });
  }

  /** The group's row key as the page has it. */
  key(): string {
    for (const row of this.rows.values()) {
      if (row.kind === 'tool') {
        return row.key;
      }
    }
    return '';
  }

  /** The group's in-place details as the page last received them. */
  tools(): ChatToolDetails | undefined {
    for (const row of this.rows.values()) {
      if (row.kind === 'tool') {
        return row.tools;
      }
    }
    return undefined;
  }

  toolRequests(): Pending[] {
    return this.store.pending.filter((request) => request.action === 'agent-tool-page');
  }

  act(action: 'toggle' | 'reload' | 'start' | 'next', sessionId = sessionA): void {
    this.bridge.toolDetails(sessionId, this.key(), action);
  }

  /** Wait until the page's details satisfy `check` (no fixed waits). */
  async until(what: string, check: (tools: ChatToolDetails | undefined) => boolean) {
    const deadline = Date.now() + 2000;
    while (!check(this.tools())) {
      if (Date.now() > deadline) {
        assert.fail(`waited for ${what}; the page has ${JSON.stringify(this.tools())}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** Wait until `count` tool-page requests were sent. */
  async requested(count: number): Promise<Pending> {
    const deadline = Date.now() + 2000;
    while (this.toolRequests().length < count) {
      if (Date.now() > deadline) {
        assert.fail(`waited for tool-page request ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return this.toolRequests()[count - 1];
  }

  /** The connection drops (the bridge sees it at once) and comes back with a snapshot. */
  disconnect(): void {
    this.store.update({
      connection: { ...this.store.state.connection, status: 'reconnecting' },
    });
  }

  reconnect(): void {
    this.store.update({ connection: { ...this.store.state.connection, status: 'online' } });
    this.store.update({ engine: { paused: false } });
  }
}

/** Let promise reactions run (an answer is applied in a microtask). */
async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
}

const open = (tools: ChatToolDetails | undefined) => tools?.open === true;
const loaded = (text: string) => (tools: ChatToolDetails | undefined) =>
  tools?.open === true && tools.loaded && tools.text === text && tools.status !== toolTexts.loading;

interface Case {
  name: string;
  run(h: Harness): Promise<void>;
}

/**
 * The rule's cases: closed; opening; loaded one page; more pages; failed and
 * retried; opened while the turn still runs and more calls arrive; the
 * conversation switched and back; closed and reopened under the same ID;
 * disconnected while loading and back. Plus closing an open group, a legacy
 * tool row and the deadline (below the table).
 */
const cases: Case[] = [
  {
    name: 'closed: the row offers its details in place and asks for nothing',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined && !tools.open);
      assert.equal(h.toolRequests().length, 0);
      assert.deepEqual(h.tools(), {
        open: false,
        status: '',
        failed: false,
        text: '',
        loaded: false,
        reload: '',
        next: false,
        restart: false,
        busy: false,
      });
    },
  },
  {
    name: 'opening: asks for the first page of the first call and shows loading',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const request = await h.requested(1);
      assert.deepEqual(request.parameters, {
        id: sessionA,
        epoch: 'epoch-1',
        groupId: groupId,
        revision: 'r1',
        index: 0,
        offset: 0,
      });
      await h.until('loading', (tools) => tools?.status === toolTexts.loading);
      assert.equal(h.tools()!.busy, true);
      assert.equal(h.tools()!.loaded, false);
    },
  },
  {
    name: 'loaded one page: its text, which call and characters, Refresh and Copy',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const request = await h.requested(1);
      request.resolve(page(request, 'bash\n\nls\n\nfile.txt'));
      await h.until('the page', loaded('bash\n\nls\n\nfile.txt'));
      const tools = h.tools()!;
      assert.equal(tools.status, 'Tool 1 of 2 · characters 1–18');
      assert.equal(tools.reload, 'Refresh page');
      assert.equal(tools.next, false);
      assert.equal(tools.restart, false);
      assert.equal(tools.busy, false);
      assert.equal(tools.failed, false);
    },
  },
  {
    name: 'more pages: Next page continues the call, then the next call; From start goes back',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      first.resolve(page(first, 'a'.repeat(8192), { next: { index: 0, offset: 8192 } }));
      await h.until('page 1', (tools) => tools?.next === true);
      h.act('next');
      const second = await h.requested(2);
      // Within the same call: its revision, so another call's text never follows.
      assert.equal(second.parameters.index, 0);
      assert.equal(second.parameters.offset, 8192);
      assert.equal(second.parameters.callRevision, 'call-0');
      second.resolve(page(second, 'tail', { next: { index: 1, offset: 0 } }));
      await h.until('page 2', loaded('tail'));
      assert.equal(h.tools()!.status, 'Tool 1 of 2 · characters 8193–8196');
      assert.equal(h.tools()!.restart, true);
      h.act('next');
      const third = await h.requested(3);
      // The next call starts fresh: no call revision.
      assert.equal(third.parameters.index, 1);
      assert.equal(third.parameters.offset, 0);
      assert.equal(third.parameters.callRevision, undefined);
      third.resolve(page(third, 'read\n\nx\n\ny', { state: 'running' }));
      await h.until('call 2', loaded('read\n\nx\n\ny'));
      assert.equal(h.tools()!.status, 'Tool 2 of 2 · running · characters 1–10');
      h.act('start');
      const fourth = await h.requested(4);
      assert.equal(fourth.parameters.index, 0);
      assert.equal(fourth.parameters.offset, 0);
    },
  },
  {
    name: 'failed and retried: the failure with Try again, which repeats the request',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      first.reject(Error('Tool group is unavailable in this conversation'));
      await h.until('the failure', (tools) => tools?.failed === true);
      assert.equal(h.tools()!.status, 'Tool group is unavailable in this conversation');
      assert.equal(h.tools()!.reload, 'Try again');
      assert.equal(h.tools()!.busy, false);
      h.act('reload');
      const second = await h.requested(2);
      assert.deepEqual(second.parameters, first.parameters);
      second.resolve(page(second, 'second time'));
      await h.until('the page', loaded('second time'));
      assert.equal(h.tools()!.failed, false);
      // Nothing was retried by itself.
      assert.equal(h.toolRequests().length, 2);
    },
  },
  {
    name: 'a continuation refused because the call changed: Try again reads that page afresh',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      first.resolve(page(first, 'a'.repeat(8192), { next: { index: 0, offset: 8192 } }));
      await h.until('page 1', (tools) => tools?.next === true);
      h.act('next');
      const second = await h.requested(2);
      assert.equal(second.parameters.callRevision, 'call-0');
      second.reject(Error('Tool output changed; reload this page.'));
      await h.until('the refusal', (tools) => tools?.failed === true);
      h.act('reload');
      const third = await h.requested(3);
      // The same position, without the call revision that was refused.
      assert.equal(third.parameters.index, 0);
      assert.equal(third.parameters.offset, 8192);
      assert.equal(third.parameters.callRevision, undefined);
    },
  },
  {
    name: 'opened while the turn runs and more calls arrive: the page stays, newer output is offered',
    async run(h) {
      h.store.put(
        session(sessionA, {
          status: 'running',
          messages: [chatMessage('q', 'user', 'Fix it'), toolGroup(1, 'r1', 'running')],
        }),
      );
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      first.resolve(page(first, 'bash\n\nmake', { state: 'running' }));
      await h.until('the page', loaded('bash\n\nmake'));
      assert.equal(h.tools()!.status, 'Tool 1 of 1 · running · characters 1–10');
      // A second call arrives: a new revision and count.
      h.store.put(
        session(sessionA, {
          status: 'running',
          messages: [chatMessage('q', 'user', 'Fix it'), toolGroup(2, 'r2', 'running')],
        }),
      );
      await h.until('newer output', (tools) => tools?.status.startsWith(toolTexts.newer) === true);
      assert.equal(
        h.tools()!.status,
        toolTexts.newer + '\nTool 1 of 2 · running · characters 1–10',
      );
      assert.equal(h.tools()!.text, 'bash\n\nmake');
      h.act('reload');
      const second = await h.requested(2);
      assert.equal(second.parameters.revision, 'r2');
      second.resolve(page(second, 'bash\n\nmake\n\ndone'));
      await h.until('the refreshed page', loaded('bash\n\nmake\n\ndone'));
      assert.equal(h.tools()!.status, 'Tool 1 of 2 · characters 1–16');
    },
  },
  {
    name: 'the conversation switched and back: the group is closed and the late answer dropped',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      h.store.open(sessionB);
      h.store.open(sessionA);
      first.resolve(page(first, 'late'));
      await microtasks();
      await h.until('a closed group again', (tools) => tools !== undefined && !tools.open);
      assert.equal(h.tools()!.text, '');
      assert.equal(h.toolRequests().length, 1);
    },
  },
  {
    name: 'closed and reopened under the same ID: the group is closed, the old answer dropped',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      h.store.put(session(sessionA, { toolEpoch: 'epoch-2' }));
      first.resolve(page(first, 'from the old lifetime'));
      await microtasks();
      await h.until('closed', (tools) => tools !== undefined && !tools.open);
      h.act('toggle');
      const second = await h.requested(2);
      assert.equal(second.parameters.epoch, 'epoch-2');
    },
  },
  {
    name: 'disconnected while loading and back: the loss is shown, Load details after reconnecting',
    async run(h) {
      await h.until('a closed group', (tools) => tools !== undefined);
      h.act('toggle');
      const first = await h.requested(1);
      h.disconnect();
      await h.until('the loss', (tools) => tools?.status === toolTexts.disconnected);
      assert.equal(h.tools()!.busy, true);
      // The Connection rejects what was on its way; nothing is applied.
      first.reject(Error('Connection lost'));
      await microtasks();
      assert.equal(h.tools()!.status, toolTexts.disconnected);
      // Nothing can be asked while offline.
      h.act('reload');
      assert.equal(h.toolRequests().length, 1);
      h.reconnect();
      await h.until('online again', (tools) => tools?.busy === false);
      assert.equal(h.tools()!.reload, 'Try again');
      // Nothing is asked by itself after reconnecting.
      assert.equal(h.toolRequests().length, 1);
      h.act('reload');
      const second = await h.requested(2);
      assert.equal(second.parameters.index, 0);
      second.resolve(page(second, 'after reconnecting'));
      await h.until('the page', loaded('after reconnecting'));
    },
  },
];

for (const testCase of cases) {
  test(`tool details: ${testCase.name}`, async () => {
    const h = new Harness();
    await testCase.run(h);
  });
}

test('tool details: closing an open group forgets its page and drops a late answer', async () => {
  const h = new Harness();
  await h.until('a closed group', (tools) => tools !== undefined);
  h.act('toggle');
  const first = await h.requested(1);
  h.act('toggle');
  await h.until('closed', (tools) => tools !== undefined && !tools.open);
  first.resolve(page(first, 'late'));
  await microtasks();
  assert.equal(h.tools()!.open, false);
  h.act('toggle');
  const second = await h.requested(2);
  assert.equal(second.parameters.index, 0);
});

test('tool details: a tool row without stored calls opens to its own input and output', async () => {
  const h = new Harness();
  const legacy: AgentMessage = {
    ...chatMessage('legacy', 'tool', 'output text'),
    toolName: 'read',
    input: '{"path":"a"}',
  };
  h.store.put(session(sessionA, { messages: [legacy] }));
  await h.until('the legacy row', (tools) => tools !== undefined && h.key().includes('legacy'));
  h.act('toggle');
  await h.until('open', open);
  assert.equal(h.tools()!.text, '{"path":"a"}\n\noutput text');
  assert.equal(h.tools()!.reload, '');
  assert.equal(h.toolRequests().length, 0);
});

test('tool details: a page that takes longer than the deadline fails with Try again', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new Harness();
  // Rows go out on the bridge's own 30 ms timer.
  context.mock.timers.tick(100);
  await microtasks();
  h.act('toggle');
  assert.equal(h.toolRequests().length, 1);
  context.mock.timers.tick(toolPageDeadlineMilliseconds);
  context.mock.timers.tick(100);
  await microtasks();
  assert.equal(h.tools()!.status, toolTexts.timedOut);
  assert.equal(h.tools()!.reload, 'Try again');
});

test('tool details: Try again after a later page timed out asks for that page', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new Harness();
  context.mock.timers.tick(100);
  await microtasks();
  h.act('toggle');
  const first = h.toolRequests()[0];
  first.resolve(page(first, 'a'.repeat(8192), { next: { index: 0, offset: 8192 } }));
  await microtasks();
  context.mock.timers.tick(100);
  await microtasks();
  assert.equal(h.tools()!.next, true);
  h.act('next');
  assert.equal(h.toolRequests().length, 2);
  context.mock.timers.tick(toolPageDeadlineMilliseconds);
  context.mock.timers.tick(100);
  await microtasks();
  assert.equal(h.tools()!.status, toolTexts.timedOut);
  h.act('reload');
  const retry = h.toolRequests()[2];
  assert.equal(retry.parameters.index, 0);
  assert.equal(retry.parameters.offset, 8192);
});

test('tool details: after a timeout and a reconnect, Try again still asks for that page', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new Harness();
  context.mock.timers.tick(100);
  await microtasks();
  h.act('toggle');
  const first = h.toolRequests()[0];
  first.resolve(page(first, 'a'.repeat(8192), { next: { index: 0, offset: 8192 } }));
  await microtasks();
  h.act('next');
  context.mock.timers.tick(toolPageDeadlineMilliseconds);
  // The relay then closes the connection; it comes back with a snapshot.
  h.disconnect();
  h.reconnect();
  context.mock.timers.tick(100);
  await microtasks();
  assert.equal(h.tools()!.reload, 'Try again');
  h.act('reload');
  const retry = h.toolRequests()[2];
  assert.equal(retry.parameters.index, 0);
  assert.equal(retry.parameters.offset, 8192);
  assert.equal(retry.parameters.callRevision, undefined);
});
