/**
 * Frame request admission: one table of cases derived from the rules in
 * src/remote/README.md ("Rules: request admission"), not from the code.
 *
 * One fixture serves the whole table: a real gateway with a frame origin on
 * loopback, a real listener with its widget service socket, one synthetic
 * widget and one synthetic application (test/frame-fixture.ts). Raw sockets
 * send the requests `fetch` cannot (odd targets, missing Host, upgrades).
 */

import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';
import test from 'node:test';

import { frameFixture } from '../frame-fixture.ts';
import { delay, readStatusLine } from '../remote-fixture.ts';

type Fixture = Awaited<ReturnType<typeof frameFixture>>;
type Json = Record<string, any>;

/** Messages the frame origin itself answers with; anything else came from the listener. */
const gatewayMessages = new Set([
  'Not found',
  'Method not allowed',
  'Origin not allowed',
  'Origin required',
  'Expected JSON',
  'A Content-Length is required',
  'Request body too large',
  'Unexpected request body',
  'Credentials are not accepted here',
  'Upgrades are not accepted here',
  'Query strings are not accepted here',
  'Unknown host',
  'Too many requests',
  'Busy; try again',
  'Public requests are not allowed',
  'Too many header fields',
  'Repeated header field',
  'Expectation not supported',
]);

interface Views {
  widget: string;
  application: string;
  widgetHandle: string;
  deviceId: string;
  token: string;
}

/** Send raw bytes to the frame origin and return the status code. */
async function raw(port: number, text: string): Promise<number> {
  const socket = createConnection(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(text);
  const line = await readStatusLine(socket);
  socket.destroy();
  return Number(line.split(' ')[1]);
}

/** A raw GET with exactly the given target and extra header lines. */
function rawGet(fixture: Fixture, target: string, headers: string[] = []): Promise<number> {
  const host = `Host: 127.0.0.1:${fixture.framePort}`;
  return raw(
    fixture.framePort,
    [`GET ${target} HTTP/1.1`, host, ...headers, 'Connection: close', '', ''].join('\r\n'),
  );
}

interface Answer {
  status: number;
  error?: string;
  /** True when the listener's widget service produced the answer. */
  upstream: boolean;
}

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  let error: string | undefined;
  try {
    error = (JSON.parse(text) as Json).error;
  } catch {
    error = undefined;
  }
  const upstream =
    response.status < 300 ? true : error !== undefined && !gatewayMessages.has(error);
  return { status: response.status, error, upstream };
}

interface AdmissionCase {
  name: string;
  /** Returns the answer; the expectation follows from the rules. */
  request(fixture: Fixture, views: Views): Promise<Answer | number>;
  status: number;
  /** For allowed operations: the request must reach the widget service. */
  reachesListener?: boolean;
}

const body = (value: unknown) => ({ body: value });

