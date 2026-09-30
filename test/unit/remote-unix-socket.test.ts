import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

import { DeviceStore } from '../../src/remote/devices.ts';
import {
  checkGatewayOptions,
  Gateway,
  type GatewayServiceOptions,
} from '../../src/remote/gateway.ts';
import { claimUnixSocket } from '../../src/remote/unix-socket-claim.ts';
import { freePort, readStatusLine, remoteFixture, waitFor } from '../remote-fixture.ts';

/**
 * Unix socket mode for Tailscale Serve (`--listen unix:PATH`) and the
 * Tailscale header checks. Everything runs in temporary directories with
 * synthetic sockets; nothing touches the live gateway, its runtime directory,
 * the listener's real control socket or Tailscale.
 */

const tailnetOrigin = 'https://desk.example-tailnet.ts.net';
const tailnetHost = 'desk.example-tailnet.ts.net';

async function temporaryDirectory(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-unix-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Leave a stale socket behind, as a crashed gateway would: a child process
 * listens on the path and is killed before it can unlink it.
 */
async function staleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('ready'))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(child.stdout!, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.ok((await lstat(path)).isSocket());
}

/** A plain HTTP request over the Unix socket with explicit headers. */
function unixRequest(
  socketPath: string,
  options: { method?: string; path: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

type UnixPhone = {
  socket: WebSocket;
  messages: { type: string }[];
  closed: Promise<{ code: number }>;
};

/**
 * Open the phone WebSocket over the Unix socket, as Tailscale Serve would:
 * Host and Origin name the tailnet HTTPS origin. Resolves once upgraded
 * (HTTP 101) or rejects with the HTTP status.
 */
async function unixPhone(
  socketPath: string,
  token: string | undefined,
  headers: Record<string, string> = {},
): Promise<UnixPhone> {
  const socket = new WebSocket(`ws+unix:${socketPath}:/api/socket`, {
    headers: { Host: tailnetHost, Origin: tailnetOrigin, ...headers },
  });
  const messages: { type: string }[] = [];
  const closed = new Promise<{ code: number }>((resolve) => {
    socket.once('close', (code) => resolve({ code }));
  });
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(Error(`HTTP ${response.statusCode}`));
    });
  });

  if (token !== undefined) {
    socket.send(JSON.stringify({ type: 'auth', token }));
  }
  return { socket, messages, closed };
}

/**
 * A real listener and TCP gateway from the shared fixture, plus a second
 * gateway on a Unix socket with its OWN pairing state: one state directory
 * serves one gateway at a time. `pair()` pairs directly in the socket
 * gateway's state (the same store the pairing endpoint uses).
 */
async function unixFixture(
  context: { after(callback: () => Promise<void>): void },
  extra: Partial<GatewayServiceOptions> = {},
) {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());

  const socketDirectory = join(fixture.directory, 'phone');
  await mkdir(socketDirectory, { mode: 0o700 });
  const socketPath = join(socketDirectory, 'gateway.sock');
  const logs: string[] = [];

  const stateDirectory = join(fixture.directory, 'unix-state');
  const gateway = new Gateway({
    socketPath,
    origins: [tailnetOrigin],
    stateDirectory,
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: (message) => logs.push(message),
    ...extra,
  });
  await gateway.start();
  context.after(() => gateway.close());

  const devices = new DeviceStore(stateDirectory);
  async function pair(): Promise<{ token: string }> {
    const { code } = await devices.createPairingCode();
    const result = await devices.redeemPairingCode(code, 'Synthetic phone');
    assert.ok(result.ok);
    return { token: result.token };
  }

  return { fixture, gateway, socketPath, socketDirectory, stateDirectory, logs, pair };
}

// ---- Claiming the socket path ------------------------------------------------

test('a group- or world-accessible socket directory is refused', async (context) => {
  const directory = await temporaryDirectory(context);
  const shared = join(directory, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o750);

  await assert.rejects(
    claimUnixSocket(join(shared, 'gateway.sock')),
    /must not be accessible to other users/,
  );
  await chmod(shared, 0o701);
  await assert.rejects(
    claimUnixSocket(join(shared, 'gateway.sock')),
    /must not be accessible to other users/,
  );
});

test('a symlinked socket directory is refused', async (context) => {
  const directory = await temporaryDirectory(context);
  const real = join(directory, 'real');
  await mkdir(real, { mode: 0o700 });
  await symlink(real, join(directory, 'link'));

  await assert.rejects(claimUnixSocket(join(directory, 'link', 'gateway.sock')), /symbolic link/);
});

