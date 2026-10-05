/**
 * `companion-login`: opt-in start of the Companion listener and native UI
 * after a desktop login, as two systemd user services.
 *
 * `enable` writes the two unit files (see units.ts) into the user unit
 * directory and enables them for `graphical-session.target`; `disable` stops
 * and removes only files this tool wrote; `status` reports without changing
 * anything. It never runs sudo, never writes credentials, never touches other
 * units, and never matches or kills processes by name. Configuration, the
 * optional credentials file, logs, history and conversations are kept.
 *
 * Inputs: command-line options, this checkout's location, PATH and the XDG
 * directories. Outputs: human-readable lines; exit 0 on success, 1 on a
 * refused or failed action, 2 on a usage error.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assertUnitPath,
  listenerUnit,
  managedMarker,
  renderListenerUnit,
  renderUiUnit,
  uiUnit,
  type LoginStartupPlan,
} from './units.ts';

const help = `Usage: companion-login <command> [options]

Start the Companion listener and native UI automatically after you log into
your desktop (Omarchy/uwsm graphical-session.target). Off until you enable it.

enable      Write and enable the two user services. Run from a desktop terminal
            whose PATH finds the Node.js, Pi and wtype you want Companion to use.
  --listening       Start listening at login. Default: start paused.
  --config PATH     Listener config (default: companion.config.json in this checkout).
  --wtype-dir DIR   Put this directory (e.g. the patched wtype candidate) first in PATH.
  --node PATH       Node.js executable (default: the one running this command).
  --now             Also start the services now, in this session.
disable     Stop and disable the services and remove their unit files. Keeps your
            config, credentials file, logs, history and conversations.
status      Show the unit files, enablement and running state. Changes nothing.

Credentials (optional): systemd reads KEY=value lines from
  ${'$'}XDG_CONFIG_HOME/companion/login.env (default ~/.config/companion/login.env)
which must be private (chmod 600). This command never creates or reads its values.
Logs: ~/.local/state/companion/{listener,ui}.log, replaced at each start.
See docs/installation.md, "Start Companion after login".`;

/** Exit statuses for scripts and agents following the guide. */
const exitCodes = { ok: 0, failed: 1, usage: 2 } as const;

/** Where this tool reads and writes; derived once per command. */
interface Locations {
  checkout: string;
  unitDirectory: string;
  environmentFile: string;
  logDirectory: string;
}

/** Whether a unit file is absent, written by this tool, or somebody else's. */
type UnitFileState = 'missing' | 'managed' | 'foreign';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `systemctl --user` without a shell, with bounded time and output. It is
 * found on PATH, so tests can put a fake first. A non-zero exit is returned,
 * not thrown: `is-active` and `is-enabled` use it for ordinary answers.
 */
function runSystemctl(args: string[], timeoutMilliseconds = 30_000): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      'systemctl',
      ['--user', ...args],
      { timeout: timeoutMilliseconds, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          code = typeof error.code === 'number' ? error.code : 127;
        }
        resolveResult({
          code,
          stdout: String(stdout),
          stderr: String(stderr || error?.message || ''),
        });
      },
    );
  });
}

async function locations(): Promise<Locations> {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const stateHome = process.env.XDG_STATE_HOME || join(home, '.local', 'state');

  // This file lives in <checkout>/src/login-startup/.
  const here = dirname(fileURLToPath(import.meta.url));
  const checkout = await realpath(resolve(here, '..', '..'));

  return {
    checkout,
    unitDirectory: join(configHome, 'systemd', 'user'),
    environmentFile: join(configHome, 'companion', 'login.env'),
    logDirectory: join(stateHome, 'companion'),
  };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    await access(path, constants.X_OK);
    return info.isFile();
  } catch {
    return false;
  }
}

async function unitFileState(path: string): Promise<UnitFileState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }

  if (text.startsWith(managedMarker + '\n')) {
    return 'managed';
  }
  return 'foreign';
}

/**
 * The optional credentials file must be private. It is never read here; its
 * values reach only systemd and, through the listener, its Pi children.
 */
async function environmentFileProblem(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  if (!info.isFile()) {
    return `${path} is not a regular file`;
  }
  if (info.uid !== process.getuid?.()) {
    return `${path} is not owned by you`;
  }
  if ((info.mode & 0o077) !== 0) {
    return `${path} is readable by other users; run: chmod 600 ${path}`;
  }
  return undefined;
}

/**
 * PATH for both services: the optional wtype directory, the chosen Node.js
 * directory (Pi's launcher finds `node` through PATH), then this terminal's
 * PATH. Relative or unrepresentable entries are skipped with a warning.
 */
