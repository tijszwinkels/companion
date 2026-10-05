/**
 * `companion-phone`: opt-in, supervised phone access for Companion.
 *
 * Runs the phone gateway (`companion-remote serve`) from a pinned, reviewed
 * checkout as a hardened *transient* systemd user service, behind a
 * persistent Tailscale Serve route to a private Unix socket. Nothing starts on
 * its own: not at boot, not at login and not with the desktop, unless the
 * listener is started with the opt-in `--phone` option or you run
 * `companion-phone start` yourself.
 *
 * It never runs sudo, never changes Tailscale, never installs or enables unit
 * files, and never matches processes by name. See docs/mobile-startup.md.
 */

import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assertServiceName,
  configPath,
  configVersion,
  defaultControlSocket,
  defaultRuntimeDirectoryName,
  defaultSessionsDirectory,
  defaultStateDirectory,
  defaultUnitName,
  gatewaySocketPath,
  loadConfig,
  runtimeRoot,
  saveConfig,
  validateConfig,
  configHostname,
  type PhoneServiceConfig,
} from './config.ts';
import {
  exitCodes,
  findExecutable,
  renderStatus,
  resolveTools,
  routeCommands,
  startService,
  statusReport,
  stopService,
  type Log,
} from './lifecycle.ts';
import { verifyPinnedCheckout } from './pin.ts';
import { classifyServeConfig, probeServeRoute, type RouteProbe } from './probes.ts';
import { systemdRunArguments, transientServicePlan } from './transient-unit.ts';

const help = `Usage: companion-phone <command> [options]

Opt-in phone access: runs the phone gateway from a pinned, reviewed checkout as a
hardened transient systemd user service behind a Tailscale Serve route to a
private Unix socket. Nothing starts at boot or login. Never runs sudo or changes
Tailscale. See docs/mobile-startup.md.

configure   Record the settings and approve one exact revision (writes the config).
  --origin https://HOST        The tailnet HTTPS name (port 443 only).
  --tailscale-login LOGIN      Required Tailscale login, e.g. name@github.
  --revision SHA               Full commit ID of the reviewed checkout.
  --checkout PATH              Checkout to run (default: this one).
  --node PATH                  node binary (default: the one running this).
  --state-directory PATH       Durable pairing state (default ~/companion/remote).
  --sessions-directory PATH    Saved conversations (default ~/companion/agents/.companion-sessions).
  --control-socket PATH        Listener socket (default $XDG_RUNTIME_DIR/companion/control.sock).
  --unit-name NAME             systemd unit name (default ${defaultUnitName}).
  --runtime-directory-name NAME
                               Socket directory in $XDG_RUNTIME_DIR (default ${defaultRuntimeDirectoryName}).
  --replace                    Overwrite an existing config.

start       Start phone access if everything is in place; waits until it answers.
  --wait-for-listener SECONDS  Wait this long for the desktop listener (default 0).
  --without-listener           Start even if the desktop listener is not running.
  --ready-timeout SECONDS      Wait this long for the gateway (default 90).
stop        Stop phone access. Exit 0 only once it is confirmed off.
  --unit-name NAME, --runtime-directory-name NAME
                               Only without a readable config: which service to stop.
restart     stop, then start (same options as start).
status      Report gateway service, gateway socket, desktop listener, tailnet route
            and pairing state separately. Exit 0 only when phone access is available.
  --json                       Machine-readable report.
check-serve Print the Tailscale Serve state: ours, none, unexpected or unreadable.
  --from-file PATH             Classify saved \`tailscale serve status --json\` output.
print-service
            Print the exact systemd-run command start would use; runs nothing.
route-commands
            Print the one-time sudo commands to add or remove the Serve route.

Common:
  --config PATH                Config file (default $COMPANION_PHONE_CONFIG or
                               ~/.config/companion/phone-gateway.json).
  --help

Exit status: 0 success, 1 refused/failed/unavailable, 2 usage or configuration error.`;

const log: Log = (line) => console.error(line);

/** This checkout, for the default --checkout. */
const thisCheckout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function seconds(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3600) {
    throw new UsageError(`${option} must be a whole number of seconds (0–3600)`);
  }
  return parsed;
}

class UsageError extends Error {}

