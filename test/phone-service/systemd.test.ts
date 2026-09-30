/**
 * `companion-phone` against a real systemd user manager, with synthetic
 * everything else (see fixture.ts). Run explicitly with
 * `npm run test:phone-service`; `npm test` does not create units.
 *
 * Covered: the real transient unit and its sandbox, the pin check executed by
 * systemd itself, start refusals before any unit exists, the gateway serving
 * over its private socket with Host/Origin/login/Funnel guards, a paired
 * phone across listener loss and restart, automatic restart after a crash
 * with durable pairing, refusal to restart onto changed code, and a stop that
 * leaves nothing answering and never touches a unit it did not start.
 *
 * Not covered: a real reboot, real Tailscale Serve, a real phone, logout.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { DeviceStore } from '../../src/remote/devices.ts';
import { resolveTools } from '../../src/remote/service/lifecycle.ts';
import { loadConfig, runtimeRoot } from '../../src/remote/service/config.ts';
import { transientServicePlan } from '../../src/remote/service/transient-unit.ts';
import {
  assertUserManager,
  createWorld,
  receivedState,
  socketPhone,
  socketRequest,
  systemctlShow,
  tailnetHeaders,
  testHostname,
  testLogin,
  testOrigin,
  waitUntil,
  type PhoneServiceWorld,
} from './fixture.ts';

const run = promisify(execFile);

let world: PhoneServiceWorld;
let token: string;

before(async () => {
  await assertUserManager();
  world = await createWorld();
  // Tools are resolved from PATH: the fake tailscale must come first here too.
  process.env.PATH = world.environment.PATH;
  await world.listener.start();

  const configured = await world.phoneCli([
    'configure',
    '--origin',
    testOrigin,
    '--tailscale-login',
    testLogin,
    '--revision',
    world.revision,
    '--checkout',
    world.checkout,
    '--state-directory',
    world.stateDirectory,
    '--sessions-directory',
    join(world.base, 'sessions'),
    '--control-socket',
    world.listener.socketPath,
    '--unit-name',
    world.unitName,
    '--runtime-directory-name',
    world.runtimeDirectoryName,
  ]);
  assert.equal(configured.code, 0, configured.stderr);
});

after(async () => {
  await world?.cleanup();
});

async function unitLoaded(): Promise<boolean> {
  const state = await systemctlShow(world.unit, ['LoadState']);
  return state.LoadState !== 'not-found';
}

test('configure only writes a private config; nothing is started or created', async () => {
  const info = await lstat(world.configFile);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(await unitLoaded(), false);
  await assert.rejects(lstat(world.stateDirectory), { code: 'ENOENT' });
});

test('the sandbox is read-only outside the state directory and has no network sockets', async () => {
  const config = (await loadConfig(world.configFile))!;
  const tools = await resolveTools();
  const plan = transientServicePlan(config, tools, runtimeRoot());
  await run('mkdir', ['-m', '700', '-p', world.stateDirectory]);

  // The same properties (including the pin check run by systemd itself),
  // with a probe instead of the gateway and a separate runtime directory.
  const probeUnit = `${world.unitName}-probe.service`;
  const properties = plan.properties
    .filter((property) => !property.startsWith('Restart='))
    .map((property) =>
      property.startsWith('RuntimeDirectory=')
        ? `RuntimeDirectory=${world.unitName}-probe`
        : property,
    );
  const probe = `
    const fs = require('node:fs');
    const net = require('node:net');
    const { execFileSync } = require('node:child_process');
    const result = {};
    const attempt = (name, action) => {
      try { action(); result[name] = 'ok'; } catch (error) { result[name] = error.code || String(error); }
    };
    attempt('writeHome', () => fs.writeFileSync(${JSON.stringify(join(world.base, 'outside'))}, 'x'));
    attempt('writeCheckout', () => fs.writeFileSync(${JSON.stringify(join(world.checkout, 'x'))}, 'x'));
    attempt('writeState', () => fs.writeFileSync(${JSON.stringify(join(world.stateDirectory, 'probe'))}, 'x'));
    attempt('writeRuntime', () => fs.writeFileSync(process.env.XDG_RUNTIME_DIR_PROBE + '/probe', 'x'));
    attempt('writeTmp', () => fs.writeFileSync('/tmp/probe', 'x'));
    attempt('tailscale', () => execFileSync('tailscale', ['serve', 'status', '--json']));
    attempt('flock', () => execFileSync('flock', ['-n', ${JSON.stringify(join(world.stateDirectory, 'probe.lock'))}, 'true']));
    const tcp = net.connect(80, '127.0.0.1');
    tcp.on('error', (error) => { result.tcp = error.code; });
    const unix = net.connect(${JSON.stringify(world.listener.socketPath)});
    unix.on('connect', () => { result.listener = 'ok'; unix.destroy(); });
    unix.on('error', (error) => { result.listener = error.code; });
    setTimeout(() => { console.log(JSON.stringify(result)); }, 500);
  `;
  const { stdout } = await run('systemd-run', [
    '--user',
    `--unit=${probeUnit}`,
    '--quiet',
    '--wait',
    '--pipe',
    '--collect',
    '--expand-environment=no',
    ...properties.map((property) => `--property=${property}`),
    `--setenv=XDG_RUNTIME_DIR_PROBE=${join(runtimeRoot(), `${world.unitName}-probe`)}`,
    '--',
    config.nodeExecutable,
    '-e',
    probe,
  ]);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);

  assert.deepEqual(result, {
    writeHome: 'EROFS',
    writeCheckout: 'EROFS',
    writeState: 'ok',
    writeRuntime: 'ok',
    writeTmp: 'ok',
    tailscale: 'ok',
    flock: 'ok',
    tcp: 'EAFNOSUPPORT',
    listener: 'ok',
  });
  // The private /tmp was the unit's own.
  await assert.rejects(lstat('/tmp/probe'), { code: 'ENOENT' });
});

test('start refuses without the exact Serve route, before any unit exists', async () => {
  await world.setServeStatus({});
  const missing = await world.phoneCli(['start']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /sudo tailscale serve --bg --https=443 unix:\S+gateway\.sock/);
  assert.equal(await unitLoaded(), false);

  const funnel = {
    ...(world.exactRoute() as object),
    AllowFunnel: { [`${testHostname}:443`]: true },
  };
  await world.setServeStatus(funnel);
  const exposed = await world.phoneCli(['start']);
  assert.equal(exposed.code, 1);
  assert.match(exposed.stderr, /configured differently/);
  assert.equal(await unitLoaded(), false);
});

test('start refuses while the desktop listener is down', async () => {
  await world.setServeStatus(world.exactRoute());
  await world.listener.stop();
  try {
    const refused = await world.phoneCli(['start']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /desktop listener does not answer/);
    assert.equal(await unitLoaded(), false);
  } finally {
    await world.listener.start();
  }
});

test('if Serve changes after the preflight, the gateway itself refuses and start reports it', async () => {
  // First call (the tool, outside the sandbox) sees the exact route and leaves
  // a marker; later calls (the gateway, inside the read-only sandbox) see Funnel.
  const tailscale = join(world.binDirectory, 'tailscale');
  const original = await readFile(tailscale, 'utf8');
  const marker = join(world.base, 'serve-read-once');
  const funnel = JSON.stringify({
    ...(world.exactRoute() as object),
    AllowFunnel: { [`${testHostname}:443`]: true },
  });
  await writeFile(
    tailscale,
    [
      '#!/bin/sh',
      `if [ -e ${marker} ]; then echo '${funnel}'; exit 0; fi`,
      `touch ${marker}`,
      `exec cat ${world.serveStatusFile}`,
      '',
    ].join('\n'),
  );
  await world.setServeStatus(world.exactRoute());

  try {
    const started = Date.now();
    const result = await world.phoneCli(['start']);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /the gateway stopped \(failed, /);
    assert.ok(Date.now() - started < 60_000);

    const journal = await run('journalctl', [
      '--user',
      '-u',
      world.unit,
      '--no-pager',
      '-o',
      'cat',
    ]);
    assert.match(journal.stdout, /Not starting: Serve has settings other than/);
    await assert.rejects(lstat(world.socketPath), { code: 'ENOENT' });
  } finally {
    await writeFile(tailscale, original);
    await run('systemctl', ['--user', 'reset-failed', world.unit]).catch(() => {});
  }
});

test('start runs the gateway as a hardened transient service on a private socket', async () => {
  await world.setServeStatus(world.exactRoute());
  const started = await world.phoneCli(['start']);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /phone access is on/);

  const unit = await systemctlShow(world.unit, [
    'ActiveState',
    'Transient',
    'FragmentPath',
    'UnitFileState',
    'ProtectHome',
    'ProtectSystem',
    'RestrictAddressFamilies',
    'NoNewPrivileges',
    'PrivateTmp',
    'ReadWritePaths',
    'Restart',
    'StartLimitBurst',
  ]);
  assert.equal(unit.ActiveState, 'active');
  assert.equal(unit.Transient, 'yes');
  assert.equal(unit.FragmentPath, join(runtimeRoot(), 'systemd', 'transient', world.unit));
  assert.equal(unit.UnitFileState, 'transient');
  assert.equal(unit.ProtectHome, 'read-only');
  assert.equal(unit.ProtectSystem, 'strict');
  assert.equal(unit.RestrictAddressFamilies, 'AF_UNIX');
  assert.equal(unit.NoNewPrivileges, 'yes');
  assert.equal(unit.PrivateTmp, 'yes');
  assert.equal(unit.ReadWritePaths, world.stateDirectory);
  assert.equal(unit.Restart, 'on-failure');
  assert.equal(unit.StartLimitBurst, '3');

  // systemd's own assessment of the running gateway's sandbox (0 best, 10 worst).
  const security = await run('systemd-analyze', ['--user', 'security', world.unit, '--no-pager']);
  const exposure = Number(/Overall exposure level for \S+: ([0-9.]+)/.exec(security.stdout)?.[1]);
  assert.ok(exposure <= 2.5, `exposure ${exposure}`);

  const socket = await lstat(world.socketPath);
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal((await lstat(join(world.socketPath, '..'))).mode & 0o777, 0o700);
  assert.equal((await lstat(world.stateDirectory)).mode & 0o777, 0o700);

  // Host, login and Funnel guards, over the socket as Serve would connect.
  const page = await socketRequest(world.socketPath, { path: '/', headers: tailnetHeaders });
  assert.equal(page.status, 200);
  const wrongHost = await socketRequest(world.socketPath, {
    path: '/',
    headers: { ...tailnetHeaders, Host: 'evil.example' },
  });
  assert.equal(wrongHost.status, 421);
  const otherLogin = await socketRequest(world.socketPath, {
    path: '/',
    headers: { ...tailnetHeaders, 'Tailscale-User-Login': 'someone@else' },
  });
  assert.equal(otherLogin.status, 403);
  const funnel = await socketRequest(world.socketPath, {
    path: '/',
    headers: { ...tailnetHeaders, 'Tailscale-Funnel-Request': '?1' },
  });
  assert.equal(funnel.status, 403);

  // Starting again with the same settings changes nothing.
  const again = await world.phoneCli(['start']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /already running with this configuration/);
});

test('status separates gateway, listener, route and pairing', async () => {
  const unpaired = await world.phoneCli(['status', '--json']);
  assert.equal(unpaired.code, 1);
  const report = JSON.parse(unpaired.stdout);
  assert.equal(report.gateway.socket.state, 'answering');
  assert.equal(report.gateway.matchesConfig, true);
  assert.equal(report.listener.state, 'answering');
  assert.equal(report.route.state, 'ours');
  assert.equal(report.pairing.state, 'ok');
  assert.equal(report.pairing.devices, 0);
  assert.deepEqual(report.reasons, ['no phone is paired']);
});

test('a paired phone keeps working across listener loss and restart', async () => {
  const { code } = await new DeviceStore(world.stateDirectory).createPairingCode();
  const paired = await socketRequest(world.socketPath, {
    method: 'POST',
    path: '/api/pair',
    headers: { ...tailnetHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: 'Synthetic phone' }),
  });
  assert.equal(paired.status, 200, paired.body);
  token = JSON.parse(paired.body).token;

  const status = await world.phoneCli(['status']);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, /Phone access: +available/);

  const phone = await socketPhone(world.socketPath, token);
  await waitUntil(async () => receivedState(phone), 10_000, 'state through the gateway');

  // The listener goes away: the phone is told the listener is unavailable,
  // the gateway service keeps running, and status says what is missing.
  await world.listener.stop();
  assert.equal((await phone.closed).code, 4503);
  assert.equal((await systemctlShow(world.unit, ['ActiveState'])).ActiveState, 'active');
  const down = JSON.parse((await world.phoneCli(['status', '--json'])).stdout);
  assert.equal(down.gateway.socket.state, 'answering');
  assert.notEqual(down.listener.state, 'answering');
  assert.deepEqual(down.reasons, ['the desktop listener is not running']);

  // The listener comes back at the same path: the same credential works.
  await world.listener.start();
  const again = await socketPhone(world.socketPath, token);
  await waitUntil(async () => receivedState(again), 10_000, 'state after listener restart');
  again.socket.terminate();
});

test('systemd restarts a crashed gateway and pairing survives', async () => {
  const before = await systemctlShow(world.unit, ['MainPID', 'NRestarts']);
  await run('systemctl', ['--user', 'kill', '--signal=SIGKILL', world.unit]);

  await waitUntil(
    async () => {
      const state = await systemctlShow(world.unit, ['ActiveState', 'MainPID', 'NRestarts']);
      return (
        state.ActiveState === 'active' && state.MainPID !== before.MainPID && state.MainPID !== '0'
      );
    },
    30_000,
    'automatic restart',
  );
  await waitUntil(
    async () => {
      try {
        return (
          (await socketRequest(world.socketPath, { path: '/', headers: tailnetHeaders })).status ===
          200
        );
      } catch {
        return false;
      }
    },
    30_000,
    'gateway answering again',
  );
  assert.equal(
    Number((await systemctlShow(world.unit, ['NRestarts'])).NRestarts),
    Number(before.NRestarts) + 1,
  );

  const phone = await socketPhone(world.socketPath, token);
  await waitUntil(async () => receivedState(phone), 10_000, 'state after gateway restart');
  phone.socket.terminate();
});

test('systemd refuses to restart the gateway onto a changed checkout', async () => {
  const readme = join(world.checkout, 'README.md');
  const original = await readFile(readme, 'utf8');
  await writeFile(readme, original + '\nUnreviewed change.\n');

  try {
    await run('systemctl', ['--user', 'kill', '--signal=SIGKILL', world.unit]);
    await waitUntil(
      async () => (await systemctlShow(world.unit, ['ActiveState'])).ActiveState === 'failed',
      60_000,
      'the unit to give up',
    );
    const journal = await run('journalctl', [
      '--user',
      '-u',
      world.unit,
      '--no-pager',
      '-o',
      'cat',
    ]);
    assert.match(journal.stdout, /has uncommitted changes; refusing to start/);
    await assert.rejects(lstat(world.socketPath), { code: 'ENOENT' });

    const status = await world.phoneCli(['status', '--json']);
    const report = JSON.parse(status.stdout);
    assert.match(report.gateway.service, /^failed/);
    assert.equal(report.checkout.ok, false);

    const refused = await world.phoneCli(['start']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /uncommitted changes/);
  } finally {
    await writeFile(readme, original);
  }

  const restarted = await world.phoneCli(['start']);
  assert.equal(restarted.code, 0, restarted.stderr);
  const phone = await socketPhone(world.socketPath, token);
  await waitUntil(async () => receivedState(phone), 10_000, 'state after a fresh start');
  phone.socket.terminate();
});

test('stop leaves nothing answering, and is idempotent', async () => {
  const stopped = await world.phoneCli(['stop']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(await unitLoaded(), false);
  await assert.rejects(lstat(join(world.socketPath, '..')), { code: 'ENOENT' });

  const again = await world.phoneCli(['stop']);
  assert.equal(again.code, 0, again.stderr);

  // Pairing is durable: still there for the next start.
  assert.equal((await new DeviceStore(world.stateDirectory).devices()).length, 1);
});

test('stop and start leave alone a unit of the same name that this tool did not start', async () => {
  await run('systemd-run', ['--user', `--unit=${world.unit}`, '--quiet', '/bin/sleep', '120']);
  try {
    const stop = await world.phoneCli(['stop']);
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /not started by companion-phone/);
    const start = await world.phoneCli(['start']);
    assert.equal(start.code, 1);
    assert.equal((await systemctlShow(world.unit, ['ActiveState'])).ActiveState, 'active');
  } finally {
    await run('systemctl', ['--user', 'stop', world.unit]);
  }
});
