import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationContext } from '../../src/agents/conversation-context.ts';
import { chatMessage } from '../../src/agents/types.ts';

test('first/last message positions overlap only once and preserve chronological roles', () => {
  const expectedPositions = [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 4, 5], [1, 2, 5, 6]];

  for (const [count, positions] of expectedPositions.entries()) {
    const messages = Array.from({ length: count }, (_, index) =>
      chatMessage(String(index), index % 2 === 0 ? 'user' : 'assistant', 'Repeated text'),
    );
    const context = conversationContext({ title: 'Topic', messages });

    assert.equal(context.totalMessages, count);
    assert.deepEqual(
      context.messages.map((message) => message.position),
      positions,
    );
    assert.deepEqual(
      context.messages.map((message) => message.role),
      positions.map((position) => (position % 2 === 1 ? 'user' : 'assistant')),
    );
    assert.ok(context.messages.every((message) => message.text === 'Repeated text'));
  }
});

test('only non-empty user/assistant text counts, with HTML fallback and original states', () => {
  const queued = { ...chatMessage('q', 'user', '  A queued request\n'), state: 'queued' as const };
  const partial = { ...chatMessage('a', 'assistant', 'Partial answer'), state: 'running' as const };
  const failed = { ...chatMessage('f', 'user', 'Unsent request'), state: 'error' as const };
  const html = { ...chatMessage('h', 'assistant', 'Text fallback'), html: '<p>HTML display</p>' };
  const context = conversationContext({
    title: 'Selected title',
    messages: [
      chatMessage('tool', 'tool', 'Do not use tool output'),
      queued,
      chatMessage('blank', 'assistant', ' \n\t'),
      partial,
      chatMessage('notice', 'notice', 'Do not use notices'),
      failed,
      html,
    ],
  });

  assert.equal(context.totalMessages, 4);
  assert.deepEqual(context.messages, [
    { position: 1, role: 'user', state: 'queued', text: queued.text, truncated: false },
    { position: 2, role: 'assistant', state: 'running', text: partial.text, truncated: false },
    { position: 3, role: 'user', state: 'error', text: failed.text, truncated: false },
    { position: 4, role: 'assistant', state: 'done', text: html.text, truncated: false },
  ]);
});

test('bounds count Unicode code points, retaining message beginnings and endings', () => {
  const exactMessage = '🌱'.repeat(2000);
  const longMessage = '🌱'.repeat(1000) + 'middle'.repeat(1000) + '🎙'.repeat(1000);
  const session = {
    title: '🌱'.repeat(201),
    messages: [
      chatMessage('exact', 'user', exactMessage),
      chatMessage('long', 'assistant', longMessage),
    ],
  };
  const context = conversationContext(session);

  assert.equal([...context.title].length, 200);
  assert.equal(context.title, '🌱'.repeat(199) + '…');
  assert.equal(context.titleTruncated, true);
  assert.equal(context.messages[0].text, exactMessage);
  assert.equal(context.messages[0].truncated, false);
  assert.equal([...context.messages[1].text].length, 2000);
  assert.equal(context.messages[1].truncated, true);
  assert.ok(
    context.messages[1].text.startsWith('🌱'.repeat(1000) + '\n[... middle omitted ...]\n'),
  );
  assert.equal(
    context.messages[1].text,
    '🌱'.repeat(1000) + '\n[... middle omitted ...]\n' + '🎙'.repeat(974),
  );
  assert.equal(session.messages[1].text, longMessage, 'Clipping must not edit the transcript');

  const exactTitle = '🌱'.repeat(200);
  assert.deepEqual(conversationContext({ title: exactTitle, messages: [] }), {
    title: exactTitle,
    titleTruncated: false,
    totalMessages: 0,
    messages: [],
  });
});

test('later in-place edits, title changes and new messages cannot mutate a captured context', () => {
  const message = chatMessage('answer', 'assistant', 'Original text');
  const session = { title: 'Original title', messages: [message] };
  const captured = conversationContext(session);

  session.title = 'Renamed';
  message.text = 'Changed text';
  message.state = 'error';
  session.messages.push(chatMessage('next', 'user', 'Later request'));

  assert.deepEqual(captured, {
    title: 'Original title',
    titleTruncated: false,
    totalMessages: 1,
    messages: [
      { position: 1, role: 'assistant', state: 'done', text: 'Original text', truncated: false },
    ],
  });
});
