/**
 * Fakes for testing `companion-phone` without a systemd user manager or
 * Tailscale: `systemctl`, `systemd-run` and `tailscale` scripts that keep one
 * unit's state in files, plus `pkill`/`pgrep` trip-wires that record any call.
 *
 * The fake `systemd-run` can start a stand-in gateway: a small Node process
 * listening on the `--listen unix:` path from its arguments, so readiness,
 * stop and "something else answers" paths are real socket behavior.
 *
 * Behavior switches (files in the fake directory):
 *   run-behavior   serve (default) | fail | silent
 *   run-delay      milliseconds systemd-run takes before the unit exists
 *   serve-delay    milliseconds tailscale takes to answer
 *   stop-behavior  stop (default; also removes the socket directory) | stuck
 *   serve-status   printed by `tailscale serve status --json`
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One Node program implementing every fake command, chosen by its file name. */
const fakeProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = __FAKE_DIRECTORY__;
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'calls'), JSON.stringify([name, ...args]) + '\n');

const unitFile = path.join(directory, 'unit.json');
const read = (file, fallback) => { try { return fs.readFileSync(path.join(directory, file), 'utf8').trim(); } catch { return fallback; } };
const unit = () => { try { return JSON.parse(fs.readFileSync(unitFile, 'utf8')); } catch { return undefined; } };
const save = (value) => fs.writeFileSync(unitFile, JSON.stringify(value));
const killGateway = (state) => { if (state && state.pid) { try { process.kill(state.pid); } catch {} } };

if (name === 'pkill' || name === 'pgrep') {
  process.exit(1);
}

if (name === 'tailscale') {
  if (args.join(' ') !== 'serve status --json') { process.exit(64); }
  setTimeout(() => {
    process.stdout.write(read('serve-status', '{}'));
    process.exit(0);
  }, Number(read('serve-delay', '0')));
  return;
}

if (name === 'systemd-run') {
  const properties = args.filter((arg) => arg.startsWith('--property=')).map((arg) => arg.slice(11));
  const property = (key) => (properties.find((p) => p.startsWith(key + '=')) || '').slice(key.length + 1);
  const unitName = (args.find((arg) => arg.startsWith('--unit=')) || '').slice(7);
  const command = args.slice(args.indexOf('--') + 1);
  const listen = command[command.indexOf('--listen') + 1].slice('unix:'.length);
  const behavior = read('run-behavior', 'serve');
  const state = {
    unit: unitName,
    active: 'active',
    sub: 'running',
    result: 'success',
    description: property('Description'),
    environment: property('Environment'),
    transient: 'yes',
    runtimeDirectory: path.dirname(listen),
  };
  if (behavior === 'fail') {
    Object.assign(state, { active: 'failed', sub: 'failed', result: 'exit-code' });
  }
  const create = () => {
  if (behavior === 'serve') {
    fs.mkdirSync(path.dirname(listen), { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1])', listen], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    state.pid = child.pid;
  }
  save(state);
  process.exit(0);
  };
  // A slow submission: the unit only exists once systemd-run has finished.
  setTimeout(create, Number(read('run-delay', '0')));
  return;
}

if (name === 'systemctl') {
  const verb = args[1];
  const state = unit();
  if (verb === 'show') {
    if (!state) {
      process.stdout.write('LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\nDescription=\nTransient=no\nFragmentPath=\nMainPID=0\nNRestarts=0\nEnvironment=\n');
    } else {
      process.stdout.write([
        'LoadState=loaded', 'ActiveState=' + state.active, 'SubState=' + state.sub, 'Result=' + state.result,
        'Description=' + state.description, 'Transient=' + state.transient, 'FragmentPath=/run/fake/' + state.unit,
        'MainPID=' + (state.pid || 0), 'NRestarts=0', 'Environment=' + state.environment,
      ].join('\n') + '\n');
    }
    process.exit(0);
  }
  if (verb === 'stop') {
    if (read('stop-behavior', 'stop') === 'stuck') { process.stderr.write('Job failed\n'); process.exit(1); }
    killGateway(state);
    // Like RuntimeDirectory=: systemd removes the socket directory on stop.
    if (state && state.runtimeDirectory) { fs.rmSync(state.runtimeDirectory, { recursive: true, force: true }); }
    fs.rmSync(unitFile, { force: true });
    process.exit(0);
  }
  if (verb === 'reset-failed') {
    if (state && state.active === 'failed') { fs.rmSync(unitFile, { force: true }); }
    process.exit(0);
  }
  process.exit(1);
}
process.exit(70);
`;

export interface Fakes {
  directory: string;
  binDirectory: string;
  calls(): Promise<string[][]>;
  set(
    file: 'run-behavior' | 'run-delay' | 'serve-delay' | 'stop-behavior' | 'serve-status',
    value: string,
  ): Promise<void>;
  /** Pretend a unit exists (e.g. one this tool did not start). */
  setUnit(state: Record<string, string | number>): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createFakes(): Promise<Fakes> {
  const directory = await mkdtemp(join(tmpdir(), 'companion-phone-fakes-'));
  const binDirectory = join(directory, 'bin');
  await mkdir(binDirectory);

  const program =
    `#!${process.execPath}\n` +
    fakeProgram.replace('__FAKE_DIRECTORY__', JSON.stringify(directory));
  for (const name of ['systemctl', 'systemd-run', 'tailscale', 'pkill', 'pgrep']) {
    await writeFile(join(binDirectory, name), program, { mode: 0o755 });
  }

  return {
    directory,
    binDirectory,
    async calls() {
      let text = '';
      try {
        text = await readFile(join(directory, 'calls'), 'utf8');
      } catch {
        return [];
      }
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    async set(file, value) {
      await writeFile(join(directory, file), value);
    },
    async setUnit(state) {
      await writeFile(join(directory, 'unit.json'), JSON.stringify(state));
    },
    async cleanup() {
      try {
        const state = JSON.parse(await readFile(join(directory, 'unit.json'), 'utf8'));
        if (state.pid) {
          process.kill(state.pid);
        }
      } catch {
        // No fake gateway running.
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal Git checkout that passes the pin check: the gateway options the
 * tool looks for, an ignored node_modules/tsx and an ignored built app page.
 */
export async function createPinnedCheckout(
  parent: string,
): Promise<{ path: string; revision: string }> {
  const path = join(parent, 'checkout');
  await mkdir(join(path, 'src', 'remote'), { recursive: true });
  await mkdir(join(path, 'node_modules', 'tsx', 'dist'), { recursive: true });
  await mkdir(join(path, 'integrations', 'mobile', 'dist'), { recursive: true });
  await writeFile(join(path, '.gitignore'), 'node_modules/\nintegrations/mobile/dist/\n');
  await writeFile(
    join(path, 'src', 'remote', 'cli.ts'),
    "options = { listen: {}, 'require-tailscale-login': {}, 'check-tailscale-serve': {} };\n",
  );
  await writeFile(join(path, 'README.md'), 'Synthetic checkout\n');
  await writeFile(join(path, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  await writeFile(join(path, 'integrations', 'mobile', 'dist', 'index.html'), '<!doctype html>\n');

  const git = (...args: string[]) => run('git', ['-C', path, ...args]);
  await git('init', '--quiet');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'synthetic',
  );
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  return { path, revision };
}