const cases: AdmissionCase[] = [
  // ---- Every allowed operation reaches the listener --------------------------
  {
    name: 'widget document GET /',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.widget)),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'widget GET state',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.widget + 'state')),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'widget POST action',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.widget + 'action',
          body({ action: 'increment', args: {}, requestId: 'admission-action' }),
        ),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'widget POST present',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.widget + 'present',
          body({ presentation: { placement: 'inline' }, requestId: 'admission-present' }),
        ),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'widget POST viewport',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.widget + 'viewport',
          body({ widthCssPixels: 320, heightCssPixels: 200, textScale: 1 }),
        ),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'application document GET /',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.application)),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'application GET state',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.application + 'state')),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'application POST action',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.application + 'action',
          body({
            action: 'add_note',
            args: { text: 'Synthetic' },
            version: 1,
            requestId: 'admission-note',
          }),
        ),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'application POST query',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.application + 'query',
          body({ name: 'count_notes', args: {}, version: 1 }),
        ),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    // Forwarded; the listener refuses because the desktop granted nothing.
    name: 'application POST chat-read reaches the listener, which applies its grant',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.application + 'chat-read', body({ version: 1 }))),
    status: 403,
    reachesListener: true,
  },
  {
    name: 'application POST chat-send reaches the listener, which applies its grant',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(
          views.application + 'chat-send',
          body({ version: 1, text: 'Hello' }),
        ),
      ),
    status: 403,
    reachesListener: true,
  },
  {
    name: 'application POST chat-receipt reaches the listener',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.application + 'chat-receipt', body({ version: 1 }))),
    status: 403,
    reachesListener: true,
  },

  // ---- Refused operations and paths ----------------------------------------
  ...['popout', 'frame', 'layout', 'input'].flatMap((operation): AdmissionCase[] => [
    {
      name: `${operation} (GET) is not an operation`,
      request: async (fixture, views) =>
        answer(await fixture.frameRequest(views.widget + operation)),
      status: 404,
    },
    {
      name: `${operation} (POST) is not an operation`,
      request: async (fixture, views) =>
        answer(await fixture.frameRequest(views.widget + operation, body({}))),
      status: 404,
    },
  ]),
  {
    name: 'an operation of the other kind on a widget (query) is unknown',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget + 'query', body({ name: 'x' }))),
    status: 404,
  },
  {
    name: 'an operation of the other kind on an application (present) is unknown',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.application + 'present', body({}))),
    status: 404,
  },
  {
    name: 'an unknown operation',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget + 'agent', body({}))),
    status: 404,
  },
  {
    name: 'the handle without its trailing slash',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget.slice(0, -1))),
    status: 404,
  },
  {
    name: 'a trailing slash after an operation',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.widget + 'state/')),
    status: 404,
  },
  {
    name: 'a never-issued handle',
    request: async (fixture) =>
      answer(await fixture.frameRequest(`${fixture.frameOrigin}/f/${'A'.repeat(43)}/state`)),
    status: 404,
  },
  {
    name: 'a handle one character short',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(`${fixture.frameOrigin}/f/${views.widgetHandle.slice(1)}/state`),
      ),
    status: 404,
  },

  // ---- Paths that try to leave the view --------------------------------------
  ...[
    (handle: string) => `/f/${handle}/../state`,
    (handle: string) => `/f/${handle}/%2e%2e/state`,
    (handle: string) => `/f/${handle}%2Fstate`,
    (handle: string) => `/f/${handle}/%73tate`,
    (handle: string) => `/f/${handle}//state`,
    (handle: string) => `//f/${handle}/state`,
    (handle: string) => `/f/${handle}/view/${'a'.repeat(64)}`,
    (handle: string) => `/f/${handle}/state/../../view/${'a'.repeat(64)}`,
    (handle: string) => `/f/${handle}\\state`,
    (handle: string) => `/F/${handle}/state`,
  ].map((target): AdmissionCase => ({
    name: `path ${target('<handle>')}`,
    request: (fixture, views) => rawGet(fixture, target(views.widgetHandle)),
    status: 404,
  })),
  {
    name: 'absolute-form target',
    request: (fixture, views) =>
      rawGet(fixture, `http://127.0.0.1:${fixture.framePort}/f/${views.widgetHandle}/state`),
    status: 404,
  },

  // ---- The two origins never serve each other -------------------------------
  {
    name: 'the gateway origin does not serve /f/ (document)',
    request: async (fixture, views) =>
      answer(await fetch(views.widget.replace(fixture.frameOrigin, fixture.origin))),
    status: 404,
  },
  {
    name: 'the gateway origin does not serve /f/ (state)',
    request: async (fixture, views) =>
      answer(await fetch(views.widget.replace(fixture.frameOrigin, fixture.origin) + 'state')),
    status: 404,
  },
  ...['/', '/index.html', '/api/apps', '/api/socket', '/api/screenshots/x'].map(
    (path): AdmissionCase => ({
      name: `the frame origin does not serve the gateway path ${path}`,
      request: async (fixture) => answer(await fetch(fixture.frameOrigin + path)),
      status: 404,
    }),
  ),
  {
    name: 'the frame origin does not serve pairing',
    request: async (fixture) =>
      answer(
        await fixture.frameRequest(
          fixture.frameOrigin + '/api/pair',
          body({ code: 'x', name: 'y' }),
        ),
      ),
    status: 404,
  },

  // ---- Methods ---------------------------------------------------------------
  ...['HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].map((method): AdmissionCase => ({
    name: `${method} on the document`,
    request: async (fixture, views) =>
      (await fixture.frameRequest(views.widget, { method })).status,
    status: 405,
  })),
  {
    name: 'POST on the document',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.widget, body({}))),
    status: 405,
  },
  {
    name: 'POST on state',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget + 'state', body({}))),
    status: 405,
  },
  {
    name: 'GET on action',
    request: async (fixture, views) => answer(await fixture.frameRequest(views.widget + 'action')),
    status: 405,
  },

  // ---- Credentials, queries, upgrades ---------------------------------------
  {
    name: 'an Authorization header',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'state', {
          headers: { Authorization: `Bearer ${views.token}` },
        }),
      ),
    status: 400,
  },
  {
    name: 'an empty Authorization header',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'state', { headers: { Authorization: '' } }),
      ),
    status: 400,
  },
  {
    name: 'a query that looks like a token',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget + 'state?token=' + 'f'.repeat(64))),
    status: 400,
  },
  {
    name: 'any query string, even an empty one',
    request: (fixture, views) => rawGet(fixture, `/f/${views.widgetHandle}/state?`),
    status: 400,
  },
  {
    name: 'a viewport query on the document',
    request: async (fixture, views) =>
      answer(await fixture.frameRequest(views.widget + '?width=800')),
    status: 400,
  },
  {
    name: 'a WebSocket upgrade',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, [
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ]),
    status: 400,
  },
  {
    name: 'a CONNECT tunnel',
    request: (fixture) =>
      raw(
        fixture.framePort,
        `CONNECT 127.0.0.1:${fixture.port} HTTP/1.1\r\nHost: 127.0.0.1:${fixture.port}\r\n\r\n`,
      ),
    status: 400,
  },

  // ---- Host and Origin --------------------------------------------------------
  {
    name: 'Host of the gateway origin',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.1\r\nHost: 127.0.0.1:${fixture.port}\r\nConnection: close\r\n\r\n`,
      ),
    status: 421,
  },
  {
    name: 'Host localhost instead of 127.0.0.1',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.1\r\nHost: localhost:${fixture.framePort}\r\nConnection: close\r\n\r\n`,
      ),
    status: 421,
  },
  {
    name: 'a wrong Host with a correct X-Forwarded-Host (TCP ignores it)',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.1\r\nHost: evil.example\r\nX-Forwarded-Host: 127.0.0.1:${fixture.framePort}\r\nConnection: close\r\n\r\n`,
      ),
    status: 421,
  },
  {
    name: 'HTTP/1.0 without Host',
    request: (fixture, views) =>
      raw(fixture.framePort, `GET /f/${views.widgetHandle}/state HTTP/1.0\r\n\r\n`),
    status: 421,
  },
  {
    name: 'GET with the gateway Origin',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'state', { headers: { Origin: fixture.origin } }),
      ),
    status: 403,
  },
  {
    name: 'GET with the frame Origin',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'state', {
          headers: { Origin: fixture.frameOrigin },
        }),
      ),
    status: 200,
    reachesListener: true,
  },
  {
    name: 'POST without Origin',
    request: async (fixture, views) =>
      answer(
        await fetch(views.widget + 'action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'increment', args: {}, requestId: 'no-origin' }),
        }),
      ),
    status: 403,
  },
  ...['null', 'http://evil.example', 'gateway'].map((origin): AdmissionCase => ({
    name: `POST with Origin ${origin}`,
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'action', {
          body: { action: 'increment', args: {}, requestId: 'bad-origin' },
          headers: { Origin: origin === 'gateway' ? fixture.origin : origin },
        }),
      ),
    status: 403,
  })),
  {
    name: 'a Funnel request',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'state', {
          headers: { 'Tailscale-Funnel-Request': '?1' },
        }),
      ),
    status: 403,
  },

  // ---- Bodies -----------------------------------------------------------------
  {
    name: 'POST with a text/plain body',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'action', {
          body: {},
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    status: 415,
  },
  {
    name: 'POST with chunked transfer encoding',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        [
          `POST /f/${views.widgetHandle}/action HTTP/1.1`,
          `Host: 127.0.0.1:${fixture.framePort}`,
          `Origin: ${fixture.frameOrigin}`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: close',
          '',
          '2',
          '{}',
          '0',
          '',
          '',
        ].join('\r\n'),
      ),
    status: 411,
  },
  {
    name: 'action body one byte over 160 KiB',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'action', {
          body: { pad: 'x'.repeat(160 * 1024 - 9) },
        }),
      ),
    status: 413,
  },
  {
    name: 'action body exactly 160 KiB reaches the listener',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.widget + 'action', {
          body: { pad: 'x'.repeat(160 * 1024 - 10) },
        }),
      ),
    // The listener refuses the content (no such action), not the size.
    status: 400,
    reachesListener: true,
  },
  {
    name: 'chat-send body over 32 KiB',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.application + 'chat-send', {
          body: { version: 1, text: 'x'.repeat(32 * 1024) },
        }),
      ),
    status: 413,
  },
  {
    name: 'chat-receipt body over 1 KiB',
    request: async (fixture, views) =>
      answer(
        await fixture.frameRequest(views.application + 'chat-receipt', {
          body: { version: 1, pad: 'x'.repeat(1024) },
        }),
      ),
    status: 413,
  },
  {
    name: 'GET with a body',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      ),
    status: 400,
  },

  // ---- Header lists and expectations ---------------------------------------
  {
    name: '64 header fields (a Funnel marker could have been dropped)',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, [
        ...Array.from({ length: 61 }, (_value, index) => `X-Filler-${index}: x`),
        'Tailscale-Funnel-Request: ?1',
      ]),
    status: 431,
  },
  {
    name: '63 header fields are still admitted',
    request: (fixture, views) =>
      rawGet(
        fixture,
        `/f/${views.widgetHandle}/state`,
        Array.from({ length: 61 }, (_value, index) => `X-Filler-${index}: x`),
      ),
    status: 200,
  },
  {
    name: 'a repeated Host, the first one correct',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, ['Host: evil.example']),
    status: 400,
  },
  {
    name: 'a repeated Origin',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, [
        `Origin: ${fixture.frameOrigin}`,
        `Origin: ${fixture.frameOrigin}`,
      ]),
    status: 400,
  },
  {
    name: 'a repeated Funnel marker',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, [
        'Tailscale-Funnel-Request: ?1',
        'Tailscale-Funnel-Request: ?1',
      ]),
    status: 400,
  },
  {
    name: 'an unsupported expectation',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, ['Expect: something-else']),
    status: 417,
  },
  {
    name: 'a repeated Tailscale identity field of any name',
    request: (fixture, views) =>
      rawGet(fixture, `/f/${views.widgetHandle}/state`, [
        'Tailscale-User-Name: one',
        'Tailscale-User-Name: two',
      ]),
    status: 400,
  },
  {
    name: 'HTTP/1.1 without Host',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.1\r\nConnection: close\r\n\r\n`,
      ),
    status: 421,
  },
  {
    name: 'an expectation that only contains 100-continue',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        [
          `POST /f/${views.widgetHandle}/action HTTP/1.1`,
          `Host: 127.0.0.1:${fixture.framePort}`,
          `Origin: ${fixture.frameOrigin}`,
          'Content-Type: application/json',
          'Content-Length: 2',
          'Expect: 100-continue, something-else',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      ),
    status: 417,
  },
  {
    name: 'an unsupported expectation on HTTP/1.0',
    request: (fixture, views) =>
      raw(
        fixture.framePort,
        `GET /f/${views.widgetHandle}/state HTTP/1.0\r\nHost: 127.0.0.1:${fixture.framePort}\r\nExpect: something-else\r\n\r\n`,
      ),
    status: 417,
  },
];

