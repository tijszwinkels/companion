import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PauseControl } from '../../src/core/pause-control.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { DesktopServer } from '../../src/desktop/server.ts';
import { deferred } from '../helpers.ts';
import { createConnection } from 'node:net';

test('unclean owner death releases locks and simultaneous stale-socket recovery admits one owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-ownership-'));
  const databasePath = join(directory, 'utterances.sqlite');
  const socketPath = join(directory, 'control.sock');
  const runtimeModule = new URL('../../src/desktop/runtime.ts', import.meta.url).href;
  const pauseModule = new URL('../../src/core/pause-control.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { DesktopRuntime } from ${JSON.stringify(runtimeModule)};
    import { PauseControl } from ${JSON.stringify(pauseModule)};
    const runtime = new DesktopRuntime(new PauseControl(), () => {}, new AbortController().signal, {
      database: ${JSON.stringify(databasePath)}, socket: ${JSON.stringify(socketPath)},
      preview: true, sounds: false
    });
    await runtime.start();
    runtime.activity.transcribed({ id: 1, observedAt: 1, utterance: 'Interrupted automatic send' });
    runtime.activity.deliveryStarted(1);
    process.send('ready');
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const exited = once(child, 'exit');
  let childError = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk) => {
    childError += chunk;
  });
  const controller = new AbortController();
  const makeRuntime = (socket = socketPath) =>
    new DesktopRuntime(new PauseControl(), () => {}, controller.signal, {
      database: databasePath,
      socket,
      preview: true,
      sounds: false,
    });
  const first = makeRuntime();
  const second = makeRuntime();
  const alternate = makeRuntime(join(directory, 'other.sock'));

  try {
    const started = await Promise.race([
      once(child, 'message').then(() => true),
      exited.then(() => false),
    ]);
    assert.ok(started, childError);

    // Even a different socket must not recover another live owner's database.
    await assert.rejects(alternate.start(), /already running/);
    await alternate.close();
    child.kill('SIGKILL');
    await exited;

    const attempts = await Promise.allSettled([first.start(), second.start()]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    assert.match(String(rejected?.reason), /already running/);
    const owner = attempts[0].status === 'fulfilled' ? first : second;
    owner.activity.transcribed?.({ id: 2, observedAt: 2, utterance: 'Still processing' });
    await assert.rejects(alternate.start(), /already running/);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const rows = database.prepare('SELECT outcome FROM utterances ORDER BY observed_at').all();
      assert.deepEqual(
        rows.map((row) => row.outcome),
        ['interrupted', 'processing'],
      );
    } finally {
      database.close();
    }
  } finally {
    child.kill('SIGKILL');
    await exited;
    controller.abort();
    await first.close();
    await second.close();
    await alternate.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('socket ownership stays locked until pending requests settle during shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-closing-'));
  const path = join(directory, 'control.sock');
  const started = deferred<void>();
  const finish = deferred<void>();
  const first = new DesktopServer(
    path,
    () => ({}),
    async () => {
      started.resolve();
      await finish.promise;
    },
  );
  const second = new DesktopServer(
    path,
    () => ({}),
    async () => {},
  );
  await first.start();
  const client = createConnection(path);

  try {
    client.write('{"action":"paste"}\n');
    await started.promise;
    const closing = first.close();
    await assert.rejects(second.start(), /already running/);
    finish.resolve();
    await closing;
    await second.start();
  } finally {
    finish.resolve();
    client.destroy();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('crash recovery distinguishes pending work from started automatic and manual delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-delivery-history-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);

  try {
    await history.open();
    history.add({ id: 1, observedAt: 1, utterance: 'Not delivered' });
    history.add({ id: 2, observedAt: 2, utterance: 'Delivery may have begun' });
    history.markDeliveryStarted(2);
    const id = history.snapshot()[0].id;
    history.beginPaste(id, '0xabc');
    const started = history.beginPaste(id, '0xdef');
    history.markPasteStarted(started, 'fixture');
    history.close();
    await history.open();
    assert.deepEqual(
      history.snapshot().map((row) => row.outcome),
      ['interrupted', 'cancelled'],
    );
    const database = new DatabaseSync(path, { readOnly: true });

    try {
      const rows = database
        .prepare('SELECT outcome, delivery_started_at FROM paste_events ORDER BY rowid')
        .all();
      assert.deepEqual(
        rows.map((row) => row.outcome),
        ['cancelled', 'interrupted'],
      );
      assert.equal(rows[0].delivery_started_at, null);
      assert.equal(typeof rows[1].delivery_started_at, 'number');
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('version 1 migration preserves legacy delivery uncertainty and completed outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-migration-'));
  const path = join(directory, 'utterances.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE utterances (
      id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, transcript TEXT NOT NULL,
      application TEXT, window_title TEXT, window_address TEXT, recognized_intent TEXT,
      outcome TEXT NOT NULL DEFAULT 'processing', completed_at INTEGER
    );
    CREATE TABLE paste_events (
      id TEXT PRIMARY KEY, utterance_id TEXT NOT NULL REFERENCES utterances(id),
      attempted_at INTEGER NOT NULL, target_address TEXT NOT NULL, target_application TEXT,
      outcome TEXT NOT NULL, completed_at INTEGER
    );
    INSERT INTO utterances (id, observed_at, transcript, recognized_intent, outcome) VALUES
      ('send', 1, 'Unfinished send', 'SEND_TEXT_TO_APPLICATION', 'processing'),
      ('pending', 2, 'Pending decision', NULL, 'processing'),
      ('done', 3, 'Completed send', 'SEND_TEXT_TO_APPLICATION', 'sent');
    INSERT INTO paste_events (id, utterance_id, attempted_at, target_address, outcome)
      VALUES ('paste', 'send', 1, '0xabc', 'pending');
    PRAGMA user_version = 1;
  `);
  old.close();
  const history = new UtteranceHistory(path);

  try {
    await history.open();
    assert.deepEqual(
      history.snapshot().map((row) => row.outcome),
      ['sent', 'cancelled', 'interrupted'],
    );
    history.close();
    await history.open();
    const database = new DatabaseSync(path, { readOnly: true });

    try {
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(
        database.prepare('SELECT outcome FROM paste_events').get()?.outcome,
        'interrupted',
      );
    } finally {
      database.close();
    }
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
