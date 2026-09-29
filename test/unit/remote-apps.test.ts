import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppRegistry } from '../../src/apps/registry.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { remoteFixture } from '../remote-fixture.ts';

/**
 * The phone gateway's app list/open endpoints with a real listener control
 * socket, temporary device store and registry, a synthetic loopback backend
 * and the app proxy on a synthetic `*.localhost` origin. No live state.
 */

test('the gateway lists and opens only phone-enabled apps for paired devices', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-remote-apps-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  // Registry first: the gateway reads it for every decision.
  const registry = new AppRegistry(join(root, 'apps'));
  const backend = createServer((request, response) => response.end(`backend saw ${request.url}`));
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const backendPort = (backend.address() as { port: number }).port;

  await registry.add({ id: 'budget', name: 'Budget', upstream: `http://127.0.0.1:${backendPort}` });
  await registry.update('budget', { phoneAccess: true });
  await registry.add({ id: 'hidden', name: 'Hidden', upstream: 'http://127.0.0.1:9' });

  // The app proxy binds port 0; its public origins use a fixed synthetic port
  // that only appears in Host headers, so no port is reserved in advance.
  const publicPort = 8790;
  const budgetOrigin = `http://budget.localhost:${publicPort}`;
  const fixture = await remoteFixture({
    gateway: {
      apps: {
        host: '127.0.0.1',
        port: 0,
        origins: [
          ['budget', budgetOrigin],
          ['hidden', `http://hidden.localhost:${publicPort}`],
        ],
        registryDirectory: join(root, 'apps'),
      },
    },
  });
  context.after(() => fixture.close());
  const appsPort = fixture.gateway.apps!.port;
  assert.notEqual(appsPort, 0);

  const { token } = await fixture.pair();
  const bearer = { Authorization: `Bearer ${token}` };

  // Listing needs a paired device.
  assert.equal((await fetch(`${fixture.origin}/api/apps`)).status, 401);
  const listed = await fetch(`${fixture.origin}/api/apps`, { headers: bearer });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    apps: [{ id: 'budget', name: 'Budget', origin: budgetOrigin, running: true }],
  });

  // Opening needs POST, the gateway's exact Origin and a paired device.
  const openUrl = `${fixture.origin}/api/apps/budget/open`;
  assert.equal((await fetch(openUrl, { headers: bearer })).status, 405);
  assert.equal((await fetch(openUrl, { method: 'POST', headers: bearer })).status, 403);
  assert.equal(
    (
      await fetch(openUrl, {
        method: 'POST',
        headers: { ...bearer, Origin: budgetOrigin },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(openUrl, { method: 'POST', headers: { Origin: fixture.origin } })).status,
    401,
  );
  const hidden = await fetch(`${fixture.origin}/api/apps/hidden/open`, {
    method: 'POST',
    headers: { ...bearer, Origin: fixture.origin },
  });
  assert.equal(hidden.status, 404);

  const opened = await fetch(openUrl, {
    method: 'POST',
    headers: { ...bearer, Origin: fixture.origin },
  });
  assert.equal(opened.status, 200);
  const { url } = (await opened.json()) as { url: string };
  assert.ok(url.startsWith(`${budgetOrigin}/__companion_app_grant?grant=`));
  assert.equal(url.includes(token), false);

  // Redeem on the app origin (explicit Host: *.localhost needs no DNS here).
  const parsed = new URL(url);
  const redeemed = await get(appsPort, parsed.host, parsed.pathname + parsed.search);
  assert.equal(redeemed.status, 200);
  const cookie = String(redeemed.headers['set-cookie']?.[0]).split(';')[0];

  const page = await get(appsPort, parsed.host, '/hello', { cookie });
  assert.equal(page.status, 200);
  assert.equal(page.body, 'backend saw /hello');

  // The device token cannot be used against the app origin, even as upstream auth.
  const withToken = await get(appsPort, parsed.host, '/hello', {
    cookie,
    authorization: `Bearer ${token}`,
  });
  assert.equal(withToken.status, 400);

  // Revoking the phone ends its app session within the gateway's recheck interval.
  const [device] = await fixture.devices.devices();
  await fixture.devices.revoke(device.id);
  await fixture.gateway.apps!.sweep();
  assert.equal((await get(appsPort, parsed.host, '/hello', { cookie })).status, 401);
});

