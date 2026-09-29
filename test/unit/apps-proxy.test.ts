import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import {
  checkBrowserRequest,
  filterHandshakeResponse,
  phoneResponseHeaders,
  rewriteRefresh,
  sessionCookieName,
  upstreamRequestHeaders,
  withoutDomainAttribute,
} from '../../src/apps/headers.ts';
import { checkAppOrigins } from '../../src/apps/origins.ts';
import { AppProxy } from '../../src/apps/proxy.ts';
import { AppRegistry } from '../../src/apps/registry.ts';

/**
 * The phone app proxy against synthetic loopback backends, a temporary
 * registry and an in-memory paired-device set. Requests set Host explicitly,
 * so synthetic `*.localhost` origins need no name resolution. Nothing here
 * touches the real gateway, device store, Tailscale or a real browser.
 */

// ---- Pure policy ---------------------------------------------------------------

test('app origins need host names distinct from each other and from the gateway', () => {
  const gateway = ['https://desk.example.ts.net', 'http://127.0.0.1:8787', 'http://localhost:8787'];

  const valid = checkAppOrigins(
    [
      ['budget', 'https://budget.example.ts.net'],
      ['notes', 'http://notes.localhost:8790'],
    ],
    gateway,
  );
  assert.equal(valid.size, 2);

  // The gateway's host name is refused on every port.
  assert.throws(
    () => checkAppOrigins([['single', 'https://desk.example.ts.net:8444']], gateway),
    /gateway's host name/,
  );
  assert.throws(
    () => checkAppOrigins([['local', 'http://localhost:8790']], gateway),
    /gateway's host name/,
  );

  assert.throws(
    () =>
      checkAppOrigins([
        ['a', 'https://desk.example.ts.net:8444'],
        ['b', 'https://desk.example.ts.net:8445'],
      ]),
    /share the host name/,
  );
  assert.throws(() => checkAppOrigins([['a', 'https://desk.example.ts.net']], gateway), /gateway/);
  assert.throws(() => checkAppOrigins([['a', 'http://127.0.0.1:8790']], gateway), /gateway/);
  assert.throws(() => checkAppOrigins([['a', 'http://budget.example.com']]), /https/);
  assert.throws(() => checkAppOrigins([['a', 'https://budget.example.com/app']]), /exactly/);
  assert.throws(() => checkAppOrigins([['a', 'ftp://budget.example.com']]), /https/);
  assert.throws(() => checkAppOrigins([['Bad', 'https://x.example.com']]), /App ID/);
  assert.throws(
    () =>
      checkAppOrigins([
        ['a', 'https://x.example.com'],
        ['a', 'https://y.example.com'],
      ]),
    /more than one/,
  );
});

test('upstream request headers drop Companion cookies, hop-by-hop and forwarding claims', () => {
  const headers: IncomingHttpHeaders = {
    host: 'budget.localhost:8790',
    origin: 'http://budget.localhost:8790',
    cookie: `app_session=abc; ${sessionCookieName}=secret; ${sessionCookieName}x=also; theme=dark`,
    authorization: 'Bearer app-own-token',
    connection: 'keep-alive, x-private-hop',
    'x-private-hop': 'drop me',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    'proxy-authorization': 'Basic Zm9v',
    forwarded: 'for=1.2.3.4',
    'x-forwarded-for': '1.2.3.4',
    'x-forwarded-host': 'evil.example',
    'x-real-ip': '1.2.3.4',
    expect: '100-continue',
    'content-type': 'text/csv',
  };

  assert.deepEqual(upstreamRequestHeaders(headers), {
    host: 'budget.localhost:8790',
    origin: 'http://budget.localhost:8790',
    cookie: 'app_session=abc; theme=dark',
    authorization: 'Bearer app-own-token',
    'content-type': 'text/csv',
  });

  const onlyOurs = upstreamRequestHeaders({ cookie: `${sessionCookieName}=secret` });
  assert.equal(onlyOurs.cookie, undefined);

  const upgrade = upstreamRequestHeaders(
    { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'k' },
    true,
  );
  assert.deepEqual(upgrade, {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': 'k',
  });
});

