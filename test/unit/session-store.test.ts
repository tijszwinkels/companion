import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentSession,
  type SessionEvent,
} from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import { stopped, waitFor } from '../desktop-fixture.ts';

async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.companion-sessions');
  return { directory, path, store: new SessionStore(path) };
}

function savedSession(): AgentSession {
  return {
    id: randomUUID(),
    title: 'Original question',
    status: 'completed',
    model: 'fixture',
    error: '',
    updatedAt: 123456789,
    messages: [chatMessage('user', 'user', 'Unedited **question**')],
  };
}

function backend(run: AgentBackend['run'] = async () => {}): AgentBackend {
  return { id: 'fixture', label: 'Fixture', dependencies: {}, run };
}

test('archives from the removed HTML feature reopen as text without losing their model profile', async (context) => {
  const { path, store } = await fixture(context);
  const session = savedSession();
  session.profile = 'quickQuestion';
  await store.save(session);

  // Match an archive written by the former renderer, without reading or
  // rewriting any of the user's real conversations.
  const saved = JSON.parse(await readFile(join(path, `${session.id}.json`), 'utf8'));
  saved.messages.push({
    ...chatMessage('graphic', 'assistant', 'Input leads to Result.'),
    html: '<table><tr><td>Input</td><td>Result</td></tr></table>',
  });
  const serialized = JSON.stringify(saved);
  await writeFile(join(path, `${session.id}.json`), serialized);

  const restored = await store.read(session.id);
  assert.equal(restored.profile, 'quickQuestion');
  assert.equal(restored.messages[1].text, 'Input leads to Result.');
  assert.equal('html' in restored.messages[1], false);
  assert.equal((await store.previous(() => {})).length, 1);
  assert.equal(await readFile(join(path, `${session.id}.json`), 'utf8'), serialized);
});

