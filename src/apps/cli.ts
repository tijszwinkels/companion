/**
 * `companion-app`: register, run and open trusted local web apps.
 *
 * Registration and phone access are changed only here, by the local user.
 * Nothing in this command restarts Companion, its listener, UI or gateway, and
 * nothing changes Tailscale, DNS, TLS or system settings.
 */

import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { defaultChromium, openAppWindow } from './desktop.ts';
import { portAcceptsConnections, runApp } from './launcher.ts';
import {
  AppRegistry,
  defaultAppsDirectory,
  parseUpstream,
  type AppLaunch,
  type RegisteredApp,
} from './registry.ts';

const help = `Usage: companion-app <command> [options]

add ID --name NAME --upstream http://127.0.0.1:PORT [--cwd DIR] [-- EXECUTABLE ARGS...]
          Register an app. Its backend must listen on that exact loopback address.
          The optional command after -- is how \`run\` starts it (no shell; the
          executable is resolved to an absolute path now). Phone access starts off.
list      Print registered apps as JSON.
remove ID Forget an app. Its browser profile and its own data are kept.
set-launch ID [--cwd DIR] -- EXECUTABLE ARGS...
          Replace the launch command.   set-launch ID --none   removes it.
phone ID on|off
          Allow or stop phone access. Turning it off ends open phone sessions.

run ID [--open]
          Start the backend in the foreground; Ctrl+C stops it. Refuses if the
          port is already in use. --open opens the app window once it is ready.
open ID   Open the app in its own Chromium window and persistent profile.
desktop-entry ID
          Add a launcher entry (in $XDG_DATA_HOME/applications) that opens the app.

demo [--port N] [--directory DIR] [--no-open]
          Run the synthetic CSV notebook app. Without --directory everything is
          temporary and deleted on exit.

Common:
  --apps-directory PATH   Registry and browser profiles (default ~/companion/apps).
  --chromium PATH         Browser executable (default ${defaultChromium}).
  --help`;

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Split `companion-app … -- command args` at the first standalone `--`. */
function splitCommand(argv: string[]): { options: string[]; command: string[] } {
  const separator = argv.indexOf('--');
  if (separator < 0) {
    return { options: argv, command: [] };
  }

  return { options: argv.slice(0, separator), command: argv.slice(separator + 1) };
}

/**
 * Resolve the executable once, at registration, so later runs do not depend on
 * whoever's PATH happens to start them.
 */
async function resolveExecutable(name: string): Promise<string> {
  if (isAbsolute(name)) {
    await access(name, constants.X_OK);
    return name;
  }
  if (name.includes('/')) {
    const absolute = resolve(name);
    await access(absolute, constants.X_OK);
    return absolute;
  }

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }

  throw Error(`Cannot find executable ${name} in PATH`);
}

async function launchFrom(command: string[], cwd: string | undefined): Promise<AppLaunch> {
  const executable = await resolveExecutable(command[0]);
  const directory = resolve(cwd ?? process.cwd());

  if (!(await stat(directory)).isDirectory()) {
    throw Error(`${directory} is not a directory`);
  }

  return { argv: [executable, ...command.slice(1)], cwd: directory };
}

/** Quote one Exec argument per the Desktop Entry specification. */
function desktopExecArgument(argument: string): string {
  const escaped = argument.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%');
  return `"${escaped}"`;
}

async function writeDesktopEntry(app: RegisteredApp, appsDirectory: string): Promise<string> {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const directory = join(dataHome, 'applications');
  const path = join(directory, `companion-app-${app.id}.desktop`);

  const exec = [
    join(checkout, 'bin', 'companion-app'),
    'open',
    app.id,
    '--apps-directory',
    appsDirectory,
  ]
    .map(desktopExecArgument)
    .join(' ');

  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${app.name.replace(/[\r\n]/g, ' ')}`,
    'Comment=Local app opened by Companion',
    `Exec=${exec}`,
    `StartupWMClass=companion-app-${app.id}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n');

  await mkdir(directory, { recursive: true });
  await writeFile(path, entry, { mode: 0o644 });
  return path;
}

/** Run until SIGINT/SIGTERM; returns the abort signal the handlers trigger. */
function stopSignal(): AbortSignal {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  return controller.signal;
}

async function runForeground(
  registry: AppRegistry,
  app: RegisteredApp,
  openWindow: boolean,
  chromium: string,
): Promise<number> {
  const result = await runApp(app, {
    signal: stopSignal(),
    log: (message) => console.error(`[companion-app] ${message}`),
    onReady: () => {
      console.error(`[companion-app] Open ${app.upstream}/ (Ctrl+C stops the backend)`);
      if (openWindow) {
        registry
          .prepareProfile(app)
          .then((profile) => openAppWindow(app, profile, chromium))
          .catch((error) => {
            console.error(`[companion-app] Could not open the window: ${String(error)}`);
          });
      }
    },
  });

  if (result.stoppedByRequest) {
    console.error(`[companion-app] Stopped ${app.id}; its data and browser profile are kept.`);
    return 0;
  }

  console.error(
    `[companion-app] ${app.id} exited (${result.signal ?? `code ${String(result.code)}`}).`,
  );
  return result.code === 0 ? 0 : 1;
}

