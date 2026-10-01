import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  checkServeRoute,
  checkServeRouteAtStartup,
  expectedServeRoute,
  ServeRouteWatch,
  serveConfigMismatch,
} from '../../src/remote/tailscale-serve-check.ts';
import { freePort, readStatusLine, waitFor, within } from '../remote-fixture.ts';

/**
 * The read-only Tailscale Serve check (`--check-tailscale-serve`) and the
 * `companion-remote serve` flags around it. A fake `tailscale` script prints
 * synthetic `serve status --json` output; the real Tailscale is never run.
 */

const hostname = 'desk.example-tailnet.ts.net';
const socketPath = '/run/user/1000/companion-phone/gateway.sock';
const expected = { hostname, socketPath };

/** The only configuration the check accepts. */
function exactConfig(): any {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${hostname}:443`]: { Handlers: { '/': { Proxy: `unix:${socketPath}` } } },
    },
  };
}

test('only the exact background route to our socket matches', () => {
  assert.equal(serveConfigMismatch(exactConfig(), expected), undefined);

  // Empty values from other Tailscale versions are harmless.
  const withEmpties = exactConfig();
  withEmpties.AllowFunnel = {};
  withEmpties.Services = null;
  withEmpties.TCP['443'].HTTP = false;
  assert.equal(serveConfigMismatch(withEmpties, expected), undefined);

  const variants: [string, (config: any) => void][] = [
    ['Funnel enabled', (config) => (config.AllowFunnel = { [`${hostname}:443`]: true })],
    ['foreground session', (config) => (config.Foreground = { session: exactConfig() })],
    ['services', (config) => (config.Services = { 'svc:x': {} })],
    ['extra port', (config) => (config.TCP['8443'] = { HTTPS: true })],
    ['TCP forward', (config) => (config.TCP['443'] = { TCPForward: '127.0.0.1:1' })],
    ['HTTP instead of HTTPS', (config) => (config.TCP['443'] = { HTTP: true })],
    [
      'other host',
      (config) =>
        (config.Web = { 'other.example-tailnet.ts.net:443': config.Web[`${hostname}:443`] }),
    ],
    [
      'extra handler',
      (config) => (config.Web[`${hostname}:443`].Handlers['/admin'] = { Text: 'x' }),
    ],
    [
      'TCP target',
      (config) =>
        (config.Web[`${hostname}:443`].Handlers['/'] = { Proxy: 'http://127.0.0.1:18787' }),
    ],
    [
      'other socket',
      (config) => (config.Web[`${hostname}:443`].Handlers['/'] = { Proxy: 'unix:/tmp/other.sock' }),
    ],
    ['text handler', (config) => (config.Web[`${hostname}:443`].Handlers['/'].Text = 'hello')],
  ];
  for (const [name, change] of variants) {
    const config = exactConfig();
    change(config);
    assert.notEqual(serveConfigMismatch(config, expected), undefined, name);
  }

  // Today's foreground-only setup, and nothing at all, do not match.
  const foregroundOnly = { Foreground: { session: exactConfig() } };
  assert.notEqual(serveConfigMismatch(foregroundOnly, expected), undefined);
  assert.notEqual(serveConfigMismatch({}, expected), undefined);
  assert.notEqual(serveConfigMismatch([], expected), undefined);
  assert.notEqual(serveConfigMismatch(null, expected), undefined);
});

test('the Serve check needs a Unix socket and one https origin on port 443', () => {
  assert.deepEqual(expectedServeRoute([`https://${hostname}`], socketPath), expected);
  assert.throws(() => expectedServeRoute([`https://${hostname}`], undefined), /--listen unix/);
  assert.throws(() => expectedServeRoute([], socketPath), /exactly one --origin/);
  assert.throws(
    () => expectedServeRoute([`https://${hostname}`, 'https://other.example'], socketPath),
    /exactly one --origin/,
  );
  assert.throws(
    () => expectedServeRoute([`https://${hostname}:8443`], socketPath),
    /default port 443/,
  );
});

