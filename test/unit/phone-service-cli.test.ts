/**
 * `bin/companion-phone` as a process, with fake `systemctl`, `systemd-run`
 * and `tailscale` first on PATH (test/phone-service-fakes.ts) and a synthetic
 * checkout, config, runtime directory and listener socket. Covers opt-in and
 * no side effects, start preconditions and ordering, readiness and failure,
 * safe stop, restart order and status. `pkill`/`pgrep` are trip-wires: the
 * tool must never call them.
 *
 * The same behavior against a real systemd user manager is in
 * test/phone-service/systemd.test.ts (`npm run test:phone-service`).
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { DeviceStore } from '../../src/remote/devices.ts';
import { PhoneAccessHook } from '../../src/remote/service/desktop-hook.ts';
import { acquireLifetimeLock } from '../../src/remote/unix-socket-claim.ts';
import { createFakes, createPinnedCheckout, type Fakes } from '../phone-service-fakes.ts';

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, '..', '..', 'bin', 'companion-phone');
const origin = 'https://desk.tailnet-name.ts.net';

interface World {
  directory: string;
  fakes: Fakes;
  checkout: { path: string; revision: string };
  configFile: string;
  controlSocket: string;
  gatewaySocket: string;
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  phone(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  listen(): Promise<void>;
  exactRoute(): string;
}

async function world(context: { after(callback: () => Promise<void>): void }): Promise<World> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-phone-cli-')));
  const fakes = await createFakes();
  const listeners: Server[] = [];
  context.after(async () => {
    for (const server of listeners) {
      await new Promise((done) => server.close(done));
    }
    await fakes.cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  const checkout = await createPinnedCheckout(directory);
  const runtime = join(directory, 'run');
  await mkdir(runtime, { mode: 0o700 });
  const controlSocket = join(runtime, 'companion', 'control.sock');
  const gatewaySocket = join(runtime, 'companion-phone', 'gateway.sock');
  const configFile = join(directory, 'config', 'phone-gateway.json');
  const stateDirectory = join(directory, 'state');

  // Synthetic HOME and config home: the user's own are never read or written.
  const home = join(directory, 'home');
  await mkdir(join(home, '.config'), { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    PATH: `${fakes.binDirectory}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: runtime,
    COMPANION_PHONE_CONFIG: configFile,
  };

  const phone = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(cli, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
    });

  return {
    directory,
    fakes,
    checkout,
    configFile,
    controlSocket,
    gatewaySocket,
    stateDirectory,
    environment,
    phone,
    async listen() {
      await mkdir(join(runtime, 'companion'), { mode: 0o700, recursive: true });
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((done) => server.listen(controlSocket, done));
      listeners.push(server);
    },
    exactRoute() {
      return JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: {
          'desk.tailnet-name.ts.net:443': { Handlers: { '/': { Proxy: `unix:${gatewaySocket}` } } },
        },
      });
    },
  };
}

async function configure(w: World): Promise<void> {
  const result = await w.phone([
    'configure',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    w.checkout.revision,
    '--checkout',
    w.checkout.path,
    '--state-directory',
    w.stateDirectory,
    '--sessions-directory',
    join(w.directory, 'sessions'),
  ]);
  assert.equal(result.code, 0, result.stderr);
}

/** Everything is in place: config, listener, exact route. */
async function ready(context: { after(callback: () => Promise<void>): void }): Promise<World> {
  const w = await world(context);
  await configure(w);
  await w.listen();
  await w.fakes.set('serve-status', w.exactRoute());
  return w;
}

function names(calls: string[][]): string[] {
  return calls.map((call) => `${call[0]} ${call[2] ?? call[1] ?? ''}`.trim());
}

async function assertNeverKilledByName(w: World): Promise<void> {
  const calls = await w.fakes.calls();
  assert.ok(
    !calls.some((call) => call[0] === 'pkill' || call[0] === 'pgrep'),
    'pkill/pgrep must never run',
  );
}

