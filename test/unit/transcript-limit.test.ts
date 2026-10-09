import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import {
  historyPageRows,
  historyPageText,
  type HistoryPage,
} from '../../src/agents/history-pages.ts';
import { chatMessage, type AgentBackend, type AgentMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';

/** Walk forward and rebuild exact input/text, including oversized fragments. */
function readAll(sessions: AgentSessions): AgentMessage[] {
  const view = sessions.snapshot()[0];
  const messages = new Map<string, AgentMessage>();
  let position = { index: 0, offset: 0 };
  do {
    const page: HistoryPage = sessions.historyPage({
      id: view.id,
      epoch: view.toolEpoch!,
      direction: 'after',
      ...position,
    });
    assert.ok(page.messages.length <= historyPageRows);
    assert.ok(
      page.messages.reduce((sum, row) => sum + row.text.length + row.input.length, 0) <=
        historyPageText,
    );
    for (const message of page.messages) {
      const existing = messages.get(message.id);
      const { historyFragment: _fragment, ...row } = message;
      messages.set(
        message.id,
        existing
          ? { ...row, input: existing.input + row.input, text: existing.text + row.text }
          : row,
      );
    }
    assert.notDeepEqual(page.history.end, position, 'Each nonempty page advances');
    position = page.history.end;
  } while (position.index < view.history!.total || position.offset > 0);
  return [...messages.values()];
}

for (const size of [262_145, 999_999, 1_000_000, 1_000_001, 2_100_000]) {
  test(`history preserves ${size} text/input units across pages and reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-transcript-size-'));
    const text = 'x'.repeat(size - 100);
    const backend: AgentBackend = {
      id: 'transcript-size-fixture',
      label: 'Transcript fixture',
      dependencies: {},
      async run(_request, _signal, emit) {
        emit({ ...chatMessage('large-answer', 'assistant', text), input: 'i'.repeat(100) });
      },
    };
    const sessions = new AgentSessions({ pi: backend }, () => {}, directory);
    try {
      const id = sessions.start(frame, signal());
      await sessions.idle();
      assert.equal(sessions.snapshot()[0].status, 'completed');
      const all = readAll(sessions);
      assert.equal(all[1].text, text);
      assert.equal(all[1].input, 'i'.repeat(100));
      const stored = JSON.parse(
        await readFile(join(directory, '.companion-sessions', `${id}.json`), 'utf8'),
      );
      assert.equal(stored.messages[1].text, text);
      assert.equal(stored.history, undefined);
      assert.equal(stored.messages[1].historyFragment, undefined);
      const epoch = sessions.snapshot()[0].toolEpoch!;
      await sessions.remove(id);
      await sessions.reopen(id);
      assert.deepEqual(readAll(sessions), all);
      assert.throws(
        () => sessions.historyPage({ id, epoch, direction: 'after', index: 0, offset: 0 }),
        /unavailable/,
      );
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const count of [201, 4000, 4001, 6200]) {
  test(`history preserves ${count} bubbles, reopens and continues beyond display boundaries`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-transcript-rows-'));
    let turns = 0;
    const backend: AgentBackend = {
      id: 'transcript-fixture',
      label: 'Transcript fixture',
      dependencies: {},
      async run(request, _signal, emit) {
        turns++;
        assert.equal(request.resume, turns > 1);
        for (let index = 1; index < (turns === 1 ? count : 2); index++) {
          emit(chatMessage(`answer-${index}`, 'assistant', `Answer ${index}`));
        }
      },
    };
    const sessions = new AgentSessions({ pi: backend }, () => {}, directory);
    try {
      const id = sessions.start(frame, signal());
      await sessions.idle();
      const view = sessions.snapshot()[0];
      assert.equal(view.status, 'completed');
      assert.equal(view.messages.length, historyPageRows);
      const all = readAll(sessions);
      assert.equal(all.length, count);
      await sessions.remove(id);
      await sessions.reopen(id);
      assert.equal(turns, 1, 'Reopening never replays a turn');
      assert.deepEqual(readAll(sessions), all);
      sessions.followUp(id, 'Continue normally', signal());
      await sessions.idle();
      assert.equal(sessions.snapshot()[0].status, 'completed');
      assert.equal(readAll(sessions).length, count + 2);
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
