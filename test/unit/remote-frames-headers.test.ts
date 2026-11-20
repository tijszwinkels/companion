/**
 * Frame-origin headers: one table of cases derived from the rules in
 * src/remote/README.md ("Rules: headers"), plus the requirement that a
 * gateway without frame options behaves exactly as before.
 *
 * Forwarded answers come from the real widget service, or from a fake one on
 * a private Unix socket for the answers the real service never gives (a
 * cookie, a redirect, a wrong content type, a stall).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { frameFixture } from '../frame-fixture.ts';
import { recordGateway } from '../gateway-baseline.ts';

type Fixture = Awaited<ReturnType<typeof frameFixture>>;
type Json = Record<string, any>;

/** The gateway's page policy before frames existed (also in the recording). */
const basePolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; " +
  "connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

const permissions =
  'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()';

/** The fixed headers of every frame-origin response, by rule. */
function expectedFrameHeaders(fixture: Fixture): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors ${fixture.origin}; webrtc 'block'`,
    'origin-agent-cluster': '?1',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'permissions-policy': permissions,
  };
}

/** Headers other than the transport's own (date, connection, keep-alive). */
function headersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    if (!['date', 'connection', 'keep-alive', 'content-length'].includes(name)) {
      result[name] = value;
    }
  }
  return result;
}

/** One conversation with the counter widget; returns its frame address. */
async function widgetFrame(fixture: Fixture): Promise<string> {
  const { run } = await fixture.conversation();
  const widgetId = await fixture.publishCounter(run);
  await fixture.applyNotes(run);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) =>
      session.messages.some((row: Json) => row.widget?.id === widgetId),
    ),
  );
  return snapshot.sessions[0].messages.find((row: Json) => row.widget).widget.frameUrl as string;
}

/** A fake widget service on a private socket whose answers a case decides. */
async function fakeUpstream() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-fake-widgets-'));
  const socketPath = join(directory, 'widgets.sock');
  const seen: IncomingMessage[] = [];
  let answer: (request: IncomingMessage, response: ServerResponse) => void = (_r, response) =>
    response.end();
  const server = createServer((request, response) => {
    seen.push(request);
    answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    seen,
    respond(handler: typeof answer) {
      answer = handler;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('headers rule: forwarded documents, JSON and refusals carry exactly the fixed set', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);
  const fixed = expectedFrameHeaders(fixture);

  const cases: Array<{ name: string; url: string; status: number; contentType: string }> = [
    { name: 'document', url: frameUrl, status: 200, contentType: 'text/html; charset=utf-8' },
    { name: 'state', url: frameUrl + 'state', status: 200, contentType: 'application/json' },
    {
      name: 'refusal',
      url: frameUrl + 'popout',
      status: 404,
      contentType: 'application/json; charset=utf-8',
    },
    {
      name: 'unknown host path',
      url: fixture.frameOrigin + '/',
      status: 404,
      contentType: 'application/json; charset=utf-8',
    },
  ];
  for (const entry of cases) {
    const response = await fixture.frameRequest(entry.url);
    assert.equal(response.status, entry.status, entry.name);
    assert.deepEqual(headersOf(response), { ...fixed, 'content-type': entry.contentType });
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    await response.arrayBuffer();
  }

  // The listener itself still sends X-Frame-Options: DENY on its own route;
  // the frame origin replaced it.
  const viewUrl = fixture.sessions.snapshot()[0].messages.find((row) => row.widget)!.widget!
    .viewUrl!;
  const direct = await fetch(viewUrl);
  assert.equal(direct.headers.get('x-frame-options'), 'DENY');
  await direct.arrayBuffer();
});

test('headers rule: the gateway page policy gains exactly frame-src with a frame origin', async (context) => {
  const withFrames = await frameFixture();
  context.after(() => withFrames.close());
  const withoutFrames = await frameFixture({ frames: false });
  context.after(() => withoutFrames.close());

  for (const path of ['/', '/missing.js', '/api/unknown']) {
    const framed = await fetch(withFrames.origin + path);
    assert.equal(
      framed.headers.get('content-security-policy'),
      `${basePolicy}; frame-src ${withFrames.frameOrigin}`,
    );
    await framed.arrayBuffer();

    const plain = await fetch(withoutFrames.origin + path);
    assert.equal(plain.headers.get('content-security-policy'), basePolicy);
    await plain.arrayBuffer();
  }
});

test('without frame options the gateway and relay output equal the base revision', async () => {
  const recorded = JSON.parse(
    await readFile(new URL('../fixtures/gateway-base-output.json', import.meta.url), 'utf8'),
  ) as Json;
  const current = await recordGateway();
  assert.deepEqual(current.http, recorded.http);
  assert.deepEqual(current.relay, recorded.relay);
  // The recording really contains the views whose addresses are removed.
  assert.equal(recorded.relay.snapshot.application.name, 'notes');
  assert.ok(!JSON.stringify(recorded).includes('frameUrl'));
  assert.ok(!JSON.stringify(recorded).includes('/view/'));
});

test('without frame options no second listener runs and no frame address is sent', async (context) => {
  const fixture = await frameFixture({ frames: false });
  context.after(() => fixture.close());
  assert.equal(fixture.gateway.frames, undefined);
  await assert.rejects(fetch(`${fixture.frameOrigin}/`));
});

interface UpstreamCase {
  name: string;
  operation: '' | 'state' | 'action';
  answer(request: IncomingMessage, response: ServerResponse): void;
  status: number;
  /** Extra expectations on the forwarded answer. */
  check?(response: Response, fixture: Fixture): Promise<void> | void;
}

const json = (response: ServerResponse, status: number, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end('{"ok":true}');
};

const upstreamCases: UpstreamCase[] = [
  {
    name: 'a cookie, X-Frame-Options and unknown headers are dropped; CSP is kept',
    operation: '',
    answer(_request, response) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'session=synthetic; HttpOnly',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'",
        'Access-Control-Allow-Origin': '*',
        'X-Upstream-Secret': 'synthetic',
        'Cache-Control': 'public, max-age=3600',
        'Referrer-Policy': 'unsafe-url',
      });
      response.end('<!doctype html><p>synthetic');
    },
    status: 200,
    check(response, fixture) {
      const headers = headersOf(response);
      assert.equal(headers['set-cookie'], undefined);
      assert.equal(headers['x-frame-options'], undefined);
      assert.equal(headers['access-control-allow-origin'], undefined);
      assert.equal(headers['x-upstream-secret'], undefined);
      assert.equal(headers['cache-control'], 'no-store');
      assert.equal(headers['referrer-policy'], 'no-referrer');
      // Both policies apply: ours, then the document's own, unchanged.
      assert.equal(
        headers['content-security-policy'],
        `frame-ancestors ${fixture.origin}; webrtc 'block', default-src 'none'`,
      );
    },
  },
  {
    name: 'a redirect is neither followed nor passed on',
    operation: 'state',
    answer(_request, response) {
      response.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere', 'Set-Cookie': 'a=b' });
      response.end();
    },
    status: 502,
    check(response) {
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    },
  },
  {
    name: 'a 301 on the document is neither followed nor passed on',
    operation: '',
    answer(_request, response) {
      response.writeHead(301, { Location: '/view/other' });
      response.end();
    },
    status: 502,
  },
  {
    name: 'a document that is not HTML',
    operation: '',
    answer: (_request, response) => json(response, 200),
    status: 502,
  },
  {
    name: 'state that is HTML',
    operation: 'state',
    answer(_request, response) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<p>');
    },
    status: 502,
  },
  {
    name: 'state without a content type',
    operation: 'state',
    answer(_request, response) {
      response.writeHead(200);
      response.end('{}');
    },
    status: 502,
  },
  {
    name: 'an upstream error passes through with its JSON body',
    operation: 'action',
    answer: (_request, response) => json(response, 409),
    status: 409,
  },
  {
    name: 'an answer over 1 MiB',
    operation: 'state',
    answer(_request, response) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('"' + 'x'.repeat(1024 * 1024 + 10) + '"');
    },
    status: 502,
  },
];

test('headers rule: unexpected upstream answers', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);

  for (const entry of upstreamCases) {
    await context.test(entry.name, async () => {
      upstream.respond(entry.answer);
      const before = upstream.seen.length;
      const response = await fixture.frameRequest(
        frameUrl + entry.operation,
        entry.operation === 'action'
          ? { body: { action: 'increment', args: {}, requestId: 'x' } }
          : {},
      );
      assert.equal(response.status, entry.status);
      await entry.check?.(response, fixture);
      await response.arrayBuffer();
      // Exactly one upstream request: nothing was followed.
      assert.equal(upstream.seen.length, before + 1);
    });
  }
});

test('only a fixed Host and the JSON body headers reach the listener', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);
  upstream.respond((_request, response) => json(response, 200));

  const response = await fixture.frameRequest(frameUrl + 'action', {
    body: { action: 'increment', args: {}, requestId: 'headers' },
    headers: {
      Cookie: 'session=synthetic',
      'X-Forwarded-For': '203.0.113.7',
      'User-Agent': 'synthetic',
      'Tailscale-User-Login': 'user@example.com',
    },
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const request = upstream.seen.at(-1)!;
  const capability = fixture.sessions
    .snapshot()[0]
    .messages.find((row) => row.widget)!
    .widget!.viewUrl!.slice(-64);
  assert.equal(request.url, `/view/${capability}/action`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.host, 'companion-widgets.invalid');
  assert.deepEqual(Object.keys(request.headers).sort(), [
    'connection',
    'content-length',
    'content-type',
    'host',
  ]);
  assert.equal(request.headers.connection, 'close');
});

test('forwarded requests are bounded per device and the slots come back', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);

  const held: ServerResponse[] = [];
  upstream.respond((_request, response) => {
    held.push(response);
  });
  const pending = Array.from({ length: 8 }, () => fixture.frameRequest(frameUrl + 'state'));
  const until = Date.now() + 3000;
  while (held.length < 8) {
    assert.ok(Date.now() < until);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const ninth = await fixture.frameRequest(frameUrl + 'state');
  assert.equal(ninth.status, 503);
  await ninth.arrayBuffer();

  for (const response of held) {
    json(response, 200);
  }
  for (const response of await Promise.all(pending)) {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  upstream.respond((_request, response) => json(response, 200));
  const after = await fixture.frameRequest(frameUrl + 'state');
  assert.equal(after.status, 200);
});

test('an upstream 404 ends the handle and answers like an unknown one', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);
  const size = fixture.gateway.frames!.handles.size;

  upstream.respond((_request, response) => json(response, 404));
  const ended = await fixture.frameRequest(frameUrl + 'state');
  assert.equal(ended.status, 404);
  assert.deepEqual(await ended.json(), { error: 'Not found' });
  assert.equal(fixture.gateway.frames!.handles.size, size - 1);

  // The handle is gone: nothing more is forwarded for it.
  const before = upstream.seen.length;
  upstream.respond((_request, response) => json(response, 200));
  assert.equal((await fixture.frameRequest(frameUrl + 'state')).status, 404);
  assert.equal(upstream.seen.length, before);
});

test('a client that never finishes its request headers is closed after about 10 seconds', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const socket = createConnection(fixture.framePort, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const started = Date.now();
  socket.write(`GET /f/${'a'.repeat(43)}/ HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\n`);
  socket.on('data', () => {});
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9_000 && elapsed <= 12_500, `closed after ${elapsed} ms`);
});

test('a forwarded action keeps its slot until the listener finishes it, even if the client left', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);

  // Hold every widget reducer until released, as a slow widget would.
  const renderer = (fixture.sessions as any).widgets.renderer;
  const original = renderer.reduce.bind(renderer);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered = 0;
  renderer.reduce = async (...args: unknown[]) => {
    entered++;
    await gate;
    return original(...args);
  };

  const clients = Array.from({ length: 8 }, () => new AbortController());
  const pending = clients.map((client, index) =>
    fetch(frameUrl + 'action', {
      method: 'POST',
      signal: client.signal,
      headers: { 'Content-Type': 'application/json', Origin: fixture.frameOrigin },
      body: JSON.stringify({ action: 'increment', args: {}, requestId: `slow-${index}` }),
    }).catch(() => undefined),
  );
  const until = Date.now() + 3000;
  while (entered < 1 || (fixture.gateway.frames as any).forwarded < 8) {
    assert.ok(Date.now() < until);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // The tabs go away; the listener still has the work, so the slots stay.
  for (const client of clients) {
    client.abort();
  }
  await Promise.all(pending);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const busy = await fixture.frameRequest(frameUrl + 'state');
  assert.equal(busy.status, 503);
  await busy.arrayBuffer();

  // The listener finishes every accepted action; then the slots come back.
  // (A single free slot already admits a state request, so wait for all.)
  release();
  const later = Date.now() + 5000;
  let count = 0;
  while (count !== 8 || (fixture.gateway.frames as any).forwarded !== 0) {
    assert.ok(Date.now() < later, `count ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fixture.frameRequest(frameUrl + 'state');
    const value = (await response.json()) as Json;
    if (response.status === 200) {
      count = value.props.count;
    }
  }
  assert.equal((fixture.gateway.frames as any).forwarded, 0);
});