test('a missing socket directory is created private; relative paths are refused', async (context) => {
  const directory = await temporaryDirectory(context);
  const created = join(directory, 'created');

  const claim = await claimUnixSocket(join(created, 'gateway.sock'));
  const info = await lstat(created);
  assert.equal(info.mode & 0o777, 0o700);
  await claim.release();

  await assert.rejects(claimUnixSocket('relative/gateway.sock'), /must be absolute/);
});

test('a socket that answers is never replaced', async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, 'gateway.sock');
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(socketPath, resolve));
  context.after(() => new Promise<void>((resolve) => other.close(() => resolve())));

  await assert.rejects(claimUnixSocket(socketPath), /already listening/);
  assert.ok((await lstat(socketPath)).isSocket());
});

test('a stale socket from a crashed gateway is removed', async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, 'gateway.sock');
  await staleSocket(socketPath);

  const claim = await claimUnixSocket(socketPath);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
  await claim.release();
});

test('a socket that cannot be probed is left alone', async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, 'gateway.sock');
  await staleSocket(socketPath);

  // Without write permission, connect() fails with EACCES instead of
  // ECONNREFUSED: we cannot tell whether it is in use, so we refuse.
  await chmod(socketPath, 0o000);
  await assert.rejects(claimUnixSocket(socketPath), /Could not tell whether/);
  assert.ok((await lstat(socketPath)).isSocket());
});

test('regular files and symlinks at the socket path are left alone', async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, 'gateway.sock');

  await writeFile(socketPath, 'not a socket');
  await assert.rejects(claimUnixSocket(socketPath), /not a socket/);
  assert.equal(await readFile(socketPath, 'utf8'), 'not a socket');
  await rm(socketPath);

  // Even a symlink to a genuinely stale socket is not followed or unlinked.
  const target = join(directory, 'target.sock');
  await staleSocket(target);
  await symlink(target, socketPath);
  await assert.rejects(claimUnixSocket(socketPath), /not a socket/);
  assert.ok((await lstat(socketPath)).isSymbolicLink());
  assert.ok((await lstat(target)).isSocket());
});

test('the lifetime lock admits one gateway and refuses a symlinked lock file', async (context) => {
  const directory = await temporaryDirectory(context);
  const socketPath = join(directory, 'gateway.sock');

  const first = await claimUnixSocket(socketPath);
  await assert.rejects(claimUnixSocket(socketPath), /Another phone gateway/);
  await first.release();
  const again = await claimUnixSocket(socketPath);
  await again.release();

  const other = join(directory, 'other');
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(directory, 'elsewhere.lock'), '');
  await symlink(join(directory, 'elsewhere.lock'), join(other, 'gateway.sock.lock'));
  await assert.rejects(claimUnixSocket(join(other, 'gateway.sock')), /symbolic link/);
});

test('the device store refuses a symlinked state directory', async (context) => {
  const directory = await temporaryDirectory(context);
  const real = join(directory, 'real-state');
  await mkdir(real, { mode: 0o700 });
  await symlink(real, join(directory, 'state'));

  await assert.rejects(new DeviceStore(join(directory, 'state')).prepare(), /symbolic link/);

  // The existing permission check still applies.
  await chmod(real, 0o755);
  await assert.rejects(new DeviceStore(real).prepare(), /must not be accessible/);
});

// ---- Options ---------------------------------------------------------------------

test('Unix socket mode requires https origins and no TCP settings', () => {
  const base = {
    stateDirectory: '/nonexistent',
    controlSocket: '/nonexistent',
    sessionsDirectory: '/nonexistent',
    appDirectory: '/nonexistent',
    log: () => {},
  };

  checkGatewayOptions({ ...base, socketPath: '/run/x/gateway.sock', origins: [tailnetOrigin] });

  assert.throws(
    () => checkGatewayOptions({ ...base, socketPath: '/run/x/gateway.sock', origins: [] }),
    /at least one https origin/,
  );
  assert.throws(
    () =>
      checkGatewayOptions({
        ...base,
        socketPath: '/run/x/gateway.sock',
        origins: ['http://127.0.0.1:8787'],
      }),
    /https origins only/,
  );
  assert.throws(
    () => checkGatewayOptions({ ...base, socketPath: 'gateway.sock', origins: [tailnetOrigin] }),
    /must be absolute/,
  );
  assert.throws(
    () =>
      checkGatewayOptions({
        ...base,
        socketPath: '/run/x/gateway.sock',
        origins: [tailnetOrigin],
        host: '127.0.0.1',
      } as never),
    /no host, port or TLS/,
  );
  for (const login of ['', ' ', 'user @github', 'user@github\n']) {
    assert.throws(
      () =>
        checkGatewayOptions({
          ...base,
          socketPath: '/run/x/gateway.sock',
          origins: [tailnetOrigin],
          requireTailscaleLogin: login,
        }),
      /required Tailscale login/,
    );
  }
});

