import assert from 'node:assert/strict';
import test from 'node:test';
import { historyPage, historyPageRows, historyPageText } from '../../src/agents/history-pages.ts';
import { chatMessage, type AgentMessage, type AgentSession } from '../../src/agents/types.ts';

function session(messages: AgentMessage[]): AgentSession {
  return {
    id: 'fixture',
    title: 'Fixture',
    status: 'completed',
    model: 'fixture',
    error: '',
    updatedAt: 0,
    toolEpoch: 'epoch',
    messages,
  };
}

function check(page: ReturnType<typeof historyPage>): void {
  assert.ok(page.messages.length <= historyPageRows);
  assert.ok(
    page.messages.reduce((sum, row) => sum + row.input.length + row.text.length, 0) <=
      historyPageText,
  );
  assert.deepEqual(
    page.history.ids,
    page.messages.map((row) => row.id),
  );
}

test('forward and backward pages partition empty, small and oversized rows losslessly', () => {
  const messages = Array.from({ length: 705 }, (_, index) => ({
    ...chatMessage(
      String(index),
      'assistant',
      index % 51 === 0 ? '🦋'.repeat(70001) : index % 3 === 0 ? '' : 'answer'.repeat(50),
    ),
    input: index % 53 === 0 ? 'input'.repeat(15000) : '',
  }));
  const view = session(messages);
  for (const direction of ['before', 'after'] as const) {
    const collected = new Map<string, { text: string; input: string }>();
    let position = { index: direction === 'before' ? messages.length : 0, offset: 0 };
    let pages = 0;
    do {
      const page = historyPage(view, 1, direction, position);
      check(page);
      assert.ok(++pages < 100, 'Every page makes progress');
      for (const row of page.messages) {
        const previous = collected.get(row.id) ?? { text: '', input: '' };
        collected.set(
          row.id,
          direction === 'after'
            ? { text: previous.text + row.text, input: previous.input + row.input }
            : { text: row.text + previous.text, input: row.input + previous.input },
        );
      }
      position = direction === 'before' ? page.history.start : page.history.end;
    } while (
      direction === 'before'
        ? position.index > 0 || position.offset > 0
        : position.index < messages.length
    );
    assert.equal(collected.size, messages.length);
    for (const row of messages)
      assert.deepEqual(collected.get(row.id), { text: row.text, input: row.input });
  }
});

test('positions reject invalid offsets; empty transcript has an empty page', () => {
  const view = session([chatMessage('a', 'assistant', 'hello')]);
  for (const position of [
    { index: -1, offset: 0 },
    { index: 2, offset: 0 },
    { index: 0, offset: 5 },
    { index: 1, offset: 1 },
    { index: 0, offset: -1 },
    { index: 0.1, offset: 0 },
  ]) {
    assert.throws(() => historyPage(view, 0, 'after', position), /History position/);
  }
  assert.equal(historyPage(session([]), 0).messages.length, 0);
});

test('appends preserve existing page boundaries and updates return authoritative content', () => {
  const view = session(
    Array.from({ length: 450 }, (_, index) => chatMessage(String(index), 'assistant', 'old')),
  );
  const recent = historyPage(view, 1);
  const start = recent.history.start;
  view.messages.push(chatMessage('new', 'assistant', 'new'));
  view.messages[0] = { ...view.messages[0], text: 'updated' };
  const older = historyPage(view, 2, 'before', start);
  assert.equal(older.messages.at(-1)!.id, '249');
  assert.equal(historyPage(view, 2, 'after', { index: 0, offset: 0 }).messages[0].text, 'updated');
  assert.equal(recent.messages[0].text, 'old', 'Reader snapshot is not mutated');
});