test('responses cannot set Companion cookies and loopback redirects become public', () => {
  const upstream = 'http://127.0.0.1:8123';
  const origin = 'https://budget.example.ts.net';

  const headers = phoneResponseHeaders(
    [
      'Set-Cookie',
      'app_session=1; HttpOnly',
      'Set-Cookie',
      `${sessionCookieName}=forged; Path=/; Secure`,
      'Location',
      'http://127.0.0.1:8123/done?x=1#y',
      'Connection',
      'close, X-Hop',
      'X-Hop',
      'drop',
      'Transfer-Encoding',
      'chunked',
      'Content-Type',
      'text/html',
    ],
    upstream,
    origin,
  );

  assert.deepEqual(headers, [
    'Set-Cookie',
    'app_session=1; HttpOnly',
    'Location',
    'https://budget.example.ts.net/done?x=1#y',
    'Content-Type',
    'text/html',
  ]);

  const elsewhere = phoneResponseHeaders(
    ['Location', 'https://bank.example/login'],
    upstream,
    origin,
  );
  assert.deepEqual(elsewhere, ['Location', 'https://bank.example/login']);
});

test('app cookies become host-only and Refresh targets are rewritten like Location', () => {
  const upstream = 'http://127.0.0.1:8123';
  const origin = 'https://budget.example.ts.net';

  assert.equal(
    withoutDomainAttribute('sid=1; Path=/; Domain=example.ts.net; HttpOnly; domain = .ts.net'),
    'sid=1; Path=/; HttpOnly',
  );
  assert.deepEqual(
    phoneResponseHeaders(
      [
        'Set-Cookie',
        'sid=1; Domain=example.ts.net; Secure',
        'Refresh',
        '3; url=http://127.0.0.1:8123/next',
      ],
      upstream,
      origin,
    ),
    ['Set-Cookie', 'sid=1; Secure', 'Refresh', '3; url=https://budget.example.ts.net/next'],
  );
  assert.equal(rewriteRefresh('0', upstream, origin), '0');
  assert.equal(
    rewriteRefresh("0; URL='http://127.0.0.1:8123/a'", upstream, origin),
    "0; URL='https://budget.example.ts.net/a'",
  );
  assert.equal(
    rewriteRefresh('0; url=https://elsewhere.example/', upstream, origin),
    '0; url=https://elsewhere.example/',
  );
});

test('WebSocket handshake responses get the same header policy and must be well formed', () => {
  const upstream = 'http://127.0.0.1:8123';
  const origin = 'https://budget.example.ts.net';

  const accepted = filterHandshakeResponse(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: abc=',
      `Set-Cookie: ${sessionCookieName}=forged; Path=/; Secure`,
      'Set-Cookie: ws=1; Domain=ts.net',
    ].join('\r\n'),
    upstream,
    origin,
  );
  assert.equal(
    accepted,
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: abc=',
      'Set-Cookie: ws=1',
      '',
      '',
    ].join('\r\n'),
  );

  const refused = filterHandshakeResponse(
    'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8123/login',
    upstream,
    origin,
  );
  assert.equal(
    refused,
    'HTTP/1.1 302 Found\r\nLocation: https://budget.example.ts.net/login\r\n\r\n',
  );

  for (const malformed of [
    'HTTP/2 101',
    'HTTP/1.1 101 OK\r\n folded: continuation',
    'HTTP/1.1 101 OK\r\nno-colon',
    'HTTP/1.1 101 OK\r\nbad name: x',
    'HTTP/1.1 101 OK\r\nX: a\nInjected: b',
  ]) {
    assert.equal(filterHandshakeResponse(malformed, upstream, origin), undefined, malformed);
  }
});

test('fetch metadata and Origin decide whether a browser request may use the session', () => {
  const origin = 'https://budget.example.ts.net';

  const allowed = [
    { headers: { 'sec-fetch-site': 'same-origin' }, method: 'GET' },
    { headers: { 'sec-fetch-site': 'none' }, method: 'GET' },
    { headers: {}, method: 'GET' },
    { headers: { 'sec-fetch-site': 'same-origin', origin }, method: 'POST' },
    { headers: { origin }, method: 'DELETE' },
  ];
  for (const { headers, method } of allowed) {
    assert.equal(checkBrowserRequest(headers, method, origin, false).allowed, true);
  }

  const refused = [
    { headers: { 'sec-fetch-site': 'cross-site' }, method: 'GET', webSocket: false },
    { headers: { 'sec-fetch-site': 'same-site' }, method: 'GET', webSocket: false },
    { headers: {}, method: 'POST', webSocket: false },
    { headers: { origin: 'null' }, method: 'POST', webSocket: false },
    { headers: { origin: 'https://notes.example.ts.net' }, method: 'PUT', webSocket: false },
    { headers: { origin: origin + ':443' }, method: 'POST', webSocket: false },
    { headers: {}, method: 'GET', webSocket: true },
    { headers: { origin: 'https://evil.example' }, method: 'GET', webSocket: true },
  ];
  for (const { headers, method, webSocket } of refused) {
    assert.equal(checkBrowserRequest(headers, method, origin, webSocket).allowed, false);
  }
});