test('frame request admission table', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());

  const { id, run } = await fixture.conversation();
  const widgetId = await fixture.publishCounter(run);
  await fixture.applyNotes(run);
  const { token, deviceId } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) => session.id === id && session.application),
  );
  const session = snapshot.sessions.find((entry: Json) => entry.id === id);
  const widget = session.messages.find((row: Json) => row.widget?.id === widgetId).widget
    .frameUrl as string;
  const views: Views = {
    widget,
    application: session.application.frameUrl,
    widgetHandle: widget.split('/')[4],
    deviceId,
    token,
  };

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      // Keep the table clear of the request budget; it has its own case.
      await delay(30);
      const result = await entry.request(fixture, views);
      const outcome = typeof result === 'number' ? { status: result, upstream: false } : result;
      assert.equal(outcome.status, entry.status, JSON.stringify(outcome));
      if (typeof result !== 'number') {
        assert.equal(outcome.upstream, entry.reachesListener === true, JSON.stringify(outcome));
      }
    });
  }

  // Refused operations never end a live handle.
  assert.equal((await fixture.frameRequest(views.widget + 'state')).status, 200);
  assert.equal((await fixture.frameRequest(views.application + 'state')).status, 200);
});

test('unknown, ended and never-issued handles get identical answers', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());

  const { id, run } = await fixture.conversation();
  await fixture.publishCounter(run);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
  );
  const ended = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;
  await fixture.sessions.remove(id);
  await phone.engine('agent-removed');

  const describe = async (url: string, init?: Parameters<Fixture['frameRequest']>[1]) => {
    const response = await fixture.frameRequest(url, init);
    const headers = [...response.headers.entries()].filter(([name]) => name !== 'date');
    return { status: response.status, headers, body: await response.text() };
  };
  const never = `${fixture.frameOrigin}/f/${'x'.repeat(43)}/`;
  const notAPath = `${fixture.frameOrigin}/somewhere/else`;
  for (const suffix of ['', 'state']) {
    const expected = await describe(never + suffix);
    assert.equal(expected.status, 404);
    assert.deepEqual(await describe(ended + suffix), expected);
    assert.deepEqual(await describe(notAPath), expected);
  }
  const posted = { body: { action: 'increment', args: {}, requestId: 'ended' } };
  assert.deepEqual(
    await describe(ended + 'action', posted),
    await describe(never + 'action', posted),
  );
});

