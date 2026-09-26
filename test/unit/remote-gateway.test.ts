import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { Gateway, checkGatewayOptions } from '../../src/remote/gateway.ts';
import { parseRemoteRequest } from '../../src/remote/protocol.ts';
import { frame, signal } from '../helpers.ts';
import { delay, freePort, remoteFixture, waitFor } from '../remote-fixture.ts';

/**
 * End-to-end gateway checks: real HTTP/WebSocket server on loopback, real
 * listener control socket and SQLite, synthetic agent backend. No model,
 * no personal data, no non-loopback address, no Tailscale.
 */

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

async function withFixture(
  context: { after(callback: () => Promise<void>): void },
  options?: Parameters<typeof remoteFixture>[0],
): Promise<Fixture> {
  const fixture = await remoteFixture(options);
  context.after(() => fixture.close());
  return fixture;
}

test('pairing requires the current code, the allowed origin and a known host', async (context) => {
  const fixture = await withFixture(context);
  const post = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${fixture.origin}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: fixture.origin, ...headers },
      body: JSON.stringify(body),
    });

  // No active code.
  assert.equal((await post({ code: 'ABCDE-FGHJK' })).status, 401);

  const { code } = await fixture.devices.createPairingCode();

  // Cross-site origin and foreign Host are refused before touching the code.
  assert.equal((await post({ code }, { Origin: 'https://evil.example' })).status, 403);
  // fetch() cannot override Host, so use a raw request for the rebinding case.
  const rebound = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: fixture.port,
        path: '/api/pair',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: fixture.origin,
          Host: 'rebound.example',
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ code }));
  });
  assert.equal(rebound, 421);

  // A wrong guess consumes an attempt but leaves the code usable.
  assert.equal((await post({ code: 'ZZZZZZZZZZ' })).status, 401);

  // Case, spaces and hyphens are forgiven for the correct code.
  const typed = code.toLowerCase().slice(0, 5) + ' - ' + code.slice(5);
  const response = await post({ code: typed, name: 'Pixel\u0000 test‮' });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token: string; deviceName: string };
  assert.ok(body.token.length >= 40);
  assert.equal(body.deviceName, 'Pixel  test');

  // Single use.
  assert.equal((await post({ code })).status, 401);

  // The token is not stored in clear text.
  const stored = await readFile(join(fixture.directory, 'remote-state', 'devices.json'), 'utf8');
  assert.ok(!stored.includes(body.token));
});

test('five wrong guesses discard a pairing code', async (context) => {
  const fixture = await withFixture(context);
  const { code } = await fixture.devices.createPairingCode();

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await fixture.devices.redeemPairingCode('0000000000', 'x');
    assert.deepEqual(result, { ok: false, reason: 'wrong-code' });
  }
  assert.deepEqual(await fixture.devices.redeemPairingCode(code, 'x'), {
    ok: false,
    reason: 'no-code',
  });
});

test('pairing codes expire', async (context) => {
  const fixture = await withFixture(context);
  const { code } = await fixture.devices.createPairingCode(Date.now() - 11 * 60 * 1000);
  assert.deepEqual(await fixture.devices.redeemPairingCode(code, 'x'), {
    ok: false,
    reason: 'expired',
  });
});

test('the socket refuses other origins, missing tokens and unknown tokens', async (context) => {
  const fixture = await withFixture(context);

  await assert.rejects(fixture.phone(undefined, 'https://evil.example'), /HTTP 403/);

  const silent = await fixture.phone(undefined);
  assert.equal((await silent.closed).code, 4408);

  const wrong = await fixture.phone('x'.repeat(43));
  assert.equal((await wrong.closed).code, 4401);
  assert.equal(wrong.messages.length, 0);
});

test('a transient device-store failure refuses control without invalidating the credential', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const path = join(fixture.directory, 'remote-state', 'devices.json');
  const stored = await readFile(path);
  await writeFile(path, 'invalid synthetic JSON');
  const unavailable = await fixture.phone(token);
  assert.equal((await unavailable.closed).code, 4503);
  await writeFile(path, stored);
  const recovered = await fixture.phone(token);
  await recovered.engine('state');
});

