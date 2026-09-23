import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { chatMessage, type AgentBackend } from '../../src/agents/types.ts';
import { ExternalSessionServer, receiptLifetimeMs } from '../../src/agents/external/server.ts';
import { requestExternal } from '../../src/agents/external/client.ts';
import { openSocketDirectory } from '../../src/agents/external/paths.ts';
import { parseOrigin, promptText } from '../../src/agents/agent-origin.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { deferred, signal } from '../helpers.ts';

const executable = fileURLToPath(new URL('../../bin/companion-session', import.meta.url));

async function fixture(
  t: TestContext,
  options: { run?: AgentBackend['run']; deadline?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'external-test-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  const prompts: string[] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'synthetic-external',
        label: 'Synthetic external',
        dependencies: {},
        async models() {
          return ['test/model'];
        },
        async run(request, signal, emit) {
          prompts.push(request.prompt.text);
          if (options.run) {
            await options.run(request, signal, emit);
          }
          emit(chatMessage(randomUUID(), 'assistant', 'Synthetic answer'));
        },
      },
    },
    () => {},
    directory,
  );
  await sessions.loadPrevious();
  const path = join(directory, 'api', 'session.sock');
  const server = new ExternalSessionServer(sessions.sessionTools, path, options.deadline);
  await server.start();
  t.after(async () => {
    await server.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  const identity = (time = Date.now()) => `${server.epoch}_${time}_${randomUUID()}`;
  const call = (method: string, args: Record<string, unknown> = {}) =>
    requestExternal(path, { method, label: 'Rowan', requestId: identity(), ...args }, signal());
  const cli = (args: string[]) => runCli(path, args);
  return { directory, path, sessions, server, prompts, identity, call, cli };
}

/** Invoke the shipped executable from an unrelated cwd, like a local MM agent. */
async function runCli(path: string, args: string[], timeout = 10_000) {
  const child = spawn(executable, [...args, '--socket', path], {
    cwd: '/tmp',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return { code, stdout, stderr, result: JSON.parse(stdout) as any };
}

async function raw(path: string, input: string | Buffer): Promise<any> {
  const socket = connect(path);
  let data = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => (data += chunk));
  await once(socket, 'connect');
  socket.write(input);
  await once(socket, 'close');
  return data ? JSON.parse(data) : undefined;
}

test('CLI -> Unix socket -> actual sessions/store: list/start/send/close/reopen, attribution and quiet defaults', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli(['list'])).result.self, null);
  const started = await f.cli([
    'start',
    '--label',
    'MM Rowan',
    '--text',
    'Synthetic first',
    '--profile',
    'quickQuestion',
    '--model',
    'test/model',
  ]);
  assert.equal(started.code, 0, started.stdout);
  const id = started.result.session.id;
  assert.ok(JSON.parse(started.stderr).requestId);
  await f.sessions.idle();
  const view = f.sessions.snapshot()[0];
  assert.equal(view.openInBackground, true);
  assert.equal(view.profile, 'quickQuestion');
  assert.equal(view.messages[0].origin?.kind, 'external');
  assert.equal('sessionId' in view.messages[0].origin!, false);
  assert.match(f.prompts[0], /external agent message.*unverified label "MM Rowan"/);
  assert.match(f.prompts[0], /no session id or automatic reply route/);
  assert.equal(
    (await f.cli(['send', '--label', 'MM Rowan', '--id', id, '--text', 'Synthetic next'])).code,
    0,
  );
  await f.sessions.idle();
  const directory = (await f.cli(['list'])).result;
  assert.equal(directory.open[0].self, false);
  assert.equal(directory.open[0].busy, false);
  assert.equal('messages' in directory.open[0], false);
  assert.equal(
    (await f.cli(['close', '--label', 'MM Rowan', '--id', id])).result.outcome,
    'closed',
  );
  assert.equal((await f.cli(['list'])).result.previous[0].id, id);
  assert.equal(
    (await f.cli(['reopen', '--label', 'MM Rowan', '--id', id])).result.outcome,
    'reopened',
  );
  assert.equal(f.sessions.snapshot()[0].openInBackground, true);
  assert.equal(f.prompts.length, 2, 'reopen must not start a turn');
  assert.equal(f.sessions.snapshot()[0].messages[0].origin?.kind, 'external');
  const saved = JSON.parse(
    await readFile(join(f.directory, '.companion-sessions', id + '.json'), 'utf8'),
  );
  assert.equal(saved.messages[0].origin.kind, 'external');
});

