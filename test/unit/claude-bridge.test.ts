import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import test from 'node:test';

import { bridgeServerPath } from '../../src/agents/claude/mcp-config.ts';
import { TurnResultRoute } from '../../src/agents/claude/turn-results.ts';

/** A fake Companion loopback service that records requests and answers `reply`. */
async function fakeService(path: string, reply: (body: Record<string, unknown>) => unknown) {
  const requests: { authorization: string; body: Record<string, unknown> }[] = [];

  const server: Server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ authorization: request.headers.authorization ?? '', body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply(body)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}${path}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The real bridge process, speaking newline-delimited JSON-RPC like Claude Code. */
class BridgeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffered = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Record<string, any>) => void>();

  constructor(environment: Record<string, string>) {
    this.child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), bridgeServerPath()],
      {
        env: { PATH: process.env.PATH ?? '', ...environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf('\n');
      while (newline >= 0) {
        const message = JSON.parse(this.buffered.slice(0, newline));
        this.buffered = this.buffered.slice(newline + 1);
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
        newline = this.buffered.indexOf('\n');
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const id = this.nextId;
    this.nextId += 1;
    const reply = new Promise<Record<string, any>>((resolve) => this.waiting.set(id, resolve));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  }

  call(name: string, args: Record<string, unknown>, toolUseId?: string) {
    const params: Record<string, unknown> = { name, arguments: args };
    if (toolUseId) {
      params._meta = { 'claudecode/toolUseId': toolUseId, progressToken: 1 };
    }
    return this.request('tools/call', params);
  }

  /** Claude Code closing stdin ends the bridge; it must exit by itself. */
  async close(): Promise<number | null> {
    const exited = once(this.child, 'exit');
    this.child.stdin.end();
    const [code] = await exited;
    return code as number | null;
  }
}

test('the bridge offers Pi’s tools, instructions and schemas, conditioned on the leases', async (context) => {
  const route = await TurnResultRoute.open();
  context.after(() => route.close());

  const minimal = new BridgeClient({
    COMPANION_CLAUDE_RESULTS_ENDPOINT: route.connection.endpoint,
    COMPANION_CLAUDE_RESULTS_TOKEN: route.connection.token,
  });
  const initialized = await minimal.request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.match(initialized.result.instructions, /mcp__companion__<name>/);
  assert.match(initialized.result.instructions, /call companion_name_session/);
  assert.match(initialized.result.instructions, /Use companion_choices when asking/);
  const minimalTools = (await minimal.request('tools/list')).result.tools;
  assert.deepEqual(
    minimalTools.map((tool: { name: string }) => tool.name),
    ['companion_choices', 'companion_name_session'],
  );
  assert.equal(minimalTools[0].inputSchema.properties.options.maxItems, 8);
  assert.equal(await minimal.close(), 0);

  const full = new BridgeClient({
    COMPANION_CLAUDE_RESULTS_ENDPOINT: route.connection.endpoint,
    COMPANION_CLAUDE_RESULTS_TOKEN: route.connection.token,
    COMPANION_WIDGET_ENDPOINT: 'http://127.0.0.1:1/agent',
    COMPANION_WIDGET_TOKEN: 'a'.repeat(64),
    COMPANION_SESSION_TOOLS_ENDPOINT: 'http://127.0.0.1:1/session',
    COMPANION_SESSION_TOOLS_TOKEN: 'b'.repeat(64),
  });
  const fullTools = (await full.request('tools/list')).result.tools;
  assert.deepEqual(
    fullTools.map((tool: { name: string }) => tool.name),
    [
      'companion_choices',
      'companion_name_session',
      'companion_widgets',
      'companion_widget',
      'companion_widget_update',
      'companion_widget_call',
      'companion_widget_present',
      'companion_sessions',
      'companion_session_start',
      'companion_session_reopen',
      'companion_session_close',
      'companion_session_send',
      'companion_session_draft',
      'companion_browser_open',
    ],
  );
  assert.equal((await full.request('ping')).result !== undefined, true);
  assert.equal((await full.request('resources/list')).error.code, -32601);
  assert.equal(await full.close(), 0);
});

test('choice and name calls report to the turn route before succeeding', async (context) => {
  const route = await TurnResultRoute.open();
  context.after(() => route.close());
  const bridge = new BridgeClient({
    COMPANION_CLAUDE_RESULTS_ENDPOINT: route.connection.endpoint,
    COMPANION_CLAUDE_RESULTS_TOKEN: route.connection.token,
  });
  context.after(() => bridge.close());

  const offered = await bridge.call(
    'companion_choices',
    { options: ['[Tests] - Run the tests', 'Yes'] },
    'toolu_choice',
  );
  assert.equal(offered.result.isError, undefined);
  assert.match(offered.result.content[0].text, /Choices offered/);
  assert.deepEqual(route.take('toolu_choice'), {
    kind: 'choices',
    options: [
      { label: 'Tests', description: 'Run the tests' },
      { label: 'Yes', description: '' },
    ],
  });
  assert.equal(route.take('toolu_choice'), undefined, 'A result is used once');

  const named = await bridge.call('companion_name_session', { title: '🐛 Login fix' }, 'toolu_n');
  assert.equal(named.result.content[0].text, 'Conversation named 🐛 Login fix.');
  assert.deepEqual(route.take('toolu_n'), { kind: 'name', title: '🐛 Login fix' });

  // Schema and semantic validation happen before anything is reported.
  const tooMany = await bridge.call(
    'companion_choices',
    { options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
    'toolu_many',
  );
  assert.equal(tooMany.result.isError, true);
  assert.match(tooMany.result.content[0].text, /Invalid arguments/);
  const duplicate = await bridge.call('companion_choices', { options: ['Yes', 'yes.'] }, 'toolu_d');
  assert.equal(duplicate.result.isError, true);
  assert.match(duplicate.result.content[0].text, /distinct/);
  const multiline = await bridge.call('companion_name_session', { title: 'a\nb' }, 'toolu_m');
  assert.equal(multiline.result.isError, true);
  assert.equal(route.take('toolu_many'), undefined);
  assert.equal(route.take('toolu_d'), undefined);
  assert.equal(route.take('toolu_m'), undefined);

  // Without Claude Code's tool-use ID nothing can be correlated.
  const anonymous = await bridge.call('companion_choices', { options: ['Yes'] });
  assert.equal(anonymous.result.isError, true);
  assert.match(anonymous.result.content[0].text, /tool-use ID/);

  // After the turn ends the route is gone, so the tool fails visibly.
  await route.close();
  const late = await bridge.call('companion_choices', { options: ['Yes'] }, 'toolu_late');
  assert.equal(late.result.isError, true);
});

test('session and widget tools reach their leases with the tool-use ID as request ID', async (context) => {
  const route = await TurnResultRoute.open();
  context.after(() => route.close());
  const sessions = await fakeService('/session', () => ({ open: [], previous: [] }));
  context.after(() => sessions.close());
  const widgets = await fakeService('/agent', () => ({ widgets: ['forecast'] }));
  context.after(() => widgets.close());
  const sessionToken = 'b'.repeat(64);
  const widgetToken = 'a'.repeat(64);

  const bridge = new BridgeClient({
    COMPANION_CLAUDE_RESULTS_ENDPOINT: route.connection.endpoint,
    COMPANION_CLAUDE_RESULTS_TOKEN: route.connection.token,
    COMPANION_WIDGET_ENDPOINT: widgets.endpoint,
    COMPANION_WIDGET_TOKEN: widgetToken,
    COMPANION_SESSION_TOOLS_ENDPOINT: sessions.endpoint,
    COMPANION_SESSION_TOOLS_TOKEN: sessionToken,
  });
  context.after(() => bridge.close());

  const listed = await bridge.call('companion_sessions', { query: 'login' }, 'toolu_list');
  assert.equal(listed.result.isError, undefined);
  assert.deepEqual(JSON.parse(listed.result.content[0].text), { open: [], previous: [] });
  assert.deepEqual(sessions.requests, [
    {
      authorization: `Bearer ${sessionToken}`,
      body: { query: 'login', method: 'list', requestId: 'toolu_list' },
    },
  ]);

  const discovered = await bridge.call('companion_widgets', { query: 'chart' }, 'toolu_w');
  assert.equal(discovered.result.isError, undefined);
  assert.deepEqual(widgets.requests[0].body, {
    query: 'chart',
    method: 'discover',
    requestId: 'toolu_w',
  });
  assert.equal(widgets.requests[0].authorization, `Bearer ${widgetToken}`);

  // Schema validation matches Pi: malformed session IDs never reach the service.
  const invalid = await bridge.call('companion_session_send', { id: 'x', text: 'hi' }, 'toolu_bad');
  assert.equal(invalid.result.isError, true);
  assert.equal(sessions.requests.length, 1);
});

test('the result route authenticates, validates and bounds reports', async (context) => {
  const route = await TurnResultRoute.open();
  context.after(() => route.close());
  const { endpoint, token } = route.connection;

  const post = (body: unknown, authorization = `Bearer ${token}`, url = endpoint) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
    });

  assert.equal(
    (await post({ kind: 'name', toolUseId: 't', title: 'x' }, 'Bearer nope')).status,
    403,
  );
  assert.equal((await post({ kind: 'name', toolUseId: 't', title: 'x' }, '')).status, 403);
  assert.equal(
    (await post({ kind: 'name', toolUseId: 't', title: 'x' }, undefined, endpoint + 'x')).status,
    403,
  );
  assert.equal((await post({ kind: 'name', title: 'x' })).status, 400);
  assert.equal((await post({ kind: 'name', toolUseId: 't', title: '' })).status, 400);
  assert.equal((await post({ kind: 'other', toolUseId: 't' })).status, 400);
  assert.equal(
    (await post({ kind: 'choices', toolUseId: 't', options: 'x'.repeat(70 * 1024) })).status,
    400,
  );
  assert.equal(route.take('t'), undefined);

  assert.equal((await post({ kind: 'name', toolUseId: 't', title: 'Fine' })).status, 200);
  assert.deepEqual(route.take('t'), { kind: 'name', title: 'Fine' });
});