test('a handle of a revoked device is unknown while another device keeps its own', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());

  const { run } = await fixture.conversation();
  await fixture.publishCounter(run);
  const one = await fixture.pair('One');
  const two = await fixture.pair('Two');
  const frameOf = async (token: string) => {
    const phone = await fixture.phone(token);
    const snapshot = await phone.engine('state', (message) =>
      message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
    );
    return snapshot.sessions[0].messages.find((row: Json) => row.widget).widget.frameUrl as string;
  };
  const first = await frameOf(one.token);
  const second = await frameOf(two.token);
  assert.notEqual(first, second);

  await fixture.devices.revoke(one.deviceId);
  const until = Date.now() + 3000;
  while ((await fixture.frameRequest(first + 'state')).status !== 404) {
    assert.ok(Date.now() < until);
    await delay(20);
  }
  // The other device's connection, its own handle, or its budget cannot
  // bring the first device's handle back.
  assert.equal((await fixture.frameRequest(second + 'state')).status, 200);
  assert.equal((await fixture.frameRequest(first + 'state')).status, 404);
});

test('over the per-device budget: 429, and the connection and handles stay', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());

  const { run } = await fixture.conversation();
  await fixture.publishCounter(run);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
  );
  const frameUrl = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;

  // Burst 120, refilled at 40 per second: 200 requests in quick batches of
  // 8 (within the per-device concurrency bound) exceed it. Requests over
  // the budget are answered 429; at most 120 plus the refill are admitted.
  const statuses: number[] = [];
  const started = Date.now();
  for (let batch = 0; batch < 25; batch++) {
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const response = await fixture.frameRequest(frameUrl + 'state');
        await response.arrayBuffer();
        statuses.push(response.status);
      }),
    );
  }
  const elapsedSeconds = (Date.now() - started) / 1000;
  const admitted = statuses.filter((status) => status === 200).length;
  const limited = statuses.filter((status) => status === 429).length;
  assert.equal(admitted + limited, 200, JSON.stringify(statuses));
  assert.ok(admitted >= 120, `admitted ${admitted}`);
  assert.ok(admitted <= 120 + Math.ceil(elapsedSeconds * 40) + 1, `admitted ${admitted}`);
  assert.ok(limited > 0);

  // The phone connection and the handle stay; the budget refills.
  assert.equal(phone.socket.readyState, phone.socket.OPEN);
  await delay(200);
  assert.equal((await fixture.frameRequest(frameUrl + 'state')).status, 200);

  // The budget is separate from the WebSocket's: the phone can still ask.
  phone.send({ requestId: 'still-allowed', action: 'panel-state', id: snapshot.sessions[0].id });
  assert.equal((await phone.reply('still-allowed')).type, 'result');
});