test('busy close refuses and real CLI sends join the human FIFO without focus', async (t) => {
  const gate = deferred<void>();
  const f = await fixture(t, { run: async () => gate.promise });
  t.after(() => gate.resolve());
  const first = await f.call('start', { text: 'Held turn' });
  const id = (first.session as any).id;
  f.sessions.followUp(id, 'Human first', signal());
  const sent = await f.cli(['send', '--label', 'MM Rowan', '--id', id, '--text', 'Agent second']);
  assert.equal(sent.result.outcome, 'queued');
  assert.equal(sent.result.queuePosition, 2);
  assert.equal((await f.cli(['close', '--label', 'MM Rowan', '--id', id])).result.code, 'busy');
  for (let i = 0; i < 6; i++) {
    await f.call('send', { id, text: `queued ${i}` });
  }
  assert.equal((await f.call('send', { id, text: 'overflow' })).code, 'rejected');
  gate.resolve();
  await f.sessions.idle();
  assert.equal(f.prompts[1], 'Human first');
  assert.match(f.prompts[2], /\n\nAgent second$/);
});

test('request receipts deduplicate concurrent/retried CLI calls, reject conflicts, expiry and restarts', async (t) => {
  const f = await fixture(t);
  const requestId = f.identity();
  const args = ['start', '--label', 'Rowan', '--text', 'Only once', '--request-id', requestId];
  const [a, b] = await Promise.all([f.cli(args), f.cli(args)]);
  assert.equal(a.code, 0);
  assert.deepEqual(a.result, b.result);
  assert.equal(f.sessions.snapshot().length, 1);
  assert.equal((await f.call('start', { requestId, text: 'Changed' })).code, 'request-conflict');
  assert.equal((await f.call('start', { text: 'Only once' })).code, 'duplicate');
  assert.equal(
    (await f.call('start', { text: 'Old', requestId: f.identity(Date.now() - receiptLifetimeMs) }))
      .code,
    'expired-request',
  );
  await f.server.close();
  const next = new ExternalSessionServer(f.sessions.sessionTools, f.path);
  await next.start();
  t.after(() => next.close());
  assert.equal((await f.cli(args)).result.code, 'expired-request');
});

test('real desktop draft routing keeps external source distinct and confirms conflict/insertion without running a turn', async (t) => {
  const f = await fixture(t);
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), f.sessions);
  t.after(() => desktop.close());
  const id = ((await f.call('start', { text: 'Draft target' })).session as any).id;
  await f.sessions.idle();
  assert.equal(
    (await f.cli(['draft', '--label', 'Rowan', '--id', id, '--text', 'Offline'])).result.code,
    'offline',
  );
  desktop.send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  await desktop.reply('panel-state');
  for (const outcome of ['conflict', 'inserted', 'appended']) {
    const pending = f.cli([
      'draft',
      '--label',
      'Rowan',
      '--id',
      id,
      '--text',
      outcome,
      ...(outcome === 'appended' ? ['--append'] : []),
    ]);
    await waitFor(() => desktop.messages.some((message) => message.type === 'agent-draft'));
    const index = desktop.messages.findIndex((message) => message.type === 'agent-draft');
    const draft = desktop.messages.splice(index, 1)[0] as any;
    assert.deepEqual(draft.source, { kind: 'external', title: 'Rowan' });
    assert.equal(draft.focus, false);
    assert.equal(draft.ifDraftExists, outcome === 'appended' ? 'append' : 'reject');
    desktop.send({ action: 'agent-draft-result', requestId: draft.requestId, outcome });
    await desktop.reply('agent-draft-result');
    const result = await pending;
    assert.equal(result.code, outcome === 'conflict' ? 4 : 0);
  }
  assert.equal(f.prompts.length, 1);
});

