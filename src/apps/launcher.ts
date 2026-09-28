/**
 * Foreground lifecycle for one registered app backend.
 *
 * `companion-app run <id>` owns exactly the process it starts:
 *
 *   1. Refuse if something already listens on the registered port. Companion
 *      never attaches to, adopts or kills a process it did not start, and it
 *      keeps no PID file that could later point at an unrelated process.
 *   2. Start the registered argv directly (no shell) in a new process group,
 *      with the registered working directory.
 *   3. Report readiness once the loopback port accepts connections.
 *   4. Stop when the backend exits (its remaining helpers get SIGTERM), or
 *      when asked (Ctrl+C / SIGTERM to the supervisor): SIGTERM to the
 *      backend's process group, then SIGKILL after a grace period.
 *
 * The backend therefore lives exactly as long as that foreground command.
 * Closing an app window never stops it, and stopping it never deletes app data.
 * If the supervisor itself is killed with SIGKILL it cannot clean up; the
 * backend then keeps running and a later `run` refuses the busy port until the
 * user stops that process themselves.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

import { parseUpstream, type LoopbackEndpoint, type RegisteredApp } from './registry.ts';

export interface RunOptions {
  /** Called once when the backend's port accepts connections. */
  onReady?(): void;
  /** Aborting stops the backend (group SIGTERM, then SIGKILL). */
  signal?: AbortSignal;
  /** How long to wait for the port after starting; default 30 seconds. */
  readyTimeoutMilliseconds?: number;
  /** Grace period between SIGTERM and SIGKILL; default 5 seconds. */
  stopGraceMilliseconds?: number;
  /** Where the backend's stdout/stderr go; default: this terminal. */
  output?: 'inherit' | 'ignore';
  log?(message: string): void;
}

export interface RunResult {
  /** The backend's exit code, or null when it ended by signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when we stopped it (abort), false when it exited on its own. */
  stoppedByRequest: boolean;
  /** Whether it ever accepted connections. */
  becameReady: boolean;
}

/** Try one TCP connection to the endpoint; resolves true if it was accepted. */
export function portAcceptsConnections(
  endpoint: LoopbackEndpoint,
  timeoutMilliseconds = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.address, port: endpoint.port });

    const finish = (accepted: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(accepted);
    };

    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * The backend's environment: the caller's environment without Companion's own
 * variables. A `run` started from inside a Companion agent turn must not hand
 * that turn's internal session/widget tokens or socket paths to app code.
 */
export function backendEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('COMPANION_')) {
      continue;
    }
    environment[name] = value;
  }

  return environment;
}

export async function runApp(app: RegisteredApp, options: RunOptions = {}): Promise<RunResult> {
  const log = options.log ?? (() => {});

  if (!app.launch) {
    throw Error(
      `${app.id} has no launch command. Start its backend yourself, or register one with ` +
        '`companion-app set-launch`.',
    );
  }

  const endpoint = parseUpstream(app.upstream);
  if (await portAcceptsConnections(endpoint)) {
    throw Error(
      `Something is already listening on ${app.upstream}. Companion does not attach to or ` +
        'stop processes it did not start; stop that process first, or just open the app.',
    );
  }
  if (options.signal?.aborted) {
    return { code: null, signal: null, stoppedByRequest: true, becameReady: false };
  }

  const [executable, ...argumentsList] = app.launch.argv;
  log(`Starting ${app.id}: ${JSON.stringify(app.launch.argv)} in ${app.launch.cwd}`);

  // `detached` gives the backend its own process group, so stopping it also
  // reaches helper processes it spawned, and a terminal Ctrl+C reaches only the
  // supervisor, which then stops the backend in an orderly way.
  const child = spawn(executable, argumentsList, {
    cwd: app.launch.cwd,
    env: backendEnvironment(),
    shell: false,
    detached: true,
    stdio: ['ignore', options.output ?? 'inherit', options.output ?? 'inherit'],
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  // Observe spawn failures even if nobody awaits `exited` yet.
  exited.catch(() => {});

  let stoppedByRequest = false;
  let becameReady = false;

  const stop = () => {
    stoppedByRequest = true;
    void stopProcessGroup(child, exited, options.stopGraceMilliseconds ?? 5000);
  };
  if (options.signal) {
    options.signal.addEventListener('abort', stop, { once: true });
  }

  try {
    becameReady = await waitUntilReady(
      endpoint,
      exited,
      options.readyTimeoutMilliseconds ?? 30_000,
      options.signal,
    );

    if (becameReady) {
      log(`${app.id} is ready at ${app.upstream}`);
      options.onReady?.();
    } else if (!stoppedByRequest && child.exitCode === null && child.signalCode === null) {
      log(`${app.id} did not accept connections in time; stopping it`);
      stop();
    }

    const { code, signal } = await exited;

    // The backend's own helpers belong to the group we created for it; do not
    // leave them running after the backend itself has gone. While any member
    // remains, the kernel keeps the group ID from being reused.
    if (!stoppedByRequest && child.pid) {
      signalGroup(child.pid, 'SIGTERM');
    }

    return { code, signal, stoppedByRequest, becameReady };
  } finally {
    options.signal?.removeEventListener('abort', stop);
  }
}

/** Poll the port until it accepts, the process exits, time runs out or we are aborted. */
async function waitUntilReady(
  endpoint: LoopbackEndpoint,
  exited: Promise<unknown>,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let processEnded = false;
  exited.then(
    () => {
      processEnded = true;
    },
    () => {
      processEnded = true;
    },
  );

  const deadline = Date.now() + timeoutMilliseconds;
  while (!processEnded && !signal?.aborted && Date.now() < deadline) {
    if (await portAcceptsConnections(endpoint, 250)) {
      // The process may have exited while we connected to someone else's
      // listener; only count readiness while our backend is still alive.
      return !processEnded;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

/** SIGTERM the group, then SIGKILL it if it has not exited after the grace period. */
async function stopProcessGroup(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMilliseconds: number,
): Promise<void> {
  if (!child.pid) {
    return;
  }

  signalGroup(child.pid, 'SIGTERM');

  const timer = setTimeout(() => signalGroup(child.pid!, 'SIGKILL'), graceMilliseconds);
  try {
    await exited;
  } catch {
    // A spawn error already means there is nothing left to stop.
  } finally {
    clearTimeout(timer);
  }

  // Helpers that ignored SIGTERM may outlive the group leader; the group is
  // still ours because it was created for this backend.
  signalGroup(child.pid, 'SIGKILL');
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group has already gone.
  }
}