// ---- Proxy against synthetic backends ------------------------------------------

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bodyBytes: number;
}

/** A synthetic backend recording what reaches it. */
async function syntheticBackend() {
  const requests: Recorded[] = [];
  const sockets = { connections: 0 };
  const events = new WebSocketServer({ noServer: true });

  const server = createHttpServer(async (request, response) => {
    let bodyBytes = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      bodyBytes += chunk.length;
    }
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      bodyBytes,
    });

    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `http://127.0.0.1:${port}/landing` });
      response.end();
      return;
    }
    if (request.url === '/forge-cookie') {
      response.writeHead(200, {
        'Set-Cookie': [`${sessionCookieName}=forged; Path=/; Secure`, 'app=1; Path=/'],
      });
      response.end('ok');
      return;
    }
    if (request.url === '/drop') {
      // Accept the body, then fail without answering.
      request.socket.destroy();
      return;
    }
    if (request.url === '/stream') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      const timer = setInterval(() => response.write('tick\n'), 20);
      response.once('close', () => clearInterval(timer));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, bodyBytes }));
  });

  // Extra handshake headers for /ws-cookie, to check the proxy filters them.
  events.on('headers', (headers, request) => {
    if (request.url === '/ws-cookie') {
      headers.push(`Set-Cookie: ${sessionCookieName}=forged; Path=/; Secure`);
      headers.push('Set-Cookie: ws=1; Domain=localhost; Path=/');
    }
  });

  server.on('upgrade', (request, socket, head) => {
    sockets.connections += 1;
    if (request.url === '/ws-refuse') {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          `Set-Cookie: ${sessionCookieName}=forged; Path=/; Secure\r\n` +
          `Location: http://127.0.0.1:${port}/login\r\n` +
          'Content-Length: 0\r\n\r\n',
      );
      return;
    }
    events.handleUpgrade(request, socket, head, (client) => {
      client.send(JSON.stringify({ hello: request.headers.cookie ?? '' }));
      client.on('message', (data) => client.send(String(data)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    requests,
    sockets,
    async close() {
      for (const client of events.clients) {
        client.terminate();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One HTTP request to the proxy with explicit headers (including Host). */
function send(
  port: number,
  options: {
    host: string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { host: options.host, ...options.headers },
        agent: false,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

/** Write raw bytes and return the first response line. */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(received.split('\r\n')[0]));
    socket.on('error', reject);
    socket.write(text);
    setTimeout(() => socket.end(), 300);
  });
}

/**
 * Public app origins use this fixed synthetic port, while the proxy itself
 * binds port 0. Requests go to the real socket with these Host headers, so no
 * port is reserved and released in advance (which another test could grab in
 * between). The number is never bound by these tests.
 */
const publicPort = 8790;

async function proxyFixture(
  context: { after(callback: () => Promise<unknown>): void },
  options: {
    maximumRequestBodyBytes?: number;
    grantLifetimeMilliseconds?: number;
    /** Bind port; only the forced-failure regression overrides the default 0. */
    bindPort?: number;
  } = {},
) {
  // Each resource registers its cleanup as soon as it exists, before anything
  // that can throw, so a failed setup never leaves listeners or files behind.
  const directory = await mkdtemp(join(tmpdir(), 'companion-apps-proxy-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const budgetBackend = await syntheticBackend();
  context.after(() => budgetBackend.close());
  const notesBackend = await syntheticBackend();
  context.after(() => notesBackend.close());

  const registry = new AppRegistry(join(directory, 'apps'));
  await registry.add({
    id: 'budget',
    name: 'Budget',
    upstream: `http://127.0.0.1:${budgetBackend.port}`,
  });
  await registry.update('budget', { phoneAccess: true });
  await registry.add({
    id: 'notes',
    name: 'Notes',
    upstream: `http://127.0.0.1:${notesBackend.port}`,
  });
  await registry.update('notes', { phoneAccess: true });
  await registry.add({ id: 'private', name: 'Private', upstream: 'http://127.0.0.1:9' });

  const paired = new Set(['phone-1', 'phone-2']);
  const deviceToken = 'D'.repeat(43);
  const budgetOrigin = `http://budget.localhost:${publicPort}`;
  const notesOrigin = `http://notes.localhost:${publicPort}`;

  const proxy = new AppProxy({
    host: '127.0.0.1',
    port: options.bindPort ?? 0,
    appOrigins: [
      ['budget', budgetOrigin],
      ['notes', notesOrigin],
      ['private', `http://private.localhost:${publicPort}`],
    ],
    gatewayOrigins: ['http://127.0.0.1:8787'],
    sources: {
      apps: () => registry.list(),
      pairedDeviceIds: async () => new Set(paired),
      isDeviceCredential: async (value) => value === deviceToken,
    },
    log: () => {},
    // Sweeps are triggered explicitly in these tests.
    sweepMilliseconds: 60_000,
    maximumRequestBodyBytes: options.maximumRequestBodyBytes,
    grantLifetimeMilliseconds: options.grantLifetimeMilliseconds,
  });
  // close() is safe before, after or without a successful start.
  context.after(() => proxy.close());
  await proxy.start();

  /** The real listening port; requests carry the synthetic public Host. */
  const port = proxy.port;

  const budgetHost = `budget.localhost:${publicPort}`;
  const notesHost = `notes.localhost:${publicPort}`;

  /** Open an app as a paired phone would; returns its session cookie header. */
  async function openApp(deviceId = 'phone-1', appId = 'budget'): Promise<string> {
    const { url } = await proxy.openForDevice(deviceId, appId);
    const parsed = new URL(url);
    const reply = await send(port, { host: parsed.host, path: parsed.pathname + parsed.search });
    assert.equal(reply.status, 200);

    const cookie = String(reply.headers['set-cookie']?.[0] ?? '');
    return cookie.split(';')[0];
  }

  return {
    port,
    proxy,
    registry,
    paired,
    budgetBackend,
    notesBackend,
    budgetOrigin,
    notesOrigin,
    budgetHost,
    notesHost,
    deviceToken,
    openApp,
  };
}

/** Listening servers in this process, after pending closes have settled. */
async function settledServerCount(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap').length;
}

async function fixtureDirectories(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith('companion-apps-proxy-')).sort();
}

test('a fixture whose proxy cannot start releases everything it acquired', async (context) => {
  // Hold a port so the fixture's proxy deterministically fails to bind it.
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const blockedPort = (blocker.address() as { port: number }).port;

  const serversBefore = await settledServerCount();
  const directoriesBefore = await fixtureDirectories();

  await context.test('setup on an occupied port', async (setup) => {
    await assert.rejects(proxyFixture(setup, { bindPort: blockedPort }), /EADDRINUSE/);
  });

  // The subtest's cleanup hooks have run: both synthetic backends are closed
  // and the temporary directory is gone, so nothing keeps this file alive.
  assert.equal(await settledServerCount(), serversBefore);
  assert.deepEqual(await fixtureDirectories(), directoriesBefore);
});

test('grants are single-use, app-bound, short-lived and become an HttpOnly Strict cookie', async (context) => {
  const fixture = await proxyFixture(context, { grantLifetimeMilliseconds: 300 });

  const { url } = await fixture.proxy.openForDevice('phone-1', 'budget');
  assert.match(url, new RegExp(`^${fixture.budgetOrigin}/__companion_app_grant\\?grant=`));
  const path = new URL(url).pathname + new URL(url).search;

  const redeemed = await send(fixture.port, { host: fixture.budgetHost, path });
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.body, /location\.replace\('\/'\)/);
  assert.match(String(redeemed.headers['content-security-policy']), /script-src 'sha256-/);
  assert.equal(redeemed.headers['referrer-policy'], 'no-referrer');
  assert.equal(redeemed.headers['cache-control'], 'no-store');
  const cookie = String(redeemed.headers['set-cookie']?.[0]);
  assert.match(cookie, new RegExp(`^${sessionCookieName}=[A-Za-z0-9_-]{43}; `));
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=']) {
    assert.ok(cookie.includes(attribute), attribute);
  }
  assert.equal(cookie.includes('Domain'), false);

  // Replay of the same grant fails.
  const replay = await send(fixture.port, { host: fixture.budgetHost, path });
  assert.equal(replay.status, 401);

  // A grant for one app cannot be redeemed on another app's origin, and is consumed.
  const other = await fixture.proxy.openForDevice('phone-1', 'budget');
  const otherPath = new URL(other.url).pathname + new URL(other.url).search;
  assert.equal(
    (await send(fixture.port, { host: fixture.notesHost, path: otherPath })).status,
    401,
  );
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, path: otherPath })).status,
    401,
  );

  // Expired grants fail.
  const late = await fixture.proxy.openForDevice('phone-1', 'budget');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const latePath = new URL(late.url).pathname + new URL(late.url).search;
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, path: latePath })).status,
    401,
  );

  // POST to the grant path is refused; nothing reaches either backend.
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, path, method: 'POST' })).status,
    405,
  );
  assert.equal(fixture.budgetBackend.requests.length, 0);
  assert.equal(fixture.notesBackend.requests.length, 0);
});