test('malformed, oversized and forged identity requests do not mutate sessions', async (t) => {
  const f = await fixture(t);
  for (const input of ['{broken\n', '[]\n', '{}\n{}\n', 'x'.repeat(32769)]) {
    assert.equal((await raw(f.path, input)).code, 'invalid');
  }
  for (const args of [
    { self: randomUUID() },
    { origin: { kind: 'agent' } },
    { depth: 0 },
    { token: 'fake' },
    { label: 'bad\nlabel' },
    { text: 'a'.repeat(4001) },
  ]) {
    const reply = await f.call('start', { text: 'Must refuse', ...args });
    assert.equal(reply.code, 'invalid');
  }
  assert.equal(f.sessions.snapshot().length, 0);
});

test('CLI reports usage and unavailable sockets with structured exits and discovers via environment', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli(['start', '--text', 'No label'])).code, 2);
  assert.equal((await runCli(join(f.directory, 'api', 'missing.sock'), ['list'])).code, 3);
  const child = spawn(executable, ['info'], {
    cwd: '/',
    env: { ...process.env, COMPANION_EXTERNAL_SOCKET: f.path },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  assert.equal((await once(child, 'close'))[0], 0);
  assert.equal(JSON.parse(output).epoch, f.server.epoch);
});

test('private directory and socket modes; symlinks, unsafe ancestors, unsafe locks and wrong owner refuse', async (t) => {
  const f = await fixture(t);
  assert.equal((await lstat(dirname(f.path))).mode & 0o777, 0o700);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.path + '.lock')).mode & 0o777, 0o600);
  const link = join(f.directory, 'link');
  await symlink(dirname(f.path), link);
  await assert.rejects(openSocketDirectory(join(link, 'session.sock'), false));
  const bad = join(f.directory, 'unsafe');
  await mkdir(bad, { mode: 0o777 });
  await chmod(bad, 0o777);
  await assert.rejects(openSocketDirectory(join(bad, 'a.sock'), true));
  await assert.rejects(openSocketDirectory(join(bad, 'nested', 'a.sock'), true));
  await assert.rejects(openSocketDirectory('/root/session.sock', false));
  const target = join(f.directory, 'victim');
  await writeFile(target, 'preserve', { mode: 0o600 });
  const attack = join(dirname(f.path), 'attack.sock');
  await symlink(target, attack);
  await assert.rejects(new ExternalSessionServer(f.sessions.sessionTools, attack).start());
  await rm(attack);
  await rm(attack + '.lock');
  await symlink(target, attack + '.lock');
  await assert.rejects(new ExternalSessionServer(f.sessions.sessionTools, attack).start());
  assert.equal(await readFile(target, 'utf8'), 'preserve');
  await assert.rejects(openSocketDirectory('relative.sock', true));
  await assert.rejects(openSocketDirectory(f.directory + '/api/../bad.sock', true));
});

test('competing listeners cannot steal sockets; cleanup preserves replacement inode', async (t) => {
  const f = await fixture(t);
  const before = await lstat(f.path);
  const competing = new ExternalSessionServer(f.sessions.sessionTools, f.path);
  await assert.rejects(competing.start(), /already running/);
  assert.equal((await lstat(f.path)).ino, before.ino);
  assert.equal((await f.cli(['list'])).code, 0);
  await rename(f.path, f.path + '.old');
  await writeFile(f.path, 'replacement', { mode: 0o600 });
  await f.server.close();
  assert.equal(await readFile(f.path, 'utf8'), 'replacement');
});

