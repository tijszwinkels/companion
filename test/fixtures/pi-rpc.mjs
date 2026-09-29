#!/usr/bin/env node
// A real child process speaking only the subset of Pi RPC used by Companion.
// It never opens a model, desktop connection, or real user's agent settings.
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let buffered = '';
let sessionName;
let promptText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const request = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    receive(request);
  }
});

function receive(request) {
  if (request.type === 'get_state') {
    if (request.id === 'final-session-name' && promptText.startsWith('native-name timeout')) {
      return;
    }
    const [provider, id] = option('--model').split('/');
    send({
      type: 'response',
      id: request.id,
      success: true,
      data: {
        model: {
          provider,
          id,
          reasoning: id !== 'non-reasoning',
          ...(id === 'requires-thinking'
            ? { thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } }
            : {}),
        },
        thinkingLevel:
          id === 'non-reasoning'
            ? 'off'
            : id === 'wrong-thinking'
              ? 'low'
              : id === 'requires-thinking' && option('--thinking') === 'off'
                ? 'minimal'
                : id === 'limited-thinking' && ['xhigh', 'max'].includes(option('--thinking'))
                  ? 'high'
                  : option('--thinking'),
        messageCount: existsSync('request.json') ? 2 : 0,
        sessionName,
      },
    });
  }
  if (request.type === 'abort') {
    writeFileSync('aborted', 'yes');
  }
  if (request.type !== 'prompt') {
    return;
  }
  promptText = request.message;
  writeFileSync(
    'request.json',
    JSON.stringify({
      request,
      argv: process.argv.slice(2),
      pid: process.pid,
      internalAgent: process.env.COMPANION_INTERNAL_AGENT,
      externalSocketExported: process.env.COMPANION_EXTERNAL_SOCKET !== undefined,
      sessionToolCapabilities: process.env.COMPANION_SESSION_TOOLS_CAPABILITIES ?? null,
    }),
  );
  if (request.message.startsWith('inherited-pipe')) {
    // Model a tool that starts its own process group while retaining Pi's
    // stdout/stderr. Killing Pi's group cannot close our end of those pipes.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', process.stdout, process.stderr],
    });
    writeFileSync('holder.pid', String(holder.pid));
    holder.unref();
    if (request.message.endsWith('success')) {
      send({ type: 'agent_settled' });
    }
    return;
  }
  if (request.message.startsWith('reject')) {
    send({ type: 'response', command: 'prompt', success: false, error: 'fixture rejection' });
    return;
  }
  if (request.message.startsWith('exit')) {
    process.exit(3);
  }
  if (request.message.startsWith('dialog')) {
    send({ type: 'extension_ui_request', id: 'dialog', method: 'confirm' });
    return;
  }

  send({ type: 'response', command: 'prompt', success: true });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First 🙂\u2028line' },
  });
  if (request.message.startsWith('stall')) {
    return;
  }
  send({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'First 🙂\u2028line.' }],
      stopReason: 'toolUse',
    },
  });
  send({
    type: 'tool_execution_start',
    toolCallId: 'read-1',
    toolName: 'read',
    args: { path: 'example.txt' },
  });
  send({
    type: 'tool_execution_update',
    toolCallId: 'read-1',
    partialResult: { content: [{ type: 'text', text: 'partial' }] },
  });
  send({
    type: 'tool_execution_end',
    toolCallId: 'read-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'complete tool output' }] },
  });

  if (request.message.startsWith('choices')) {
    const result = (options) => ({
      content: [{ type: 'text', text: 'Choices' }],
      details: { companionChoices: { version: 1, options } },
    });
    // Neither uncorrelated results, partial results, failed tool calls, nor
    // ordinary assistant text containing [labels] can create live actions.
    send({
      type: 'tool_execution_end',
      toolCallId: 'unrelated',
      isError: false,
      result: result(['Wrong']),
    });
    send({
      type: 'tool_execution_start',
      toolName: 'companion_choices',
      toolCallId: 'failed',
      args: {},
    });
    send({
      type: 'tool_execution_end',
      toolCallId: 'failed',
      isError: true,
      result: result(['Wrong']),
    });
    send({
      type: 'tool_execution_start',
      toolName: 'companion_choices',
      toolCallId: 'choices-1',
      args: {},
    });
    send({
      type: 'tool_execution_update',
      toolCallId: 'choices-1',
      partialResult: result(['Partial']),
    });
    send({
      type: 'tool_execution_end',
      toolCallId: 'choices-1',
      isError: false,
      result: result(['Yes', 'No']),
    });
    send({
      type: 'tool_execution_start',
      toolName: 'companion_choices',
      toolCallId: 'choices-2',
      args: {},
    });
    const options = request.message.startsWith('choices malformed')
      ? ['Yes', 'YES!']
      : request.message.startsWith('choices clear')
        ? []
        : ['[Tests] - Run the tests'];
    const replacement = result(options);
    if (request.message.startsWith('choices missing')) {
      replacement.details = { otherExtension: true };
    } else if (request.message.startsWith('choices version')) {
      replacement.details.companionChoices.version = 2;
    }
    send({
      type: 'tool_execution_end',
      toolCallId: 'choices-2',
      isError: false,
      result: replacement,
    });
  }

  if (request.message.startsWith('native-name')) {
    send({
      type: 'tool_execution_start',
      toolName: 'companion_name_session',
      toolCallId: 'name-1',
      args: {},
    });
    sessionName = request.message.startsWith('native-name invalid')
      ? 'Invalid\nname'
      : '🐛 Login fix';
    send({
      type: 'tool_execution_end',
      toolCallId: 'name-1',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'This text is not the authoritative name' }],
        details: { companionSessionName: { version: 1, title: 'Also not the name' } },
      },
    });
  }

  // Completion must not be inferred from agent_end; retry work follows it.
  send({ type: 'agent_end', willRetry: true });
  setTimeout(() => {
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '## Answer\n**42**' },
    });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '## Answer\n**42**' }],
        stopReason: request.message.startsWith('error') ? 'error' : 'stop',
        errorMessage: 'fixture model failure',
      },
    });
    send({ type: 'agent_settled' });
    if (request.message.startsWith('native-name exit')) {
      process.exit(0);
    }
  }, 150);
}