test('the gateway frees vanished phone slots while responsive phones stay connected', async (context) => {
  const fixture = await withFixture(context, { gateway: { heartbeatMilliseconds: 100 } });
  const { token } = await fixture.pair();
  const healthy = await fixture.phone(token);
  await healthy.engine('state');
  const vanished = new WebSocket(`ws://127.0.0.1:${fixture.port}/api/socket`, {
    headers: { Origin: fixture.origin },
    autoPong: false,
  });
  context.after(async () => vanished.terminate());
  const closed = once(vanished, 'close');
  await once(vanished, 'open');
  vanished.send(JSON.stringify({ type: 'auth', token }));
  await closed;
  assert.equal(healthy.socket.readyState, WebSocket.OPEN);
  const replacement = await fixture.phone(token);
  await replacement.engine('state');
});

test('an authenticated phone receives state and gets correlated replies', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);

  const state = await phone.engine('state');
  assert.equal(state.ready, true);

  // The desktop's recent-utterance list reaches desktop panels, never phones.
  fixture.desktop.seed();
  await waitFor(() =>
    fixture.desktop.messages.some((message) => message.type === 'state' && message.history?.length),
  );
  await delay(50);
  const phoneStates = phone.messages.filter(
    (message) => message.type === 'engine' && message.message.type === 'state',
  );
  assert.ok(phoneStates.length >= 2);
  for (const message of phoneStates) {
    assert.deepEqual((message as { message: { history: unknown[] } }).message.history, []);
    assert.equal(Object.hasOwn((message as { message: object }).message, 'agentActions'), false);
  }
  assert.equal(state.sessionControlsAvailable, true);

  phone.send({ requestId: 'sounds-1', action: 'toggle-sounds' });
  const reply = await phone.reply('sounds-1');
  assert.deepEqual(reply, {
    type: 'result',
    requestId: 'sounds-1',
    action: 'toggle-sounds',
    result: 'sounds-enabled',
  });

  // Model catalogue discovery is a read-only request.
  phone.send({ requestId: 'models', action: 'agent-models' });
  const models = (await phone.reply('models')) as { result: { models: string[] } };
  assert.deepEqual(models.result.models, ['local/qwen-synthetic', 'cloud/synthetic-large']);

  // The live listener has a separate Claude catalogue. Its discovery does
  // not invoke Pi or switch the conversation's harness.
  phone.send({ requestId: 'claude-models', action: 'claude-models' });
  const claude = (await phone.reply('claude-models')) as {
    result: { models: string[]; model: string };
  };
  assert.ok(claude.result.models.includes(claude.result.model));
  assert.ok(!claude.result.models.includes('local/qwen-synthetic'));
});

test('desktop-only and malformed requests never reach the listener', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  const refused = [
    { requestId: 'a', action: 'paste', id: 'x', target: '0x1' },
    { requestId: 'b', action: 'submit-utterance', text: 'hi', target: '0x1' },
    { requestId: 'c', action: 'media-playback', playing: true },
    { requestId: 'd', action: 'client-role', role: 'remote' },
    { requestId: 'e', action: 'toggle-sounds', extra: true },
    { requestId: 'f', action: 'send-agent', id: 'not-a-uuid', text: 'hi' },
    { requestId: 'g', action: 'start-agent', text: 'x'.repeat(4001), profile: 'coding' },
  ];

  for (const request of refused) {
    phone.send(request);
    const reply = await phone.reply(request.requestId);
    assert.equal(reply.type, 'error', request.action);
  }

  // Nothing above toggled sounds or created a conversation.
  assert.equal(fixture.sessions.snapshot().length, 0);
  phone.send({ requestId: 'check', action: 'toggle-sounds' });
  assert.equal(((await phone.reply('check')) as { result: string }).result, 'sounds-enabled');
});

