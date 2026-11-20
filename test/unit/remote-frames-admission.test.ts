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

test('frame requests do not use phone connection slots', async (context) => {
  const fixture = await frameFixture();
  context.after(() => fixture.close());

  const { run } = await fixture.conversation();
  await fixture.publishCounter(run);
  const { token } = await fixture.pair();
  const phones = [await fixture.phone(token), await fixture.phone(token)];
  const snapshot = await phones[0].engine('state', (message) =>
    message.sessions?.some((session: Json) => session.messages.some((row: Json) => row.widget)),
  );
  const frameUrl = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;
  await phones[1].engine('state');

  // Both phone slots are taken; frames still answer, many at once.
  const statuses = await Promise.all(
    Array.from({ length: 8 }, async () => (await fixture.frameRequest(frameUrl + 'state')).status),
  );
  assert.deepEqual(statuses, Array(8).fill(200));
  // And a third phone is still refused for capacity, not because of frames.
  const third = await fixture.phone(token);
  assert.equal((await third.closed).code, 4429);
});