test('stale sockets are recovered, but an active server without our lock is never unlinked', async (t) => {
  const f = await fixture(t);
  const path = join(dirname(f.path), 'stale.sock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await once(child.stdout, 'data');
  await chmod(path, 0o600);
  const external = new ExternalSessionServer(f.sessions.sessionTools, path);
  await assert.rejects(external.start(), /already running/);
  child.kill('SIGKILL');
  await once(child, 'close');
  const recovered = new ExternalSessionServer(f.sessions.sessionTools, path);
  await recovered.start();
  assert.equal((await requestExternal(path, { method: 'info' }, signal())).ok, true);
  await recovered.close();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('client timeout and cancellation preserve an ambiguous draft receipt; no implicit retry', async (t) => {
  const f = await fixture(t, { deadline: 150 });
  const id = ((await f.call('start', { text: 'Cancellation target' })).session as any).id;
  await f.sessions.idle();
  let forwarded = 0;
  f.sessions.setDraftHost(async (_request, abort) => {
    forwarded++;
    await new Promise<void>((resolve) => {
      if (abort.aborted) {
        resolve();
      } else {
        abort.addEventListener('abort', () => resolve(), { once: true });
      }
    });
    return { outcome: 'unconfirmed', reason: '' };
  });
  const requestId = f.identity();
  const args = [
    'draft',
    '--label',
    'Rowan',
    '--id',
    id,
    '--text',
    'Uncertain draft',
    '--request-id',
    requestId,
  ];
  const response = await f.cli([...args, '--timeout-ms', '40']);
  assert.equal(response.code, 5);
  assert.equal((await f.cli(args)).result.code, 'unconfirmed');
  assert.equal(forwarded, 1);
  assert.equal((await f.call('draft', { id, text: 'Uncertain draft' })).code, 'duplicate');
});

test('archived external provenance validates independently and cannot gain an internal return address', () => {
  const origin = { kind: 'external', title: 'MM Rowan', requestId: 'abcdefgh_12345678', depth: 1 };
  assert.deepEqual(parseOrigin(origin), origin);
  assert.equal(parseOrigin({ ...origin, sessionId: randomUUID() }), undefined);
  assert.equal(parseOrigin({ ...origin, depth: 0 }), undefined);
  assert.match(promptText('Request', parseOrigin(origin)), /unverified/);
});

test('cancelled model discovery cannot create a session; accepted work outlives CLI disconnect', async (t) => {
  const f = await fixture(t, { deadline: 80 });
  const discovery = deferred<void>();
  f.sessions.dependencies.backend.models = async () => {
    await discovery.promise;
    return ['test/model'];
  };
  const pending = f.call('start', { text: 'Never created', model: 'test/model' });
  assert.equal((await pending).code, 'unconfirmed');
  discovery.resolve();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.sessions.snapshot().length, 0);

  const socket = connect(f.path);
  await once(socket, 'connect');
  const requestId = f.identity();
  const command = {
    method: 'start',
    label: 'Rowan',
    requestId,
    text: 'Accepted before disconnect',
  };
  socket.write(JSON.stringify(command) + '\n');
  await waitFor(() => f.sessions.snapshot().length === 1);
  socket.destroy();
  await f.sessions.idle();
  assert.equal(f.sessions.snapshot()[0].status, 'completed');
  assert.equal((await requestExternal(f.path, command, signal())).outcome, 'started');
  assert.equal(f.prompts.length, 1);
});

test('global external action budget cannot be bypassed by changing labels', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  for (let i = 0; i < 60; i++) {
    assert.equal((await f.call('close', { id, label: `caller ${i}` })).code, 'unknown-session');
  }
  assert.equal((await f.call('start', { text: 'Over budget', label: 'new label' })).code, 'limit');
  assert.equal((await f.call('list')).ok, true);
});

test('simultaneous startup has exactly one winner and never changes process umask', async (t) => {
  const f = await fixture(t);
  const path = join(dirname(f.path), 'race.sock');
  const originalUmask = process.umask();
  const a = new ExternalSessionServer(f.sessions.sessionTools, path);
  const b = new ExternalSessionServer(f.sessions.sessionTools, path);
  const results = await Promise.allSettled([a.start(), b.start()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(process.umask(), originalUmask);
  assert.equal((await requestExternal(path, { method: 'info' }, signal())).ok, true);
  await a.close();
  await b.close();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('unsafe socket permissions and regular files are refused by the CLI without repair', async (t) => {
  const f = await fixture(t);
  await chmod(f.path, 0o666);
  assert.equal((await f.cli(['list'])).code, 3);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o666);
  await chmod(f.path, 0o600);
  const file = join(dirname(f.path), 'file.sock');
  await writeFile(file, 'not a socket', { mode: 0o600 });
  assert.equal((await runCli(file, ['list'])).code, 3);
});