test('grants are refused for unpaired devices, disabled apps and unconfigured apps', async (context) => {
  const fixture = await proxyFixture(context);

  await assert.rejects(fixture.proxy.openForDevice('stranger', 'budget'), /no longer paired/);
  await assert.rejects(fixture.proxy.openForDevice('phone-1', 'private'), /not available/);
  await assert.rejects(fixture.proxy.openForDevice('phone-1', 'missing'), /not available/);

  const listed = await fixture.proxy.phoneApps();
  assert.deepEqual(
    listed.map((app) => [app.id, app.running]),
    [
      ['budget', true],
      ['notes', true],
    ],
  );
});

test('requests without a valid session, from foreign hosts or with forged targets never reach a backend', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  const unknownHost = await send(fixture.port, { host: 'evil.localhost:1', headers: { cookie } });
  assert.equal(unknownHost.status, 421);

  const rebinding = await send(fixture.port, { host: `127.0.0.1:${fixture.port}` });
  assert.equal(rebinding.status, 421);

  const noCookie = await send(fixture.port, { host: fixture.budgetHost });
  assert.equal(noCookie.status, 401);

  const forged = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie: `${sessionCookieName}=${'A'.repeat(43)}` },
  });
  assert.equal(forged.status, 401);

  // A budget session is not a notes session, even on the same proxy.
  const crossApp = await send(fixture.port, { host: fixture.notesHost, headers: { cookie } });
  assert.equal(crossApp.status, 401);

  const crossSite = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  const siblingApp = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(siblingApp.status, 403);

  const postWithoutOrigin = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    headers: { cookie },
    body: 'x',
  });
  assert.equal(postWithoutOrigin.status, 403);

  const postFromSibling = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    headers: { cookie, origin: fixture.notesOrigin },
    body: 'x',
  });
  assert.equal(postFromSibling.status, 403);

  const absoluteForm = await rawRequest(
    fixture.port,
    `GET http://127.0.0.1:22/ HTTP/1.1\r\nHost: ${fixture.budgetHost}\r\nCookie: ${cookie}\r\n\r\n`,
  );
  assert.match(absoluteForm, /^HTTP\/1\.1 400/);

  const tunnel = await rawRequest(
    fixture.port,
    `CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: ${fixture.budgetHost}\r\n\r\n`,
  );
  assert.match(tunnel, /^HTTP\/1\.1 405/);

  assert.equal(fixture.budgetBackend.requests.length, 0);
  assert.equal(fixture.notesBackend.requests.length, 0);
});

