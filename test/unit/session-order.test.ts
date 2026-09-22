import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { SessionEvent } from '../../src/agents/types.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { deferred, frame, signal } from '../helpers.ts';

test('moving running sessions retains turn, messages and queue; order rejects stale requests', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-order-'));
  const finish = deferred<void>();
  const calls: string[] = [];
  const events: SessionEvent[] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'order-fixture',
        label: 'Order fixture',
        dependencies: {},
        async run(request, _signal, emit) {
          calls.push(request.id);
          emit(chatMessage('reply', 'assistant', 'Before move'));
          await finish.promise;
          emit(chatMessage('reply', 'assistant', 'After move'));
        },
      },
    },
    () => {},
    directory,
  );
  context.after(async () => {
    finish.resolve();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  sessions.subscribe((event) => events.push(event));
  const first = sessions.start(frame, signal());
  const second = sessions.start(frame, signal());
  const third = sessions.start(frame, signal());
  sessions.followUp(second, 'Retained queue', signal());
  const old = sessions.order();
  const runId = sessions.snapshot()[1].runId;
  sessions.move(second, first, old.revision);
  assert.deepEqual(sessions.order().ids, [second, first, third]);
  assert.equal(sessions.snapshot()[0].runId, runId);
  assert.equal(sessions.snapshot()[0].messages.at(-1)?.text, 'Retained queue');
  assert.throws(() => sessions.move(first, '', old.revision), /order changed/);
  assert.throws(() => sessions.move(first, 'missing', sessions.order().revision), /order changed/);
  finish.resolve();
  await sessions.idle();
  assert.deepEqual(
    sessions.snapshot().map((entry) => entry.id),
    [second, first, third],
  );
  assert.equal(calls.filter((id) => id === second).length, 2);
  assert.ok(sessions.snapshot()[0].messages.some((message) => message.text === 'After move'));
  const current = sessions.order();
  await sessions.remove(first);
  assert.notEqual(sessions.order().revision, current.revision);
  await sessions.reopen(first);
  assert.deepEqual(sessions.order().ids, [second, third, first]);
  assert.ok(events.some((event) => event.type === 'agent-order' && event.ids[0] === second));
});
