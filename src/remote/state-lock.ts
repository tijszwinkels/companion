/**
 * Serialize gateway/CLI credential transactions across processes on Linux.
 *
 * flock locks an inherited open file description. Keeping our descriptor open
 * owns the lock after the helper exits; close or process death releases it.
 * The lock file is permanent: unlinking it would let writers lock different
 * inodes. A bounded wait fails the operation without weakening serialization.
 */
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

export async function withStateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const file = await open(path, 'a', 0o600);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--timeout', '5', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(Error('Device state is busy or flock is unavailable; retry the command'));
        }
      });
    });

    return await operation();
  } finally {
    await file.close();
  }
}
