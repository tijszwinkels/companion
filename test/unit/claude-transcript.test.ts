import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeTranscript, companionToolName } from '../../src/agents/claude/claude-transcript.ts';
import type { AgentMessage } from '../../src/agents/types.ts';

function recorder() {
  const updates: AgentMessage[] = [];
  const finished: [string, string, boolean][] = [];
  const transcript = new ClaudeTranscript(
    (message) => updates.push(message),
    (toolUseId, toolName, succeeded) => finished.push([toolUseId, toolName, succeeded]),
  );
  return { updates, finished, transcript };
}

function assistant(id: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { id, role: 'assistant', content }, ...extra };
}

test('only the companion MCP prefix is removed from tool names', () => {
  assert.equal(companionToolName('mcp__companion__companion_choices'), 'companion_choices');
  assert.equal(companionToolName('mcp__other__companion_choices'), 'mcp__other__companion_choices');
  assert.equal(companionToolName('Bash'), 'Bash');
});

test('without stream events, API message IDs separate assistant bubbles and blocks join', () => {
  const { updates, transcript } = recorder();

  transcript.receive(assistant('msg_1', [{ type: 'thinking', thinking: 'hidden' }]));
  transcript.receive(assistant('msg_1', [{ type: 'text', text: 'First' }]));
  transcript.receive(assistant('msg_1', [{ type: 'text', text: 'Second' }]));
  transcript.receive(assistant('msg_2', [{ type: 'text', text: 'Next message' }]));
  transcript.receive({ type: 'result', subtype: 'success', is_error: false });

  const final = new Map(updates.map((message) => [message.id, message]));
  assert.equal(final.get('assistant-1')?.text, 'First\n\nSecond');
  assert.equal(final.get('assistant-1')?.state, 'done');
  assert.equal(final.get('assistant-2')?.text, 'Next message');
  assert.equal(final.get('assistant-2')?.state, 'done');
  assert.equal(
    updates.some((message) => message.text.includes('hidden')),
    false,
    'Thinking is never displayed',
  );
});

test('the complete text block replaces streamed text at its content index', () => {
  const { updates, transcript } = recorder();

  transcript.receive({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm' } },
  });
  transcript.receive({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  });
  transcript.receive({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Draf' } },
  });
  transcript.receive(assistant('m', [{ type: 'text', text: 'Final' }]));
  transcript.receive({ type: 'stream_event', event: { type: 'message_stop' } });

  assert.deepEqual(
    updates.map((message) => [message.text, message.state]),
    [
      ['Draf', 'running'],
      ['Final', 'running'],
      ['Final', 'done'],
    ],
  );
});

test('invalid content indexes and content before a message are rejected', () => {
  const { transcript } = recorder();
  assert.throws(
    () =>
      transcript.receive({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      }),
    /before starting an assistant message/,
  );

  transcript.receive({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm' } },
  });
  assert.throws(
    () =>
      transcript.receive({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: -1, delta: { type: 'text_delta', text: 'x' } },
      }),
    /invalid content index/,
  );
});

test('synthetic API error messages end in the error state', () => {
  const { updates, transcript } = recorder();

  transcript.receive(
    assistant('e', [{ type: 'text', text: 'There is an issue with the model' }], {
      error: 'model_not_found',
    }),
  );
  transcript.finish();

  assert.equal(updates.at(-1)?.state, 'error');
});

test('tool results use text blocks only, and unfinished tools are closed as failed', () => {
  const { updates, finished, transcript } = recorder();

  transcript.receive(
    assistant('t', [
      { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/x.png' } },
    ]),
  );
  transcript.receive(
    assistant('t', [
      { type: 'tool_use', id: 'toolu_b', name: 'mcp__companion__companion_sessions' },
    ]),
  );
  transcript.receive({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_a',
          content: [
            { type: 'text', text: 'one' },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    },
  });
  transcript.finish();
  transcript.finish();

  const final = new Map(updates.map((message) => [message.id, message]));
  assert.equal(final.get('tool-toolu_a')?.text, 'one\n\ntwo');
  assert.equal(final.get('tool-toolu_a')?.state, 'done');
  assert.equal(final.get('tool-toolu_b')?.toolName, 'companion_sessions');
  assert.equal(final.get('tool-toolu_b')?.input, '{}');
  assert.equal(final.get('tool-toolu_b')?.state, 'error');
  assert.deepEqual(finished, [
    ['toolu_a', 'Read', true],
    ['toolu_b', 'companion_sessions', false],
  ]);
});

test('results for unknown tool calls and subagent events are ignored', () => {
  const { updates, finished, transcript } = recorder();

  transcript.receive({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }],
    },
  });
  transcript.receive({
    ...assistant('s', [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: {} }]),
    parent_tool_use_id: 'toolu_agent',
  });
  transcript.finish();

  assert.deepEqual(updates, []);
  assert.deepEqual(finished, []);
});
