import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentMessage, type AgentSession } from '../../src/agents/types.ts';
import {
  applicationChatLimits,
  applicationChatSnapshot,
  type ApplicationChatSnapshot,
} from '../../src/session-apps/chat.ts';

function snapshot(messages: AgentMessage[], status: AgentSession['status'] = 'completed') {
  const result = applicationChatSnapshot({ messages, status });
  assert.equal(result.changed, true);
  return result as ApplicationChatSnapshot;
}

test('app chat projects only text rows, without attachments, tool bodies or widget state', () => {
  const user = {
    ...chatMessage('question', 'user', 'A synthetic question'),
    screenshot: true,
    screenshotUrl: 'private-attachment-sentinel',
    input: 'private-input-sentinel',
  };
  const widget = {
    ...chatMessage('widget', 'assistant', 'private-widget-sentinel'),
    widget: { id: 'synthetic-widget' } as AgentMessage['widget'],
  };
  const result = snapshot([
    user,
    chatMessage('tool', 'tool', 'private-tool-sentinel'),
    chatMessage('notice', 'notice', 'private-notice-sentinel'),
    widget,
    chatMessage('answer', 'assistant', 'A synthetic answer'),
  ]);

  assert.deepEqual(
    result.messages.map((row) => row.id),
    ['question', 'answer'],
  );
  assert.deepEqual(
    result.messages.map((row) => row.source),
    ['human', 'assistant'],
  );
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.equal(result.truncated, false);
});

test('app chat labels non-human input and unknown origins conservatively', () => {
  const origins = [
    { kind: 'agent' },
    { kind: 'external' },
    { kind: 'scheduled-wake' },
    { kind: 'application-event' },
    { kind: 'future-origin' },
  ];
  const messages = origins.map((origin, index) => ({
    ...chatMessage(String(index), 'user', 'Synthetic origin text'),
    origin: origin as AgentMessage['origin'],
  }));
  assert.deepEqual(
    snapshot(messages).messages.map((row) => row.source),
    ['agent', 'external', 'scheduled', 'application', 'unknown'],
  );
});

test('app chat revision tracks streaming text, state, status and window removals', () => {
  const message = chatMessage('answer', 'assistant', 'First');
  message.state = 'running';
  const session = { messages: [message], status: 'running' as AgentSession['status'] };
  const first = applicationChatSnapshot(session);
  assert.deepEqual(applicationChatSnapshot(session, first.revision), {
    changed: false,
    revision: first.revision,
  });

  message.text += ' second';
  const streaming = applicationChatSnapshot(session, first.revision);
  assert.equal(streaming.changed, true);
  assert.notEqual(streaming.revision, first.revision);

  message.state = 'done';
  const done = applicationChatSnapshot(session, streaming.revision);
  assert.equal(done.changed, true);
  session.status = 'completed';
  const completed = applicationChatSnapshot(session, done.revision);
  assert.equal(completed.changed, true);
  session.messages = [];
  const empty = applicationChatSnapshot(session, completed.revision);
  assert.equal(empty.changed, true);
  if (empty.changed) {
    assert.deepEqual(empty.messages, []);
  }
});

test('app chat caps message count and scans only a fixed recent canonical window', () => {
  const messages = Array.from({ length: 40 }, (_, index) =>
    chatMessage(String(index), 'user', 'x'),
  );
  const result = snapshot(messages);
  assert.equal(result.messages.length, applicationChatLimits.messages);
  assert.equal(result.messages[0].id, '16');
  assert.equal(result.truncated, true);

  const oldRow = chatMessage('old', 'user', 'must not inspect old history');
  Object.defineProperty(oldRow, 'kind', {
    get() {
      throw Error('Read beyond the bounded scan');
    },
  });
  const tools = Array.from({ length: applicationChatLimits.scannedRows }, (_, index) =>
    chatMessage('tool-' + index, 'tool', 'excluded'),
  );
  const onlyTools = snapshot([oldRow, ...tools]);
  assert.deepEqual(onlyTools.messages, []);
  assert.equal(onlyTools.truncated, true);
});

test('app chat keeps complete astral code points at its text truncation boundary', () => {
  const limit = applicationChatLimits.textUnitsPerMessage;
  const text = 'prefix😀' + 'x'.repeat(limit - 1);
  const row = snapshot([chatMessage('answer', 'assistant', text)]).messages[0];
  assert.equal(row.text, 'x'.repeat(limit - 1));
  assert.equal(row.truncated, true);
});

test('app chat budgets escaped JSON bytes, including malformed archived Unicode', () => {
  for (const value of ['\0', '\n', '"', '\\', '😀', '\ud800', '\udc00', 'é']) {
    const messages = Array.from({ length: 30 }, (_, index) =>
      chatMessage('row-' + index, 'assistant', value.repeat(10000)),
    );
    const result = snapshot(messages);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result), 'utf8') < applicationChatLimits.responseBytes,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(result.messages), 'utf8') <=
        applicationChatLimits.encodedMessagesBytes,
    );
    assert.ok(
      result.messages.every((row) => row.text.length <= applicationChatLimits.textUnitsPerMessage),
    );
    assert.equal(result.truncated, true);
    if (value === '😀') {
      assert.ok(result.messages.every((row) => /^(?:😀)*$/u.test(row.text)));
    }
  }
});

test('app chat bounds metadata and does not mutate canonical rows', () => {
  const row = Object.freeze(chatMessage('x'.repeat(10000), 'assistant', 'y'.repeat(10000)));
  const result = snapshot([row]);
  assert.ok(result.messages[0].id.length <= 200);
  assert.equal(row.id.length, 10000);
  assert.equal(row.text.length, 10000);
  assert.equal(result.messages[0].truncated, true);
  assert.equal('at' in result.messages[0], false, 'Do not invent unavailable creation timestamps');
});
