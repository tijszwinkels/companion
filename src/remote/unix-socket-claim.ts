/**
 * Claim a Unix socket path for exactly one phone gateway.
 *
 * Tailscale Serve can forward the tailnet HTTPS name to `unix:<path>`. Whoever
 * listens on that path answers the phone, so the path must be impossible for
 * other users to reach and must never be silently taken over (security review
 * item H2):
 *
 * 1. The socket's directory must already be private: owned by this user, not
 *    group/world accessible and not a symlink. It is created 0700 when it does
 *    not exist yet (systemd's `RuntimeDirectory=` normally creates it).
 * 2. A lifetime lock `<socket>.lock` is held for as long as the gateway runs.
 *    A second gateway fails immediately instead of replacing the first.
 * 3. An existing path is removed only when it is a socket that nobody
 *    answers on (a stale socket left by a crash). A live socket, a symlink, a
 *    regular file or anything else is refused and left in place.
 *
 * Input: an absolute socket path. Output: a claim whose `release()` gives up
 * the lock after the server has closed. The lock file itself stays: removing
 * it would let two gateways lock different inodes at the same path.
 *
 * The caller binds the socket after `claimUnixSocket()` resolves, with a
 * restrictive umask, and should `chmod 600` it afterwards; the private
 * directory already keeps other users out during that short window.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

import { assertPrivateDirectory } from './private-directory.ts';

/** How long we wait for an existing socket to accept a probe connection. */
const probeTimeoutMilliseconds = 1000;

export interface UnixSocketClaim {
  /** The socket path, now free for `listen()`. */
  readonly path: string;
  /** Release the lifetime lock. Call after the server has stopped listening. */
  release(): Promise<void>;
}

export async function claimUnixSocket(socketPath: string): Promise<UnixSocketClaim> {
  if (!isAbsolute(socketPath)) {
    throw Error(`Unix socket path must be absolute: ${socketPath}`);
  }

  // Step 1: private directory. Only the final component is created; a missing
  // parent is a configuration mistake worth reporting, not papering over.
  const directory = dirname(socketPath);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await assertPrivateDirectory(directory);

  // Step 2: lifetime lock. Hold it before looking at the socket path, so two
  // gateways starting together cannot both decide the path is stale.
  const lock = await acquireLifetimeLock(`${socketPath}.lock`);

  // Step 3: make sure nothing is (or pretends to be) at the socket path.
  try {
    await removeStaleSocket(socketPath);
  } catch (error) {
    await lock.close();
    throw error;
  }

  return {
    path: socketPath,
    async release() {
      await lock.close();
    },
  };
}

/**
 * Open the lock file without following symlinks and take a non-blocking
 * exclusive flock on it. The returned handle owns the lock until it is closed
 * or the process exits; the kernel releases it on crash too. `holder` names
 * what a held lock means, for the refusal message.
 *
 * This uses the same flock(1) technique as state-lock.ts, but deliberately
 * does not wait: state-lock serializes short transactions (and waits up to
 * 5 s), whereas this lock is held for the gateway's whole lifetime, so a
 * held lock means "another gateway is running" and must fail at once.
 */
export async function acquireLifetimeLock(
  lockPath: string,
  holder = 'Another phone gateway',
): Promise<FileHandle> {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
  let file: FileHandle;
  try {
    file = await open(lockPath, flags, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw Error(`${lockPath} is a symbolic link; refusing to use it as a lock`);
    }
    throw error;
  }

  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw Error(`${lockPath} is not a regular file`);
    }
    if (process.getuid && info.uid !== process.getuid()) {
      throw Error(`${lockPath} is not owned by the current user`);
    }

    // flock(1) locks the open file description it inherits as descriptor 3.
    // It exits immediately (--nonblock); our descriptor keeps the lock.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      });
      child.once('error', reject);
      child.once('close', resolve);
    });

    if (exitCode !== 0) {
      throw Error(
        `${holder} holds ${lockPath}; stop it first ` + '(or check that flock(1) is installed)',
      );
    }
  } catch (error) {
    await file.close();
    throw error;
  }

  return file;
}

/** Remove a stale socket left by a crashed gateway; refuse anything else. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!existing.isSocket()) {
    // Symlinks, regular files and directories may be someone's data or a
    // trap; never unlink them automatically.
    throw Error(`${socketPath} exists and is not a socket; refusing to remove it`);
  }

  const probe = await probeSocket(socketPath);
  if (probe === 'answering') {
    throw Error(`Something is already listening on ${socketPath}; refusing to replace it`);
  }
  if (probe === 'unknown') {
    throw Error(`Could not tell whether ${socketPath} is in use; refusing to replace it`);
  }
  if (probe === 'gone') {
    return;
  }

  // Unlink only the very socket we probed. Inside a private directory only
  // this user can swap it, but checking the inode costs nothing.
  const again = await lstat(socketPath);
  if (!again.isSocket() || again.ino !== existing.ino || again.dev !== existing.dev) {
    throw Error(`${socketPath} changed while starting; refusing to remove it`);
  }
  await unlink(socketPath);
}

type ProbeResult = 'answering' | 'stale' | 'gone' | 'unknown';

/**
 * Try to connect. ECONNREFUSED on an existing socket means nobody listens:
 * the socket is stale. Any other outcome (including a timeout from a full
 * backlog) is treated as "possibly in use" so we never steal a live path.
 */
function probeSocket(socketPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const client = connect({ path: socketPath });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };

    timer = setTimeout(() => finish('unknown'), probeTimeoutMilliseconds);

    client.once('connect', () => finish('answering'));
    client.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish('stale');
      } else if (error.code === 'ENOENT') {
        finish('gone');
      } else {
        finish('unknown');
      }
    });
  });
}
