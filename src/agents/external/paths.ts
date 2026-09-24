/** Linux-only filesystem boundary for the optional same-user session API. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

export function externalSocketPath(override = process.env.COMPANION_EXTERNAL_SOCKET): string {
  if (override) {
    return override;
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) {
    throw Error('Set XDG_RUNTIME_DIR or COMPANION_EXTERNAL_SOCKET');
  }
  return join(runtime, 'companion-external', 'session.sock');
}

function safePath(path: string): void {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) {
    throw Error('External access requires an unprivileged Linux user');
  }
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    Buffer.byteLength(path) > 100 ||
    /[\x00-\x1f\x7f]/.test(path)
  ) {
    throw Error('Socket path must be canonical, absolute and at most 100 bytes');
  }
}

/**
 * Walk using held directory descriptors. No symlink is followed, including in
 * ancestors. Only the final directory may be created, with 0700 at creation.
 * Root-owned sticky directories (/tmp) are safe ancestors: other users cannot
 * rename this user's entries. Other writable ancestors are refused.
 */
export async function openSocketDirectory(path: string, create: boolean): Promise<FileHandle> {
  safePath(path);
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  const components = dirname(path).split('/').filter(Boolean);
  try {
    for (let index = 0; index < components.length; index++) {
      const candidate = `/proc/self/fd/${directory.fd}/${components[index]}`;
      const final = index === components.length - 1;
      if (final && create) {
        await mkdir(candidate, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        });
      }
      const next = await open(
        candidate,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stat = await next.stat();
      const owned = stat.uid === process.getuid!();
      const writable = (stat.mode & 0o022) !== 0;
      const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (
        (final && (!owned || (stat.mode & 0o777) !== 0o700)) ||
        (!final && ((!owned && stat.uid !== 0) || (writable && !stickyRoot)))
      ) {
        await next.close();
        throw Error('Unsafe socket directory ownership or permissions');
      }
      await directory.close();
      directory = next;
    }
    if (components.length === 0) {
      throw Error('Socket requires a private directory');
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

export async function checkSocket(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) {
    throw Error('Unsafe socket type, ownership or permissions');
  }
}

/** Holds a kernel flock through an inherited open file description, not a PID. */
export class SocketOwnership {
  private directory?: FileHandle;
  private lock?: FileHandle;
  private stage = '';
  private published?: { dev: number; ino: number };
  target = '';
  bindPath = '';

  constructor(readonly path: string) {}

  async acquire(): Promise<void> {
    this.directory = await openSocketDirectory(this.path, true);
    const root = `/proc/self/fd/${this.directory.fd}`;
    this.target = `${root}/${basename(this.path)}`;
    try {
      const lock = await open(
        this.target + '.lock',
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      this.lock = lock;
      const stat = await lock.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw Error('Unsafe socket lock');
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', lock.fd],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(Error('External listener already running or flock unavailable'));
          }
        });
      });
      const existing = await lstat(this.target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        return undefined;
      });
      if (existing) {
        await checkSocket(this.target);
        // A server not using our lock may still be live. Only ECONNREFUSED is
        // evidence of staleness; timeout/permission failures never permit unlink.
        await new Promise<void>((resolve, reject) => {
          const socket = connect(this.target);
          socket.setTimeout(500, () => {
            socket.destroy();
            reject(Error('Existing socket did not answer'));
          });
          socket.once('connect', () => {
            socket.destroy();
            reject(Error('External listener already running'));
          });
          socket.once('error', (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === 'ECONNREFUSED') {
              resolve();
            } else {
              reject(error);
            }
          });
        });
        const current = await lstat(this.target);
        if (current.dev !== existing.dev || current.ino !== existing.ino) {
          throw Error('Socket changed during startup');
        }
        await unlink(this.target);
      }
      // Node binds under a private staging directory. The socket may initially
      // have permissive mode bits, but is unreachable to other users. Publish
      // only after chmod(0600). No process-wide umask changes are needed.
      this.stage = await mkdtemp(`${root}/.bind-`);
      this.bindPath = this.stage + '/socket';
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async publish(): Promise<void> {
    await chmod(this.bindPath, 0o600);
    await rename(this.bindPath, this.target);
    this.published = await lstat(this.target);
  }

  async release(): Promise<void> {
    try {
      if (this.published) {
        const current = await lstat(this.target).catch(() => undefined);
        if (current?.dev === this.published.dev && current?.ino === this.published.ino) {
          await unlink(this.target);
        }
      }
      // libuv only knows the original staging name, so its automatic unlink
      // cannot remove a replacement at the public name during server.close().
      if (this.stage) {
        await rmdir(this.stage).catch(() => {});
      }
    } finally {
      this.published = undefined;
      await this.lock?.close();
      this.lock = undefined;
      await this.directory?.close();
      this.directory = undefined;
    }
  }
}