test('without a config nothing happens and nothing is created', async (context) => {
  const w = await world(context);

  for (const command of ['start', 'restart', 'status', 'check-serve', 'print-service']) {
    const result = await w.phone([command]);
    assert.equal(result.code, 2, command);
    assert.match(result.stderr, /not configured/);
  }
  const json = await w.phone(['status', '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).configured, false);

  assert.deepEqual(await w.fakes.calls(), []);
  await assert.rejects(lstat(w.stateDirectory), { code: 'ENOENT' });
  await assert.rejects(lstat(w.configFile), { code: 'ENOENT' });
});

test('unknown commands and options that do not apply are usage errors', async (context) => {
  const w = await world(context);
  for (const args of [
    ['launch'],
    ['stop', '--json'],
    ['start', '--json'],
    ['status', '--bogus'],
    ['start', 'extra'],
  ]) {
    const result = await w.phone(args);
    assert.equal(result.code, 2, args.join(' '));
  }
  assert.deepEqual(await w.fakes.calls(), []);
});

test('configure writes only the config, and never overwrites one silently', async (context) => {
  const w = await world(context);
  await configure(w);

  assert.equal((await lstat(w.configFile)).mode & 0o777, 0o600);
  assert.deepEqual(await w.fakes.calls(), []);
  await assert.rejects(lstat(w.stateDirectory), { code: 'ENOENT' });

  const again = await w.phone([
    'configure',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    w.checkout.revision,
    '--checkout',
    w.checkout.path,
  ]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists; pass --replace/);

  const wrongRevision = await w.phone([
    'configure',
    '--replace',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    'b'.repeat(40),
    '--checkout',
    w.checkout.path,
  ]);
  assert.equal(wrongRevision.code, 1);
  assert.match(wrongRevision.stderr, /not at the approved revision/);

  const unsafe = await w.phone([
    'configure',
    '--replace',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    w.checkout.revision,
    '--checkout',
    w.checkout.path,
    '--state-directory',
    '/home/some one/state',
  ]);
  assert.equal(unsafe.code, 2);
  assert.match(unsafe.stderr, /may contain only/);
});

test('start refuses each missing precondition before creating a unit', async (context) => {
  const w = await world(context);
  await configure(w);

  // No listener.
  await w.fakes.set('serve-status', w.exactRoute());
  let result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /desktop listener does not answer/);

  // No route: prints the one-time human command, never runs it.
  await w.listen();
  await w.fakes.set('serve-status', '{}');
  result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.ok(
    result.stderr.includes(`sudo tailscale serve --bg --https=443 unix:${w.gatewaySocket}`),
  );

  // Funnel on the route.
  const funnel = JSON.parse(w.exactRoute());
  funnel.AllowFunnel = { 'desk.tailnet-name.ts.net:443': true };
  await w.fakes.set('serve-status', JSON.stringify(funnel));
  result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /configured differently/);

  // Unreadable status.
  await w.fakes.set('serve-status', 'not json');
  result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not valid JSON/);

  // Changed code.
  await w.fakes.set('serve-status', w.exactRoute());
  await writeFile(join(w.checkout.path, 'README.md'), 'unreviewed\n');
  result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /uncommitted changes/);

  const calls = await w.fakes.calls();
  assert.ok(!calls.some((call) => call[0] === 'systemd-run'), 'no unit may be started');
  await assert.rejects(lstat(w.stateDirectory), { code: 'ENOENT' });
  assert.ok(!calls.some((call) => call[0] === 'tailscale' && call[1] !== 'serve'));
  await assertNeverKilledByName(w);
});

test('start refuses a non-private pairing directory', async (context) => {
  const w = await ready(context);
  await mkdir(w.stateDirectory, { mode: 0o755 });

  const result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must not be accessible to other users/);
  assert.ok(!(await w.fakes.calls()).some((call) => call[0] === 'systemd-run'));
});

test('start creates private durable state, starts the unit and waits until it answers', async (context) => {
  const w = await ready(context);

  const printed = await w.phone(['print-service']);
  assert.equal(printed.code, 0);

  const result = await w.phone(['start']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /phone access is on: https:\/\/desk\.tailnet-name\.ts\.net/);
  assert.equal((await lstat(w.stateDirectory)).mode & 0o777, 0o700);

  const runs = (await w.fakes.calls()).filter((call) => call[0] === 'systemd-run');
  assert.equal(runs.length, 1);
  // Pasted into a shell, the printed command has exactly the arguments start used.
  const asPrintf = printed.stdout.trim().replace(/^systemd-run/, "printf '%s\\0'");
  const parsed = (await execute('/bin/sh', ['-c', asPrintf])).stdout.split('\0').slice(0, -1);
  assert.deepEqual(parsed, runs[0].slice(1), 'print-service shows exactly what start runs');

  // Idempotent: a second start sees its own unit and starts nothing new.
  const again = await w.phone(['start']);
  assert.equal(again.code, 0);
  assert.equal((await w.fakes.calls()).filter((call) => call[0] === 'systemd-run').length, 1);

  const status = await w.phone(['status', '--json']);
  const report = JSON.parse(status.stdout);
  assert.equal(report.gateway.socket.state, 'answering');
  assert.equal(report.listener.state, 'answering');
  assert.equal(report.route.state, 'ours');
  assert.deepEqual(report.reasons, ['no phone is paired']);
  await assertNeverKilledByName(w);
});

