/**
 * Read-only probes behind `companion-phone status` and the start/stop checks.
 * Each answers one question separately, so a report can say *which* part of
 * phone access is missing:
 *
 * - Unix sockets (gateway, desktop listener): does something answer there?
 * - Tailscale Serve: is the route absent, exactly ours, something else, or
 *   unreadable right now? Uses the gateway's own matcher, so the tool and the
 *   gateway can never disagree about what counts as safe.
 * - Pairing state: is the durable directory private, and how many devices are
 *   paired? Only a count is reported; token hashes are never printed.
 *
 * Nothing here writes, binds, or changes Tailscale.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { connect } from 'node:net';

import { DeviceStore } from '../devices.ts';
import { assertPrivateDirectory } from '../private-directory.ts';
import {
  readServeConfig,
  serveConfigIsEmpty,
  serveConfigMismatch,
  type ExpectedServeRoute,
} from '../tailscale-serve-check.ts';

const socketProbeMilliseconds = 1000;

/**
 * `absent` (nothing at the path) and `not-answering` (a socket that refuses
 * connections, ECONNREFUSED) are definite. `unsafe` (not ours, a symlink, not
 * a socket) and `error` (including no answer in time) are indeterminate: the
 * path might still serve a client such as tailscaled.
 */
export type SocketProbe =
  | { state: 'answering' }
  | { state: 'absent' }
  | { state: 'not-answering' }
  | { state: 'unsafe'; reason: string }
  | { state: 'error'; reason: string };

/**
 * Connect to a Unix socket and hang up at once. A path that is missing, not a
 * socket, a symlink or someone else's is reported without connecting.
 */
export async function probeUnixSocket(path: string): Promise<SocketProbe> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return { state: 'unsafe', reason: 'is a symbolic link' };
    }
    if (!info.isSocket()) {
      return { state: 'unsafe', reason: 'is not a socket' };
    }
    if (process.getuid && info.uid !== process.getuid()) {
      return { state: 'unsafe', reason: 'is owned by another user' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent' };
    }
    return { state: 'error', reason: (error as Error).message };
  }

  return new Promise((resolve) => {
    const socket = connect(path);
    // No answer in time is not a refusal: something may be there but busy.
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ state: 'error', reason: 'no answer within 1 s (busy or stuck)' });
    }, socketProbeMilliseconds);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ state: 'answering' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        resolve({ state: 'absent' });
      } else if (error.code === 'ECONNREFUSED') {
        resolve({ state: 'not-answering' });
      } else {
        resolve({ state: 'error', reason: error.code ?? error.message });
      }
    });
  });
}

export type RouteProbe =
  | { state: 'ours' }
  | { state: 'none' }
  | { state: 'unexpected'; reason: string }
  | { state: 'unreadable'; reason: string };

/** Classify a parsed `tailscale serve status --json` document. */
export function classifyServeConfig(config: unknown, expected: ExpectedServeRoute): RouteProbe {
  if (serveConfigIsEmpty(config)) {
    return { state: 'none' };
  }
  const mismatch = serveConfigMismatch(config, expected);
  if (mismatch !== undefined) {
    return { state: 'unexpected', reason: mismatch };
  }
  return { state: 'ours' };
}

/** Read Serve status (no sudo, read-only) and classify it. */
export async function probeServeRoute(
  tailscale: string,
  expected: ExpectedServeRoute,
): Promise<RouteProbe> {
  let config: unknown;
  try {
    config = await readServeConfig(tailscale);
  } catch (error) {
    return { state: 'unreadable', reason: (error as Error).message };
  }
  return classifyServeConfig(config, expected);
}

export type StateProbe =
  { state: 'ok'; devices: number } | { state: 'missing' } | { state: 'problem'; reason: string };

/** Check the durable pairing directory without creating it. */
export async function probePairingState(directory: string): Promise<StateProbe> {
  try {
    await assertPrivateDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }
    return { state: 'problem', reason: (error as Error).message };
  }

  // devices.json must be a private regular file when present.
  try {
    const info = await lstat(`${directory}/devices.json`);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      return { state: 'problem', reason: 'devices.json is not a private (0600) regular file' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'problem', reason: (error as Error).message };
    }
  }

  try {
    const devices = await new DeviceStore(directory).devices();
    return { state: 'ok', devices: devices.length };
  } catch (error) {
    return { state: 'problem', reason: `devices.json cannot be read: ${(error as Error).message}` };
  }
}

/**
 * Whether a gateway currently serves this pairing state: gateways hold an
 * exclusive lifetime flock on `gateway.lock` there (see Gateway.start). This
 * only tries the lock and never creates the file, so it changes nothing.
 * Gateways from before that lock take no lock and cannot be detected here.
 */
export async function pairingStateInUse(directory: string, flock: string): Promise<boolean> {
  let file;
  try {
    file = await open(`${directory}/gateway.lock`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(flock, ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    return code !== 0;
  } finally {
    // Closing our descriptor drops the lock again if flock(1) took it.
    await file.close();
  }
}