// ---- Serving over the socket --------------------------------------------------

test('the socket is private and removed on close; a second gateway is refused', async (context) => {
  const { fixture, gateway, socketPath } = await unixFixture(context);

  const info = await lstat(socketPath);
  assert.ok(info.isSocket());
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(gateway.address, `unix:${socketPath}`);

  const second = new Gateway({
    socketPath,
    origins: [tailnetOrigin],
    // Its own pairing state, so the socket's lifetime lock is what refuses it.
    stateDirectory: join(fixture.directory, 'second-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: () => {},
  });
  await assert.rejects(second.start(), /Another phone gateway holds .*gateway\.sock\.lock/);
  assert.ok((await lstat(socketPath)).isSocket());

  await gateway.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('Host, Origin and authentication are enforced over the socket', async (context) => {
  const { socketPath, pair } = await unixFixture(context);

  // HTTP: a foreign Host is misdirected; the tailnet Host is served.
  const rebound = await unixRequest(socketPath, {
    path: '/',
    headers: { Host: 'rebound.example' },
  });
  assert.equal(rebound.status, 421);
  const served = await unixRequest(socketPath, { path: '/', headers: { Host: tailnetHost } });
  assert.equal(served.status, 503); // no app built in the fixture, but routed

  // Pairing needs the allowed Origin.
  const pairing = await unixRequest(socketPath, {
    method: 'POST',
    path: '/api/pair',
    headers: {
      Host: tailnetHost,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(pairing.status, 403);

  // WebSocket: 421 for a foreign Host, 403 for a foreign Origin.
  await assert.rejects(unixPhone(socketPath, undefined, { Host: 'rebound.example' }), /HTTP 421/);
  await assert.rejects(
    unixPhone(socketPath, undefined, { Origin: 'https://evil.example' }),
    /HTTP 403/,
  );

  // Upgraded (101) but unauthenticated or wrongly authenticated: no data.
  const silent = await unixPhone(socketPath, undefined);
  assert.equal((await silent.closed).code, 4408);
  assert.equal(silent.messages.length, 0);
  const wrong = await unixPhone(socketPath, 'x'.repeat(43));
  assert.equal((await wrong.closed).code, 4401);
  assert.equal(wrong.messages.length, 0);

  // A paired device authenticates and receives state.
  const { token } = await pair();
  const phone = await unixPhone(socketPath, token);
  context.after(async () => {
    phone.socket.terminate();
  });
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
  await waitFor(() => phone.messages.some((message) => message.type === 'engine'));
});

test('Funnel requests are refused in Unix socket and TCP modes', async (context) => {
  const { fixture, socketPath, logs } = await unixFixture(context);
  const funnel = { 'Tailscale-Funnel-Request': '?1' };

  const http = await unixRequest(socketPath, {
    path: '/',
    headers: { Host: tailnetHost, ...funnel },
  });
  assert.equal(http.status, 403);
  await assert.rejects(unixPhone(socketPath, undefined, funnel), /HTTP 403/);
  assert.ok(logs.some((line) => line.includes('Funnel')));

  // TCP loopback mode gets the same protection behind a TCP Serve route.
  const tcp = await fetch(`${fixture.origin}/`, { headers: funnel });
  assert.equal(tcp.status, 403);
  const plain = await fetch(`${fixture.origin}/`);
  assert.equal(plain.status, 503);
});

test('a required Tailscale login must match exactly', async (context) => {
  const login = 'synthetic-user@github';
  const { socketPath, logs, pair } = await unixFixture(context, {
    requireTailscaleLogin: login,
  });

  // Missing, different and differently cased logins are refused.
  const refused: Record<string, string>[] = [
    {},
    { 'Tailscale-User-Login': 'someone-else@github' },
    { 'Tailscale-User-Login': login.toUpperCase() },
  ];
  for (const headers of refused) {
    const response = await unixRequest(socketPath, {
      path: '/',
      headers: { Host: tailnetHost, ...headers },
    });
    assert.equal(response.status, 403);
    await assert.rejects(unixPhone(socketPath, undefined, headers), /HTTP 403/);
  }

  // The offered login is never written to the log.
  assert.ok(logs.some((line) => line.includes('Tailscale login')));
  assert.ok(logs.every((line) => !line.includes('someone-else')));

  // The right login reaches the normal checks and a paired device connects.
  const allowed = await unixRequest(socketPath, {
    path: '/',
    headers: { Host: tailnetHost, 'Tailscale-User-Login': login },
  });
  assert.equal(allowed.status, 503);

  const { token } = await pair();
  const phone = await unixPhone(socketPath, token, { 'Tailscale-User-Login': login });
  context.after(async () => {
    phone.socket.terminate();
  });
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
});

test('a duplicated login header is refused', async (context) => {
  const login = 'synthetic-user@github';
  const { socketPath } = await unixFixture(context, { requireTailscaleLogin: login });

  // Raw request so the header really appears twice on the wire.
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ socketPath, path: '/', method: 'GET' }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.setHeader('Host', tailnetHost);
    request.setHeader('Tailscale-User-Login', [login, login]);
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('Funnel and login refusals cover the app routes and every upgrade path', async (context) => {
  const login = 'synthetic-user@github';
  const { socketPath } = await unixFixture(context, { requireTailscaleLogin: login });
  const allowed = { Host: tailnetHost, 'Tailscale-User-Login': login };

  // The phone app list and app-open endpoints: refused before authentication.
  const funnelList = await unixRequest(socketPath, {
    path: '/api/apps',
    headers: { ...allowed, 'Tailscale-Funnel-Request': '?1' },
  });
  assert.equal(funnelList.status, 403);
  const strangerOpen = await unixRequest(socketPath, {
    method: 'POST',
    path: '/api/apps/notebook/open',
    headers: { Host: tailnetHost, Origin: tailnetOrigin, 'Tailscale-User-Login': 'x@github' },
  });
  assert.equal(strangerOpen.status, 403);

  // With the right login they reach the normal device-token check.
  const unpaired = await unixRequest(socketPath, { path: '/api/apps', headers: allowed });
  assert.equal(unpaired.status, 401);

  // An upgrade to any path is refused with 403 when marked as Funnel.
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      path: '/not-the-socket',
      headers: {
        ...allowed,
        'Tailscale-Funnel-Request': '?1',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
      },
    });
    request.on('upgrade', () => reject(Error('unexpected upgrade')));
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('a start that fails after claiming the socket releases the lock', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());

  // A socket path longer than the kernel's sun_path limit: the claim works
  // (it never binds), then listen() fails with EINVAL.
  const directory = join(fixture.directory, 'x'.repeat(120));
  await mkdir(directory, { mode: 0o700 });
  const socketPath = join(directory, 'gateway.sock');

  const gateway = new Gateway({
    socketPath,
    origins: [tailnetOrigin],
    stateDirectory: join(fixture.directory, 'unix-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: () => {},
  });
  await assert.rejects(gateway.start());

  // The lifetime lock was released by the rollback, so a new claim succeeds.
  const claim = await claimUnixSocket(socketPath);
  await claim.release();
  await gateway.close();
});

test('closing stops the gateway socket before waiting for the app proxy', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());

  const socketDirectory = join(fixture.directory, 'phone');
  await mkdir(socketDirectory, { mode: 0o700 });
  const socketPath = join(socketDirectory, 'gateway.sock');
  const appsPort = await freePort();

  const gateway = new Gateway({
    socketPath,
    origins: [tailnetOrigin],
    stateDirectory: join(fixture.directory, 'unix-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    apps: {
      host: '127.0.0.1',
      port: appsPort,
      origins: [],
      registryDirectory: join(fixture.directory, 'apps'),
    },
    log: () => {},
  });
  await gateway.start();

  // A local peer holds a refused CONNECT to the app proxy open. The app proxy
  // now destroys refused sockets itself (see apps-proxy.test.ts); this test
  // still checks that the gateway releases its own socket first.
  const holder = createConnection({ host: '127.0.0.1', port: appsPort, allowHalfOpen: true });
  holder.on('error', () => {});

  // Registered before any wait that can fail: an early failure must still
  // release the held connection and close the gateway (close() is idempotent).
  context.after(async () => {
    holder.destroy();
    await gateway.close();
  });

  const refusal = readStatusLine(holder);
  holder.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  assert.match(await refusal, /^HTTP\/1\.1 405/);

  const closing = gateway.close();

  try {
    // The gateway socket is gone and its lock free, whatever the app proxy does.
    await waitFor(() => !existsSync(socketPath), 2000);
    const claim = await claimUnixSocket(socketPath);
    await claim.release();
  } finally {
    holder.destroy();
    await closing;
  }
});

test('a failed start reports its error even if the app proxy never finishes closing', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());

  // The socket directory is group-accessible, so the claim fails after the
  // app proxy has already started.
  const socketDirectory = join(fixture.directory, 'shared');
  await mkdir(socketDirectory, { mode: 0o700 });
  await chmod(socketDirectory, 0o750);

  const gateway = new Gateway({
    socketPath: join(socketDirectory, 'gateway.sock'),
    origins: [tailnetOrigin],
    stateDirectory: join(fixture.directory, 'unix-state'),
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    apps: {
      host: '127.0.0.1',
      port: await freePort(),
      origins: [],
      registryDirectory: join(fixture.directory, 'apps'),
    },
    log: () => {},
  });

  // Simulate an app proxy whose close() waits forever on a held connection.
  const appProxy = gateway.apps!;
  const realClose = appProxy.close.bind(appProxy);
  appProxy.close = () => new Promise<void>(() => {});
  context.after(() => realClose());

  // Bounded, so a regression fails the test instead of hanging it.
  const hung = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(Error('start() never reported its error')), 8000).unref();
  });
  const startedAt = Date.now();
  await assert.rejects(
    Promise.race([gateway.start(), hung]),
    /must not be accessible to other users/,
  );
  assert.ok(Date.now() - startedAt < 4000, 'the startup error is reported within the bound');
});

