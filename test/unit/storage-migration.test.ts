import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { desktopPaths } from '../../src/desktop/runtime.ts';
import { migrateDesktopStorage } from '../../src/desktop/storage-migration.ts';
import { InstanceLock } from '../../src/system/instance-lock.ts';

test('the default database is under ~/companion while the socket remains in the runtime directory', () => {
  const originalRuntime = process.env.XDG_RUNTIME_DIR;
  const originalState = process.env.XDG_STATE_HOME;
  process.env.XDG_RUNTIME_DIR = '/runtime/companion-test';
  process.env.XDG_STATE_HOME = '/old-state';

  try {
    assert.deepEqual(desktopPaths(), {
      database: join(homedir(), 'companion', 'utterances.sqlite'),
      socket: '/runtime/companion-test/companion/control.sock',
    });
  } finally {
    if (originalRuntime === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalRuntime;
    }
    if (originalState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalState;
    }
  }
});

test('migration copies committed WAL data and preferences, preserves the source, and never overwrites the destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-storage-migration-'));
  const oldDirectory = join(directory, 'old');
  const newDirectory = join(directory, 'new');
  await mkdir(oldDirectory);
  await mkdir(newDirectory);
  const source = join(oldDirectory, 'utterances.sqlite');
  const destination = join(newDirectory, 'utterances.sqlite');
  const writer = new DatabaseSync(source);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE utterances (id TEXT PRIMARY KEY, transcript TEXT NOT NULL);
    CREATE TABLE paste_events (id TEXT PRIMARY KEY, utterance_id TEXT REFERENCES utterances(id));
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO utterances VALUES ('preserve-me', 'Committed in the WAL');
    INSERT INTO paste_events VALUES ('paste', 'preserve-me');
    PRAGMA user_version = 2;
  `);

  try {
    await writeFile(
      join(oldDirectory, 'disabled-intents.json'),
      '["START_CODING_AGENT_SESSION"]\n',
    );
    assert.ok((await stat(`${source}-wal`)).size > 0);
    assert.equal(await migrateDesktopStorage(source, destination), true);
    const database = new DatabaseSync(destination);

    try {
      assert.equal(
        database.prepare('SELECT transcript FROM utterances').get()?.transcript,
        'Committed in the WAL',
      );
      assert.equal(
        database.prepare('SELECT utterance_id FROM paste_events').get()?.utterance_id,
        'preserve-me',
      );
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
      database.exec("INSERT INTO utterances VALUES ('new', 'New destination data')");
      assert.equal(await migrateDesktopStorage(source, destination), false);
      assert.equal(database.prepare('SELECT count(*) AS count FROM utterances').get()?.count, 2);
    } finally {
      database.close();
    }

    assert.equal(writer.prepare('SELECT count(*) AS count FROM utterances').get()?.count, 1);
    assert.equal(
      await readFile(join(newDirectory, 'disabled-intents.json'), 'utf8'),
      '["START_CODING_AGENT_SESSION"]\n',
    );
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(join(newDirectory, 'disabled-intents.json'))).mode & 0o777, 0o600);
    assert.ok((await readdir(newDirectory)).every((name) => !name.endsWith('.tmp')));
  } finally {
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration refuses an active legacy owner and supports a clean retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-storage-lock-'));
  const source = join(directory, 'old.sqlite');
  const destination = join(directory, 'new.sqlite');
  const database = new DatabaseSync(source);
  database.exec('CREATE TABLE example (id INTEGER)');
  database.close();
  const lock = new InstanceLock(`${source}.lock`);

  try {
    await lock.acquire();
    await assert.rejects(migrateDesktopStorage(source, destination), /already running/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    await lock.close();
    assert.equal(await migrateDesktopStorage(source, destination), true);
  } finally {
    await lock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