test('start --without-listener runs without the desktop listener', async (context) => {
  const w = await world(context);
  await configure(w);
  await w.fakes.set('serve-status', w.exactRoute());

  const result = await w.phone(['start', '--without-listener']);
  assert.equal(result.code, 0, result.stderr);

  const status = JSON.parse((await w.phone(['status', '--json'])).stdout);
  assert.equal(status.gateway.socket.state, 'answering');
  assert.equal(status.listener.state, 'absent');
  assert.ok(status.reasons.includes('the desktop listener is not running'));
});

test('start reports a gateway that fails, and stops one that never answers', async (context) => {
  const w = await ready(context);

  await w.fakes.set('run-behavior', 'fail');
  const failed = await w.phone(['start']);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    /the gateway stopped \(failed, exit-code\); see journalctl --user -u companion-phone-gateway/,
  );

  // The failed unit is reset before the next attempt.
  await w.fakes.set('run-behavior', 'silent');
  const silent = await w.phone(['start', '--ready-timeout', '2']);
  assert.equal(silent.code, 1);
  assert.match(silent.stderr, /did not answer within 2 s/);
  const calls = names(await w.fakes.calls());
  assert.ok(calls.includes('systemctl reset-failed'));
  assert.equal(calls.at(-1), 'systemctl stop', 'a start that timed out stops its unit again');
});

test('a running unit with other settings is refused by start and replaced by restart', async (context) => {
  const w = await ready(context);
  assert.equal((await w.phone(['start'])).code, 0);

  // Approve another revision while it runs.
  await writeFile(join(w.checkout.path, 'README.md'), 'next\n');
  await execute('git', [
    '-C',
    w.checkout.path,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-am',
    'next',
  ]);
  const next = (await execute('git', ['-C', w.checkout.path, 'rev-parse', 'HEAD'])).stdout.trim();
  const replaced = await w.phone([
    'configure',
    '--replace',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    next,
    '--checkout',
    w.checkout.path,
    '--state-directory',
    w.stateDirectory,
    '--sessions-directory',
    join(w.directory, 'sessions'),
  ]);
  assert.equal(replaced.code, 0, replaced.stderr);

  const refused = await w.phone(['start']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already running with different settings/);

  const status = await w.phone(['status']);
  assert.equal(status.code, 1, 'a gateway running other settings is not "available"');
  assert.match(status.stdout, /started with other settings or revision/);
  assert.match(
    status.stdout,
    /unavailable — .*the running gateway was started with other settings/,
  );

  // restart = stop first, then start.
  const restarted = await w.phone(['restart']);
  assert.equal(restarted.code, 0, restarted.stderr);
  const calls = names(await w.fakes.calls());
  const stop = calls.lastIndexOf('systemctl stop');
  const run = calls.lastIndexOf('systemd-run --unit=companion-phone-gateway.service');
  assert.ok(stop >= 0 && run > stop, 'restart stops before starting');
});

test('stop confirms the gateway is off and touches only its own unit', async (context) => {
  const w = await ready(context);

  // Nothing running: success, no stop issued.
  let result = await w.phone(['stop']);
  assert.equal(result.code, 0);
  assert.ok(!names(await w.fakes.calls()).includes('systemctl stop'));

  assert.equal((await w.phone(['start'])).code, 0);
  result = await w.phone(['stop']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /phone access is off/);
  const stops = (await w.fakes.calls()).filter(
    (call) => call[0] === 'systemctl' && call[2] === 'stop',
  );
  assert.deepEqual(stops, [['systemctl', '--user', 'stop', 'companion-phone-gateway.service']]);

  // A stop that does not take effect is a failure, so a launcher keeps the listener.
  assert.equal((await w.phone(['start'])).code, 0);
  await w.fakes.set('stop-behavior', 'stuck');
  result = await w.phone(['stop']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /still active; phone access may still be on/);
  await w.fakes.set('stop-behavior', 'stop');
  assert.equal((await w.phone(['stop'])).code, 0);

  // Something else answering on the gateway socket also counts as "not off".
  await mkdir(join(w.gatewaySocket, '..'), { recursive: true, mode: 0o700 });
  const impostor = createServer();
  await new Promise<void>((done) => impostor.listen(w.gatewaySocket, done));
  context.after(() => new Promise((done) => impostor.close(() => done(undefined))));
  result = await w.phone(['stop']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /something still answers/);

  await assertNeverKilledByName(w);
});