test('authorized requests keep the app origin, root paths and app credentials', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  const reply = await send(fixture.port, {
    host: fixture.budgetHost,
    path: '//double/slash/../x?q=1&next=http://127.0.0.1:22/',
    headers: {
      cookie: `${cookie}; app_session=mine`,
      authorization: 'Basic YXBwOnNlY3JldA==',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      forwarded: 'host=evil.example',
    },
  });
  assert.equal(reply.status, 200);

  const [received] = fixture.budgetBackend.requests;
  assert.equal(received.url, '//double/slash/../x?q=1&next=http://127.0.0.1:22/');
  assert.equal(received.headers.host, fixture.budgetHost);
  assert.equal(received.headers.cookie, 'app_session=mine');
  assert.equal(received.headers.authorization, 'Basic YXBwOnNlY3JldA==');
  assert.equal(received.headers['x-forwarded-for'], undefined);
  assert.equal(received.headers['x-forwarded-host'], undefined);
  assert.equal(received.headers.forwarded, undefined);

  const post = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    path: '/api/items',
    headers: { cookie, origin: fixture.budgetOrigin, 'sec-fetch-site': 'same-origin' },
    body: 'name=x',
  });
  assert.equal(post.status, 200);
  assert.equal(fixture.budgetBackend.requests[1].headers.origin, fixture.budgetOrigin);
  assert.equal(fixture.budgetBackend.requests[1].bodyBytes, 6);
});

