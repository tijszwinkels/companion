import { spawn } from 'node:child_process';
import { chmod, mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Linux process-lifetime ownership using util-linux flock. The helper locks an
 * inherited descriptor; our copy keeps that same open file description alive
 * after the helper exits. The kernel releases it even after an unclean exit.
 * Never unlink the lock file: replacing its inode would allow a second owner.
 */
export class InstanceLock {
  private file?: FileHandle;

  constructor(private readonly path: string) {}

  async acquire(): Promise<void> {
    if (this.file) {
      throw Error('Instance lock is already held by this object');
    }

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const file = await open(this.path, 'a', 0o600);

    try {
      await file.chmod(0o600);
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', file.fd],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);

          if (code === 0) {
            resolve();
          } else if (code === 1) {
            reject(Error('Companion is already running'));
          } else {
            reject(Error('Could not acquire Companion instance lock (requires util-linux flock)'));
          }
        });
      });
      this.file = file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = undefined;
  }
}