test('without app configuration the gateway offers no apps', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  const { token } = await fixture.pair();

  const listed = await fetch(`${fixture.origin}/api/apps`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await listed.json(), { apps: [] });

  const opened = await fetch(`${fixture.origin}/api/apps/budget/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: fixture.origin },
  });
  assert.equal(opened.status, 404);
  assert.equal(fixture.gateway.apps, undefined);
});

test('the gateway refuses app origins on its own host name', () => {
  assert.throws(
    () =>
      new Gateway({
        host: '127.0.0.1',
        port: 8787,
        origins: ['http://127.0.0.1:8787', 'http://localhost:8787'],
        stateDirectory: '/nonexistent',
        controlSocket: '/nonexistent',
        sessionsDirectory: '/nonexistent',
        appDirectory: '/nonexistent',
        log: () => {},
        apps: {
          host: '127.0.0.1',
          port: 8790,
          origins: [['budget', 'http://localhost:8790']],
          registryDirectory: '/nonexistent',
        },
      }),
    /gateway's host name/,
  );
});

function get(
  port: number,
  host: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host, ...headers }, agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Active server sockets and timers in this process, by kind. */
function ownedHandles(): { servers: number; timers: number } {
  const resources = process.getActiveResourcesInfo();
  return {
    servers: resources.filter((kind) => kind === 'TCPServerWrap').length,
    timers: resources.filter((kind) => kind === 'Timeout').length,
  };
}

/** Whether anything accepts TCP connections on this loopback port. */
async function listening(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

test('a gateway that fails to start releases its app proxy and keeps the original error', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-remote-apps-start-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  // Something else already holds the gateway's port.
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const occupiedPort = (blocker.address() as { port: number }).port;

  const failures: Array<{
    name: string;
    tls?: { cert: string; key: string };
    port: number;
    error: RegExp;
  }> = [
    { name: 'occupied port', port: occupiedPort, error: /EADDRINUSE/ },
    {
      name: 'unreadable TLS material',
      port: 0,
      tls: { cert: 'not a certificate', key: 'not a key' },
      error: /PEM|certificate|key|asn1|ssl/i,
    },
  ];

  for (const failure of failures) {
    // Let servers closed by earlier tests finish closing before the baseline.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = ownedHandles();

    const gateway = new Gateway({
      host: '127.0.0.1',
      port: failure.port,
      tls: failure.tls,
      origins: [`http://127.0.0.1:${failure.port}`],
      stateDirectory: join(root, failure.name.replace(/\s/g, '-')),
      controlSocket: join(root, 'no-listener.sock'),
      sessionsDirectory: join(root, 'sessions'),
      appDirectory: join(root, 'no-app'),
      log: () => {},
      apps: {
        host: '127.0.0.1',
        port: 0,
        origins: [['budget', 'http://budget.localhost:8790']],
        registryDirectory: join(root, 'apps'),
      },
    });

    // Registered before start: if a rollback ever regresses and an assertion
    // below throws, the app proxy is still closed and the file cannot hang.
    // close() is safe to repeat, so the explicit close further down stays.
    context.after(() => gateway.close());

    // Record the port the app proxy really binds (it asks for port 0).
    const apps = gateway.apps!;
    const startApps = apps.start.bind(apps);
    let boundAppsPort = 0;
    apps.start = async () => {
      await startApps();
      boundAppsPort = apps.port;
    };

    await assert.rejects(gateway.start(), failure.error, failure.name);
    assert.notEqual(boundAppsPort, 0, `${failure.name}: app proxy had started`);
    assert.equal(await listening(boundAppsPort), false, `${failure.name}: app port closed`);

    // The app proxy bound a port and then released it again.
    assert.equal(gateway.apps!.port, 0, `${failure.name}: app proxy released`);
    assert.deepEqual(ownedHandles(), before, `${failure.name}: no leaked servers or timers`);

    // Shutdown after a failed start is safe and changes nothing.
    await gateway.close();
    assert.deepEqual(ownedHandles(), before);
  }
});

test('companion-remote serve exits with the original error when its port is taken', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-remote-apps-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const occupiedPort = (blocker.address() as { port: number }).port;

  // The real CLI only accepts a concrete app proxy port (1-65535), so this
  // one test must pick a free port ahead of time. The assertion below demands
  // the error for the *gateway's* occupied port: the app proxy bound first,
  // so the rollback path really ran. In the rare case another process takes
  // this port in between, the test fails at once with a clear message; it
  // cannot hang or pass without exercising the rollback.
  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
  const appsPort = (spare.address() as { port: number }).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));

  const executable = join(import.meta.dirname, '..', '..', 'bin', 'companion-remote');
  const argumentsList = [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(occupiedPort),
    '--state-directory',
    join(root, 'state'),
    '--sessions-directory',
    join(root, 'sessions'),
    '--app-directory',
    join(root, 'static'),
    '--control-socket',
    join(root, 'no-listener.sock'),
    '--apps-listen',
    `127.0.0.1:${appsPort}`,
    '--app-origin',
    'alpha=http://alpha.localhost:8790',
    '--apps-directory',
    join(root, 'apps'),
  ];

  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve) => {
    const child = execFile(
      executable,
      argumentsList,
      { timeout: 20_000 },
      (_error, _stdout, stderr) =>
        resolve({ code: child.exitCode, signal: child.signalCode, stderr }),
    );
  });

  // Exited on its own (not killed by the timeout) with the original diagnostic.
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, new RegExp(`EADDRINUSE.*127\\.0\\.0\\.1:${occupiedPort}\\b`));
});