function servicePath(
  checkout: string,
  node: string,
  wtypeDirectory: string | undefined,
  warn: (line: string) => void,
): string[] {
  const candidates = [];
  if (wtypeDirectory) {
    candidates.push(wtypeDirectory);
  }
  candidates.push(dirname(node));
  candidates.push(...(process.env.PATH ?? '').split(delimiter));

  const entries: string[] = [];
  for (const directory of candidates) {
    if (!directory || entries.includes(directory)) {
      continue;
    }

    // npm/tsx may have added the checkout's own tool directory; the services
    // must not depend on how this command happened to be launched.
    if (directory.startsWith(join(checkout, 'node_modules') + '/')) {
      continue;
    }

    try {
      assertUnitPath('PATH entry', directory);
    } catch (error) {
      warn(`Skipping PATH entry: ${(error as Error).message}`);
      continue;
    }

    entries.push(directory);
  }

  return entries;
}

async function buildPlan(
  where: Locations,
  options: { listening: boolean; config?: string; wtypeDir?: string; node?: string },
  warn: (line: string) => void,
): Promise<LoginStartupPlan> {
  const node = await realpath(options.node ?? process.execPath);
  if (!(await isExecutableFile(node))) {
    throw Error(`Node.js executable not found: ${node}`);
  }

  const config = resolve(options.config ?? join(where.checkout, 'companion.config.json'));
  try {
    if (!(await stat(config)).isFile()) {
      throw Error();
    }
  } catch {
    throw Error(`Listener config not found: ${config} (create it as in docs/installation.md)`);
  }

  try {
    await access(join(where.checkout, 'node_modules', 'tsx', 'package.json'));
  } catch {
    throw Error(`Dependencies are missing in ${where.checkout}; run npm ci there first`);
  }

  const ui = join(where.checkout, 'native', 'window', 'build', 'companion-ui');
  if (!(await isExecutableFile(ui))) {
    throw Error(`Native UI not built: ${ui} (run npm run ui:build)`);
  }

  let wtypeDirectory: string | undefined;
  if (options.wtypeDir !== undefined) {
    wtypeDirectory = await realpath(options.wtypeDir);
    if (!(await isExecutableFile(join(wtypeDirectory, 'wtype')))) {
      throw Error(`No executable wtype in ${wtypeDirectory}`);
    }
  }

  return {
    checkout: where.checkout,
    node,
    config,
    ui,
    path: servicePath(where.checkout, node, wtypeDirectory, warn),
    environmentFile: where.environmentFile,
    logDirectory: where.logDirectory,
    listening: options.listening,
  };
}

/** Write via a temporary name and rename, so systemd never reads half a file. */
async function writeUnitFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.companion-login-${process.pid}`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, path);
}

/** Run a command that must succeed; its failure stops the current action. */
async function systemctl(args: string[], timeoutMilliseconds?: number): Promise<string> {
  const result = await runSystemctl(args, timeoutMilliseconds);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw Error(`systemctl --user ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

/** A query whose answer matters even with a non-zero exit, e.g. `inactive`. */
async function systemctlAnswer(args: string[]): Promise<string> {
  const result = await runSystemctl(args);
  return result.stdout.trim() || result.stderr.trim() || `exit ${result.code}`;
}

async function enable(
  where: Locations,
  options: { listening: boolean; config?: string; wtypeDir?: string; node?: string; now: boolean },
): Promise<number> {
  const plan = await buildPlan(where, options, (line) => console.log(line));

  const credentialsProblem = await environmentFileProblem(plan.environmentFile);
  if (credentialsProblem) {
    console.log(`Refusing: ${credentialsProblem}`);
    return exitCodes.failed;
  }

  // Without this target the units would be written but never start at login.
  const session = await systemctlAnswer(['is-active', 'graphical-session.target']);
  if (session !== 'active') {
    console.log(
      `Refusing: graphical-session.target is ${session}. Run this from your logged-in ` +
        'desktop session; the services rely on a session manager such as Omarchy’s uwsm.',
    );
    return exitCodes.failed;
  }

  for (const unit of [listenerUnit, uiUnit]) {
    const state = await unitFileState(join(where.unitDirectory, unit));
    if (state === 'foreign') {
      console.log(
        `Refusing: ${join(where.unitDirectory, unit)} was not written by companion-login.`,
      );
      return exitCodes.failed;
    }
  }

  await mkdir(where.unitDirectory, { recursive: true });
  await mkdir(where.logDirectory, { recursive: true, mode: 0o700 });

  await writeUnitFile(join(where.unitDirectory, listenerUnit), renderListenerUnit(plan));
  await writeUnitFile(join(where.unitDirectory, uiUnit), renderUiUnit(plan));
  await systemctl(['daemon-reload']);
  await systemctl(['enable', listenerUnit, uiUnit]);

  console.log(`Enabled ${listenerUnit} and ${uiUnit} for your next desktop login.`);
  console.log(`Listener starts ${plan.listening ? 'LISTENING' : 'paused'}; config ${plan.config}`);
  console.log(`Node.js ${plan.node}`);
  console.log(`PATH ${plan.path.join(':')}`);
  console.log(`Logs in ${plan.logDirectory}/ (listener.log, ui.log), replaced at each start.`);

  if (!options.now) {
    console.log('Start them now with: companion-login enable --now, or log out and back in.');
    return exitCodes.ok;
  }

  // `start` leaves an already running service alone; it never restarts one.
  for (const unit of [listenerUnit, uiUnit]) {
    const active = await systemctlAnswer(['is-active', unit]);
    if (active === 'active') {
      console.log(`${unit} is already running; restart it to apply changes:`);
      console.log(`  systemctl --user restart ${unit}`);
      continue;
    }

    await systemctl(['start', unit], 60_000);
    console.log(`Started ${unit}.`);
  }

  return exitCodes.ok;
}