async function demo(
  values: { port?: string; directory?: string; 'no-open'?: boolean },
  chromium: string,
): Promise<number> {
  const port = Number(values.port ?? '8791');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('--port must be 1024–65535');
    return 2;
  }

  const temporary = values.directory === undefined;
  const root = values.directory
    ? resolve(values.directory)
    : await mkdtemp(join(tmpdir(), 'companion-app-demo-'));

  try {
    const registry = new AppRegistry(join(root, 'apps'));
    await registry.prepare();

    let app = await registry.get('csv-notebook');
    if (!app) {
      app = await registry.add({
        id: 'csv-notebook',
        name: 'CSV notebook (demo)',
        upstream: `http://127.0.0.1:${port}`,
        launch: {
          argv: [
            join(checkout, 'node_modules', '.bin', 'tsx'),
            join(checkout, 'src', 'apps', 'demo', 'fixture-app.ts'),
            '--port',
            String(port),
            '--data',
            join(root, 'csv-notebook-data'),
          ],
          cwd: root,
        },
      });
    }

    const canOpen =
      !values['no-open'] && Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
    console.error(`[companion-app] Demo state: ${root}${temporary ? ' (deleted on exit)' : ''}`);
    return await runForeground(registry, app, canOpen, chromium);
  } finally {
    if (temporary) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<number> {
  const { options: optionArguments, command } = splitCommand(process.argv.slice(2));
  const { values, positionals } = parseArgs({
    args: optionArguments,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
      upstream: { type: 'string' },
      cwd: { type: 'string' },
      none: { type: 'boolean' },
      open: { type: 'boolean' },
      port: { type: 'string' },
      directory: { type: 'string' },
      'no-open': { type: 'boolean' },
      'apps-directory': { type: 'string' },
      chromium: { type: 'string' },
    },
  });

  const [action, id, extra] = positionals;
  if (values.help || !action) {
    console.log(help);
    return values.help ? 0 : 2;
  }

  const appsDirectory = resolve(values['apps-directory'] ?? defaultAppsDirectory());
  const registry = new AppRegistry(appsDirectory);
  const chromium = values.chromium ?? defaultChromium;

  if (action === 'demo') {
    return demo(values, chromium);
  }

  if (action === 'list') {
    console.log(JSON.stringify(await registry.list(), null, 2));
    return 0;
  }

  if (!id) {
    console.error(`${action} requires an app ID`);
    return 2;
  }

  if (action === 'add') {
    if (!values.name || !values.upstream) {
      console.error('add requires --name and --upstream');
      return 2;
    }

    const launch = command.length > 0 ? await launchFrom(command, values.cwd) : undefined;
    const app = await registry.add({ id, name: values.name, upstream: values.upstream, launch });
    console.log(JSON.stringify(app, null, 2));
    return 0;
  }

  if (action === 'remove') {
    const existing = await registry.get(id);
    const removed = await registry.remove(id);
    if (!existing || !removed) {
      console.log(`No app ${id}`);
      return 1;
    }

    console.log(
      `Removed ${id}. Its browser profile (${registry.profileDirectory(existing)}) and data ` +
        'were kept; adding the same ID again starts a new registration with a fresh profile.',
    );
    return 0;
  }

  if (action === 'set-launch') {
    if (values.none) {
      console.log(JSON.stringify(await registry.update(id, { launch: null }), null, 2));
      return 0;
    }
    if (command.length === 0) {
      console.error('set-launch requires -- EXECUTABLE ARGS... or --none');
      return 2;
    }

    const launch = await launchFrom(command, values.cwd);
    console.log(JSON.stringify(await registry.update(id, { launch }), null, 2));
    return 0;
  }

  if (action === 'phone') {
    if (extra !== 'on' && extra !== 'off') {
      console.error('Usage: companion-app phone ID on|off');
      return 2;
    }

    const app = await registry.update(id, { phoneAccess: extra === 'on' });
    console.log(
      app.phoneAccess
        ? `${id} may now be opened from a paired phone (revision ${app.revision}).`
        : `${id} is no longer available on phones; open phone sessions end within seconds.`,
    );
    return 0;
  }

  const app = await registry.get(id);
  if (!app) {
    console.error(`No app ${id}. See: companion-app list`);
    return 1;
  }

  if (action === 'run') {
    return runForeground(registry, app, values.open === true, chromium);
  }

  if (action === 'open') {
    if (!(await portAcceptsConnections(parseUpstream(app.upstream)))) {
      console.error(
        `${id} is not running at ${app.upstream}. Start it with: companion-app run ${id} --open`,
      );
      return 1;
    }

    const profile = await registry.prepareProfile(app);
    await openAppWindow(app, profile, chromium);
    return 0;
  }

  if (action === 'desktop-entry') {
    const path = await writeDesktopEntry(app, appsDirectory);
    console.log(`Wrote ${path}`);
    return 0;
  }

  console.error(help);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`companion-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