test('history inspection creates no resources and ignores unrelated Pi sessions', async (context) => {
  const { directory, path, store } = await fixture(context);
  await writeFile(join(directory, 'pi-smoke-session.jsonl'), '{}\n');
  assert.deepEqual(await store.previous(() => {}), []);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('private atomic snapshots retain PNG bytes and derive attachment URLs on read', async (context) => {
  const { path, store } = await fixture(context);
  const session = savedSession();
  session.messages[0].screenshot = true;
  session.messages[0].screenshotUrl = 'https://untrusted.example/image';
  session.completedTurnId = 'live-completion';
  const url = (await store.screenshot(session.id, frame.screenshot.png, () => true))!;
  await store.save(session);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const extension of ['json', 'png']) {
    assert.equal((await stat(join(path, `${session.id}.${extension}`))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readFile(fileURLToPath(url)), frame.screenshot.png);
  assert.equal((await store.read(session.id)).messages[0].screenshotUrl, url);
  const serialized = await readFile(join(path, `${session.id}.json`), 'utf8');
  assert.doesNotMatch(serialized, /completedTurnId/);
  const forged = JSON.parse(serialized);
  forged.messages[0].screenshotUrl = 'file:///unrelated-private-file';
  await writeFile(join(path, `${session.id}.json`), JSON.stringify(forged));
  assert.equal((await store.read(session.id)).messages[0].screenshotUrl, url);
  await store.save(session);
  assert.doesNotMatch(await readFile(join(path, `${session.id}.json`), 'utf8'), /screenshotUrl/);
  assert.equal((await readdir(path)).length, 2, 'No temporary files left after replacement');
  await rm(fileURLToPath(url));
  const restored = await store.read(session.id);
  assert.equal(restored.messages[0].text, 'Unedited **question**');
  assert.equal(restored.messages[0].screenshotUrl, undefined);
  await assert.rejects(store.read('../elsewhere'), /Invalid saved session id/);
});

test('interrupted snapshots recover as stopped and damaged records do not hide valid history', async (context) => {
  const { path, store } = await fixture(context);
  const session = savedSession();
  session.status = 'running';
  session.messages.push({
    ...chatMessage('answer', 'assistant', 'Partial answer'),
    state: 'running',
  });
  session.messages.push({
    ...chatMessage('waiting', 'user', 'A queued follow-up'),
    state: 'queued',
  });
  await store.save(session);
  await writeFile(join(path, `${session.id}.json.interrupted.tmp`), '{interrupted replacement');
  await writeFile(join(path, `${randomUUID()}.json`), '{damaged');
  const invalid = { ...session, id: randomUUID(), messages: [null] };
  await writeFile(join(path, `${invalid.id}.json`), JSON.stringify(invalid));
  const logs: string[] = [];
  const previous = await store.previous((_tag, message) => logs.push(message));
  assert.equal(logs.length, 2);
  assert.equal(previous.length, 1);
  assert.equal(previous[0].status, 'cancelled');
  assert.equal('messages' in previous[0], false);
  const recovered = await store.read(session.id);
  assert.match(recovered.error, /stopped before/);
  assert.equal(recovered.messages[1].state, 'error');
  assert.equal(recovered.messages[2].state, 'error');
});

test('close and restart keep history dormant; reopen restores the same UUID and resumes only on follow-up', async (context) => {
  const { directory } = await fixture(context);
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const agent = backend(async (request, _signal, emit) => {
    requests.push(request);
    emit(chatMessage('answer', 'assistant', `Answer ${requests.length}`));
  });
  const sessions = new AgentSessions({ pi: agent }, () => {}, directory);
  const id = sessions.start(frame, signal());
  await sessions.idle();
  const before = sessions.snapshot()[0];
  await sessions.remove(id);
  assert.equal(sessions.snapshot().length, 0);
  assert.equal(sessions.previousSnapshot().length, 1);
  await sessions.close();

  const restarted = new AgentSessions({ pi: agent }, () => {}, directory);
  context.after(() => restarted.close());
  await restarted.loadPrevious();
  assert.equal(restarted.snapshot().length, 0);
  assert.equal(requests.length, 1);
  assert.equal(restarted.previousSnapshot()[0].id, id);
  const events: SessionEvent[] = [];
  restarted.subscribe((event) => events.push(event));
  await restarted.reopen(id);
  const {
    completedTurnId: _completion,
    toolEpoch: oldEpoch,
    history: _oldWindow,
    ...saved
  } = before;
  const { toolEpoch: newEpoch, history: _newWindow, ...reopened } = restarted.snapshot()[0];
  assert.notEqual(newEpoch, oldEpoch);
  assert.deepEqual(reopened, saved);
  assert.equal(requests.length, 1);
  assert.equal(events[0].type, 'agent-restored');
  assert.deepEqual(restarted.previousSnapshot(), []);
  restarted.followUp(id, 'Keep this wording exactly.  Please.', signal());
  await restarted.idle();
  assert.equal(requests[1].id, id);
  assert.equal(requests[1].resume, true);
  assert.equal(requests[1].prompt.text, 'Keep this wording exactly.  Please.');
  assert.equal(requests[1].prompt.screenshot, undefined);
  assert.equal(restarted.snapshot()[0].messages.length, 4);
});

test('closing a running turn blocks new input and archives the final cancelled transcript', async (context) => {
  const { directory, store } = await fixture(context);
  let running = false;
  const sessions = new AgentSessions(
    {
      pi: backend(async (_request, signal, emit) => {
        running = true;
        emit({ ...chatMessage('answer', 'assistant', 'Partial answer'), state: 'running' });
        await stopped(signal);
      }),
    },
    () => {},
    directory,
  );
  context.after(() => sessions.close());
  const id = sessions.start(frame, signal());
  await waitFor(() => running);
  const closing = sessions.remove(id);
  assert.throws(() => sessions.followUp(id, 'Racing follow-up', signal()), /unavailable/);
  await assert.rejects(sessions.remove(id), /already closing/);
  await closing;
  const saved = await store.read(id);
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.messages[1].text, 'Partial answer');
  assert.equal(saved.messages[1].state, 'error');
  await sessions.reopen(id);
  assert.equal(sessions.snapshot()[0].status, 'cancelled');
});

test('failed close retains its tab; failed reopen retains history and can be retried', async (context) => {
  const { directory, path } = await fixture(context);
  const sessions = new AgentSessions({ pi: backend() }, () => {}, directory);
  context.after(() => sessions.close());
  const id = sessions.start(frame, signal());
  await sessions.idle();
  // Replace the storage directory with an ordinary file: deterministic even
  // when tests run as root, unlike permissions-based failure simulation.
  await rename(path, path + '-saved');
  await writeFile(path, 'storage unavailable');
  await assert.rejects(sessions.remove(id));
  assert.equal(sessions.snapshot()[0].id, id);
  assert.equal(sessions.previousSnapshot().length, 0);
  await rm(path);
  await rename(path + '-saved', path);
  await sessions.remove(id);
  const snapshotPath = join(path, `${id}.json`);
  const json = await readFile(snapshotPath);
  await writeFile(snapshotPath, 'damaged');
  await assert.rejects(sessions.reopen(id));
  assert.equal(sessions.previousSnapshot()[0].id, id);
  assert.equal(sessions.snapshot().length, 0);
  await writeFile(snapshotPath, json);
  await sessions.reopen(id);
  assert.equal(sessions.snapshot()[0].id, id);
});

test('save errors remain visible and cancellation before startup never launches the model', async (context) => {
  const { directory, path } = await fixture(context);
  await mkdir(path);
  await rm(path, { recursive: true });
  await writeFile(path, 'not a directory');
  const sessions = new AgentSessions(
    { pi: backend(async () => assert.fail('No model call')) },
    () => {},
    directory,
  );
  context.after(() => sessions.close());
  sessions.start(frame, signal());
  await sessions.idle();
  assert.match(sessions.snapshot()[0].error, /Could not save session history/);
  await rm(path);
  const id = sessions.start(frame, signal());
  await sessions.remove(id);
  assert.equal(sessions.previousSnapshot()[0].status, 'cancelled');
});

test('concurrent restores reserve the tab limit and cannot restore one conversation twice', async (context) => {
  const { directory, store } = await fixture(context);
  const saved = Array.from({ length: 17 }, savedSession);
  for (const session of saved) {
    await store.save(session);
  }
  const sessions = new AgentSessions({ pi: backend() }, () => {}, directory);
  context.after(() => sessions.close());
  await sessions.loadPrevious();
  const first = sessions.reopen(saved[0].id);
  await assert.rejects(sessions.reopen(saved[0].id), /unavailable/);
  await first;
  const attempts = await Promise.allSettled(
    saved.slice(1).map((session) => sessions.reopen(session.id)),
  );
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(sessions.snapshot().length, 16);
  assert.equal(sessions.previousSnapshot().length, 1);
  assert.throws(() => sessions.start(frame, signal()), /16 tabs maximum/);
});
