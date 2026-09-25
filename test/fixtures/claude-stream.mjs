#!/usr/bin/env node
// A real child process speaking only the subset of Claude Code's stream-json
// protocol used by Companion (shapes verified against claude 2.1.280). It
// never opens a model, the user's Claude sessions, or a desktop connection.
// Conversations are marker files under ./claude-sessions in its working
// directory. The first word of the prompt selects a scenario.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');

const resumeId = option('--resume');
const sessionId = resumeId ?? option('--session-id');
const sessionFile = `claude-sessions/${sessionId}`;

if (resumeId !== undefined && !existsSync(sessionFile)) {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0 });
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}
if (resumeId === undefined && existsSync(sessionFile)) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}

const mcpConfigPath = option('--mcp-config');
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
const bridge = mcpConfig.mcpServers.companion;
const resultsEndpoint = bridge.env.COMPANION_CLAUDE_RESULTS_ENDPOINT;
const resultsToken = bridge.env.COMPANION_CLAUDE_RESULTS_TOKEN;

let buffered = '';
let stalled = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    void receive(message);
  }
});
// Like Claude Code in --print mode: stdin EOF ends the process.
process.stdin.on('end', () => process.exit(0));

async function receive(message) {
  if (message.type === 'control_request' && message.request.subtype === 'get_settings') {
    const model = option('--model');
    let appliedModel = model;
    let appliedEffort = option('--effort');
    if (model === 'claude-drift') {
      appliedModel = 'claude-other';
    }
    if (model === 'claude-no-effort') {
      appliedEffort = null;
    }
    if (model === 'claude-effort-drift') {
      appliedEffort = 'low';
    }
    if (model === 'opus') {
      appliedModel = 'claude-opus-5-5';
    }
    // A living process that never answers its settings request.
    if (model === 'claude-silent-settings') {
      return;
    }
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: { applied: { model: appliedModel, effort: appliedEffort } },
      },
    });
    return;
  }

  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    writeFileSync('interrupted', 'yes');
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response: {} },
    });
    if (stalled) {
      send({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
      });
    }
    return;
  }

  if (message.type === 'user') {
    await answer(message);
  }
}

function record(message) {
  const configMode = statSync(mcpConfigPath).mode & 0o777;
  writeFileSync(
    'request.json',
    JSON.stringify({
      message,
      argv: process.argv.slice(2),
      pid: process.pid,
      cwd: process.cwd(),
      mcpConfigPath,
      mcpConfigMode: configMode,
      mcpConfig,
      internalAgent: process.env.COMPANION_INTERNAL_AGENT,
      externalSocketExported: process.env.COMPANION_EXTERNAL_SOCKET !== undefined,
      tokenVariablesExported: Object.keys(process.env).filter((name) => name.endsWith('_TOKEN')),
      parentClaudeExported: process.env.CLAUDECODE !== undefined,
    }),
  );
  mkdirSync('claude-sessions', { recursive: true });
  writeFileSync(sessionFile, 'transcript');
}

function init(overrides = {}) {
  send({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: option('--model'),
    permissionMode: option('--permission-mode'),
    mcp_servers: [{ name: 'companion', status: 'connected' }],
    ...overrides,
  });
}

/** One streamed text message: partial deltas, then the authoritative block. */
function streamText(messageId, parts, finalText = parts.join('')) {
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } });
  send({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  for (const part of parts) {
    send({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } },
    });
  }
  send({
    type: 'assistant',
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: finalText }] },
  });
  send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  send({ type: 'stream_event', event: { type: 'message_stop' } });
}