// ---- One gateway per pairing state -------------------------------------------

test('one pairing state serves one gateway at a time, whether TCP or Unix socket', async (context) => {
  // The fixture's TCP gateway serves remote-state.
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  const stateDirectory = join(fixture.directory, 'remote-state');
  const socketDirectory = join(fixture.directory, 'phone');
  await mkdir(socketDirectory, { mode: 0o700 });
  const socketPath = join(socketDirectory, 'gateway.sock');

  const unixGateway = () =>
    new Gateway({
      socketPath,
      origins: [tailnetOrigin],
      stateDirectory,
      controlSocket: fixture.desktop.socketPath,
      sessionsDirectory: join(fixture.directory, '.companion-sessions'),
      appDirectory: join(fixture.directory, 'no-app'),
      log: () => {},
    });
  const tcpGateway = () =>
    new Gateway({
      host: '127.0.0.1',
      port: fixture.port,
      origins: [fixture.origin],
      stateDirectory,
      controlSocket: fixture.desktop.socketPath,
      sessionsDirectory: join(fixture.directory, '.companion-sessions'),
      appDirectory: join(fixture.directory, 'no-app'),
      log: () => {},
    });

  // A Unix socket gateway on the same state is refused while TCP serves it,
  // and leaves no socket or socket lock behind.
  const refusedUnix = unixGateway();
  await assert.rejects(refusedUnix.start(), /serving this pairing state holds .*gateway\.lock/);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
  const socketClaim = await claimUnixSocket(socketPath);
  await socketClaim.release();

  // Pairing transactions (the CLI's state.lock) still work meanwhile.
  const { token } = await fixture.pair();

  // Handover: stop TCP first, then the socket gateway starts on the same
  // pairing, and the TCP one cannot come back while it runs.
  await fixture.gateway.close();
  const socketGateway = unixGateway();
  await socketGateway.start();
  context.after(() => socketGateway.close());
  await assert.rejects(tcpGateway().start(), /serving this pairing state/);

  const phone = await unixPhone(socketPath, token);
  context.after(async () => {
    phone.socket.terminate();
  });
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));

  // Once the socket gateway stops, TCP may serve the state again.
  await socketGateway.close();
  const tcpAgain = tcpGateway();
  await tcpAgain.start();
  await tcpAgain.close();
});

test('a failed start releases the pairing state for the next gateway', async (context) => {
  const directory = await temporaryDirectory(context);
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  const stateDirectory = join(directory, 'state');

  // A group-accessible socket directory makes the start fail after the state lock.
  const shared = join(directory, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o750);
  const failing = new Gateway({
    socketPath: join(shared, 'gateway.sock'),
    origins: [tailnetOrigin],
    stateDirectory,
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: () => {},
  });
  await assert.rejects(failing.start(), /must not be accessible to other users/);

  const privateDirectory = join(directory, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const next = new Gateway({
    socketPath: join(privateDirectory, 'gateway.sock'),
    origins: [tailnetOrigin],
    stateDirectory,
    controlSocket: fixture.desktop.socketPath,
    sessionsDirectory: join(fixture.directory, '.companion-sessions'),
    appDirectory: join(fixture.directory, 'no-app'),
    log: () => {},
  });
  await next.start();
  await next.close();
});