/** Run a validation, reporting its failure as a usage error (exit 2). */
function usageCheck(check: () => void): void {
  try {
    check();
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/**
 * Options each command accepts. Anything else is a usage error rather than
 * silently ignored: a misplaced option must never change which unit `stop`
 * acts on, for example.
 */
const commandOptions: Record<string, string[]> = {
  configure: [
    'origin',
    'tailscale-login',
    'revision',
    'checkout',
    'node',
    'state-directory',
    'sessions-directory',
    'control-socket',
    'unit-name',
    'runtime-directory-name',
    'replace',
  ],
  start: ['wait-for-listener', 'without-listener', 'ready-timeout'],
  restart: ['wait-for-listener', 'without-listener', 'ready-timeout'],
  stop: ['unit-name', 'runtime-directory-name'],
  status: ['json'],
  'check-serve': ['from-file'],
  'print-service': [],
  'route-commands': [],
};

/**
 * SIGTERM/SIGINT cancel a start cooperatively instead of killing it at an
 * arbitrary point (see StartOptions.cancelled): the start finishes or undoes
 * its current step, then exits. The listener's --phone hook relies on this.
 */
function cancellationSignal(): AbortSignal {
  const controller = new AbortController();
  const cancel = () => {
    if (!controller.signal.aborted) {
      log('companion-phone: cancelling the start');
      controller.abort();
    }
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  return controller.signal;
}

/** Quote one argument for a POSIX shell, so printed commands can be pasted. */
function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9/._+=:@,-]+$/.test(argument)) {
    return argument;
  }
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        origin: { type: 'string' },
        'tailscale-login': { type: 'string' },
        revision: { type: 'string' },
        checkout: { type: 'string' },
        node: { type: 'string' },
        'state-directory': { type: 'string' },
        'sessions-directory': { type: 'string' },
        'control-socket': { type: 'string' },
        'unit-name': { type: 'string' },
        'runtime-directory-name': { type: 'string' },
        replace: { type: 'boolean' },
        'wait-for-listener': { type: 'string' },
        'without-listener': { type: 'boolean' },
        'ready-timeout': { type: 'string' },
        json: { type: 'boolean' },
        'from-file': { type: 'string' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseCommandLine();

  const [command, ...extra] = positionals;
  if (values.help) {
    console.log(help);
    return exitCodes.ok;
  }
  if (!command || extra.length > 0 || !(command in commandOptions)) {
    console.error(help);
    return exitCodes.usage;
  }
  for (const option of Object.keys(values)) {
    if (option !== 'config' && !commandOptions[command].includes(option)) {
      throw new UsageError(`${command} does not take --${option}`);
    }
  }

  const file = configPath(values.config);

  if (command === 'configure') {
    return configure(file, values);
  }

  if (command === 'stop') {
    return stop(file, values);
  }

  let config: PhoneServiceConfig | undefined;
  try {
    config = await loadConfig(file);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (!config) {
    log(`companion-phone: not configured (${file} does not exist); run companion-phone configure`);
    return command === 'status' && values.json ? printUnconfigured(file) : exitCodes.usage;
  }
  const root = runtimeRoot();

  const startOptions = () => ({
    readySeconds: seconds(values['ready-timeout'], 90, '--ready-timeout'),
    listenerWaitSeconds: seconds(values['wait-for-listener'], 0, '--wait-for-listener'),
    withoutListener: values['without-listener'] === true,
    cancelled: cancellationSignal(),
  });

  switch (command) {
    case 'start':
      return startService(config, root, startOptions(), log);

    case 'restart': {
      const options = startOptions();
      const stopped = await stopService(config.unitName, gatewaySocketPath(config, root), log);
      if (stopped !== exitCodes.ok) {
        return stopped;
      }
      return startService(config, root, options, log);
    }

    case 'status': {
      const report = await statusReport(config, root);
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        renderStatus(report, (line) => console.log(line));
      }
      return report.available ? exitCodes.ok : exitCodes.failed;
    }

    case 'check-serve':
      return checkServe(config, root, values['from-file']);

    case 'print-service': {
      const plan = transientServicePlan(config, await resolveTools(), root);
      const words = ['systemd-run', ...systemdRunArguments(plan)].map(shellQuote);
      console.log(words.join(' \\\n  '));
      return exitCodes.ok;
    }

    case 'route-commands': {
      const commands = routeCommands(gatewaySocketPath(config, root));
      console.log('# Add the persistent tailnet route (run yourself, once):');
      console.log(commands.add.join('\n'));
      console.log('# Remove it again:');
      console.log(commands.remove.join('\n'));
      return exitCodes.ok;
    }

    default:
      console.error(help);
      return exitCodes.usage;
  }
}

function printUnconfigured(file: string): number {
  console.log(JSON.stringify({ configured: false, config: file, available: false }, null, 2));
  return exitCodes.failed;
}

/**
 * Stop the configured service. Without a readable config the tool cannot
 * know which instance is meant, so it refuses rather than guess a default
 * name: `--unit-name` (and optionally `--runtime-directory-name`, for the
 * socket check) names one explicitly. With a config those come from it.
 */
async function stop(
  file: string,
  values: { 'unit-name'?: string; 'runtime-directory-name'?: string },
): Promise<number> {
  const explicitUnit = values['unit-name'];
  const explicitRuntime = values['runtime-directory-name'];

  let config: PhoneServiceConfig | undefined;
  let problem: string | undefined;
  try {
    config = await loadConfig(file);
  } catch (error) {
    problem = (error as Error).message;
  }

  if (config) {
    if (explicitUnit !== undefined || explicitRuntime !== undefined) {
      throw new UsageError(
        'stop takes the unit and runtime directory from the config; do not pass them',
      );
    }
    return stopService(config.unitName, gatewaySocketPath(config, runtimeRoot()), log);
  }

  if (explicitUnit === undefined) {
    log(`companion-phone: ${problem ?? `not configured (${file} does not exist)`}`);
    throw new UsageError(
      'cannot tell which phone service to stop; pass --unit-name NAME ' +
        '(and --runtime-directory-name NAME to check its socket)',
    );
  }
  usageCheck(() => assertServiceName('--unit-name', explicitUnit));
  let socketPath: string | undefined;
  if (explicitRuntime !== undefined) {
    usageCheck(() => assertServiceName('--runtime-directory-name', explicitRuntime));
    socketPath = join(runtimeRoot(), explicitRuntime, 'gateway.sock');
  }
  return stopService(explicitUnit, socketPath, log);
}

async function checkServe(
  config: PhoneServiceConfig,
  root: string,
  fromFile: string | undefined,
): Promise<number> {
  const expected = {
    hostname: configHostname(config),
    socketPath: gatewaySocketPath(config, root),
  };

  let route: RouteProbe;
  if (fromFile !== undefined) {
    route = await classifySavedStatus(fromFile, expected);
  } else {
    const tailscale = await findExecutable('tailscale');
    route = await probeServeRoute(tailscale, expected);
  }

  console.log(route.state);
  if (route.state === 'unexpected' || route.state === 'unreadable') {
    log(`companion-phone: ${route.reason}`);
    return exitCodes.failed;
  }
  return exitCodes.ok;
}

/** Classify a saved `tailscale serve status --json` file, e.g. for a review. */
async function classifySavedStatus(
  path: string,
  expected: { hostname: string; socketPath: string },
): Promise<RouteProbe> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { state: 'unreadable', reason: (error as Error).message };
  }
  return classifyServeConfig(parsed, expected);
}