test('redirects are returned, not followed, and apps cannot plant the session cookie', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  const redirect = await send(fixture.port, {
    host: fixture.budgetHost,
    path: '/redirect',
    headers: { cookie },
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `${fixture.budgetOrigin}/landing`);
  assert.equal(fixture.budgetBackend.requests.length, 1);

  const forged = await send(fixture.port, {
    host: fixture.budgetHost,
    path: '/forge-cookie',
    headers: { cookie },
  });
  assert.deepEqual(forged.headers['set-cookie'], ['app=1; Path=/']);
});

test('backend failures are reported without retrying, and uncertain POSTs say so', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  const dropped = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    path: '/drop',
    headers: { cookie, origin: fixture.budgetOrigin },
    body: 'amount=100',
  });
  assert.equal(dropped.status, 502);
  assert.match(dropped.body, /may or may not have been/);
  // Exactly one delivery: the proxy never replays a request.
  assert.equal(fixture.budgetBackend.requests.filter((r) => r.url === '/drop').length, 1);

  await fixture.budgetBackend.close();
  const stopped = await send(fixture.port, { host: fixture.budgetHost, headers: { cookie } });
  assert.equal(stopped.status, 502);
  assert.match(stopped.body, /not running/);
});

test('large uploads stream through, and oversized bodies are refused', async (context) => {
  const fixture = await proxyFixture(context, { maximumRequestBodyBytes: 8 * 1024 * 1024 });
  const cookie = await fixture.openApp();

  const rows = ['date,amount,description'];
  let length = 0;
  while (length < 5 * 1024 * 1024) {
    const row = `2026-09-${String((rows.length % 28) + 1).padStart(2, '0')},${rows.length},synthetic`;
    rows.push(row);
    length += row.length + 1;
  }
  const csv = Buffer.from(rows.join('\n') + '\n');

  const upload = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    path: '/api/datasets',
    headers: { cookie, origin: fixture.budgetOrigin, 'content-type': 'text/csv' },
    body: csv,
  });
  assert.equal(upload.status, 200);
  assert.equal(JSON.parse(upload.body).bodyBytes, csv.length);

  const tooLarge = await send(fixture.port, {
    host: fixture.budgetHost,
    method: 'POST',
    path: '/api/datasets',
    headers: { cookie, origin: fixture.budgetOrigin, 'content-type': 'text/csv' },
    body: Buffer.alloc(9 * 1024 * 1024, 0x61),
  }).catch(() => ({ status: 413 }) as Reply);
  assert.equal(tooLarge.status, 413);
  assert.equal(fixture.budgetBackend.requests.length, 1);
});