async function disable(where: Locations): Promise<number> {
  const ours: string[] = [];
  let refused = false;

  for (const unit of [listenerUnit, uiUnit]) {
    const state = await unitFileState(join(where.unitDirectory, unit));
    if (state === 'managed') {
      ours.push(unit);
    } else if (state === 'foreign') {
      console.log(`Leaving ${join(where.unitDirectory, unit)}: not written by companion-login.`);
      refused = true;
    }
  }

  if (ours.length > 0) {
    // Waits for each stop job; the listener finishes its graceful shutdown.
    await systemctl(['disable', '--now', ...ours], 90_000);
    for (const unit of ours) {
      await rm(join(where.unitDirectory, unit));
    }
    await systemctl(['daemon-reload']);
    console.log(`Stopped, disabled and removed ${ours.join(' and ')}.`);
  } else if (!refused) {
    console.log('Login startup is not enabled; nothing to do.');
  }

  console.log(
    'Kept: listener config, credentials file, logs, history and conversations. ' +
      'Start Companion manually as in docs/installation.md.',
  );

  return refused ? exitCodes.failed : exitCodes.ok;
}

async function status(where: Locations): Promise<number> {
  for (const unit of [listenerUnit, uiUnit]) {
    const file = join(where.unitDirectory, unit);
    const state = await unitFileState(file);
    const enabled = await systemctlAnswer(['is-enabled', unit]);
    const shown = await systemctlAnswer([
      'show',
      unit,
      '--property=ActiveState,SubState,MainPID,NRestarts,Result',
    ]);

    // systemctl prints properties in its own order, so read them by name.
    const properties = new Map<string, string>();
    for (const line of shown.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) {
        properties.set(line.slice(0, separator), line.slice(separator + 1));
      }
    }
    const active = properties.get('ActiveState');
    const sub = properties.get('SubState');
    const pid = properties.get('MainPID');
    const restarts = properties.get('NRestarts');
    const result = properties.get('Result');

    console.log(`${unit}`);
    console.log(`  file      ${file} (${state})`);
    console.log(`  enabled   ${enabled}`);
    console.log(`  state     ${active}/${sub} pid ${pid} restarts ${restarts} result ${result}`);

    if (unit === listenerUnit && state === 'managed') {
      const text = await readFile(file, 'utf8');
      const paused = / --paused( |$)/m.test(text);
      console.log(`  at login  ${paused ? 'paused' : 'LISTENING'}`);
    }
  }

  const credentialsProblem = await environmentFileProblem(where.environmentFile);
  let credentials = 'present and private';
  try {
    await stat(where.environmentFile);
  } catch {
    credentials = 'absent (optional)';
  }
  if (credentialsProblem) {
    credentials = `NOT OK: ${credentialsProblem}`;
  }

  console.log(`credentials ${where.environmentFile}: ${credentials}`);
  console.log(`logs        ${where.logDirectory}/listener.log, ui.log`);
  console.log(
    `session     graphical-session.target ${await systemctlAnswer(['is-active', 'graphical-session.target'])}`,
  );

  return exitCodes.ok;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(help);
    return command === undefined ? exitCodes.usage : exitCodes.ok;
  }

  const enableOptions = {
    listening: { type: 'boolean', default: false },
    config: { type: 'string' },
    'wtype-dir': { type: 'string' },
    node: { type: 'string' },
    now: { type: 'boolean', default: false },
  } as const;

  let values;
  try {
    values = parseArgs({
      args: rest,
      options: command === 'enable' ? enableOptions : {},
      allowPositionals: false,
    }).values;
  } catch (error) {
    console.log(`${(error as Error).message}\n\n${help}`);
    return exitCodes.usage;
  }

  for (const option of ['config', 'wtype-dir', 'node'] as const) {
    const value = (values as Record<string, unknown>)[option];
    if (typeof value === 'string' && !isAbsolute(value)) {
      console.log(`--${option} needs an absolute path`);
      return exitCodes.usage;
    }
  }

  const where = await locations();

  if (command === 'enable') {
    const chosen = values as {
      listening: boolean;
      config?: string;
      'wtype-dir'?: string;
      node?: string;
      now: boolean;
    };
    return enable(where, {
      listening: chosen.listening,
      config: chosen.config,
      wtypeDir: chosen['wtype-dir'],
      node: chosen.node,
      now: chosen.now,
    });
  }
  if (command === 'disable') {
    return disable(where);
  }
  if (command === 'status') {
    return status(where);
  }

  console.log(`Unknown command: ${command}\n\n${help}`);
  return exitCodes.usage;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`companion-login: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = exitCodes.failed;
  },
);
