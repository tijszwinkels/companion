/**
 * `companion-login` without a real systemd user manager: the unit renderer as
 * a pure function, and the CLI run as a subprocess from a disposable copy of
 * its sources, with a temporary HOME and a fake `systemctl` first on PATH.
 * Nothing here writes to the real user unit directory or starts a service.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertUnitPath,
  managedMarker,
  renderListenerUnit,
  renderUiUnit,
  type LoginStartupPlan,
} from '../../src/login-startup/units.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const plan: LoginStartupPlan = {
  checkout: '/home/user/Work/companion',
  node: '/home/user/.local/share/mise/installs/node/26.8.2/bin/node',
  config: '/home/user/Work/companion/companion.config.json',
  ui: '/home/user/Work/companion/native/window/build/companion-ui',
  path: ['/home/user/.local/share/companion/wtype-candidate', '/usr/bin'],
  environmentFile: '/home/user/.config/companion/login.env',
  logDirectory: '/home/user/.local/state/companion',
  listening: false,
};

test('the listener unit starts paused by default, directly under node, without a startup screenshot', () => {
  const text = renderListenerUnit(plan);

  assert.ok(text.startsWith(managedMarker + '\n'));
  assert.match(
    text,
    /^ExecStart=\/home\/user\/\.local\/share\/mise\/installs\/node\/26\.8\.2\/bin\/node --import tsx src\/cli\.ts --config \/home\/user\/Work\/companion\/companion\.config\.json --paused --no-startup-capture$/m,
  );
  assert.match(text, /^WorkingDirectory=\/home\/user\/Work\/companion$/m);
  assert.match(
    text,
    /^Environment=PATH=\/home\/user\/\.local\/share\/companion\/wtype-candidate:\/usr\/bin$/m,
  );
  assert.match(text, /^EnvironmentFile=-\/home\/user\/\.config\/companion\/login\.env$/m);
  assert.match(text, /^PartOf=graphical-session\.target$/m);
  assert.match(text, /^Requisite=graphical-session\.target$/m);
  assert.match(text, /^WantedBy=graphical-session\.target$/m);
  assert.match(text, /^KillMode=mixed$/m);
  assert.match(
    text,
    /^StandardOutput=truncate:\/home\/user\/\.local\/state\/companion\/listener\.log$/m,
  );
  assert.doesNotMatch(text, /npm/);

  const listening = renderListenerUnit({ ...plan, listening: true });
  assert.doesNotMatch(listening, /--paused/);
  assert.match(listening, /--no-startup-capture$/m);
});

test('the UI unit starts the built host hidden, with its own log', () => {
  const text = renderUiUnit(plan);

  assert.ok(text.startsWith(managedMarker + '\n'));
  assert.match(
    text,
    /^ExecStart=\/home\/user\/Work\/companion\/native\/window\/build\/companion-ui --hidden$/m,
  );
  assert.match(text, /^StandardOutput=truncate:\/home\/user\/\.local\/state\/companion\/ui\.log$/m);
});

test('paths systemd could read differently are refused instead of escaped', () => {
  for (const bad of [
    'relative/path',
    '/with space',
    '/percent%h',
    '/dollar$HOME',
    '/quote"',
    '/semi;colon',
  ]) {
    assert.throws(() => assertUnitPath('Test', bad));
  }
  assert.throws(
    () => renderListenerUnit({ ...plan, config: '/home/user/my config.json' }),
    /space/,
  );
  assert.throws(() => renderUiUnit({ ...plan, path: [] }), /PATH/);
});

/** A fake `systemctl` that records its calls and answers from small state files. */
const fakeSystemctl = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'calls'), JSON.stringify(args) + '\n');
const read = (name, fallback) => { try { return fs.readFileSync(path.join(directory, name), 'utf8').trim(); } catch { return fallback; } };
const [scope, verb, target] = args;
if (scope !== '--user') { process.exit(64); }
if (verb === 'is-active') {
  const answer = target === 'graphical-session.target' ? read('session', 'active') : read('unit-active', 'inactive');
  console.log(answer);
  process.exit(answer === 'active' ? 0 : 3);
}
if (verb === 'is-enabled') { console.log('enabled'); process.exit(0); }
if (verb === 'show') { console.log('ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nResult=success'); process.exit(0); }
process.exit(0);
`;

interface Sandbox {
  checkout: string;
  home: string;
  fakes: string;
  unitDirectory: string;
  logDirectory: string;
  environmentFile: string;
}

/** A disposable checkout copy (sources only) with a built-looking UI and config. */
async function sandbox(context: TestContext): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'companion-login-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const checkout = join(root, 'checkout');
  await cp(join(repository, 'src', 'login-startup'), join(checkout, 'src', 'login-startup'), {
    recursive: true,
  });
  await symlink(join(repository, 'node_modules'), join(checkout, 'node_modules'));
  await mkdir(join(checkout, 'native', 'window', 'build'), { recursive: true });
  await writeFile(join(checkout, 'native', 'window', 'build', 'companion-ui'), '#!/bin/sh\n', {
    mode: 0o755,
  });
  await writeFile(join(checkout, 'companion.config.json'), '{}\n');

  const fakes = join(root, 'fakes');
  await mkdir(fakes);
  await writeFile(join(fakes, 'systemctl'), fakeSystemctl, { mode: 0o755 });

  const home = join(root, 'home');
  await mkdir(home);

  return {
    checkout,
    home,
    fakes,
    unitDirectory: join(home, '.config', 'systemd', 'user'),
    logDirectory: join(home, '.local', 'state', 'companion'),
    environmentFile: join(home, '.config', 'companion', 'login.env'),
  };
}

interface Run {
  code: number;
  output: string;
  calls: string[][];
}

function companionLogin(box: Sandbox, args: string[]): Promise<Run> {
  const environment = {
    HOME: box.home,
    PATH: [box.fakes, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
  };

  return new Promise((resolveRun) => {
    execFile(
      join(repository, 'node_modules', '.bin', 'tsx'),
      [join(box.checkout, 'src', 'login-startup', 'cli.ts'), ...args],
      { env: environment, timeout: 30_000 },
      async (error, stdout, stderr) => {
        let calls: string[][] = [];
        try {
          const lines = (await readFile(join(box.fakes, 'calls'), 'utf8')).trim().split('\n');
          calls = lines.map((line) => JSON.parse(line));
          await rm(join(box.fakes, 'calls'));
        } catch {
          // No systemctl call was made.
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolveRun({ code, output: stdout + stderr, calls });
      },
    );
  });
}

/** Calls that would change systemd state, as opposed to queries. */
function mutatingCalls(run: Run): string[][] {
  return run.calls.filter((call) => !['is-active', 'is-enabled', 'show'].includes(call[1]));
}

test('enable writes both managed units and enables them, without starting anything', async (context) => {
  const box = await sandbox(context);
  const wtype = join(box.home, 'wtype-candidate');
  await mkdir(wtype);
  await writeFile(join(wtype, 'wtype'), '#!/bin/sh\n', { mode: 0o755 });

  const run = await companionLogin(box, ['enable', '--wtype-dir', wtype]);
  assert.equal(run.code, 0, run.output);

  const shown = await companionLogin(box, ['status']);
  assert.match(shown.output, new RegExp(`wtype {5}${join(wtype, 'wtype')}`));

  const listener = await readFile(join(box.unitDirectory, 'companion-listener.service'), 'utf8');
  const ui = await readFile(join(box.unitDirectory, 'companion-ui.service'), 'utf8');
  assert.ok(listener.startsWith(managedMarker));
  assert.ok(ui.startsWith(managedMarker));
  assert.match(listener, / --paused --no-startup-capture$/m);
  assert.match(
    listener,
    new RegExp(`^Environment=PATH=${wtype}:${dirname(process.execPath)}:`, 'm'),
  );
  assert.equal((await stat(join(box.unitDirectory, 'companion-ui.service'))).mode & 0o777, 0o644);
  assert.equal((await stat(box.logDirectory)).mode & 0o777, 0o700);

  assert.deepEqual(mutatingCalls(run), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', 'companion-listener.service', 'companion-ui.service'],
  ]);
});

test('enable advises starting the written units, not re-enabling with defaults', async (context) => {
  const box = await sandbox(context);
  const config = join(box.home, 'custom.json');
  await writeFile(config, '{}\n');

  const run = await companionLogin(box, ['enable', '--config', config]);
  assert.equal(run.code, 0, run.output);
  assert.match(
    run.output,
    /systemctl --user start companion-listener\.service companion-ui\.service/,
  );
  assert.doesNotMatch(run.output, /enable --now/);
});

test('enable makes an existing public log directory and log files private', async (context) => {
  const box = await sandbox(context);
  await mkdir(box.logDirectory, { recursive: true });
  await chmod(box.logDirectory, 0o755);
  await writeFile(join(box.logDirectory, 'listener.log'), 'old transcript\n', { mode: 0o644 });
  await chmod(join(box.logDirectory, 'listener.log'), 0o644);

  const run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 0, run.output);
  assert.equal((await stat(box.logDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(box.logDirectory, 'listener.log'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(box.logDirectory, 'ui.log'))).mode & 0o777, 0o600);
});

test('enable refuses a symlink in place of a log file and writes no units', async (context) => {
  const box = await sandbox(context);
  await mkdir(box.logDirectory, { recursive: true, mode: 0o700 });
  const elsewhere = join(box.home, 'elsewhere.log');
  await writeFile(elsewhere, '');
  await symlink(elsewhere, join(box.logDirectory, 'ui.log'));

  const run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 1);
  assert.match(run.output, /Cannot use log file/);
  assert.deepEqual(mutatingCalls(run), []);
  await assert.rejects(stat(join(box.unitDirectory, 'companion-listener.service')));
});

test('enable refuses a FIFO in place of a log file instead of hanging', async (context) => {
  const box = await sandbox(context);
  await mkdir(box.logDirectory, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolveFifo, rejectFifo) => {
    execFile('mkfifo', [join(box.logDirectory, 'listener.log')], (error) =>
      error ? rejectFifo(error) : resolveFifo(),
    );
  });

  // companionLogin bounds the run at 30 seconds; a hang would fail the test.
  const run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 1);
  assert.match(run.output, /Cannot use log file|must be a regular file/);
  assert.deepEqual(mutatingCalls(run), []);
});

test('enable --listening --now starts both services and says so', async (context) => {
  const box = await sandbox(context);

  const run = await companionLogin(box, ['enable', '--listening', '--now']);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /starts LISTENING/);

  const listener = await readFile(join(box.unitDirectory, 'companion-listener.service'), 'utf8');
  assert.doesNotMatch(listener, /--paused/);
  assert.deepEqual(mutatingCalls(run).slice(2), [
    ['--user', 'start', 'companion-listener.service'],
    ['--user', 'start', 'companion-ui.service'],
  ]);
});

test('enable refuses and changes nothing when a precondition fails', async (context) => {
  const box = await sandbox(context);

  // Somebody else's unit with the same name is never overwritten.
  await mkdir(box.unitDirectory, { recursive: true });
  await writeFile(join(box.unitDirectory, 'companion-ui.service'), '[Unit]\nDescription=mine\n');
  let run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 1);
  assert.match(run.output, /not written by companion-login/);
  assert.equal(
    await readFile(join(box.unitDirectory, 'companion-ui.service'), 'utf8'),
    '[Unit]\nDescription=mine\n',
  );
  assert.deepEqual(mutatingCalls(run), []);
  await rm(join(box.unitDirectory, 'companion-ui.service'));

  // A credentials file readable by others.
  await mkdir(dirname(box.environmentFile), { recursive: true });
  await writeFile(box.environmentFile, 'COMPANION_LLM_API_KEY=synthetic\n', { mode: 0o644 });
  await chmod(box.environmentFile, 0o644);
  run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 1);
  assert.match(run.output, /chmod 600/);
  assert.doesNotMatch(run.output, /synthetic/);
  assert.deepEqual(mutatingCalls(run), []);
  await chmod(box.environmentFile, 0o600);

  // Not inside a desktop session that has graphical-session.target.
  await writeFile(join(box.fakes, 'session'), 'inactive\n');
  run = await companionLogin(box, ['enable']);
  assert.equal(run.code, 1);
  assert.match(run.output, /graphical-session\.target is inactive/);
  assert.deepEqual(mutatingCalls(run), []);
  await rm(join(box.fakes, 'session'));

  // Missing listener config.
  run = await companionLogin(box, ['enable', '--config', join(box.home, 'absent.json')]);
  assert.equal(run.code, 1);
  assert.match(run.output, /Listener config not found/);
  assert.deepEqual(mutatingCalls(run), []);

  // Relative paths are usage errors.
  run = await companionLogin(box, ['enable', '--config', 'companion.config.json']);
  assert.equal(run.code, 2);

  await assert.rejects(stat(join(box.unitDirectory, 'companion-listener.service')));
});

test('disable removes only its own units and keeps credentials and logs', async (context) => {
  const box = await sandbox(context);
  assert.equal((await companionLogin(box, ['enable'])).code, 0);

  await mkdir(dirname(box.environmentFile), { recursive: true });
  await writeFile(box.environmentFile, 'COMPANION_LLM_API_KEY=synthetic\n', { mode: 0o600 });
  await writeFile(join(box.logDirectory, 'listener.log'), 'previous run\n');

  // Replace one managed unit with a personal one; disable must leave it.
  await writeFile(join(box.unitDirectory, 'companion-ui.service'), '[Unit]\nDescription=mine\n');

  const run = await companionLogin(box, ['disable']);
  assert.equal(run.code, 1, run.output);
  assert.deepEqual(mutatingCalls(run), [
    ['--user', 'disable', '--now', 'companion-listener.service'],
    ['--user', 'daemon-reload'],
  ]);
  await assert.rejects(stat(join(box.unitDirectory, 'companion-listener.service')));
  assert.equal(
    await readFile(join(box.unitDirectory, 'companion-ui.service'), 'utf8'),
    '[Unit]\nDescription=mine\n',
  );
  assert.equal(await readFile(box.environmentFile, 'utf8'), 'COMPANION_LLM_API_KEY=synthetic\n');
  assert.equal(await readFile(join(box.logDirectory, 'listener.log'), 'utf8'), 'previous run\n');
});

test('status only queries systemd and never prints credentials', async (context) => {
  const box = await sandbox(context);
  assert.equal((await companionLogin(box, ['enable'])).code, 0);
  await mkdir(dirname(box.environmentFile), { recursive: true });
  await writeFile(box.environmentFile, 'COMPANION_LLM_API_KEY=synthetic\n', { mode: 0o600 });

  const run = await companionLogin(box, ['status']);
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(mutatingCalls(run), []);
  assert.match(run.output, /at login {2}paused/);
  assert.match(run.output, /present and private/);
  assert.doesNotMatch(run.output, /synthetic/);
});

test('the listener accepts --no-startup-capture only where a startup screenshot exists', async () => {
  const listener = (args: string[]) =>
    new Promise<{ code: number; output: string }>((resolveRun) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        { cwd: repository, timeout: 30_000 },
        (error, stdout) => {
          resolveRun({ code: error ? 1 : 0, output: stdout });
        },
      );
    });

  const help = await listener(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.output, /--no-startup-capture/);

  // Rejected while validating arguments, before any config, capture or model.
  const refused = await listener(['--text', 'hello', '--no-startup-capture']);
  assert.equal(refused.code, 1);
  assert.match(refused.output, /--no-startup-capture applies only to microphone and WAV modes/);
});
