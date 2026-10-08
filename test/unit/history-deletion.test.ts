import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ActivityHistory } from '../../src/desktop/activity-history.ts';
import { artifactPath, removeArtifacts } from '../../src/desktop/artifacts.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { desktopFixture, waitFor, windowReply } from '../desktop-fixture.ts';
import { deferred, frame, screenshot } from '../helpers.ts';

/** Real storage only in a disposable directory; no live listener or recordings. */
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-delete-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);
  await history.open();
  const database = new DatabaseSync(path);
  return {
    directory,
    history,
    database,
    async seed(frameId = 1) {
      history.add({ ...frame, id: frameId }, 'on');
      const id = history.snapshot()[0].id;
      await history.saveScreenshot(frameId, screenshot, () => true);
      await history.saveAudio(frameId, new Float32Array([0.1, -0.1]), () => true);
      history.setIntent(frameId, 'IGNORE');
      history.setOutcome(frameId, 'ignored');
      history.finish(frameId);
      return id;
    },
    async close() {
      history.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('deleting an utterance removes its files, feedback and paste records, preserving its neighbour', async (context) => {
  const setup = await storage();
  context.after(setup.close);
  const { history, database, directory } = setup;
  const id = await setup.seed();
  const neighbour = await setup.seed(2);
  history.label(id, false, 'SEND_TEXT_TO_APPLICATION');
  const paste = history.beginPaste(id, '0xabc');
  history.finishPaste(paste, 'sent', 'editor');
  const image = artifactPath(directory, id, frame.observedAt, 'screenshots');
  const audio = artifactPath(directory, id, frame.observedAt, 'audio');
  await writeFile(`${image}.tmp`, 'incomplete');
  await writeFile(`${audio}.tmp`, 'incomplete');

  await history.delete(id);
  assert.equal(history.find(id), undefined);
  assert.equal(database.prepare('SELECT * FROM intent_feedback WHERE id = ?').get(id), undefined);
  assert.equal(
    database.prepare('SELECT * FROM paste_events WHERE utterance_id = ?').get(id),
    undefined,
  );
  for (const path of [image, audio, `${image}.tmp`, `${audio}.tmp`]) {
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  assert.equal(history.find(neighbour)?.utterance, frame.utterance);
  assert.deepEqual(
    await readFile(artifactPath(directory, neighbour, frame.observedAt, 'screenshots')),
    screenshot.png,
  );
  assert.equal(
    (await readFile(artifactPath(directory, neighbour, frame.observedAt, 'audio')))
      .subarray(0, 4)
      .toString(),
    'RIFF',
  );
  await assert.rejects(history.delete(id), /not found/);
});

test('processing and pending pastes prevent deletion; a claimed deletion blocks new uses', async (context) => {
  const setup = await storage();
  context.after(setup.close);
  const { history } = setup;
  history.add(frame, 'on');
  const id = history.snapshot()[0].id;
  await assert.rejects(history.delete(id), /finish processing or pasting/);
  history.setOutcome(frame.id, 'ignored');
  await assert.rejects(
    history.delete(id),
    /finish processing or pasting/,
    'Finish, not outcome alone, releases capture ownership',
  );
  history.setIntent(frame.id, 'IGNORE');
  history.finish(frame.id);
  const paste = history.beginPaste(id, '0xabc');
  await assert.rejects(history.delete(id), /finish processing or pasting/);
  history.finishPaste(paste, 'sent', 'editor');

  const deleting = history.delete(id);
  assert.throws(() => history.beginPaste(id, '0xabc'), /being deleted/);
  assert.throws(() => history.label(id, true), /being deleted/);
  await assert.rejects(history.recordedFrame(id), /being deleted/);
  await assert.rejects(history.delete(id), /being deleted/);
  await deleting;
  assert.equal(history.find(id), undefined, 'An utterance without recordings can be removed');
});

test('filesystem failure retains the row and permits retry after a partially removed artifact', async (context) => {
  const setup = await storage();
  context.after(setup.close);
  const id = await setup.seed();
  const audio = artifactPath(setup.directory, id, frame.observedAt, 'audio');
  await rm(audio);
  await mkdir(audio);
  await writeFile(join(audio, 'sentinel'), 'Do not recursively delete directories');
  await assert.rejects(setup.history.delete(id));
  assert.ok(setup.history.find(id));
  assert.equal(
    await readFile(join(audio, 'sentinel'), 'utf8'),
    'Do not recursively delete directories',
  );
  await rm(audio, { recursive: true });
  await setup.history.delete(id);
  assert.equal(setup.history.find(id), undefined);
});

test('SQLite failure rolls back dependent rows and permits retry with already removed recordings', async (context) => {
  const setup = await storage();
  context.after(setup.close);
  const { history, database } = setup;
  const id = await setup.seed();
  history.label(id, true);
  const paste = history.beginPaste(id, '0xabc');
  history.finishPaste(paste, 'sent', 'editor');
  database.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON utterances BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  await assert.rejects(history.delete(id), /fixture failure/);
  assert.ok(history.find(id));
  assert.equal(history.feedback(id).correct, true);
  assert.ok(database.prepare('SELECT id FROM paste_events WHERE id = ?').get(paste));
  database.exec('DROP TRIGGER fail_delete');
  await history.delete(id);
  assert.equal(history.find(id), undefined);
});

test('artifact deletion tolerates a different date bucket and missing files, and rejects non-UUID paths', async (context) => {
  const setup = await storage();
  context.after(setup.close);
  const id = await setup.seed();
  const oldBucket = join(setup.directory, 'data', '2025-01-01', 'screenshots', `${id}.png`);
  await mkdir(dirname(oldBucket), { recursive: true });
  await writeFile(oldBucket, screenshot.png);
  await setup.history.delete(id);
  await assert.rejects(readFile(oldBucket), { code: 'ENOENT' });
  await removeArtifacts(setup.directory, id);
  await assert.rejects(removeArtifacts(setup.directory, '../anything'), /Invalid utterance id/);
});

test('removed Activity entries keep paging positions and carry no transcript in reconnect markers', () => {
  const history = new ActivityHistory();
  for (let sequence = 1; sequence <= 53; sequence++) {
    history.update(
      {
        id: String(sequence),
        observedAt: sequence,
        utterance: 'Disposable text',
        application: null,
        intent: 'IGNORE',
        outcome: 'ignored',
        cleanupEnabled: null,
        cleanupStatus: null,
        cleanedText: null,
        cleanupFallback: null,
        transcriptSource: null,
        captureStorage: null,
        inputKind: null,
        screenshotSaved: null,
        audioSaved: null,
        labelingUnavailable: null,
        screenshotUnavailable: false,
      },
      { correct: null, actualIntent: null },
    );
  }
  const oldPage = history.page(0, 53);
  for (let sequence = 1; sequence <= 50; sequence++) {
    history.remove(String(sequence));
  }
  const page = history.page(0, 53);
  assert.equal(page.entries.length, 0);
  assert.equal(page.removed.length, 50);
  assert.equal(page.next, 50, 'An empty page still advances over removal markers');
  assert.equal(history.count, 53, 'Paging watermark is never reused');
  assert.equal(history.has('1'), false);
  assert.ok(page.removed[0].revision > oldPage.entries[0].revision);
  assert.deepEqual(Object.keys(page.removed[0]).sort(), ['deleted', 'id', 'revision', 'sequence']);
  assert.deepEqual(
    history.page(50, 53).entries.map((entry) => entry.id),
    ['51', '52', '53'],
  );
  assert.equal(history.remove('1'), undefined);
});

test('socket deletion publishes removal to both history views and rejects subsequent recovery actions', async (context) => {
  const setup = await desktopFixture(async () => windowReply());
  context.after(setup.close);
  const id = setup.seed();
  await setup.runtime.activity.screenshotCaptured?.(frame.id, screenshot);
  await setup.runtime.activity.audioCaptured?.(frame.id, new Float32Array([0.1]));
  setup.runtime.activity.intentRecognized?.(frame.id, 'IGNORE');
  setup.runtime.activity.outcome?.(frame.id, 'ignored');
  setup.runtime.activity.finished?.(frame.id);
  await waitFor(() => setup.messages.some((message) => message.type === 'activity-entry'));
  const sessionId = setup.messages.find((message) => message.activitySessionId)?.activitySessionId;
  setup.send({ action: 'delete-history', id });
  assert.equal((await setup.reply('delete-history')).result, 'deleted');
  const removal = setup.messages.find((message) => message.type === 'history-deleted');
  assert.equal(removal?.id, id);
  assert.equal(removal?.removed?.deleted, true);
  const latest = setup.messages.filter((message) => message.type === 'state').at(-1)!;
  assert.equal(latest.historyDeletionAvailable, true);
  assert.deepEqual(latest.history, []);
  assert.equal(setup.database.prepare('SELECT id FROM utterances WHERE id = ?').get(id), undefined);
  setup.send({ action: 'activity-history', sessionId, after: 0, through: 1 });
  const page = (await setup.reply('activity-history')).result;
  assert.ok(page && typeof page === 'object');
  assert.deepEqual(page.entries, []);
  assert.equal(page.removed[0].id, id);
  for (const request of [
    { action: 'paste', id, target: screenshot.window.address },
    { action: 'label-history', id, correct: true },
    { action: 'start-history-agent', id },
    { action: 'delete-history', id: 42 },
  ]) {
    setup.send(request);
    assert.equal((await setup.reply(request.action)).type, 'error');
  }
});

test('preview disables deletion and leaves stored entries intact', async (context) => {
  const setup = await desktopFixture(async () => assert.fail('No desktop commands'), undefined, {
    preview: true,
  });
  context.after(setup.close);
  const id = setup.seed();
  setup.runtime.activity.outcome?.(frame.id, 'preview');
  setup.runtime.activity.finished?.(frame.id);
  setup.send({ action: 'delete-history', id });
  assert.equal((await setup.reply('delete-history')).result, 'preview');
  assert.equal(
    setup.messages.filter((message) => message.type === 'state').at(-1)?.historyDeletionAvailable,
    false,
  );
  assert.ok(setup.database.prepare('SELECT id FROM utterances WHERE id = ?').get(id));
});

test('a delete received while a recovery paste is typing cannot remove its observation', async (context) => {
  const typing = deferred<void>();
  const started = deferred<void>();
  const setup = await desktopFixture(async (binary) => {
    if (binary === 'wtype') {
      started.resolve();
      await typing.promise;
    }
    return windowReply();
  });
  context.after(async () => {
    typing.resolve();
    await setup.close();
  });
  const id = setup.seed();
  setup.runtime.activity.outcome?.(frame.id, 'ignored');
  setup.runtime.activity.finished?.(frame.id);
  setup.send({ action: 'paste', id, target: screenshot.window.address });
  await started.promise;
  setup.send({ action: 'delete-history', id });
  assert.match((await setup.reply('delete-history')).message!, /finish processing or pasting/);
  assert.ok(setup.database.prepare('SELECT id FROM utterances WHERE id = ?').get(id));
  typing.resolve();
  assert.equal((await setup.reply('paste')).result, 'sent');
  setup.send({ action: 'delete-history', id });
  assert.equal((await setup.reply('delete-history')).result, 'deleted');
});