/**
 * How frames meet the gateway's connection limits (protocol.ts: 4 per device,
 * 8 in total, draining relays counted) and its per-device WebSocket request
 * bucket: frame requests never count against either, and neither stops them.
 */
interface LimitCase {
  name: string;
  /** Fill something up with phones of these devices; returns the refused phone's close. */
  run(fixture: Fixture, frameUrl: string, token: string): Promise<void>;
}

/** All eight frame requests at once must answer 200. */
async function framesStillAnswer(fixture: Fixture, frameUrl: string): Promise<void> {
  const statuses = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const response = await fixture.frameRequest(frameUrl + 'state');
      await response.arrayBuffer();
      return response.status;
    }),
  );
  assert.deepEqual(statuses, Array(8).fill(200));
}

const limitCases: LimitCase[] = [
  {
    name: 'a device at its limit of 4 connections: frames answer, a 5th connection is refused',
    async run(fixture, frameUrl, token) {
      for (let index = 1; index < 4; index++) {
        await (await fixture.phone(token)).engine('state');
      }
      await framesStillAnswer(fixture, frameUrl);
      const fifth = await fixture.phone(token);
      assert.deepEqual(await fifth.closed, { code: 4429, reason: 'device' });
      await framesStillAnswer(fixture, frameUrl);
    },
  },
  {
    name: 'the gateway at its total of 8 connections: frames answer, a 9th is refused',
    async run(fixture, frameUrl, token) {
      for (let index = 1; index < 4; index++) {
        await (await fixture.phone(token)).engine('state');
      }
      const other = await fixture.pair('Other device');
      for (let index = 0; index < 4; index++) {
        await (await fixture.phone(other.token)).engine('state');
      }
      await framesStillAnswer(fixture, frameUrl);
      const third = await fixture.pair('Third device');
      const ninth = await fixture.phone(third.token);
      assert.deepEqual(await ninth.closed, { code: 4429, reason: 'total' });
      await framesStillAnswer(fixture, frameUrl);
    },
  },
  {
    name: 'the WebSocket request bucket spent: frames still answer (separate budgets)',
    async run(fixture, frameUrl, token) {
      const phone = await fixture.phone(token);
      await phone.engine('state');
      // Pings share the device's WebSocket bucket (burst 30).
      for (let index = 0; index < 60; index++) {
        phone.socket.send(JSON.stringify({ type: 'ping' }));
      }
      await delay(100);
      const pongs = phone.messages.filter((message) => message.type === 'pong').length;
      assert.ok(pongs <= 31, `pongs ${pongs}`);
      await framesStillAnswer(fixture, frameUrl);
    },
  },
];

