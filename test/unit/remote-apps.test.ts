import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppRegistry } from '../../src/apps/registry.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { freePort, remoteFixture } from '../remote-fixture.ts';

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

  const appsPort = await freePort();
  const budgetOrigin = `http://budget.localhost:${appsPort}`;
  const fixture = await remoteFixture({
    gateway: {
      apps: {
        host: '127.0.0.1',
        port: appsPort,
        origins: [
          ['budget', budgetOrigin],
          ['hidden', `http://hidden.localhost:${appsPort}`],
        ],
        registryDirectory: join(root, 'apps'),
      },
    },
  });
  context.after(() => fixture.close());
  assert.equal(fixture.gateway.apps?.port, appsPort);

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