/** Poll an asynchronous condition (such as the fake's call count). */
async function waitUntil(condition: () => Promise<boolean>, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A fake `tailscale` that prints whatever the status file currently holds
 * (and fails when there is none), counting its calls. Status updates are
 * atomic renames so a check never reads a half-written file.
 */
async function fakeTailscale(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-serve-check-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const binDirectory = join(directory, 'bin');
  await mkdir(binDirectory);
  const statusFile = join(directory, 'status.json');
  const callsFile = join(directory, 'calls');
  const command = join(binDirectory, 'tailscale');
  await writeFile(
    command,
    [
      '#!/bin/sh',
      `echo call >> ${JSON.stringify(callsFile)}`,
      '[ "$*" = "serve status --json" ] || exit 64',
      `exec cat ${JSON.stringify(statusFile)}`,
      '',
    ].join('\n'),
  );
  await chmod(command, 0o755);

  async function writeStatus(text: string): Promise<void> {
    const temporary = `${statusFile}.tmp`;
    await writeFile(temporary, text);
    await rename(temporary, statusFile);
  }

  return {
    directory,
    binDirectory,
    command,
    setStatus: (value: unknown) => writeStatus(JSON.stringify(value)),
    setRawStatus: writeStatus,
    clearStatus: () => rm(statusFile, { force: true }),
    calls: async () => {
      try {
        return (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

test('an unreadable Serve status is reported apart from a mismatch', async (context) => {
  const fake = await fakeTailscale(context);

  // No status file: the command fails.
  const failed = await checkServeRoute(expected, fake.command);
  assert.equal(failed.status, 'unreadable');
  assert.match(failed.status === 'unreadable' ? failed.reason : '', /Could not read/);

  await fake.setRawStatus('not json');
  const garbled = await checkServeRoute(expected, fake.command);
  assert.equal(garbled.status, 'unreadable');
  assert.match(garbled.status === 'unreadable' ? garbled.reason : '', /not valid JSON/);

  await fake.setStatus({});
  assert.equal((await checkServeRoute(expected, fake.command)).status, 'mismatch');

  await fake.setStatus(exactConfig());
  assert.deepEqual(await checkServeRoute(expected, fake.command), { status: 'match' });
});

test('startup retries only an unreadable status, and still fails closed', async (context) => {
  const fake = await fakeTailscale(context);
  const retry = { attempts: 4, delayMilliseconds: 30 };

  // Unreadable throughout: every attempt is used, then it gives up.
  const never = await checkServeRouteAtStartup(expected, fake.command, retry);
  assert.equal(never.status, 'unreadable');
  assert.equal(await fake.calls(), 4);

  // A mismatch is final at once: no retry.
  await fake.setStatus({});
  const mismatch = await checkServeRouteAtStartup(expected, fake.command, retry);
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(await fake.calls(), 5);

  // tailscaled comes back during the retries: the start proceeds.
  await fake.clearStatus();
  const recovering = checkServeRouteAtStartup(expected, fake.command, {
    attempts: 20,
    delayMilliseconds: 30,
  });
  await waitUntil(async () => (await fake.calls()) >= 7);
  await fake.setStatus(exactConfig());
  assert.deepEqual(await recovering, { status: 'match' });
});

test('the watch reports a mismatch once and at once', async (context) => {
  const fake = await fakeTailscale(context);
  await fake.setStatus(exactConfig());

  const reasons: string[] = [];
  const watch = new ServeRouteWatch(expected, {
    tailscaleCommand: fake.command,
    intervalMilliseconds: 20,
    maximumConsecutiveUnreadable: 1000,
    onMismatch: (reason) => reasons.push(reason),
  });
  watch.start();
  context.after(async () => watch.stop());

  // Several matching checks pass silently.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(reasons, []);

  const funnel = exactConfig();
  funnel.AllowFunnel = { [`${hostname}:443`]: true };
  await fake.setStatus(funnel);
  await waitFor(() => reasons.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /other than one background HTTPS route/);
});

test('the watch tolerates a few unreadable checks in a row, not more', async (context) => {
  const fake = await fakeTailscale(context);
  await fake.setStatus(exactConfig());

  // Stepped by hand (no timer) so the sequence is exact under any load.
  const reasons: string[] = [];
  const watch = new ServeRouteWatch(expected, {
    tailscaleCommand: fake.command,
    intervalMilliseconds: 60_000,
    maximumConsecutiveUnreadable: 3,
    onMismatch: (reason) => reasons.push(reason),
  });
  context.after(async () => watch.stop());

  // Two unreadable checks, then a matching one: the count resets.
  await fake.clearStatus();
  await watch.checkOnce();
  await watch.checkOnce();
  await fake.setStatus(exactConfig());
  await watch.checkOnce();
  assert.deepEqual(reasons, []);

  // Two more unreadable checks are still tolerated after the reset...
  await fake.clearStatus();
  await watch.checkOnce();
  await watch.checkOnce();
  assert.deepEqual(reasons, []);

  // ...and the third in a row stops the watch, reported once.
  await watch.checkOnce();
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Could not read/);
  await watch.checkOnce();
  assert.equal(reasons.length, 1);
  assert.equal(await fake.calls(), 6); // the stopped watch no longer reads
});

// ---- companion-remote serve flags ---------------------------------------------

/** Run `companion-remote` with extra PATH entries; resolves when it exits. */
function runCli(
  args: string[],
  pathPrefix?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/remote/cli.ts', ...args],
      {
        env: {
          ...process.env,
          PATH: pathPrefix ? pathPrefix + delimiter + process.env.PATH : process.env.PATH,
        },
        timeout: 30_000,
      },
      (error, _stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr });
      },
    );
  });
}