for (const entry of limitCases) {
  test(`frames and connection limits: ${entry.name}`, async (context) => {
    const fixture = await frameFixture();
    context.after(() => fixture.close());
    const { run } = await fixture.conversation();
    await fixture.publishCounter(run);
    const { token } = await fixture.pair();
    const first = await fixture.phone(token);
    const snapshot = await first.engine('state', (message) =>
      message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
    );
    const frameUrl = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
      .frameUrl as string;
    await entry.run(fixture, frameUrl, token);
  });
}

/** Send a POST's headers with `Expect: 100-continue` and report what comes back first. */
async function expectContinue(fixture: Fixture, views: Views, origin: string): Promise<string> {
  const socket = createConnection(fixture.framePort, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const body = JSON.stringify({ action: 'increment', args: {}, requestId: 'continue-' + origin });
  socket.write(
    [
      `POST /f/${views.widgetHandle}/action HTTP/1.1`,
      `Host: 127.0.0.1:${fixture.framePort}`,
      `Origin: ${origin}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Expect: 100-continue',
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );
  const first = await readStatusLine(socket);
  if (first.includes(' 100 ')) {
    socket.write(body);
  }
  socket.destroy();
  return first;
}

test('Expect: 100-continue is answered only for an admitted request', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const { run } = await fixture.conversation();
  await fixture.publishCounter(run);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
  );
  const widget = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;
  const views = { widget, widgetHandle: widget.split('/')[4] } as Views;

  assert.match(await expectContinue(fixture, views, fixture.frameOrigin), / 100 /);
  assert.match(await expectContinue(fixture, views, 'http://evil.example'), / 403 /);
});

test('upgrade and CONNECT refusals carry the fixed headers', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const socket = createConnection(fixture.framePort, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    `GET /f/${'a'.repeat(43)}/ HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  let text = '';
  socket.setEncoding('latin1');
  await new Promise<void>((resolve) => {
    socket.on('data', (chunk) => (text += chunk));
    socket.once('close', () => resolve());
  });
  assert.match(text, /^HTTP\/1\.1 400 /);
  assert.match(text, new RegExp(`content-security-policy: frame-ancestors ${fixture.origin}`, 'i'));
  assert.match(text, /origin-agent-cluster: \?1/i);
  assert.match(text, /"error":"Upgrades are not accepted here"/);
});

test('a POST whose handle ends while its body arrives is not forwarded', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const { run } = await fixture.conversation();
  const widgetId = await fixture.publishCounter(run);
  const { token, deviceId } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
  );
  const widget = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;

  const body = JSON.stringify({ action: 'increment', args: {}, requestId: 'during-revocation' });
  const socket = createConnection(fixture.framePort, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    [
      `POST /f/${widget.split('/')[4]}/action HTTP/1.1`,
      `Host: 127.0.0.1:${fixture.framePort}`,
      `Origin: ${fixture.frameOrigin}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body.slice(0, 10),
    ].join('\r\n'),
  );
  // Admitted and waiting for the rest of the body; now revoke the device.
  await delay(100);
  await fixture.devices.revoke(deviceId);
  const until = Date.now() + 3000;
  while (fixture.gateway.frames!.handles.size > 0) {
    assert.ok(Date.now() < until);
    await delay(20);
  }
  socket.write(body.slice(10));
  const line = await readStatusLine(socket);
  socket.destroy();
  assert.match(line, / 404 /);
  const record = fixture.sessions
    .snapshot()[0]
    ?.messages.find((row) => row.widget?.id === widgetId);
  assert.equal(record?.widget?.revision, 1, 'the action never reached the listener');
});

/** Raw bytes in, the whole answer out (until the server closes). */
async function rawExchange(port: number, text: string): Promise<string> {
  const socket = createConnection(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  let answer = '';
  socket.setEncoding('latin1');
  socket.on('data', (chunk) => (answer += chunk));
  socket.on('error', () => {});
  socket.write(text);
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return answer;
}

test('requests the HTTP parser refuses still get the fixed refusal headers', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  for (const [name, text, status] of [
    ['malformed request line', 'NOT HTTP AT ALL\r\n\r\n', 400],
    [
      'oversized headers',
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\nX-Big: ${'x'.repeat(20_000)}\r\n\r\n`,
      431,
    ],
    [
      'conflicting body framing',
      `POST / HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n`,
      400,
    ],
  ] as const) {
    const answer = await rawExchange(fixture.framePort, text);
    assert.match(answer, new RegExp(`^HTTP/1\\.1 ${status} `), name);
    assert.match(answer, /content-security-policy: frame-ancestors /i, name);
    assert.match(answer, /"error":"Bad request"/, name);
  }
});

