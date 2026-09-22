import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { toolPageUnits, type ToolPageRequest } from '../../src/agents/tool-transcripts.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentSession,
  type SessionEvent,
} from '../../src/agents/types.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-lazy-tools-'));
  const ready = deferred<void>();
  const done = deferred<void>();
  let emit!: Parameters<AgentBackend['run']>[2];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'lazy-tools',
        label: 'Lazy tool fixture',
        dependencies: {},
        async run(_request, signal, callback) {
          emit = callback;
          ready.resolve();
          await Promise.race([done.promise, stopped(signal)]);
        },
      },
    },
    () => {},
    directory,
  );
  const events: SessionEvent[] = [];
  sessions.subscribe((event) => events.push(event));
  const id = sessions.start(frame, signal());
  await ready.promise;
  context.after(async () => {
    done.resolve();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    sessions,
    id,
    emit,
    events,
    finish: async () => {
      done.resolve();
      await sessions.idle();
    },
  };
}

function request(view: AgentSession, position = 1): ToolPageRequest {
  const group = view.messages[position];
  assert.ok(group.toolGroup, 'Tool calls must be represented by a body-free group');
  return {
    id: view.id,
    epoch: view.toolEpoch!,
    groupId: group.id,
    revision: group.toolGroup.revision,
    index: 0,
    offset: 0,
  };
}

function readAll(sessions: AgentSessions, start: ToolPageRequest): string[] {
  let cursor = start;
  const calls: string[] = [];
  while (true) {
    const page = sessions.toolPage(cursor);
    assert.ok(page.text.length <= toolPageUnits);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50 * 1024);
    calls[page.index] = (calls[page.index] ?? '') + page.text;
    if (!page.next) return calls;
    cursor = { ...cursor, ...page.next };
  }
}

function tool(id: string, text: string, state: 'running' | 'done' | 'error' = 'done') {
  return { ...chatMessage(id, 'tool', text), toolName: 'read', input: '{"path":"fixture"}', state };
}

function body(message: ReturnType<typeof tool>) {
  return message.toolName + '\n\n' + message.input + '\n\n' + message.text;
}

test('1500 consecutive calls consume one display row, with no bodies in events, snapshots or JSON', async (context) => {
  const setup = await fixture(context);
  const secret = 'ONLY_IN_TOOL_DETAILS_';
  for (let index = 0; index < 1500; index++)
    setup.emit(tool(String(index), secret + 'x'.repeat(1000)));
  await setup.finish();
  const view = setup.sessions.snapshot()[0];
  assert.equal(view.status, 'completed');
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1].toolGroup?.count, 1500);
  assert.equal(view.messages[1].text, '');
  assert.equal(view.messages[1].input, '');
  assert.ok(!JSON.stringify(setup.events).includes(secret));
  const payloadBytes = Buffer.byteLength(JSON.stringify(view));
  assert.ok(
    payloadBytes < 2000,
    `Actual ordinary snapshot: ${payloadBytes} bytes versus >1.5MB raw tool bodies`,
  );
  const saved = await readFile(
    join(setup.directory, '.companion-sessions', setup.id + '.json'),
    'utf8',
  );
  assert.ok(saved.length < 2000);
  assert.ok(!saved.includes(secret));
  const db = join(setup.directory, '.companion-sessions', 'tool-transcripts.sqlite');
  assert.equal((await stat(db)).mode & 0o777, 0o600);
  assert.equal((await stat(join(setup.directory, '.companion-sessions'))).mode & 0o777, 0o700);
  assert.ok(setup.sessions.toolPage({ ...request(view), index: 1499 }).text.includes(secret));
});

test('updates retain group position across assistant, notice and queued user boundaries', async (context) => {
  const setup = await fixture(context);
  setup.emit(tool('a', 'partial', 'running'));
  setup.emit(tool('b', 'failed', 'error'));
  const initial = setup.sessions.snapshot()[0];
  const oldRequest = request(initial);
  setup.emit(chatMessage('answer', 'assistant', 'Intervening answer'));
  setup.emit(tool('c', 'third'));
  setup.emit(chatMessage('notice', 'notice', 'Intervening notice'));
  setup.emit(tool('d', 'fourth'));
  setup.sessions.followUp(setup.id, 'Queued question', signal());
  setup.emit(tool('e', 'fifth'));
  setup.emit(tool('a', 'complete'));
  const view = setup.sessions.snapshot()[0];
  assert.deepEqual(
    view.messages.map((m) => m.kind),
    ['user', 'tool', 'assistant', 'tool', 'notice', 'tool', 'user', 'tool'],
  );
  assert.equal(view.messages[1].id, initial.messages[1].id);
  assert.equal(view.messages[1].toolGroup?.count, 2);
  assert.equal(view.messages[1].state, 'error');
  assert.equal(view.messages[6].state, 'queued');
  assert.throws(() => setup.sessions.toolPage(oldRequest), /changed/);
  assert.equal(readAll(setup.sessions, request(view))[0], body(tool('a', 'complete')));
  await setup.sessions.stop(setup.id);
  assert.equal(setup.sessions.snapshot()[0].messages[6].state, 'error');
});

