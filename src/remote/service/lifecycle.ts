/**
 * Start, stop and report on the supervised phone gateway.
 *
 * Ordering with the desktop (see docs/mobile-startup.md; the listener's
 * opt-in `--phone` hook in desktop-hook.ts follows it):
 * - Start phone access only after the desktop listener answers on its control
 *   socket (`start` checks, or waits with `--wait-for-listener`).
 * - Stop phone access before the listener's control socket goes away.
 * - A listener restart while the gateway runs is harmless: phones get "listener
 *   unavailable" (close code 4503) and reconnect when it is back.
 * - One gateway per pairing state: start refuses while another gateway holds
 *   the state's lifetime lock (see Gateway.start).
 *
 * Start refuses, before anything runs, unless every precondition holds: the
 * pinned checkout is exactly the approved revision, the pairing directory is
 * private and not served by another gateway, the listener answers, and
 * Tailscale Serve has exactly the one
 * expected route to the gateway socket (the gateway re-checks this itself).
 * It never runs sudo or changes Serve; when the route is missing it prints the
 * one-time command for the user to run.
 *
 * Stop only ever names this tool's own transient unit. It reports success
 * only once that unit is confirmed inactive and nothing answers on the
 * gateway socket any more.
 */

import { access, constants, lstat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DeviceStore } from '../devices.ts';
import {
  assertSafePath,
  configHostname,
  gatewayRuntimeDirectory,
  type PhoneServiceConfig,
} from './config.ts';
import { verifyPinnedCheckout } from './pin.ts';
import {
  pairingStateInUse,
  probePairingState,
  probeServeRoute,
  probeUnixSocket,
  type RouteProbe,
  type SocketProbe,
  type StateProbe,
} from './probes.ts';
import {
  isOurUnit,
  resetFailedUnit,
  startTransientService,
  stopUnit,
  unitRunning,
  unitState,
  type UnitState,
} from './systemd.ts';
import { transientServicePlan, type ServiceTools } from './transient-unit.ts';

/** Exit codes shared by every command. */
export const exitCodes = { ok: 0, failed: 1, usage: 2 } as const;

export type Log = (line: string) => void;

/** How often start polls for readiness, and how long a stopped unit may look stopped. */
const pollMilliseconds = 500;

/**
 * An automatic restart passes briefly through "failed"; only a unit that
 * stays down for longer than RestartSec=2 (seven polls, 3.5 s) has really
 * given up, e.g. after hitting its start limit.
 */
const downPollsBeforeGivingUp = 7;

/** Find an executable on PATH, as an absolute path systemd can run. */
export async function findExecutable(name: string, path = process.env.PATH ?? ''): Promise<string> {
  for (const directory of path.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next directory.
    }
  }
  throw Error(`${name} was not found on PATH`);
}

/** The helpers the service needs, resolved once per command. */
export async function resolveTools(): Promise<ServiceTools> {
  const tools = {
    git: await findExecutable('git'),
    tailscale: await findExecutable('tailscale'),
    flock: await findExecutable('flock'),
  };
  for (const [name, path] of Object.entries(tools)) {
    assertSafePath(name, path);
  }
  return tools;
}

function expectedRoute(config: PhoneServiceConfig, socketPath: string) {
  return { hostname: configHostname(config), socketPath };
}

/** Human-run commands for the persistent Serve route; this tool never runs them. */
export function routeCommands(socketPath: string): { add: string[]; remove: string[] } {
  return {
    add: [`sudo tailscale serve --bg --https=443 unix:${socketPath}`, 'sudo -k'],
    remove: ['sudo tailscale serve --https=443 off', 'sudo -k'],
  };
}

function journalHint(unit: string): string {
  return `journalctl --user -u ${unit} -n 50`;
}

function describeSocket(probe: SocketProbe): string {
  if (probe.state === 'unsafe' || probe.state === 'error') {
    return `${probe.state} (${probe.reason})`;
  }
  return probe.state;
}

/**
 * Wait until the listener answers, for at most `seconds` (0: check once), or
 * until the start is cancelled.
 */