test('peers that reset during an upgrade refusal do not stop the gateway', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  for (let attempt = 0; attempt < 40; attempt++) {
    const socket = createConnection(fixture.framePort, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      `GET /f/${'a'.repeat(43)}/ HTTP/1.1\r\nHost: 127.0.0.1:${fixture.framePort}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.resetAndDestroy();
  }
  await delay(200);
  const response = await fixture.frameRequest(`${fixture.frameOrigin}/f/${'a'.repeat(43)}/`);
  assert.equal(response.status, 404);
  assert.equal((await fetch(fixture.origin + '/api/unknown')).status, 404);
});

test('expectation refusals go through the request path, with its checks and deadline', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  const head = (extra: string[]) =>
    [
      `POST /f/${'a'.repeat(43)}/action HTTP/1.1`,
      `Host: 127.0.0.1:${fixture.framePort}`,
      `Origin: ${fixture.frameOrigin}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      ...extra,
      'Connection: close',
      '',
      '',
    ].join('\r\n');

  // A refusal from the shared path carries the fixed headers and body.
  for (const expectation of ['something-else', '100-continue, something-else']) {
    const answer = await rawExchange(fixture.framePort, head([`Expect: ${expectation}`]));
    assert.match(answer, /^HTTP\/1\.1 417 /, expectation);
    assert.match(answer, /content-security-policy: frame-ancestors /i, expectation);
    assert.match(answer, /"error":"Expectation not supported"/, expectation);
  }
  // The header-list checks run first, as for every request.
  const repeated = await rawExchange(
    fixture.framePort,
    head(['Expect: something-else', 'Host: evil.example']),
  );
  assert.match(repeated, /^HTTP\/1\.1 400 /);
  assert.match(repeated, /"error":"Repeated header field"/);
});

test('a raw refusal cannot hold its socket when the client never reads it', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());
  // A socket whose writes never complete, as with a client that stopped
  // reading and a full send buffer.
  const socket = new Duplex({ write() {}, read() {} });
  const started = Date.now();
  (fixture.gateway.frames as any).endWithRefusal(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const elapsed = Date.now() - started;
  assert.ok(socket.destroyed);
  assert.ok(elapsed >= 4_500 && elapsed <= 7_000, `destroyed after ${elapsed} ms`);
});