test('stop and start leave a unit they did not start alone', async (context) => {
  const w = await ready(context);
  await w.fakes.setUnit({
    unit: 'companion-phone-gateway.service',
    active: 'active',
    sub: 'running',
    result: 'success',
    description: 'Someone else’s gateway',
    environment: '',
    transient: 'no',
  });

  const stop = await w.phone(['stop']);
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /not started by companion-phone; not touching it/);
  const start = await w.phone(['start']);
  assert.equal(start.code, 1);
  assert.match(start.stderr, /exists that this tool did not start/);

  const calls = await w.fakes.calls();
  assert.ok(
    !calls.some(
      (call) => call[0] === 'systemd-run' || call[2] === 'stop' || call[2] === 'reset-failed',
    ),
  );
});

test('stop never guesses which service is meant', async (context) => {
  const w = await world(context);

  // A custom instance whose config is gone, with its gateway still answering.
  await mkdir(join(w.gatewaySocket, '..'), { recursive: true, mode: 0o700 });
  const running = createServer();
  await new Promise<void>((done) => running.listen(w.gatewaySocket, done));
  context.after(() => new Promise((done) => running.close(() => done(undefined))));

  // Missing config: refused, nothing queried, nothing claimed.
  let result = await w.phone(['stop']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot tell which phone service to stop/);
  assert.doesNotMatch(result.stderr, /phone access is off/);

  // Broken config: the same.
  await mkdir(join(w.configFile, '..'), { mode: 0o700 });
  await writeFile(w.configFile, '{ broken', { mode: 0o600 });
  result = await w.phone(['stop']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not valid JSON/);
  assert.deepEqual(await w.fakes.calls(), []);

  // Named explicitly, with its runtime directory: the socket check still applies.
  result = await w.phone([
    'stop',
    '--unit-name',
    'companion-phone-gateway',
    '--runtime-directory-name',
    'companion-phone',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /something still answers/);

  // Named without a runtime directory: stopped, but not claimed to be off.
  result = await w.phone(['stop', '--unit-name', 'companion-phone-gateway']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /the gateway socket was not checked/);
  assert.doesNotMatch(result.stderr, /phone access is off/);
  assert.deepEqual(
    (await w.fakes.calls()).map((call) => call.slice(0, 4)),
    [
      ['systemctl', '--user', 'show', 'companion-phone-gateway.service'],
      ['systemctl', '--user', 'show', 'companion-phone-gateway.service'],
    ],
  );

  // With a valid config the names come from it and may not be overridden.
  await rm(w.configFile);
  await configure(w);
  result = await w.phone(['stop', '--unit-name', 'other']);
  assert.equal(result.code, 2);
  result = await w.phone(['stop', '--unit-name', 'Bad_Name']);
  assert.equal(result.code, 2);
});

test('start never adopts an existing runtime directory', async (context) => {
  const w = await ready(context);
  const runtimeDirectory = join(w.gatewaySocket, '..');
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await writeFile(join(runtimeDirectory, 'sentinel'), 'keep me');

  const result = await w.phone(['start']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists; systemd would take it over/);
  assert.equal(await readFile(join(runtimeDirectory, 'sentinel'), 'utf8'), 'keep me');
  assert.ok(!(await w.fakes.calls()).some((call) => call[0] === 'systemd-run'));
});

test('configure refuses layouts where stopping would delete something else', async (context) => {
  const w = await world(context);
  const base = [
    'configure',
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    w.checkout.revision,
    '--checkout',
    w.checkout.path,
    '--state-directory',
    w.stateDirectory,
    '--sessions-directory',
    join(w.directory, 'sessions'),
  ];

  // The listener's own socket directory ($XDG_RUNTIME_DIR/companion).
  let result = await w.phone([...base, '--runtime-directory-name', 'companion']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /overlaps the listener's socket directory/);

  // Pairing state inside the runtime directory.
  result = await w.phone([
    ...base.slice(0, -4),
    '--state-directory',
    join(w.environment.XDG_RUNTIME_DIR!, 'companion-phone', 'state'),
    '--sessions-directory',
    join(w.directory, 'sessions'),
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /overlaps the service's runtime directory/);

  // An overlong socket path is refused before anything is written.
  result = await w.phone([...base, '--runtime-directory-name', 'x'.repeat(64)]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /too long/);
  await assert.rejects(lstat(w.configFile), { code: 'ENOENT' });
});

test('configure creates missing parent directories privately', async (context) => {
  const w = await world(context);
  const nested = join(w.directory, 'fresh', 'config', 'companion', 'phone-gateway.json');
  const result = await w.phone([
    'configure',
    '--config',
    nested,
    '--origin',
    origin,
    '--tailscale-login',
    'someone@github',
    '--revision',
    w.checkout.revision,
    '--checkout',
    w.checkout.path,
    '--state-directory',
    w.stateDirectory,
    '--sessions-directory',
    join(w.directory, 'sessions'),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await lstat(nested)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(nested, '..'))).mode & 0o777, 0o700);
});

test('check-serve classifies live and saved Serve status', async (context) => {
  const w = await world(context);
  await configure(w);

  await w.fakes.set('serve-status', '{}');
  assert.deepEqual(await w.phone(['check-serve']).then((r) => [r.code, r.stdout.trim()]), [
    0,
    'none',
  ]);
  await w.fakes.set('serve-status', w.exactRoute());
  assert.deepEqual(await w.phone(['check-serve']).then((r) => [r.code, r.stdout.trim()]), [
    0,
    'ours',
  ]);

  const saved = join(w.directory, 'saved.json');
  await writeFile(saved, JSON.stringify({ Foreground: { x: {} } }));
  assert.deepEqual(
    await w.phone(['check-serve', '--from-file', saved]).then((r) => [r.code, r.stdout.trim()]),
    [1, 'unexpected'],
  );
  await writeFile(saved, 'garbage');
  assert.deepEqual(
    await w.phone(['check-serve', '--from-file', saved]).then((r) => [r.code, r.stdout.trim()]),
    [1, 'unreadable'],
  );
});

test('route-commands prints the human steps and changes nothing', async (context) => {
  const w = await world(context);
  await configure(w);
  const result = await w.phone(['route-commands']);
  assert.equal(result.code, 0);
  assert.ok(
    result.stdout.includes(`sudo tailscale serve --bg --https=443 unix:${w.gatewaySocket}`),
  );
  assert.ok(result.stdout.includes('sudo tailscale serve --https=443 off'));
  assert.deepEqual(await w.fakes.calls(), []);
});

test('status and check-serve are read-only and never print secrets', async (context) => {
  const w = await ready(context);
  assert.equal((await w.phone(['start'])).code, 0);

  // A paired device and a pending pairing code, as after real use.
  const devices = new DeviceStore(w.stateDirectory);
  const { code } = await devices.createPairingCode();
  const paired = await devices.redeemPairingCode(code, 'Synthetic phone');
  assert.ok(paired.ok);
  await devices.createPairingCode();
  const secrets = [
    paired.token,
    paired.device.tokenHash,
    JSON.parse(await readFile(join(w.stateDirectory, 'pairing.json'), 'utf8')).codeHash,
  ];

  const before = await snapshot(w.stateDirectory);
  const callsBefore = (await w.fakes.calls()).length;
  const outputs = [
    await w.phone(['status']),
    await w.phone(['status', '--json']),
    await w.phone(['check-serve']),
  ];
  assert.deepEqual(await snapshot(w.stateDirectory), before, 'the state directory is unchanged');

  for (const output of outputs) {
    for (const secret of secrets) {
      assert.ok(!output.stdout.includes(secret) && !output.stderr.includes(secret));
    }
  }
  assert.equal(JSON.parse(outputs[1].stdout).pairing.devices, 1);
  // Only reads: status and check-serve issue no start, stop or reset.
  const readOnly = (await w.fakes.calls()).slice(callsBefore);
  assert.ok(readOnly.length > 0);
  assert.ok(
    readOnly.every((call) => call[0] === 'tailscale' || call[2] === 'show'),
    JSON.stringify(readOnly),
  );

  // Nothing was written to the synthetic HOME either (only the explicit config).
  assert.deepEqual(await readdir(join(w.directory, 'home', '.config')), []);
});

/** Names, sizes and modification times of every file in a directory. */
async function snapshot(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const info = await lstat(join(directory, name));
    entries.push(`${name} ${info.size} ${info.mtimeMs} ${info.mode}`);
  }
  return entries;
}

test('start refuses while another gateway holds the pairing state', async (context) => {
  const w = await ready(context);
  await mkdir(w.stateDirectory, { mode: 0o700 });

  // No lock file yet: probing must not create one.
  assert.equal((await w.phone(['start', '--ready-timeout', '5'])).code, 0);
  assert.equal((await w.phone(['stop'])).code, 0);
  await assert.rejects(lstat(join(w.stateDirectory, 'gateway.lock')), { code: 'ENOENT' });

  // A gateway (here: its lifetime lock) serving the same state blocks start.
  const lock = await acquireLifetimeLock(join(w.stateDirectory, 'gateway.lock'));
  context.after(() => lock.close());
  const runsBefore = (await w.fakes.calls()).filter((call) => call[0] === 'systemd-run').length;
  const refused = await w.phone(['start']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /another phone gateway is serving the pairing state/);
  assert.equal(
    (await w.fakes.calls()).filter((call) => call[0] === 'systemd-run').length,
    runsBefore,
  );

  await lock.close();
  assert.equal((await w.phone(['start'])).code, 0);
});

test('listener shutdown during a slow systemd-run leaves no gateway behind', async (context) => {
  const w = await ready(context);
  await w.fakes.set('run-delay', '1500');
  const lines: string[] = [];
  const hook = new PhoneAccessHook({
    executable: cli,
    environment: w.environment,
    log: (line) => lines.push(line),
  });

  hook.start();
  await waitFor(async () => (await w.fakes.calls()).some((call) => call[0] === 'systemd-run'));
  // The unit does not exist yet: systemd-run is still submitting it.
  await assert.rejects(lstat(join(w.fakes.directory, 'unit.json')), { code: 'ENOENT' });

  assert.equal(await hook.stop(), true);
  assert.ok(lines.includes('companion-phone: cancelling the start'), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('stopped companion-phone-gateway.service again')));

  // Nothing appears afterwards: no unit, no answering gateway socket.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await assert.rejects(lstat(join(w.fakes.directory, 'unit.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(w.gatewaySocket), { code: 'ENOENT' });
});

test('a start cancelled before submission creates nothing', async (context) => {
  const w = await ready(context);
  await w.fakes.set('serve-delay', '1500');
  const lines: string[] = [];
  const hook = new PhoneAccessHook({
    executable: cli,
    environment: w.environment,
    log: (line) => lines.push(line),
  });

  // Cancelled while the Serve route is still being read.
  hook.start();
  await waitFor(async () => (await w.fakes.calls()).some((call) => call[0] === 'tailscale'));
  assert.equal(await hook.stop(), true);

  assert.ok(lines.includes('companion-phone: not starting: cancelled'), lines.join('\n'));
  assert.ok(!(await w.fakes.calls()).some((call) => call[0] === 'systemd-run'));
  await assert.rejects(lstat(join(w.fakes.directory, 'unit.json')), { code: 'ENOENT' });
});

async function waitFor(check: () => Promise<boolean>, milliseconds = 20_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('stop does not claim off when the gateway socket path is suspicious', async (context) => {
  const w = await ready(context);
  const runtimeDirectory = join(w.gatewaySocket, '..');
  await mkdir(runtimeDirectory, { mode: 0o700 });

  // A symlink to a socket that answers: never followed, never "off".
  const elsewhere = join(w.directory, 'elsewhere.sock');
  const server = createServer();
  await new Promise<void>((done) => server.listen(elsewhere, done));
  context.after(() => new Promise((done) => server.close(() => done(undefined))));
  await symlink(elsewhere, w.gatewaySocket);
  let result = await w.phone(['stop']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsafe \(is a symbolic link\); cannot confirm phone access is off/);
  assert.ok((await lstat(w.gatewaySocket)).isSymbolicLink(), 'left untouched');

  // Not a socket at all.
  await rm(w.gatewaySocket);
  await writeFile(w.gatewaySocket, '');
  result = await w.phone(['stop']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not a socket\); cannot confirm/);

  // A socket that refuses connections is definitely off.
  await rm(w.gatewaySocket);
  // A process killed while listening leaves exactly such a socket behind.
  const holder = spawn(process.execPath, [
    '-e',
    'require("node:net").createServer().listen(process.argv[1], () => console.log("up"))',
    w.gatewaySocket,
  ]);
  await new Promise((done) => holder.stdout.once('data', done));
  holder.kill('SIGKILL');
  await new Promise((done) => holder.once('exit', done));
  assert.ok((await lstat(w.gatewaySocket)).isSocket());
  result = await w.phone(['stop']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /phone access is off/);
});