function toolCall(messageId, id, name, input) {
  send({
    type: 'assistant',
    message: { id: messageId, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

function toolResult(id, content, isError = false) {
  send({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });
}

function success(text = '## Answer\n**42**') {
  send({ type: 'result', subtype: 'success', is_error: false, result: text });
}

/** Play the MCP bridge's part: report a result to the backend's loopback route. */
async function report(body, token = resultsToken) {
  const response = await fetch(resultsEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  writeFileSync('report-status', String(response.status));
}

async function answer(message) {
  record(message);
  const text = message.message.content[0].text;
  const [scenario, variant] = text.split(' ');

  if (scenario === 'exit') {
    init();
    process.stderr.write('fixture crash\n');
    process.exit(3);
  }

  if (scenario === 'control') {
    init();
    send({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool' } });
    return;
  }

  if (scenario === 'permission') {
    init({ permissionMode: 'default' });
    return;
  }

  if (scenario === 'bridge-failed') {
    init({ mcp_servers: [{ name: 'companion', status: 'failed' }] });
    return;
  }

  if (scenario === 'bridge-unknown') {
    init({ mcp_servers: [{ name: 'companion' }] });
    return;
  }

  // A stream that never confirms its init must not complete the turn, even
  // when it otherwise looks like a successful answer.
  if (scenario === 'no-init') {
    streamText('msg-no-init', ['unverified']);
    success();
    return;
  }

  // A living process that took the prompt but never confirms its init.
  if (scenario === 'silent-init') {
    return;
  }

  if (scenario === 'wrong-session') {
    init({ session_id: '00000000-0000-4000-8000-000000000000' });
    return;
  }

  init();

  if (scenario === 'malformed') {
    process.stdout.write('{not json\n');
    return;
  }

  if (scenario === 'oversized') {
    process.stdout.write('"' + 'x'.repeat(9 * 1024 * 1024) + '"\n');
    return;
  }

  if (scenario === 'unterminated') {
    process.stdout.write('"' + 'x'.repeat(9 * 1024 * 1024));
    return;
  }

  if (scenario === 'stall') {
    stalled = true;
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_stall' } } });
    send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Partial' },
      },
    });
    return;
  }

  if (scenario === 'inherited-pipe') {
    // Model a tool that starts its own process group while retaining Claude
    // Code's stdout/stderr. Killing the group cannot close those pipe ends.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', process.stdout, process.stderr],
    });
    writeFileSync('holder.pid', String(holder.pid));
    if (variant === 'cancel') {
      stalled = true;
      return;
    }
    streamText('msg_answer', ['## Answer\n**42**']);
    success();
    return;
  }

  if (scenario === 'error') {
    send({
      type: 'assistant',
      message: {
        id: 'msg_error',
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture model failure' }],
      },
      error: 'model_not_found',
    });
    send({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'fixture model failure',
      terminal_reason: 'api_error',
    });
    return;
  }

  if (scenario === 'leak') {
    toolCall('msg_leak', 'toolu_leak', 'Bash', { command: `echo ${resultsToken}` });
    toolResult('toolu_leak', `token=${resultsToken}`);
    process.stderr.write(`config ${JSON.stringify(bridge.env)}\n`);
    process.exit(2);
  }

  if (scenario === 'tools') {
    toolCall('msg_tools', 'toolu_bash', 'Bash', { command: 'echo bash-ok' });
    // Subagent traffic belongs to its Agent tool call and is not displayed.
    send({
      type: 'assistant',
      parent_tool_use_id: 'toolu_bash',
      message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'text', text: 'subagent' }] },
    });
    toolResult('toolu_bash', [{ type: 'text', text: 'bash-ok' }]);
    toolCall('msg_tools2', 'toolu_fail', 'mcp__other__lookup', { query: 'x' });
    toolResult('toolu_fail', 'lookup failed', true);
    streamText('msg_answer', ['## Ans', 'wer\n**42**']);
    success();
    return;
  }

  if (scenario === 'choices') {
    const options = [{ label: 'Tests', description: 'Run the tests' }, { label: 'Yes' }];
    if (variant === 'ok' || variant === 'failed') {
      await report({ kind: 'choices', toolUseId: 'toolu_choice', options });
    }
    if (variant === 'forged') {
      await report({ kind: 'choices', toolUseId: 'toolu_choice', options }, 'f'.repeat(64));
    }
    if (variant === 'mismatched') {
      await report({ kind: 'choices', toolUseId: 'toolu_other', options });
    }
    toolCall('msg_choice', 'toolu_choice', 'mcp__companion__companion_choices', { options });
    toolResult(
      'toolu_choice',
      variant === 'failed' ? 'Choices rejected' : 'Choices offered.',
      variant === 'failed',
    );
    streamText('msg_answer', ['## Answer\n**42**']);
    success();
    return;
  }

  if (scenario === 'name') {
    if (variant !== 'unreported') {
      await report({ kind: 'name', toolUseId: 'toolu_name', title: '🐛 Login fix' });
    }
    toolCall('msg_name', 'toolu_name', 'mcp__companion__companion_name_session', {
      title: '🐛 Login fix',
    });
    toolResult('toolu_name', 'Conversation named 🐛 Login fix.', variant === 'failed');
    streamText('msg_answer', ['## Answer\n**42**']);
    success();
    return;
  }

  // A verified turn whose answer takes `variant` milliseconds.
  if (scenario === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, Number(variant)));
    streamText('msg_answer', ['## Answer\n**42**']);
    success();
    return;
  }

  if (scenario === 'background') {
    streamText('msg_answer', ['## Answer\n**42**']);
    success();
    // A background task later starts another model turn on the same process.
    streamText('msg_late', ['late background answer']);
    send({ type: 'result', subtype: 'success', is_error: true, result: 'late failure' });
    return;
  }

  streamText('msg_answer', ['## Ans', 'wer\n**42**']);
  success();
}