/** Temporary state/socket paths for the CLI; never the live runtime paths. */
async function cliPaths(directory: string) {
  const socketDirectory = join(directory, 'phone');
  await mkdir(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, 'gateway.sock');
  return {
    socket,
    common: [
      '--state-directory',
      join(directory, 'state'),
      '--control-socket',
      join(directory, 'no-listener.sock'),
      '--sessions-directory',
      join(directory, 'sessions'),
      '--app-directory',
      join(directory, 'no-app'),
    ],
  };
}

test('--listen cannot be mixed with TCP flags and needs an https origin', async (context) => {
  const fake = await fakeTailscale(context);
  const { socket, common } = await cliPaths(fake.directory);

  const mixed = await runCli(['serve', '--listen', `unix:${socket}`, '--port', '9999', ...common]);
  assert.equal(mixed.code, 2);
  assert.match(mixed.stderr, /cannot be combined/);

  const tcpForm = await runCli(['serve', '--listen', '127.0.0.1:9999', ...common]);
  assert.equal(tcpForm.code, 2);
  assert.match(tcpForm.stderr, /unix:/);

  const noOrigin = await runCli(['serve', '--listen', `unix:${socket}`, ...common]);
  assert.equal(noOrigin.code, 1);
  assert.match(noOrigin.stderr, /at least one https origin/);

  const checkOverTcp = await runCli([
    'serve',
    '--port',
    '9999',
    '--origin',
    `https://${hostname}`,
    '--check-tailscale-serve',
    ...common,
  ]);
  assert.equal(checkOverTcp.code, 2);
  assert.match(checkOverTcp.stderr, /requires --listen unix/);

  await assert.rejects(lstat(socket), { code: 'ENOENT' });
});