type ConfigureValues = {
  origin?: string;
  'tailscale-login'?: string;
  revision?: string;
  checkout?: string;
  node?: string;
  'state-directory'?: string;
  'sessions-directory'?: string;
  'control-socket'?: string;
  'unit-name'?: string;
  'runtime-directory-name'?: string;
  replace?: boolean;
};

async function configure(file: string, values: ConfigureValues): Promise<number> {
  if (!values.origin || !values['tailscale-login'] || !values.revision) {
    throw new UsageError('configure needs --origin, --tailscale-login and --revision');
  }

  if (!values.replace && (await loadConfig(file)) !== undefined) {
    log(`companion-phone: ${file} already exists; pass --replace to overwrite it`);
    return exitCodes.failed;
  }

  let config: PhoneServiceConfig;
  try {
    config = validateConfig({
      version: configVersion,
      origin: values.origin,
      tailscaleLogin: values['tailscale-login'],
      checkout: values.checkout ?? (await realpath(thisCheckout)),
      revision: values.revision,
      nodeExecutable: values.node ?? (await realpath(process.execPath)),
      stateDirectory: values['state-directory'] ?? defaultStateDirectory(),
      sessionsDirectory: values['sessions-directory'] ?? defaultSessionsDirectory(),
      controlSocket: values['control-socket'] ?? defaultControlSocket(),
      unitName: values['unit-name'] ?? defaultUnitName,
      runtimeDirectoryName: values['runtime-directory-name'] ?? defaultRuntimeDirectoryName,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const problems = await verifyPinnedCheckout(
    config.checkout,
    config.revision,
    await findExecutable('git'),
  );
  if (problems.length > 0) {
    for (const problem of problems) {
      log(`companion-phone: ${problem}`);
    }
    log('companion-phone: not saved; fix the checkout or approve its actual revision');
    return exitCodes.failed;
  }

  // Everything that can be checked without starting anything is checked
  // before the file is written: the socket path length and the runtime
  // directory layout included.
  let socketPath: string;
  try {
    socketPath = gatewaySocketPath(config, runtimeRoot());
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  await saveConfig(file, config);

  console.log(`Saved ${file}`);
  console.log(`Gateway code: ${config.checkout} at ${config.revision}`);
  console.log(`Phone origin: ${config.origin} (login ${config.tailscaleLogin})`);
  console.log(`Gateway socket: ${socketPath}`);
  console.log('Nothing was started. Next steps are in docs/mobile-startup.md.');
  return exitCodes.ok;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`companion-phone: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError ? exitCodes.usage : exitCodes.failed;
  },
);