test('pipelined answers whose connection closes still give their slots back', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);
  const handle = frameUrl.split('/')[4];

  const held: ServerResponse[] = [];
  upstream.respond((_request, response) => {
    held.push(response);
  });
  // Two pipelined requests on one connection: the second answer would queue
  // behind the first. The connection then drops.
  const socket = createConnection(fixture.framePort, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const line = `GET /f/${handle}/state HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\n\r\n`;
  socket.write(line + line);
  const until = Date.now() + 3000;
  while ((fixture.gateway.frames as any).forwarded < 1) {
    assert.ok(Date.now() < until);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  for (const response of held.splice(0)) {
    json(response, 200);
  }
  upstream.respond((_request, response) => json(response, 200));
  while ((fixture.gateway.frames as any).forwarded !== 0) {
    assert.ok(Date.now() < until + 3000, 'a slot was never given back');
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const response of held.splice(0)) {
      json(response, 200);
    }
  }
});

test('an upstream 404 ends the handle even when the client has already left', async (context) => {
  const upstream = await fakeUpstream();
  context.after(() => upstream.close());
  const fixture = await frameFixture({ widgetSocket: upstream.socketPath });
  context.after(() => fixture.close());
  const frameUrl = await widgetFrame(fixture);
  const handles = fixture.gateway.frames!.handles;
  const before = handles.size;

  let answer!: () => void;
  upstream.respond((_request, response) => {
    answer = () => json(response, 404);
  });
  const client = new AbortController();
  const pending = fetch(frameUrl + 'state', { signal: client.signal }).catch(() => undefined);
  const until = Date.now() + 3000;
  while (answer === undefined) {
    assert.ok(Date.now() < until);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  client.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 50));
  answer();
  while (handles.size !== before - 1) {
    assert.ok(Date.now() < until + 2000, 'the handle stayed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
