import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { InstanceLock } from '../system/instance-lock.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * First-start migration from XDG state into ~/companion. The caller holds the
 * destination database and socket locks; also exclude an older listener using
 * the source. SQLite's backup API includes committed WAL data. Keep the source
 * as a fallback, and never replace an existing destination database.
 */
export async function migrateDesktopStorage(source: string, destination: string): Promise<boolean> {
  if ((await exists(destination)) || !(await exists(source))) {
    return false;
  }

  const sourceLock = new InstanceLock(`${source}.lock`);
  await sourceLock.acquire();
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let database: DatabaseSync | undefined;

  try {
    // Own destination setup here, rather than relying on the caller's lock file
    // to have created the same directory as a side effect of acquiring its lock.
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

    // Precreate privately: the backup API otherwise uses SQLite's file mode.
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    database = new DatabaseSync(source, { readOnly: true });
    await backup(database, temporary);
    database.close();
    database = undefined;

    const sourcePreferences = join(dirname(source), 'disabled-intents.json');
    const destinationPreferences = join(dirname(destination), 'disabled-intents.json');

    try {
      await copyFile(sourcePreferences, destinationPreferences, constants.COPYFILE_EXCL);
      await chmod(destinationPreferences, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        throw error;
      }
    }

    // Publish after preferences are copied. A failed attempt can be retried
    // without opening an empty destination and hiding the user's old history.
    await rename(temporary, destination);
    return true;
  } finally {
    database?.close();
    await rm(temporary, { force: true });
    await sourceLock.close();
  }
}