async function waitForListener(
  controlSocket: string,
  seconds: number,
  cancelled: AbortSignal | undefined,
): Promise<SocketProbe> {
  const deadline = Date.now() + seconds * 1000;
  let probe = await probeUnixSocket(controlSocket);
  while (probe.state !== 'answering' && Date.now() < deadline && !cancelled?.aborted) {
    // The pause ends early on cancellation; the caller then refuses.
    try {
      await delay(pollMilliseconds, undefined, { signal: cancelled });
    } catch {
      break;
    }
    probe = await probeUnixSocket(controlSocket);
  }
  return probe;
}

export interface StartOptions {
  /** How long to wait for the gateway to answer after starting it. */
  readySeconds: number;
  /** How long to wait for the desktop listener before refusing. */
  listenerWaitSeconds: number;
  /** Start even though the desktop listener does not answer (phones then see it as unavailable). */
  withoutListener: boolean;
  /**
   * Cooperative cancellation (SIGTERM/SIGINT to `companion-phone start`).
   * Checked between steps, never in the middle of `systemd-run`: a request
   * that may already have reached systemd is always waited for, and a unit
   * this invocation created is stopped again, so a cancelled start cannot
   * leave a gateway appearing afterwards.
   */
  cancelled?: AbortSignal;
}

export async function startService(
  config: PhoneServiceConfig,
  root: string,
  options: StartOptions,
  log: Log,
): Promise<number> {
  const tools = await resolveTools();
  const plan = transientServicePlan(config, tools, root);
  const isCancelled = () => options.cancelled?.aborted === true;
  const refuse = (reason: string): number => {
    log(`companion-phone: not starting: ${reason}`);
    return exitCodes.failed;
  };

  // 1. The code to run must be exactly the approved revision.
  const pinProblems = await verifyPinnedCheckout(config.checkout, config.revision, tools.git);
  if (pinProblems.length > 0) {
    for (const problem of pinProblems) {
      log(`companion-phone: ${problem}`);
    }
    return refuse(
      'the checkout is not the approved, complete revision (re-run configure after review)',
    );
  }
  try {
    await access(config.nodeExecutable, constants.X_OK);
  } catch {
    return refuse(`${config.nodeExecutable} is not executable (re-run configure with --node)`);
  }

  // 2. Is a unit of this name already there?
  let state = await unitState(plan.unit);
  if (state.loadState !== 'not-found' && !isOurUnit(state)) {
    return refuse(
      `a unit named ${plan.unit} exists that this tool did not start ` +
        '(an installed unit file or another transient unit); leave it alone or choose --unit-name',
    );
  }
  if (unitRunning(state)) {
    if (state.fingerprint !== plan.fingerprint) {
      return refuse(
        `${plan.unit} is already running with different settings or revision; ` +
          'use `companion-phone restart` to switch',
      );
    }
    log(`companion-phone: ${plan.unit} is already running with this configuration`);
    return waitUntilReady(config, plan.unit, plan.socketPath, options, log, false);
  }
  if (state.activeState === 'failed' || state.loadState !== 'not-found') {
    // A failed transient unit keeps its name until it is reset.
    await resetFailedUnit(plan.unit);
    state = await unitState(plan.unit);
    if (state.loadState !== 'not-found' && !isOurUnit(state)) {
      return refuse(`${plan.unit} could not be reset (${state.activeState})`);
    }
  }

  // 2b. The runtime directory must not exist yet. systemd would adopt an
  // existing directory of that name and delete it, with whatever is inside,
  // when the service stops. Ours only exists while our unit runs.
  const runtimeDirectory = gatewayRuntimeDirectory(config, root);
  try {
    await lstat(runtimeDirectory);
    return refuse(
      `${runtimeDirectory} already exists; systemd would take it over and delete it on stop. ` +
        'Remove it if it is a leftover of this service, or choose another --runtime-directory-name',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // 3. Durable pairing state must be private if it exists (created in step 7).
  const pairing = await probePairingState(config.stateDirectory);
  if (pairing.state === 'problem') {
    return refuse(`pairing state ${config.stateDirectory}: ${pairing.reason}`);
  }

  // 3b. No other gateway may serve the same pairing state, e.g. one started
  // in a terminal. (Gateways older than the state lock cannot be detected.)
  if (
    pairing.state !== 'missing' &&
    (await pairingStateInUse(config.stateDirectory, tools.flock))
  ) {
    return refuse(
      `another phone gateway is serving the pairing state ${config.stateDirectory}; stop it first`,
    );
  }

  // 4. Nothing may already answer on the gateway socket (e.g. a manual gateway).
  const existing = await probeUnixSocket(plan.socketPath);
  if (existing.state !== 'absent' && existing.state !== 'not-answering') {
    return refuse(`something else is at ${plan.socketPath} (${describeSocket(existing)})`);
  }

  if (isCancelled()) {
    return refuse('cancelled');
  }

  // 5. The desktop listener.
  if (!options.withoutListener) {
    const listener = await waitForListener(
      config.controlSocket,
      options.listenerWaitSeconds,
      options.cancelled,
    );
    if (isCancelled()) {
      return refuse('cancelled');
    }
    if (listener.state !== 'answering') {
      return refuse(
        `the desktop listener does not answer on ${config.controlSocket} (${describeSocket(listener)}); ` +
          'start Companion first, or pass --without-listener',
      );
    }
  }

  if (isCancelled()) {
    return refuse('cancelled');
  }

  // 6. The tailnet route: exactly ours, or nothing starts.
  const route = await probeServeRoute(tools.tailscale, expectedRoute(config, plan.socketPath));
  if (route.state !== 'ours') {
    reportRouteProblem(route, plan.socketPath, log);
    return refuse('Tailscale Serve does not have exactly the expected route');
  }

  // 7. Create the pairing directory (0700) if this is the first start: the
  // sandbox needs it to exist. Then start the service and wait until it answers.
  try {
    await new DeviceStore(config.stateDirectory).prepare();
  } catch (error) {
    return refuse(`pairing state ${config.stateDirectory}: ${(error as Error).message}`);
  }
  // The last point where a cancelled start creates nothing at all.
  if (isCancelled()) {
    return refuse('cancelled');
  }
  // Not interrupted once begun: systemd may accept the request even if this
  // client died, so we always learn the outcome (bounded by its timeout).
  await startTransientService(plan);
  log(`companion-phone: started ${plan.unit} (${config.revision.slice(0, 12)})`);
  return waitUntilReady(config, plan.unit, plan.socketPath, options, log, true);
}

function reportRouteProblem(route: RouteProbe, socketPath: string, log: Log): void {
  const commands = routeCommands(socketPath);
  if (route.state === 'none') {
    log(
      'companion-phone: Tailscale Serve has no route yet. This is a one-time step you run yourself:',
    );
    for (const line of commands.add) {
      log(`  ${line}`);
    }
    log(
      'Then run this command again. (Remove it later with: ' + commands.remove.join(' && ') + ')',
    );
  } else if (route.state === 'unexpected') {
    log(`companion-phone: Tailscale Serve is configured differently: ${route.reason}`);
    log('  Inspect it with `tailscale serve status`; this tool never changes it.');
  } else if (route.state === 'unreadable') {
    log(`companion-phone: ${route.reason}`);
  }
}

/**
 * Poll until the gateway socket answers while the unit runs. Gives up when
 * the unit has stayed down (see downPollsBeforeGivingUp) or the deadline
 * passes; in the latter case a unit we just started is stopped again, so a
 * failed start never leaves a half-started gateway behind.
 */
async function waitUntilReady(
  config: PhoneServiceConfig,
  unit: string,
  socketPath: string,
  options: StartOptions,
  log: Log,
  startedHere: boolean,
): Promise<number> {
  const seconds = options.readySeconds;
  const deadline = Date.now() + seconds * 1000;
  let downPolls = 0;

  // A unit this invocation created is stopped again if the start does not
  // complete: on timeout, and when the start is cancelled.
  const undo = async (reason: string): Promise<number> => {
    log(`companion-phone: ${reason}`);
    if (startedHere) {
      await stopUnit(unit);
      log(`companion-phone: stopped ${unit} again`);
    }
    return exitCodes.failed;
  };

  while (Date.now() < deadline) {
    if (options.cancelled?.aborted) {
      return undo('start cancelled');
    }

    const state = await unitState(unit);
    const running = unitRunning(state);

    if (running && state.activeState === 'active') {
      const socket = await probeUnixSocket(socketPath);
      if (socket.state === 'answering') {
        log(`companion-phone: phone access is on: ${config.origin}`);
        return exitCodes.ok;
      }
    }

    if (running) {
      downPolls = 0;
    } else {
      downPolls++;
      if (downPolls >= downPollsBeforeGivingUp) {
        log(
          `companion-phone: the gateway stopped (${state.activeState}, ${state.result || 'no result'}); ` +
            `see ${journalHint(unit)}`,
        );
        return exitCodes.failed;
      }
    }

    await delay(pollMilliseconds);
  }

  return undo(`the gateway did not answer within ${seconds} s; see ${journalHint(unit)}`);
}

/**
 * Stop the gateway. Success means: our unit is not running and nothing
 * answers on the gateway socket. A unit of this name that this tool did not
 * start is left alone and reported as a failure.
 */
export async function stopService(
  unitName: string,
  socketPath: string | undefined,
  log: Log,
): Promise<number> {
  const unit = `${unitName}.service`;
  let state = await unitState(unit);

  if (state.loadState !== 'not-found' && !isOurUnit(state)) {
    log(`companion-phone: ${unit} was not started by companion-phone; not touching it`);
    return exitCodes.failed;
  }

  // A unit already deactivating (a stop issued elsewhere) is stopped too:
  // `systemctl stop` joins the pending stop job and waits for it (bounded by
  // the unit's TimeoutStopSec and our command timeout), instead of failing.
  if (unitRunning(state) || state.activeState === 'deactivating') {
    const result = await stopUnit(unit);
    if (result.code !== 0) {
      log(`companion-phone: systemctl --user stop ${unit} failed: ${result.stderr.trim()}`);
    }
    state = await unitState(unit);
  }

  if (unitRunning(state) || state.activeState === 'deactivating') {
    log(`companion-phone: ${unit} is still ${state.activeState}; phone access may still be on`);
    return exitCodes.failed;
  }
  if (state.activeState === 'failed') {
    await resetFailedUnit(unit);
  }

  // Without a config (an explicit --unit-name stop) the socket path is
  // unknown: report the unit as stopped, but do not claim phone access is off.
  if (socketPath === undefined) {
    log(`companion-phone: ${unit} is not running; the gateway socket was not checked (no config)`);
    return exitCodes.ok;
  }

  // "Off" only for a definite result: nothing there, or a socket that
  // refuses connections. Anything else might still serve Tailscale Serve.
  const socket = await probeUnixSocket(socketPath);
  if (socket.state === 'answering') {
    log(`companion-phone: ${unit} is stopped, but something still answers on ${socketPath}`);
    return exitCodes.failed;
  }
  if (socket.state !== 'absent' && socket.state !== 'not-answering') {
    log(
      `companion-phone: ${unit} is stopped, but ${socketPath} is ${describeSocket(socket)}; ` +
        'cannot confirm phone access is off',
    );
    return exitCodes.failed;
  }

  log('companion-phone: phone access is off');
  return exitCodes.ok;
}

export interface StatusReport {
  configured: boolean;
  origin?: string;
  revision?: string;
  unit: string;
  gateway: {
    service: string;
    ours: boolean;
    matchesConfig: boolean;
    restarts: number;
    socket: SocketProbe;
    socketPath?: string;
  };
  checkout: { ok: boolean; problems: string[] };
  listener: SocketProbe & { path?: string };
  route: RouteProbe & { add?: string[]; remove?: string[] };
  pairing: StateProbe & { path?: string };
  /** True when a phone could use Companion right now. */
  available: boolean;
  reasons: string[];
}

function describeState(state: StateProbe): string {
  if (state.state === 'ok') {
    return `private, ${state.devices} paired device${state.devices === 1 ? '' : 's'}`;
  }
  if (state.state === 'missing') {
    return 'not created yet';
  }
  return state.reason;
}

function describeUnit(state: UnitState): string {
  if (state.loadState === 'not-found') {
    return 'not running';
  }
  const detail =
    state.subState && state.subState !== state.activeState ? ` (${state.subState})` : '';
  const result = state.activeState === 'failed' ? `, ${state.result}` : '';
  return `${state.activeState}${detail}${result}`;
}

/** Collect every part of phone access separately. Read-only. */
export async function statusReport(
  config: PhoneServiceConfig,
  root: string,
): Promise<StatusReport> {
  const tools = await resolveTools();
  const plan = transientServicePlan(config, tools, root);
  const state = await unitState(plan.unit);
  const socket = await probeUnixSocket(plan.socketPath);
  const listener = await probeUnixSocket(config.controlSocket);
  const route = await probeServeRoute(tools.tailscale, expectedRoute(config, plan.socketPath));
  const pairing = await probePairingState(config.stateDirectory);
  const pinProblems = await verifyPinnedCheckout(config.checkout, config.revision, tools.git);

  const ours = isOurUnit(state);
  const running = ours && unitRunning(state);
  const reasons: string[] = [];
  if (!running || state.activeState !== 'active') {
    reasons.push('the gateway service is not running');
  } else if (socket.state !== 'answering') {
    reasons.push('the gateway does not answer on its socket yet');
  }
  if (running && state.fingerprint !== plan.fingerprint) {
    reasons.push(
      'the running gateway was started with other settings or revision (restart to apply them)',
    );
  }
  if (state.loadState !== 'not-found' && !ours) {
    reasons.push(`${plan.unit} exists but was not started by companion-phone`);
  }
  if (listener.state !== 'answering') {
    reasons.push('the desktop listener is not running');
  }
  if (route.state !== 'ours') {
    reasons.push('the tailnet route (Tailscale Serve) is not exactly the expected one');
  }
  if (pairing.state === 'ok' && pairing.devices === 0) {
    reasons.push('no phone is paired');
  } else if (pairing.state !== 'ok') {
    reasons.push('the pairing state is not usable');
  }

  const commands = routeCommands(plan.socketPath);
  return {
    configured: true,
    origin: config.origin,
    revision: config.revision,
    unit: plan.unit,
    gateway: {
      service: describeUnit(state),
      ours,
      matchesConfig: ours && state.fingerprint === plan.fingerprint,
      restarts: state.restarts,
      socket,
      socketPath: plan.socketPath,
    },
    checkout: { ok: pinProblems.length === 0, problems: pinProblems },
    listener: { ...listener, path: config.controlSocket },
    route: route.state === 'ours' ? route : { ...route, ...commands },
    pairing: { ...pairing, path: config.stateDirectory },
    available: reasons.length === 0,
    reasons,
  };
}

export function renderStatus(report: StatusReport, log: Log): void {
  const gateway = report.gateway;
  let service = gateway.service;
  if (gateway.ours && !gateway.matchesConfig) {
    service += ' — started with other settings or revision (restart to apply)';
  }
  if (gateway.restarts > 0) {
    service += `, ${gateway.restarts} automatic restart${gateway.restarts === 1 ? '' : 's'}`;
  }

  log(`Phone origin:     ${report.origin} (code ${report.revision?.slice(0, 12)})`);
  log(`Gateway service:  ${service} [${report.unit}]`);
  log(`Gateway socket:   ${describeSocket(gateway.socket)} (${gateway.socketPath})`);
  log(
    `Pinned checkout:  ${report.checkout.ok ? 'ok' : 'NOT startable: ' + report.checkout.problems.join('; ')}`,
  );
  log(`Desktop listener: ${describeSocket(report.listener)} (${report.listener.path})`);

  let route: string = report.route.state;
  if (report.route.state === 'unexpected' || report.route.state === 'unreadable') {
    route += ` — ${report.route.reason}`;
  }
  log(`Tailnet route:    ${route}`);
  if (report.route.state === 'none' && report.route.add) {
    log('  One-time setup you run yourself: ' + report.route.add.join(' && '));
  }

  log(`Pairing state:    ${describeState(report.pairing)} (${report.pairing.path})`);
  log(
    report.available
      ? 'Phone access:     available'
      : `Phone access:     unavailable — ${report.reasons.join('; ')}`,
  );
}