test('serve refuses to start unless Tailscale Serve matches, and stops cleanly', async (context) => {
  const fake = await fakeTailscale(context);
  const { socket, common } = await cliPaths(fake.directory);
  const args = [
    'serve',
    '--listen',
    `unix:${socket}`,
    '--origin',
    `https://${hostname}`,
    '--require-tailscale-login',
    'synthetic-user@github',
    '--check-tailscale-serve',
    ...common,
  ];

  // Today's foreground TCP route: refused before binding.
  await fake.setStatus({
    Foreground: {
      session: {
        TCP: { '443': { HTTPS: true } },
        Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:18787' } } } },
      },
    },
  });
  const refused = await runCli(args, fake.binDirectory);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Not starting/);
  await assert.rejects(lstat(socket), { code: 'ENOENT' });

  // The exact route to this socket: it serves until SIGTERM, then exits 0
  // and removes the socket (the watch timer must not keep it alive).
  const matching = exactConfig();
  matching.Web = {
    [`${hostname}:443`]: { Handlers: { '/': { Proxy: `unix:${socket}` } } },
  };
  await fake.setStatus(matching);

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/remote/cli.ts', ...args], {
    env: { ...process.env, PATH: fake.binDirectory + delimiter + process.env.PATH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  context.after(async () => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor(() => stderr.includes('Pair a phone'), 20_000);
  assert.match(
    stderr,
    new RegExp(`Serving on unix:${socket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(stderr, /Tailscale Serve route verified/);
  assert.ok(!stderr.includes('synthetic-user@github'), 'the required login is not logged');
  assert.equal((await lstat(socket)).mode & 0o777, 0o600);

  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  await assert.rejects(lstat(socket), { code: 'ENOENT' });
});

test('serve warns when the login check or Serve check gives less protection', async (context) => {
  const fake = await fakeTailscale(context);
  const { socket, common } = await cliPaths(fake.directory);

  /** Start the CLI, wait until it serves, stop it, and return its stderr. */
  async function serveOnce(args: string[]): Promise<string> {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/remote/cli.ts', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    context.after(async () => {
      child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    await waitFor(() => stderr.includes('Pair a phone'), 20_000);
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    return stderr;
  }

  // TCP mode on a temporary loopback port: the login header can be forged.
  const port = await freePort();
  const tcp = await serveOnce([
    'serve',
    '--port',
    String(port),
    '--require-tailscale-login',
    'synthetic-user@github',
    ...common,
  ]);
  assert.match(tcp, /Warning: --require-tailscale-login on a TCP port/);
  assert.ok(!tcp.includes('synthetic-user@github'));

  // Unix mode without the login and Serve checks.
  const bare = await serveOnce([
    'serve',
    '--listen',
    `unix:${socket}`,
    '--origin',
    `https://${hostname}`,
    ...common,
  ]);
  assert.match(bare, /Warning: serving a Unix socket without --require-tailscale-login/);
  await assert.rejects(lstat(socket), { code: 'ENOENT' });
});

test('a runtime Serve mismatch stops serving with exit 1 despite open connections', async (context) => {
  const fake = await fakeTailscale(context);
  const { socket, common } = await cliPaths(fake.directory);

  const matching = exactConfig();
  matching.Web = { [`${hostname}:443`]: { Handlers: { '/': { Proxy: `unix:${socket}` } } } };
  await fake.setStatus(matching);

  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/remote/cli.ts',
      'serve',
      '--listen',
      `unix:${socket}`,
      '--origin',
      `https://${hostname}`,
      '--check-tailscale-serve',
      ...common,
    ],
    {
      env: {
        ...process.env,
        PATH: fake.binDirectory + delimiter + process.env.PATH,
        COMPANION_REMOTE_SERVE_CHECK_MILLISECONDS: '100',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  context.after(async () => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = once(child, 'exit');
  await waitFor(() => stderr.includes('Pair a phone'), 20_000);

  // Peers that never close their side: a refused upgrade (the socket now
  // belongs to the gateway, not the HTTP server) and an idle half-request.
  const refusedUpgrade = createConnection({ path: socket, allowHalfOpen: true });
  const halfRequest = createConnection({ path: socket, allowHalfOpen: true });
  const halfRequestConnected = once(halfRequest, 'connect');
  context.after(async () => {
    refusedUpgrade.destroy();
    halfRequest.destroy();
  });
  refusedUpgrade.on('error', () => {});
  halfRequest.on('error', () => {});

  // Proceed only once each connection is known to have reached the gateway:
  // the upgrade has been answered, and a probe request on the half-request's
  // server shows the connection was accepted before it.
  const refusal = readStatusLine(refusedUpgrade);
  refusedUpgrade.write(
    'GET /elsewhere HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
  );
  assert.match(await refusal, /^HTTP\/1\.1 404/);
  await within(halfRequestConnected, 5000, 'the idle connection');
  halfRequest.write('GET / HTTP/1.1\r\nHost: ');
  const probeResponse = new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      socketPath: socket,
      path: '/',
      headers: { Host: 'localhost', 'X-Forwarded-Host': hostname },
    });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(await within(probeResponse, 5000, 'the probe request'), 503);

  // Funnel gets switched on: the next check stops the gateway, promptly and
  // by closing normally rather than through the shutdown deadline.
  const funnel = structuredClone(matching);
  funnel.AllowFunnel = { [`${hostname}:443`]: true };
  const changedAt = Date.now();
  await fake.setStatus(funnel);

  // Bounded, so a broken watch fails the test instead of hanging it.
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(Error('the gateway did not stop')), 10_000).unref();
  });
  const [code] = await Promise.race([exited, timeout]);
  assert.equal(code, 1);
  assert.ok(Date.now() - changedAt < 4000, 'stopped well before the 5 s deadline');
  assert.match(stderr, /Stopping: Serve has settings other than/);
  assert.ok(!stderr.includes('did not finish'));
  await assert.rejects(lstat(socket), { code: 'ENOENT' });
});