/** Open a WebSocket through the proxy; resolves with the socket once open. */
function openSocket(
  fixture: Awaited<ReturnType<typeof proxyFixture>>,
  headers: Record<string, string>,
  path = '/events',
): Promise<{ socket: WebSocket; first: Promise<string>; upgradeHeaders: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${fixture.port}${path}`, {
      headers: { host: fixture.budgetHost, ...headers },
    });
    let upgradeHeaders: IncomingHttpHeaders = {};
    socket.once('upgrade', (response) => {
      upgradeHeaders = response.headers;
    });
    const first = new Promise<string>((resolveFirst) =>
      socket.once('message', (data) => resolveFirst(String(data))),
    );
    socket.once('open', () => resolve({ socket, first, upgradeHeaders }));
    socket.once('unexpected-response', (_request, response) => {
      const error = Error(`HTTP ${response.statusCode}`) as Error & {
        headers?: IncomingHttpHeaders;
      };
      error.headers = response.headers;
      reject(error);
    });
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
  });
}

test('WebSockets need the exact Origin and a session, and never see the session cookie', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  await assert.rejects(openSocket(fixture, { cookie }), /HTTP 403/);
  await assert.rejects(
    openSocket(fixture, { cookie, origin: 'http://evil.localhost:1' }),
    /HTTP 403/,
  );
  await assert.rejects(openSocket(fixture, { cookie, origin: fixture.notesOrigin }), /HTTP 403/);
  await assert.rejects(openSocket(fixture, { origin: fixture.budgetOrigin }), /HTTP 401/);
  assert.equal(fixture.budgetBackend.sockets.connections, 0);

  const { socket, first } = await openSocket(fixture, {
    cookie: `${cookie}; app_session=mine`,
    origin: fixture.budgetOrigin,
  });
  assert.deepEqual(JSON.parse(await first), { hello: 'app_session=mine' });

  const echoed = new Promise<string>((resolve) =>
    socket.once('message', (data) => resolve(String(data))),
  );
  socket.send('ping through proxy');
  assert.equal(await echoed, 'ping through proxy');
  socket.close();
});

test('WebSocket handshake responses from the backend are filtered too', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  const { socket, upgradeHeaders } = await openSocket(
    fixture,
    { cookie, origin: fixture.budgetOrigin },
    '/ws-cookie',
  );
  assert.deepEqual(upgradeHeaders['set-cookie'], ['ws=1; Path=/']);
  socket.close();

  const refused = await openSocket(fixture, { cookie, origin: fixture.budgetOrigin }, '/ws-refuse')
    .then(() => undefined)
    .catch((error: Error & { headers?: IncomingHttpHeaders }) => error);
  assert.ok(refused);
  assert.match(refused.message, /HTTP 403/);
  assert.equal(refused.headers?.['set-cookie'], undefined);
  assert.equal(refused.headers?.location, `${fixture.budgetOrigin}/login`);
});

test('a Companion device credential is never forwarded to an app backend', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();

  for (const authorization of [
    `Bearer ${fixture.deviceToken}`,
    fixture.deviceToken,
    `Basic  ${fixture.deviceToken} `,
  ]) {
    const reply = await send(fixture.port, {
      host: fixture.budgetHost,
      headers: { cookie, authorization },
    });
    assert.equal(reply.status, 400, authorization);
  }

  await assert.rejects(
    openSocket(fixture, {
      cookie,
      origin: fixture.budgetOrigin,
      authorization: `Bearer ${fixture.deviceToken}`,
    }),
    /HTTP 400/,
  );

  assert.equal(fixture.budgetBackend.requests.length, 0);
  assert.equal(fixture.budgetBackend.sockets.connections, 0);

  // An app's own Authorization still passes.
  const own = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie, authorization: 'Bearer app-issued-token' },
  });
  assert.equal(own.status, 200);
});

test('revoking the device ends HTTP and WebSocket authority, including open streams', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp('phone-1');
  const otherCookie = await fixture.openApp('phone-2');

  const { socket } = await openSocket(fixture, { cookie, origin: fixture.budgetOrigin });

  const stream = new Promise<'ended'>((resolve) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: fixture.port,
        path: '/stream',
        headers: { host: fixture.budgetHost, cookie },
        agent: false,
      },
      (response) => {
        response.on('data', () => {});
        response.on('close', () => resolve('ended'));
        response.on('error', () => resolve('ended'));
      },
    );
    request.on('error', () => resolve('ended'));
    request.end();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  fixture.paired.delete('phone-1');
  await fixture.proxy.sweep();

  await closed(socket);
  assert.equal(await stream, 'ended');
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, headers: { cookie } })).status,
    401,
  );

  // The other phone's session is unaffected.
  const other = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie: otherCookie },
  });
  assert.equal(other.status, 200);
});

test('turning phone access off, or changing the registration, ends existing sessions', async (context) => {
  const fixture = await proxyFixture(context);
  const cookie = await fixture.openApp();
  const { socket } = await openSocket(fixture, { cookie, origin: fixture.budgetOrigin });

  await fixture.registry.update('budget', { phoneAccess: false });
  await fixture.proxy.sweep();
  await closed(socket);
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, headers: { cookie } })).status,
    401,
  );

  // Turning it back on creates a new revision; the old session stays dead.
  await fixture.registry.update('budget', { phoneAccess: true });
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, headers: { cookie } })).status,
    401,
  );

  const fresh = await fixture.openApp();
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, headers: { cookie: fresh } })).status,
    200,
  );

  // Any registration change (here: the name) also invalidates it, checked per request.
  await fixture.registry.update('budget', { name: 'Budget 2' });
  assert.equal(
    (await send(fixture.port, { host: fixture.budgetHost, headers: { cookie: fresh } })).status,
    401,
  );
  assert.equal(fixture.proxy.sessionCount, 0);
});

test('removing and re-adding an app id never carries sessions or grants over', async (context) => {
  const fixture = await proxyFixture(context);
  const session = await fixture.openApp();
  const pending = await fixture.proxy.openForDevice('phone-1', 'budget');
  const before = (await fixture.registry.get('budget'))!;

  // Re-register the same id with the same revision number but another backend.
  await fixture.registry.remove('budget');
  await fixture.registry.add({
    id: 'budget',
    name: 'Replacement',
    upstream: `http://127.0.0.1:${fixture.notesBackend.port}`,
  });
  const after = await fixture.registry.update('budget', { phoneAccess: true });
  assert.equal(after.revision, before.revision);
  assert.notEqual(after.registrationId, before.registrationId);

  // Checked per request, without waiting for a sweep to notice the gap.
  const reused = await send(fixture.port, {
    host: fixture.budgetHost,
    headers: { cookie: session },
  });
  assert.equal(reused.status, 401);

  const pendingPath = new URL(pending.url).pathname + new URL(pending.url).search;
  const redeemed = await send(fixture.port, { host: fixture.budgetHost, path: pendingPath });
  assert.equal(redeemed.status, 401);

  assert.equal(fixture.notesBackend.requests.length, 0);
  assert.equal(fixture.budgetBackend.requests.length, 0);
});