test('large input and result are paged losslessly, including NUL, escaping and surrogate boundaries', async (context) => {
  const setup = await fixture(context);
  const message = tool('big', '\u0000"\\\n😀<b>literal</b>\ud800'.repeat(70000));
  message.input = 'input\n'.repeat(200000);
  setup.emit(message);
  await setup.finish();
  const view = setup.sessions.snapshot()[0];
  assert.equal(view.status, 'completed', '>1M tool content must not exhaust the display budget');
  assert.equal(readAll(setup.sessions, request(view))[0], body(message));
  setup.emit(tool('late', 'must be ignored'));
  assert.equal(setup.sessions.snapshot()[0].messages[1].toolGroup?.count, 1);
});

test('invalid, foreign, stale and removed IDs cannot retrieve tool contents; reopen rotates epoch', async (context) => {
  const setup = await fixture(context);
  setup.emit(tool('a', 'private details'));
  await setup.finish();
  const original = request(setup.sessions.snapshot()[0]);
  for (const invalid of [
    { id: randomUUID() },
    { groupId: randomUUID() },
    { groupId: '../secret' },
    { groupId: 'file:///etc/passwd' },
    { epoch: 'old' },
    { revision: 'old' },
    { index: -1 },
    { index: 1 },
    { index: 0.5 },
    { offset: -1 },
    { offset: 999999 },
    { offset: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => setup.sessions.toolPage({ ...original, ...invalid }));
  await setup.sessions.remove(setup.id);
  assert.throws(() => setup.sessions.toolPage(original), /unavailable/);
  await setup.sessions.reopen(setup.id);
  const view = setup.sessions.snapshot()[0];
  assert.equal(view.messages[1].id, original.groupId);
  assert.notEqual(view.toolEpoch, original.epoch);
  assert.throws(() => setup.sessions.toolPage(original), /unavailable/);
  assert.ok(setup.sessions.toolPage(request(view)).text.includes('private details'));
});

test('stopping expires active reads and archives complete partial output for restart', async (context) => {
  const setup = await fixture(context);
  const message = tool('a', 'partial\n'.repeat(5000), 'running');
  setup.emit(message);
  const old = request(setup.sessions.snapshot()[0]);
  await setup.sessions.stop(setup.id);
  assert.equal(setup.sessions.snapshot()[0].messages[1].state, 'error');
  assert.throws(() => setup.sessions.toolPage(old), /changed/);
  await setup.sessions.remove(setup.id);
  const restarted = new AgentSessions(
    {
      backend: {
        id: 'unused',
        label: 'Unused',
        dependencies: {},
        async run() {
          assert.fail('Do not resume on reopen');
        },
      },
    },
    () => {},
    setup.directory,
  );
  try {
    await restarted.loadPrevious();
    await restarted.reopen(setup.id);
    assert.equal(readAll(restarted, request(restarted.snapshot()[0]))[0], body(message));
  } finally {
    await restarted.close();
  }
});

test('legacy JSON is retained during migration, with original tool data and order restored privately', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-legacy-tools-'));
  const store = new SessionStore(directory);
  context.after(async () => {
    store.tools.close();
    await rm(directory, { recursive: true, force: true });
  });
  const id = randomUUID();
  const first = tool('old:a', 'legacy output'.repeat(100000));
  const second = tool('old:b', 'last result');
  await store.save({
    id,
    title: 'Legacy',
    model: 'fixture',
    status: 'completed',
    error: '',
    updatedAt: 1,
    messages: [
      chatMessage('user', 'user', 'question'),
      first,
      tool('old:c', 'consecutive'),
      chatMessage('answer', 'assistant', 'answer'),
      second,
    ],
  });
  const original = await readFile(join(directory, id + '.json'), 'utf8');
  const restored = await store.read(id);
  assert.deepEqual(
    restored.messages.map((m) => m.kind),
    ['user', 'tool', 'assistant', 'tool'],
  );
  assert.equal(restored.messages[1].toolGroup?.count, 2);
  assert.equal(await readFile(join(directory, id + '.json'), 'utf8'), original);
  const again = await store.read(id);
  assert.equal(again.messages[1].id, restored.messages[1].id);
  assert.equal(again.messages[1].toolGroup?.count, 2);
  await store.save(again);
  assert.ok((await readFile(join(directory, id + '.json'), 'utf8')).length < 2000);
  assert.deepEqual((await store.read(id)).messages, again.messages);
});

test('storage failures are explicit and do not prevent saving the ordinary conversation', async (context) => {
  const setup = await fixture(context);
  // A real filesystem obstacle, independent of tool-store implementation.
  await writeFile(
    join(setup.directory, '.companion-sessions', 'tool-transcripts.sqlite'),
    'not a sqlite database',
  );
  assert.throws(() => setup.emit(tool('a', 'cannot persist')), /database/);
  await setup.finish();
  assert.equal(setup.sessions.snapshot()[0].status, 'error');
  const saved = JSON.parse(
    await readFile(join(setup.directory, '.companion-sessions', setup.id + '.json'), 'utf8'),
  );
  assert.equal(saved.messages[0].text, frame.utterance);
});

test('private socket delivers correlated bounded pages only to the selected conversation owner', async (context) => {
  const setup = await fixture(context);
  const desktop = await desktopFixture(
    async () => assert.fail('No keyboard input'),
    setup.sessions,
  );
  context.after(() => desktop.close());
  setup.emit(tool('a', 'socket-private'.repeat(10000)));
  await waitFor(() => setup.sessions.snapshot()[0].messages.length === 2);
  const page = {
    action: 'agent-tool-page',
    requestId: 'page-1',
    ...request(setup.sessions.snapshot()[0]),
  };
  desktop.send(page);
  assert.equal((await desktop.reply('agent-tool-page')).type, 'error');
  desktop.send({ action: 'panel-state', id: setup.id, composerFocused: false });
  await desktop.reply('panel-state');
  desktop.send(page);
  const response = await desktop.reply('agent-tool-page');
  assert.equal(response.type, 'result');
  assert.equal((response as unknown as { requestId: string }).requestId, 'page-1');
  assert.ok(JSON.stringify(response).length < 50 * 1024);
  assert.ok(JSON.stringify(response).includes('socket-private'));
  desktop.send({ ...page, requestId: 'bad', groupId: randomUUID() });
  const error = await desktop.reply('agent-tool-page');
  assert.equal(error.type, 'error');
  assert.equal((error as unknown as { requestId: string }).requestId, 'bad');
  assert.ok(!JSON.stringify(error).includes('socket-private'));
});

test('Pi event adapter delivers >16K inputs/results intact and releases completed calls', async (context) => {
  const { PiTranscript } = await import('../../src/agents/pi-transcript.ts');
  const setup = await fixture(context);
  const transcript = new PiTranscript(setup.emit);
  const args = { value: 'large-input'.repeat(20000) };
  const output = 'large-output'.repeat(20000);
  transcript.receive({
    type: 'tool_execution_start',
    toolCallId: 'pi-call',
    toolName: 'read',
    args,
  });
  transcript.receive({
    type: 'tool_execution_update',
    toolCallId: 'pi-call',
    partialResult: { content: [{ type: 'text', text: 'partial' }] },
  });
  transcript.receive({
    type: 'tool_execution_end',
    toolCallId: 'pi-call',
    result: { content: [{ type: 'text', text: output }] },
  });
  // An event after completion cannot revive a released call or overwrite output.
  transcript.receive({
    type: 'tool_execution_update',
    toolCallId: 'pi-call',
    partialResult: { content: [{ type: 'text', text: 'late' }] },
  });
  await setup.finish();
  assert.equal(
    readAll(setup.sessions, request(setup.sessions.snapshot()[0]))[0],
    'read\n\n' + JSON.stringify(args, null, 2) + '\n\n' + output,
  );
});

test('tools share the 800-row limit but do not reduce ordinary 1M-unit text allowance', async (context) => {
  const setup = await fixture(context);
  const userUnits = setup.sessions.snapshot()[0].messages[0].text.length;
  setup.emit(tool('a', 'tool output'.repeat(100000)));
  setup.emit(chatMessage('answer', 'assistant', 'x'.repeat(1_000_000 - userUnits)));
  for (let index = 0; index < 797; index++) setup.emit(chatMessage('empty-' + index, 'notice', ''));
  assert.equal(setup.sessions.snapshot()[0].messages.length, 800);
  setup.emit(tool('a', 'updated tool output'.repeat(100000)));
  assert.throws(
    () => setup.emit(chatMessage('over-text', 'assistant', 'x')),
    /panel transcript limit/,
  );
  assert.throws(() => setup.emit(tool('new-group', 'another tool')), /panel transcript limit/);
  await setup.finish();
  const view = setup.sessions.snapshot()[0];
  assert.equal(view.messages.length, 800);
  assert.equal(
    view.messages.reduce((units, m) => units + m.text.length + m.input.length, 0),
    1_000_000,
  );
  await setup.sessions.remove(setup.id);
  await setup.sessions.reopen(setup.id);
  assert.deepEqual(setup.sessions.snapshot()[0].messages, view.messages);
});
