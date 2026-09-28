import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { backendEnvironment, runApp } from '../../src/apps/launcher.ts';
import type { RegisteredApp } from '../../src/apps/registry.ts';

/**
 * The foreground lifecycle with a synthetic backend script: argv without a
 * shell, readiness, owned process-group shutdown, busy-port refusal and the
 * Companion-free environment. Loopback ports and temporary files only.
 */

const backendScript = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [port, markers, mode] = process.argv.slice(2);
writeFileSync(markers + '/argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync(markers + '/env.json', JSON.stringify(Object.keys(process.env)));

// A helper in the same process group, like a worker a real app might spawn.
const helper = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync(markers + '/helper.pid', String(helper.pid));

if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
}
if (mode === 'exit') {
  setTimeout(() => process.exit(7), 200);
}
if (mode === 'never-listen') {
  setInterval(() => {}, 1000);
} else {
  createServer((request, response) => response.end('ok')).listen(Number(port), '127.0.0.1');
}
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixture(context: { after(callback: () => Promise<void>): void }, mode = 'serve') {
  const directory = await mkdtemp(join(tmpdir(), 'companion-apps-launcher-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const script = join(directory, 'backend.mjs');
  await writeFile(script, backendScript);
  const port = await freePort();

  const app: RegisteredApp = {
    id: 'fixture',
    registrationId: '00000000-0000-4000-8000-000000000001',
    name: 'Fixture',
    upstream: `http://127.0.0.1:${port}`,
    launch: {
      argv: [process.execPath, script, String(port), directory, mode, '; touch INJECTED $(id)'],
      cwd: directory,
    },
    phoneAccess: false,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };

  return { directory, port, app };
}

test('runs argv without a shell, reports readiness and stops its whole process group', async (context) => {
  const { directory, app } = await fixture(context);
  const controller = new AbortController();

  process.env.COMPANION_TEST_SECRET = 'must-not-leak';
  context.after(async () => {
    delete process.env.COMPANION_TEST_SECRET;
  });

  let ready = false;
  const result = runApp(app, {
    signal: controller.signal,
    output: 'ignore',
    stopGraceMilliseconds: 2000,
    onReady: () => {
      ready = true;
      controller.abort();
    },
  });

  const outcome = await result;
  assert.equal(ready, true);
  assert.equal(outcome.becameReady, true);
  assert.equal(outcome.stoppedByRequest, true);

  // The shell-looking argument arrived as one literal argument; nothing ran it.
  const argv = JSON.parse(await readFile(join(directory, 'argv.json'), 'utf8')) as string[];
  assert.equal(argv[3], '; touch INJECTED $(id)');
  await assert.rejects(access(join(directory, 'INJECTED')));

  const environment = JSON.parse(await readFile(join(directory, 'env.json'), 'utf8')) as string[];
  assert.equal(environment.includes('COMPANION_TEST_SECRET'), false);

  const helper = Number(await readFile(join(directory, 'helper.pid'), 'utf8'));
  await waitUntil(() => !processAlive(helper));
});

test('a backend ignoring SIGTERM is killed after the grace period', async (context) => {
  const { directory, app } = await fixture(context, 'ignore-term');
  const controller = new AbortController();

  const started = Date.now();
  const outcome = await runApp(app, {
    signal: controller.signal,
    output: 'ignore',
    stopGraceMilliseconds: 300,
    onReady: () => controller.abort(),
  });

  assert.equal(outcome.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 10_000);

  const helper = Number(await readFile(join(directory, 'helper.pid'), 'utf8'));
  await waitUntil(() => !processAlive(helper));
});

test('refuses to start when something else already listens on the port', async (context) => {
  const { directory, port, app } = await fixture(context);

  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

  await assert.rejects(runApp(app, { output: 'ignore' }), /already listening/);
  // Nothing was started: the backend never wrote its markers.
  await assert.rejects(access(join(directory, 'argv.json')));
});

test('reports a backend that exits by itself and ends its leftover helpers', async (context) => {
  const { directory, app } = await fixture(context, 'exit');

  const outcome = await runApp(app, { output: 'ignore' });
  assert.equal(outcome.code, 7);
  assert.equal(outcome.stoppedByRequest, false);
  assert.equal(outcome.becameReady, true);

  const helper = Number(await readFile(join(directory, 'helper.pid'), 'utf8'));
  await waitUntil(() => !processAlive(helper));
});

test('a backend that never opens its port is stopped after the readiness timeout', async (context) => {
  const { app } = await fixture(context, 'never-listen');

  const outcome = await runApp(app, {
    output: 'ignore',
    readyTimeoutMilliseconds: 500,
    stopGraceMilliseconds: 500,
  });
  assert.equal(outcome.becameReady, false);
  assert.equal(outcome.stoppedByRequest, true);
});

test('apps without a launch command are not started', async (context) => {
  const { app } = await fixture(context);
  delete app.launch;

  await assert.rejects(runApp(app), /no launch command/);
});

test('the backend environment drops Companion variables only', () => {
  const environment = backendEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/user',
    COMPANION_EXTERNAL_SOCKET: '/run/x',
    COMPANION_INTERNAL_AGENT: '1',
  });

  assert.deepEqual(environment, { PATH: '/usr/bin', HOME: '/home/user' });
});

async function waitUntil(condition: () => boolean, timeoutMilliseconds = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