test('an unreadable registry ends every session instead of continuing', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-apps-proxy-broken-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const backend = await syntheticBackend();
  context.after(() => backend.close());

  const registry = new AppRegistry(directory);
  await registry.add({
    id: 'budget',
    name: 'Budget',
    upstream: `http://127.0.0.1:${backend.port}`,
  });
  await registry.update('budget', { phoneAccess: true });

  let broken = false;
  const proxy = new AppProxy({
    host: '127.0.0.1',
    port: 0,
    appOrigins: [['budget', `http://budget.localhost:${publicPort}`]],
    sources: {
      apps: async () => {
        if (broken) {
          throw Error('disk error');
        }
        return registry.list();
      },
      pairedDeviceIds: async () => new Set(['phone-1']),
    },
    log: () => {},
    sweepMilliseconds: 60_000,
  });
  context.after(() => proxy.close());
  await proxy.start();

  const { url } = await proxy.openForDevice('phone-1', 'budget');
  const parsed = new URL(url);
  await send(proxy.port, { host: parsed.host, path: parsed.pathname + parsed.search });
  assert.equal(proxy.sessionCount, 1);

  broken = true;
  await assert.rejects(proxy.sweep(), /unavailable/);
  assert.equal(proxy.sessionCount, 0);
});

test('the proxy refuses non-loopback binds', () => {
  const sources = { apps: async () => [], pairedDeviceIds: async () => new Set<string>() };
  for (const host of ['0.0.0.0', '100.64.0.1', '::', 'budget.localhost']) {
    assert.throws(
      () => new AppProxy({ host, port: 0, appOrigins: [], sources, log: () => {} }),
      /loopback/,
      host,
    );
  }
});

/**
 * A local peer that keeps its own side open (allowHalfOpen) after a refused
 * CONNECT or upgrade. Resolves once the refusal and the proxy's end arrived;
 * the peer socket itself stays open until the test destroys it.
 */
function heldRefusal(peers: Socket[], port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    peers.push(socket);
    let received = '';
    const deadline = setTimeout(() => {
      reject(Error('No refusal arrived: ' + JSON.stringify(received)));
    }, 3000);
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    socket.on('error', () => {});
    socket.on('end', () => {
      clearTimeout(deadline);
      resolve(received.split('\r\n')[0]);
    });
    socket.write(text);
  });
}

test('a peer holding a refused CONNECT or upgrade cannot keep the proxy open', async (context) => {
  const fixture = await proxyFixture(context);
  // Peers are released in finally, so a regression fails instead of hanging
  // the fixture's own proxy.close() cleanup.
  const peers: Socket[] = [];
  try {
    // Test-only view of the raw sockets the proxy still holds.
    const held = (fixture.proxy as unknown as { rawSockets: Set<unknown> }).rawSockets;

    assert.match(
      await heldRefusal(
        peers,
        fixture.port,
        `CONNECT example.com:443 HTTP/1.1\r\nHost: ${fixture.budgetHost}\r\n\r\n`,
      ),
      /^HTTP\/1\.1 405/,
    );
    assert.match(
      await heldRefusal(
        peers,
        fixture.port,
        'GET /socket HTTP/1.1\r\nHost: unknown.localhost:8790\r\nConnection: Upgrade\r\n' +
          'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      ),
      /^HTTP\/1\.1 421/,
    );

    // Both peers still hold their side open, yet the proxy released its
    // sockets instead of leaving them half-closed.
    for (let attempt = 0; attempt < 100 && held.size > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(held.size, 0, 'refused sockets are destroyed after the refusal');

    // And close() finishes promptly with those peers still connected.
    const bounded = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(Error('AppProxy.close() waited on a held socket')), 3000).unref();
    });
    await Promise.race([fixture.proxy.close(), bounded]);
  } finally {
    for (const peer of peers) {
      peer.destroy();
    }
  }
});