test('phones start, follow up, choose and stop conversations', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  phone.send({
    requestId: 'start',
    action: 'start-agent',
    text: 'Plan the synthetic trip',
    profile: 'coding',
  });
  const started = (await phone.reply('start')) as { result: { id: string } };
  const id = started.result.id;
  await waitFor(() => fixture.runs.length === 1);

  await phone.engine('agent-session', (event) => event.session.id === id);

  phone.send({ requestId: 'select', action: 'panel-state', id });
  await phone.reply('select');
  const running = await phone.engine(
    'remote-agent-actions',
    (event) => event.actions.sessionId === id && event.actions.stopRunId !== '',
  );

  // A follow-up while running is queued in the same FIFO as desktop input.
  phone.send({ requestId: 'follow', action: 'send-agent', id, text: 'Add a museum' });
  assert.equal(((await phone.reply('follow')) as { result: string }).result, 'submitted');

  phone.send({
    requestId: 'stop',
    action: 'stop-agent-run',
    id,
    runId: running.actions.stopRunId,
  });
  assert.equal(((await phone.reply('stop')) as { result: string }).result, 'stopped');

  // Desktop selection-specific events are never relayed.
  assert.ok(
    !phone.messages.some(
      (message) => message.type === 'engine' && message.message.type === ('agent-actions' as never),
    ),
  );
});

test('a repeated mutation after reconnect is answered from its receipt', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();

  const first = await fixture.phone(token);
  await first.engine('state');
  first.send({ requestId: 'pause-1', action: 'toggle-pause' });
  assert.equal(((await first.reply('pause-1')) as { result: string }).result, 'paused');
  first.socket.close();
  await first.closed;

  const second = await fixture.phone(token);
  await second.engine('state');
  second.send({ requestId: 'pause-1', action: 'toggle-pause' });
  const repeated = (await second.reply('pause-1')) as { result: string; duplicate?: boolean };
  assert.equal(repeated.result, 'paused');
  assert.equal(repeated.duplicate, true);
  assert.equal(fixture.desktop.pause.paused, true);

  // Reusing the ID for a different request is refused, not executed.
  second.send({ requestId: 'pause-1', action: 'toggle-sounds' });
  assert.equal((await second.reply('pause-1')).type, 'error');
});

test('a mutation whose reply was lost is not executed again', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  // Send and drop the connection immediately, before the reply can arrive.
  phone.send({ requestId: 'lost-1', action: 'toggle-pause' });
  phone.socket.terminate();
  await phone.closed;
  await waitFor(() => fixture.desktop.pause.paused);

  const again = await fixture.phone(token);
  await again.engine('state');
  again.send({ requestId: 'lost-1', action: 'toggle-pause' });
  const reply = (await again.reply('lost-1')) as { result: string; duplicate?: boolean };
  assert.equal(reply.duplicate, true);
  assert.equal(reply.result, 'paused');
  await delay(50);
  assert.equal(fixture.desktop.pause.paused, true);
});

