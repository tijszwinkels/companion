import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import {
  toolPageUnits,
  toolStorageBytes,
  type ToolPageRequest,
} from '../../src/agents/tool-transcripts.ts';
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
      pi: {
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
    undefined,
    undefined,
    // Conversation screenshots are saved only while capture storage is on.
    CaptureStoragePolicy.enabledForTesting(),
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
  // A restart releases the old listener’s exclusive timer-store ownership.
  await setup.sessions.close();
  const restarted = new AgentSessions(
    {
      pi: {
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

for (const kind of ['assistant', 'tool'] as const) {
  test(`damaged tool storage ${kind === 'tool' ? 'fails a tool turn explicitly' : 'does not fail ordinary answers'}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-storage-failure-'));
    const storage = join(directory, '.companion-sessions');
    await mkdir(storage);
    await writeFile(join(storage, 'tool-transcripts.sqlite'), 'not a sqlite database');
    const sessions = new AgentSessions(
      {
        pi: {
          id: 'storage-failure',
          label: 'Storage failure fixture',
          dependencies: {},
          async run(_request, _signal, emit) {
            emit(chatMessage('result', kind, 'Complete text'));
          },
        },
      },
      () => {},
      directory,
    );
    context.after(async () => {
      await sessions.close();
      await rm(directory, { recursive: true, force: true });
    });
    const id = sessions.start(frame, signal());
    await sessions.idle();
    const view = sessions.snapshot()[0];
    assert.equal(view.status, kind === 'tool' ? 'error' : 'completed');
    if (kind === 'tool') assert.match(view.error, /database/);
    else assert.equal(view.messages[1].text, 'Complete text');
    const saved = JSON.parse(await readFile(join(storage, id + '.json'), 'utf8'));
    assert.equal(saved.messages[0].text, frame.utterance);
    assert.equal(saved.status, view.status);
  });
}

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

test('bounded incremental projections hydrate entering rows and remove evicted ones', async (context) => {
  const setup = await fixture(context);
  let retained = setup.sessions.snapshot()[0].messages;
  let updates = 0;
  setup.sessions.subscribe((event) => {
    if (event.type !== 'agent-session') return;
    const values = new Map(retained.map((row) => [row.id, row]));
    for (const row of event.session.messages) values.set(row.id, row);
    retained = event.session.history!.ids.map((id) => {
      assert.ok(values.has(id), 'Every entering row is hydrated');
      return values.get(id)!;
    });
    assert.ok(retained.length <= 200);
    assert.ok(retained.reduce((sum, row) => sum + row.text.length + row.input.length, 0) <= 65536);
    updates++;
  });
  for (let index = 0; index < 4200; index++)
    setup.emit(chatMessage('row-' + index, 'assistant', 'first'));
  await waitFor(() => updates > 0);
  setup.emit(chatMessage('row-4199', 'assistant', 'changed'));
  setup.emit(chatMessage('row-4200', 'assistant', 'entering'));
  await setup.finish();
  assert.deepEqual(retained, setup.sessions.snapshot()[0].messages);
  assert.equal(retained.at(-2)!.text, 'changed');
  assert.equal(retained.at(-1)!.text, 'entering');
});

test('history pages require selected socket ownership and reject stale epochs and malformed cursors', async (context) => {
  const setup = await fixture(context);
  const desktop = await desktopFixture(
    async () => assert.fail('No keyboard input'),
    setup.sessions,
  );
  context.after(() => desktop.close());
  setup.emit(chatMessage('large', 'assistant', 'private-synthetic'.repeat(100000)));
  const request = {
    action: 'agent-history-page',
    requestId: 'history-1',
    id: setup.id,
    epoch: setup.sessions.snapshot()[0].toolEpoch,
    direction: 'after',
    index: 0,
    offset: 0,
  };
  desktop.send(request);
  assert.equal((await desktop.reply(request.action)).type, 'error');
  desktop.send({ action: 'panel-state', id: setup.id, composerFocused: false });
  await desktop.reply('panel-state');
  desktop.send(request);
  const result = await desktop.reply(request.action);
  assert.equal(result.type, 'result');
  assert.ok(JSON.stringify(result).includes('private-synthetic'));
  assert.ok(JSON.stringify(result).length < 70 * 1024);
  for (const invalid of [
    { epoch: randomUUID() },
    { index: -1 },
    { offset: 100000000 },
    { direction: 'all' },
    { anchor: 'missing' },
  ]) {
    desktop.send({ ...request, ...invalid });
    const result = await desktop.reply(request.action);
    assert.equal(result.type, 'error');
    assert.ok(!JSON.stringify(result).includes('private-synthetic'));
  }
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

test('old tools remain pageable after crossing row and text display budgets', async (context) => {
  const setup = await fixture(context);
  const userUnits = setup.sessions.snapshot()[0].messages[0].text.length;
  setup.emit(tool('a', 'tool output'.repeat(100000)));
  setup.emit(chatMessage('answer', 'assistant', 'x'.repeat(1_000_000 - userUnits)));
  const initial = setup.sessions.snapshot()[0];
  const first = setup.sessions.historyPage({
    id: setup.id,
    epoch: initial.toolEpoch!,
    direction: 'after',
    index: 0,
    offset: 0,
  });
  const group = first.messages.find((row) => row.toolGroup)!;
  for (let index = 0; index < 4200; index++)
    setup.emit(chatMessage('empty-' + index, 'notice', ''));
  assert.equal(setup.sessions.snapshot()[0].messages.length, 200);
  setup.emit(tool('a', 'updated tool output'.repeat(100000)));
  setup.emit(chatMessage('over-text', 'assistant', 'x'));
  setup.emit(tool('new-group', 'another tool'));
  await setup.finish();
  const view = setup.sessions.snapshot()[0];
  assert.equal(view.messages.length, 200);
  assert.ok(view.history!.total > 4000);
  const anchored = setup.sessions.historyPage({
    id: setup.id,
    epoch: view.toolEpoch!,
    direction: 'after',
    index: 0,
    offset: 0,
    anchor: group.id,
  });
  assert.equal(anchored.messages[0].id, group.id);
  const detail = setup.sessions.toolPage({
    id: setup.id,
    epoch: view.toolEpoch!,
    groupId: group.id,
    revision: anchored.messages[0].toolGroup!.revision,
    index: 0,
    offset: 0,
  });
  assert.match(detail.text, /updated tool output/);
  await setup.sessions.remove(setup.id);
  await setup.sessions.reopen(setup.id);
  assert.deepEqual(setup.sessions.snapshot()[0].messages, view.messages);
});

for (const damage of ['missing', 'corrupt']) {
  test(`${damage} tool database preserves archive discovery, ordinary chat and the recoverable reference`, async (context) => {
    const setup = await fixture(context);
    setup.emit(tool('a', 'Recoverable tool details'));
    setup.emit(chatMessage('answer', 'assistant', 'Ordinary answer'));
    await setup.finish();
    const original = request(setup.sessions.snapshot()[0]);
    const screenshotUrl = setup.sessions.snapshot()[0].messages[0].screenshotUrl;
    await setup.sessions.remove(setup.id);
    await setup.sessions.close();
    const path = join(setup.directory, '.companion-sessions', 'tool-transcripts.sqlite');
    const database = await readFile(path);
    if (damage === 'missing') await rm(path);
    else await writeFile(path, 'damaged database');
    const backend: AgentBackend = {
      id: 'unused',
      label: 'Unused',
      dependencies: {},
      async run() {
        assert.fail('Do not resume while reopening');
      },
    };
    const restarted = new AgentSessions({ pi: backend }, () => {}, setup.directory);
    try {
      await restarted.loadPrevious();
      assert.equal(restarted.previousSnapshot().length, 1);
      await restarted.reopen(setup.id);
      const view = restarted.snapshot()[0];
      assert.equal(view.messages[2].text, 'Ordinary answer');
      assert.ok(screenshotUrl);
      assert.equal(view.messages[0].screenshotUrl, screenshotUrl);
      assert.equal(view.messages[1].id, original.groupId);
      assert.equal(view.messages[1].toolGroup?.unavailable, true);
      assert.equal(view.messages[1].state, 'done');
      assert.throws(() => restarted.toolPage(request(view)), /unavailable|database/);
      await restarted.remove(setup.id);
    } finally {
      await restarted.close();
    }
    // Closing with unavailable details must preserve their IDs. Restoring the
    // original private database makes the complete text readable again.
    await writeFile(path, database, { mode: 0o600 });
    const recovered = new AgentSessions({ pi: backend }, () => {}, setup.directory);
    try {
      await recovered.loadPrevious();
      await recovered.reopen(setup.id);
      assert.ok(
        recovered
          .toolPage(request(recovered.snapshot()[0]))
          .text.includes('Recoverable tool details'),
      );
    } finally {
      await recovered.close();
    }
  });
}

test('oversized tool storage updates fail before allocation and preserve the committed version', async (context) => {
  const setup = await fixture(context);
  setup.emit(tool('a', 'committed'));
  const before = request(setup.sessions.snapshot()[0]);
  // A JS repeated string stays a rope until materialized. Admission should use
  // its length before allocating a hundreds-of-megabytes UTF-16 buffer.
  assert.throws(
    () => setup.emit(tool('a', 'x'.repeat(toolStorageBytes / 2))),
    /storage limit \(256 MiB/,
  );
  assert.deepEqual(request(setup.sessions.snapshot()[0]), before);
  assert.equal(readAll(setup.sessions, before)[0], body(tool('a', 'committed')));
});

test('legacy archives remain grouped and lazy through corrupt-store reopen, follow-up and save', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-legacy-corrupt-'));
  const storage = join(directory, '.companion-sessions');
  const store = new SessionStore(storage);
  const id = randomUUID();
  const first = tool('old-a', 'LEGACY_SECRET'.repeat(2000));
  const second = tool('old-b', 'second result');
  await store.save({
    id,
    title: 'Legacy',
    model: 'fixture',
    status: 'completed',
    error: '',
    updatedAt: 1,
    messages: [
      chatMessage('user', 'user', 'Question'),
      first,
      second,
      chatMessage('answer', 'assistant', 'Ordinary answer'),
    ],
  });
  await writeFile(join(storage, 'tool-transcripts.sqlite'), 'corrupt store');
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'ordinary-follow-up',
        label: 'Ordinary follow-up',
        dependencies: {},
        async run(_request, _signal, emit) {
          emit(chatMessage('reply', 'assistant', 'Follow-up answer'));
        },
      },
    },
    () => {},
    directory,
  );
  context.after(async () => {
    store.tools.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  await sessions.loadPrevious();
  assert.equal(sessions.previousSnapshot().length, 1);
  await sessions.reopen(id);
  const view = sessions.snapshot()[0];
  assert.equal(view.messages.length, 3);
  assert.equal(view.messages[1].toolGroup?.count, 2);
  assert.ok(!JSON.stringify(view).includes('LEGACY_SECRET'));
  assert.deepEqual(readAll(sessions, request(view)), [body(first), body(second)]);
  sessions.followUp(id, 'Continue', signal());
  await sessions.idle();
  assert.equal(sessions.snapshot()[0].status, 'completed');
  await sessions.remove(id);
  // The only original copy of tool text must survive saves during failed migration.
  const saved = JSON.parse(await readFile(join(storage, id + '.json'), 'utf8'));
  assert.equal(saved.messages.find((m: { id: string }) => m.id === first.id).text, first.text);
  await sessions.reopen(id);
  assert.deepEqual(readAll(sessions, request(sessions.snapshot()[0])), [body(first), body(second)]);
  assert.ok(sessions.snapshot()[0].messages.some((m) => m.text === 'Follow-up answer'));
});

test('cumulative Pi bursts coalesce disk writes, preserve final text, and save the latest partial on stop', async (context) => {
  const { PiTranscript } = await import('../../src/agents/pi-transcript.ts');
  const setup = await fixture(context);
  const transcript = new PiTranscript(setup.emit);
  transcript.receive({
    type: 'tool_execution_start',
    toolCallId: 'stream',
    toolName: 'read',
    args: {},
  });
  const initial = request(setup.sessions.snapshot()[0]);
  let text = '';
  const started = performance.now();
  for (let index = 0; index < 400; index++) {
    text += 'x'.repeat(10485);
    transcript.receive({
      type: 'tool_execution_update',
      toolCallId: 'stream',
      partialResult: { content: [{ type: 'text', text }] },
    });
  }
  // A structural negative control: old code rotates the persisted revision 400
  // times here. Coalesced state has not written any of those superseded bodies.
  assert.equal(setup.sessions.snapshot()[0].messages[1].toolGroup?.revision, initial.revision);
  transcript.receive({
    type: 'tool_execution_end',
    toolCallId: 'stream',
    result: { content: [{ type: 'text', text }] },
  });
  console.log(
    `400 cumulative updates + final 8 MiB body: ${(performance.now() - started).toFixed(1)} ms`,
  );
  assert.equal(
    readAll(setup.sessions, request(setup.sessions.snapshot()[0]))[0],
    'read\n\n{}\n\n' + text,
  );
  setup.emit(tool('partial', 'start', 'running'));
  setup.emit(tool('partial', 'latest accepted partial', 'running'));
  await setup.sessions.stop(setup.id);
  const calls = readAll(setup.sessions, request(setup.sessions.snapshot()[0]));
  assert.equal(calls[1], body(tool('partial', 'latest accepted partial')));
  assert.equal(setup.sessions.snapshot()[0].messages[1].state, 'error');
});

test('coalesced partials become readable on flush; a deferred write failure fails the turn', async (context) => {
  const setup = await fixture(context);
  setup.emit(tool('a', 'start', 'running'));
  const before = request(setup.sessions.snapshot()[0]);
  setup.emit(tool('a', 'fresh partial', 'running'));
  await waitFor(
    () => setup.sessions.snapshot()[0].messages[1].toolGroup?.revision !== before.revision,
  );
  assert.equal(
    readAll(setup.sessions, request(setup.sessions.snapshot()[0]))[0],
    body(tool('a', 'fresh partial')),
  );
  // Inject failure at the persistence boundary after queuing. This specifically
  // exercises the timer-to-turn error path; corrupt-file tests above cover real I/O.
  const database = (setup.sessions as unknown as { store: SessionStore }).store.tools;
  const originalPut = database.put.bind(database);
  database.put = () => {
    throw Error('fixture disk write failed');
  };
  setup.emit(tool('a', 'cannot persist this partial', 'running'));
  await setup.sessions.idle();
  database.put = originalPut;
  assert.equal(setup.sessions.snapshot()[0].status, 'error');
  assert.match(setup.sessions.snapshot()[0].error, /fixture disk write failed/);
});

test('a finished call remains pageable as siblings arrive; changed call revisions reject mixed pages', async (context) => {
  const setup = await fixture(context);
  const message = tool('a', 'x'.repeat(toolPageUnits * 3));
  setup.emit(message);
  const first = setup.sessions.toolPage(request(setup.sessions.snapshot()[0]));
  setup.emit(tool('b', 'sibling', 'running'));
  const second = setup.sessions.toolPage({ ...first, ...first.next! });
  assert.equal(second.index, 0);
  assert.equal(second.offset, toolPageUnits);
  assert.equal(second.callRevision, first.callRevision);
  setup.emit(tool('a', 'replacement'.repeat(3000)));
  assert.throws(() => setup.sessions.toolPage({ ...second, ...second.next! }), /changed/);
});

test('legacy fallback saves retain the grouped display limit after adding follow-ups', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-legacy-count-'));
  const storage = join(directory, '.companion-sessions');
  const store = new SessionStore(storage);
  const id = randomUUID();
  await store.save({
    id,
    title: 'Legacy',
    model: 'fixture',
    status: 'completed',
    error: '',
    updatedAt: 1,
    messages: [
      chatMessage('user', 'user', 'Question'),
      ...Array.from({ length: 799 }, (_, index) => tool('old-' + index, 'text')),
    ],
  });
  await writeFile(join(storage, 'tool-transcripts.sqlite'), 'corrupt store');
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'fixture',
        label: 'Fixture',
        dependencies: {},
        async run(_request, _signal, emit) {
          emit(chatMessage('answer', 'assistant', 'Follow-up'));
        },
      },
    },
    () => {},
    directory,
  );
  context.after(async () => {
    store.tools.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  await sessions.loadPrevious();
  await sessions.reopen(id);
  sessions.followUp(id, 'Continue', signal());
  await sessions.idle();
  await sessions.remove(id);
  await sessions.reopen(id);
  const view = sessions.snapshot()[0];
  assert.equal(view.messages.length, 4);
  assert.equal(view.messages[1].toolGroup?.count, 799);
  assert.equal(view.messages[3].text, 'Follow-up');
  assert.equal(
    JSON.parse(await readFile(join(storage, id + '.json'), 'utf8')).messages.length,
    802,
  );
});
