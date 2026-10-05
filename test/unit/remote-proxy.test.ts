import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import type { ConnectionOptions as TlsOptions } from 'node:tls';
import { promisify } from 'node:util';
import test from 'node:test';
import WebSocket from 'ws';
import { Gateway } from '../../src/remote/gateway.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';

/**
 * Real TLS and WebSocket proxy on loopback with temporary certificates/state.
 * Models Serve's preserved Host and untrusted forwarding headers, without
 * changing tailscaled, opening a tailnet port or touching live conversations.
 */
test('HTTPS proxy preserves strict host/origin, pairing, receipts and revocation boundaries', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  await fixture.gateway.close();
  const externalHost = 'phone.fixture.test';
  const origin = `https://${externalHost}`;
  const gateway = new Gateway({
    host: '127.0.0.1',
    port: fixture.port,
    origins: [fixture.origin, origin],
    stateDirectory: join(fixture.directory, 'remote-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    revocationCheckMilliseconds: 20,
    log: () => {},
  });
  await gateway.start();
  context.after(() => gateway.close());
  const keyPath = join(fixture.directory, 'proxy.key');
  const certPath = join(fixture.directory, 'proxy.crt');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    `subjectAltName=DNS:${externalHost}`,
  ]);
  const cert = await readFile(certPath);
  const proxy = createServer({ cert, key: await readFile(keyPath) }, (request, response) => {
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: fixture.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  const sockets = new Set<Socket>();
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = createConnection(fixture.port, '127.0.0.1');
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  async function pair(code: string, headers: Record<string, string> = {}) {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: '127.0.0.1',
          servername: externalHost,
          port,
          ca: cert,
          path: '/api/pair',
          method: 'POST',
          headers: {
            Host: externalHost,
            Origin: origin,
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.once('end', () =>
            resolve({ status: response.statusCode!, body: JSON.parse(body) }),
          );
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ code, name: 'TLS proxy fixture' }));
    });
  }
  async function connect(headers: Record<string, string> = {}) {
    // Verify the fixture certificate's DNS identity independently of the
    // adversarial HTTP Host; ws passes TLS options through to node:https.
    const options: WebSocket.ClientOptions & TlsOptions = {
      ca: cert,
      servername: externalHost,
      headers: { Host: externalHost, Origin: origin, ...headers },
    };
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/socket`, options);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        socket.terminate();
        reject(Error(`HTTP ${response.statusCode}`));
      });
    });
    const messages: any[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    return { socket, messages };
  }

  const { code } = await fixture.devices.createPairingCode();
  const forgedHeaders = {
    'X-Forwarded-Host': externalHost,
    'X-Forwarded-Proto': 'https',
    'Tailscale-User-Login': 'forged@example.invalid',
  };
  assert.equal((await pair(code, { ...forgedHeaders, Host: 'evil.invalid' })).status, 421);
  assert.equal(
    (await pair(code, { ...forgedHeaders, Origin: 'https://evil.invalid' })).status,
    403,
  );
  assert.equal((await pair(code, { Origin: 'null' })).status, 403);
  // Two individually allowed origins cannot be mixed with each other's Host.
  assert.equal((await pair(code, { Origin: fixture.origin })).status, 403);
  assert.equal((await pair(code, { Origin: `http://${externalHost}` })).status, 403);
  const paired = await pair(code);
  assert.equal(paired.status, 200);
  assert.equal((await pair(code)).status, 401);
  await assert.rejects(connect({ ...forgedHeaders, Host: 'evil.invalid' }), /HTTP 421/);
  await assert.rejects(connect({ ...forgedHeaders, Origin: fixture.origin }), /HTTP 403/);

  const unpaired = await connect(forgedHeaders);
  const refused = once(unpaired.socket, 'close');
  unpaired.socket.send(JSON.stringify({ type: 'auth', token: 'invalid' }));
  assert.equal((await refused)[0], 4401);
  assert.equal(unpaired.messages.length, 0);

  const phone = await connect();
  phone.socket.send(
    JSON.stringify({ type: 'auth', token: paired.body.token, incrementalSessions: true }),
  );
  await waitFor(() =>
    phone.messages.some((message) => message.type === 'engine' && message.message.type === 'state'),
  );
  const request = { type: 'request', action: 'toggle-pause', requestId: 'once' };
  phone.socket.send(JSON.stringify(request));
  await waitFor(() => phone.messages.some((message) => message.requestId === 'once'));
  phone.socket.send(JSON.stringify(request));
  await waitFor(() =>
    phone.messages.some((message) => message.requestId === 'once' && message.duplicate),
  );
  assert.equal(fixture.desktop.pause.paused, true);
  const revoked = once(phone.socket, 'close');
  await fixture.devices.revoke(paired.body.deviceId);
  assert.equal((await revoked)[0], 4403);

  // The same gateway still admits the original localhost origin.
  const local = await fixture.pair('Local fixture');
  const localPhone = await fixture.phone(local.token);
  await localPhone.engine('state');
});