test('screenshots are served only to authenticated devices that were shown them', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  const id = fixture.sessions.start({ ...frame, utterance: 'What is on screen?' }, signal());
  const event = await phone.engine(
    'agent-session',
    (value) => value.session.id === id && value.session.messages[0]?.screenshotUrl,
  );
  const url = event.session.messages[0].screenshotUrl as string;
  assert.equal(url, `api/screenshots/${id}`);

  const authorized = await fetch(`${fixture.origin}/${url}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), frame.screenshot.png);

  assert.equal((await fetch(`${fixture.origin}/${url}`)).status, 401);

  // A second device that never saw this conversation cannot fetch it.
  const other = await fixture.pair('Other phone');
  const unseen = await fetch(`${fixture.origin}/${url}`, {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert.equal(unseen.status, 404);

  const traversal = await fetch(`${fixture.origin}/api/screenshots/..%2F..%2Fetc%2Fpasswd`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(traversal.status, 404);
});

test('revoking a device closes its live connection and refuses its token', async (context) => {
  const fixture = await withFixture(context);
  const { token, deviceId } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  assert.equal(await fixture.devices.revoke(deviceId), true);
  assert.equal((await phone.closed).code, 4403);

  const again = await fixture.phone(token);
  assert.equal((await again.closed).code, 4401);
});

test('losing the listener closes the phone with an engine-unavailable code', async (context) => {
  const fixture = await withFixture(context);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');

  await fixture.desktop.runtime.close();
  assert.equal((await phone.closed).code, 4503);

  // Reconnecting while the listener is down authenticates, then closes again.
  const retry = await fixture.phone(token);
  assert.equal((await retry.closed).code, 4503);
});

test('unsafe network configurations are refused before binding', () => {
  const base = {
    port: 8787,
    origins: ['https://desk.example.ts.net:8787'],
    stateDirectory: '/nonexistent',
    controlSocket: '/nonexistent',
    sessionsDirectory: '/nonexistent',
    appDirectory: '/nonexistent',
    log: () => {},
  };

  assert.throws(() => checkGatewayOptions({ ...base, host: '100.64.0.1' }), /plain HTTP/);
  assert.throws(
    () => checkGatewayOptions({ ...base, host: '0.0.0.0', tls: { cert: 'x', key: 'y' } }),
    /specific address/,
  );
  for (const host of ['0', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
    assert.throws(
      () => checkGatewayOptions({ ...base, host, tls: { cert: 'x', key: 'y' } }),
      /literal IP|specific address/,
    );
  }
  assert.throws(
    () =>
      checkGatewayOptions({
        ...base,
        host: '100.64.0.1',
        tls: { cert: 'x', key: 'y' },
        origins: ['http://desk.example.ts.net:8787'],
      }),
    /must use https/,
  );
  assert.throws(
    () => checkGatewayOptions({ ...base, host: '127.0.0.1', origins: [] }),
    /origin is required/,
  );
  assert.throws(
    () => checkGatewayOptions({ ...base, host: '127.0.0.1', origins: ['http://127.0.0.1:1/'] }),
    /exactly scheme/,
  );
  for (const origin of ['ftp://desk.example', 'ws://desk.example', 'wss://desk.example']) {
    assert.throws(
      () => checkGatewayOptions({ ...base, host: '127.0.0.1', origins: [origin] }),
      /Origins must use/,
    );
  }
});

test('TLS mode serves the socket over wss with a supplied certificate', async (context) => {
  const execute = promisify(execFile);
  const fixture = await withFixture(context);
  const certificate = join(fixture.directory, 'cert.pem');
  const key = join(fixture.directory, 'key.pem');
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);

  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const gateway = new Gateway({
    host: '127.0.0.1',
    port,
    tls: { cert: await readFile(certificate, 'utf8'), key: await readFile(key, 'utf8') },
    origins: [origin],
    stateDirectory: join(fixture.directory, 'remote-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: () => {},
  });
  await gateway.start();
  context.after(() => gateway.close());

  const { token } = await fixture.pair();
  const { default: WebSocket } = await import('ws');
  const phone = await new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/socket`, {
      headers: { Origin: origin },
      ca: [readFileSync(certificate, 'utf8')],
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const messages: { type: string }[] = [];
  phone.on('message', (data) => messages.push(JSON.parse(String(data))));
  phone.send(JSON.stringify({ type: 'auth', token }));
  await waitFor(() => messages.some((message) => message.type === 'authenticated'));
  phone.terminate();
});

test('the request parser returns only declared fields', () => {
  const parsed = parseRemoteRequest({
    type: 'request',
    requestId: 'ok_1',
    action: 'label-history',
    id: 'utterance',
    correct: false,
    actualIntent: null,
  });
  assert.equal(parsed.ok, true);

  const withProto = parseRemoteRequest(
    JSON.parse('{"type":"request","requestId":"p","action":"toggle-sounds","__proto__":{"x":1}}'),
  );
  assert.equal(withProto.ok, false);

  assert.equal(parseRemoteRequest({ type: 'request', requestId: 'bad id', action: 'x' }).ok, false);
  assert.equal(parseRemoteRequest([1, 2]).ok, false);
});
