import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { ExternalSessionServer, receiptLifetimeMs } from '../../src/agents/external/server.ts';
import { requestExternal } from '../../src/agents/external/client.ts';
import { openSocketDirectory } from '../../src/agents/external/paths.ts';
import { parseOrigin, promptText } from '../../src/agents/agent-origin.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { deferred, signal } from '../helpers.ts';
import {
  executable,
  externalCliEnvironment,
  fixture,
  runCli,
} from '../external-session-fixture.ts';

async function raw(path: string, input: string | Buffer, halfClose = false): Promise<any> {
  const socket = connect(path);
  let data = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => (data += chunk));
  await once(socket, 'connect');
  if (halfClose) {
    socket.end(input);
  } else {
    socket.write(input);
  }
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
  const f = await fixture(t, { run: async () => gate.promise, beforeClose: () => gate.resolve() });
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
  const overflow = await f.call('send', { id, text: 'overflow' });
  assert.equal(overflow.code, 'rejected');
  assert.match(String(overflow.error), /8 queued messages/);
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
    env: externalCliEnvironment({ COMPANION_EXTERNAL_SOCKET: f.path }),
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
  const childClosed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGKILL');
    await childClosed;
  });
  await once(child.stdout, 'data');
  await chmod(path, 0o600);
  const external = new ExternalSessionServer(f.sessions.sessionTools, path);
  await assert.rejects(external.start(), /already running/);
  child.kill('SIGKILL');
  await childClosed;
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
  const discovery = deferred<void>();
  const f = await fixture(t, { deadline: 80, beforeClose: () => discovery.resolve() });
  f.backend.models = async () => {
    await discovery.promise;
    return {
      models: ['test/model'],
      pinned: ['test/model'],
      thinkingLevels: { 'test/model': ['off', 'minimal', 'low', 'medium', 'high'] },
    };
  };
  const pending = f.call('start', { text: 'Never created', model: 'test/model' });
  assert.equal((await pending).code, 'unconfirmed');
  discovery.resolve();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.sessions.snapshot().length, 0);
  const duplicate = await f.call('start', { text: 'Never created', model: 'test/model' });
  assert.equal(duplicate.code, 'duplicate');
  assert.match(String(duplicate.error), /may already have been delivered/);

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

test('read-only polling cannot exhaust mutation receipts, and repeated list IDs return fresh state', async (t) => {
  const f = await fixture(t);
  const listId = f.identity();
  for (let index = 0; index < 1030; index++) {
    assert.equal((await f.call('list', { label: `poller ${index}` })).ok, true);
  }
  assert.deepEqual((await f.call('list', { requestId: listId })).open, []);
  const started = await f.call('start', {
    text: 'Polling must not starve me',
    label: 'Another caller',
  });
  assert.equal(started.ok, true);
  assert.equal((await f.call('list', { requestId: listId })).open instanceof Array, true);
  assert.equal(((await f.call('list', { requestId: listId })).open as any[]).length, 1);
});

test('an internal leased turn cannot self-trigger through the shipped external CLI', async (t) => {
  let attempted = 0;
  const f = await fixture(t, {
    run: async (request) => {
      attempted++;
      if (attempted > 1) {
        return;
      }
      const result = await runCli(
        f.path,
        ['send', '--label', 'Pretend external', '--id', request.id, '--text', 'Self loop'],
        10_000,
        {
          COMPANION_SESSION_TOOLS_TOKEN: request.sessionTools!.token,
        },
      );
      assert.equal(result.code, 4);
      assert.equal(result.result.code, 'internal-caller');
      assert.match(result.result.error, /internal Companion session tools/);
    },
  });
  assert.equal((await f.call('start', { text: 'Start one internal turn' })).ok, true);
  await f.sessions.idle();
  assert.equal(attempted, 1);
  assert.equal(f.sessions.snapshot()[0].status, 'completed');
  assert.equal(
    f.sessions.snapshot()[0].messages.filter((message) => message.kind === 'user').length,
    1,
  );
  // The marker also covers turns where Companion did not grant a tool lease.
  for (const authority of [
    { COMPANION_INTERNAL_AGENT: '1' },
    { COMPANION_WIDGET_TOKEN: 'synthetic-widget-token' },
  ]) {
    const blocked = await runCli(
      f.path,
      ['start', '--label', 'Rowan', '--text', 'No lease'],
      10_000,
      authority,
    );
    assert.equal(blocked.result.code, 'internal-caller');
  }
  assert.equal(f.sessions.snapshot().length, 1);
});

test('half-closed request streams support asynchronous start, reopen and draft', async (t) => {
  const f = await fixture(t);
  f.backend.models = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      models: ['test/model'],
      pinned: ['test/model'],
      thinkingLevels: { 'test/model': ['off', 'minimal', 'low', 'medium', 'high'] },
    };
  };
  const half = (method: string, args: Record<string, unknown>) =>
    raw(
      f.path,
      JSON.stringify({ method, requestId: f.identity(), label: 'nc caller', ...args }) + '\n',
      true,
    );
  const start = await half('start', { text: 'Half close', model: 'test/model' });
  assert.equal(start.ok, true, JSON.stringify(start));
  await f.sessions.idle();
  const id = start.session.id;
  await f.call('close', { id });
  assert.equal((await half('reopen', { id })).outcome, 'reopened');
  f.sessions.setDraftHost(async (_request, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signal.aborted, false);
    return { outcome: 'inserted', reason: '' };
  });
  assert.equal((await half('draft', { id, text: 'Review this' })).outcome, 'inserted');
});

test('CLI discovery timeout is definite non-transmission, and a full connection table replies with refusal', async (t) => {
  const f = await fixture(t);
  const path = join(dirname(f.path), 'stalled.sock');
  const sockets = new Set<ReturnType<typeof connect>>();
  const stalled = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => stalled.listen(path, resolve));
  await chmod(path, 0o600);
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
  });
  const noMutation = await runCli(path, [
    'start',
    '--label',
    'Rowan',
    '--text',
    'Not sent',
    '--timeout-ms',
    '40',
  ]);
  assert.equal(noMutation.code, 3);
  assert.equal(noMutation.result.requestId, undefined);
  assert.match(noMutation.result.error, /no mutation was sent/);
  const interrupted = spawn(
    executable,
    ['start', '--socket', path, '--label', 'Rowan', '--text', 'Interrupted discovery'],
    { cwd: '/tmp', env: externalCliEnvironment() },
  );
  let interruptedOutput = '';
  interrupted.stdout.on('data', (chunk) => (interruptedOutput += chunk));
  const connected = await once(stalled, 'connection');
  await once(connected[0], 'data');
  interrupted.kill('SIGINT');
  assert.equal((await once(interrupted, 'close'))[0], 3);
  assert.match(JSON.parse(interruptedOutput).error, /no mutation was sent/);
  const held: ReturnType<typeof connect>[] = [];
  for (let index = 0; index < 32; index++) {
    const socket = connect(f.path);
    socket.on('error', () => {});
    await once(socket, 'connect');
    held.push(socket);
  }
  t.after(() => {
    for (const socket of held) {
      socket.destroy();
    }
  });
  const refused = await f.cli([
    'start',
    '--label',
    'Rowan',
    '--text',
    'Over capacity',
    '--request-id',
    f.identity(),
  ]);
  assert.equal(refused.code, 4);
  assert.equal(refused.result.code, 'limit');
  assert.equal(f.sessions.snapshot().length, 0);
});

test('unknown host exceptions preserve uncertainty without returning private errors or releasing duplicate guards', async (t) => {
  const f = await fixture(t);
  const id = ((await f.call('start', { text: 'Error target' })).session as any).id;
  await f.sessions.idle();
  f.sessions.setDraftHost(async () => {
    throw Error('secret filesystem path');
  });
  const result = await f.call('draft', { id, text: 'May have been inserted' });
  assert.equal(result.code, 'unconfirmed');
  assert.doesNotMatch(String(result.error), /secret/);
  assert.equal((await f.call('draft', { id, text: 'May have been inserted' })).code, 'duplicate');
});

test('external label controls cannot break or visually reverse attribution', async (t) => {
  const f = await fixture(t);
  for (const label of [
    'line\u2028break',
    'paragraph\u2029break',
    '\u202eYou',
    '\u0085newline',
    '\u2066isolate',
  ]) {
    assert.equal((await f.call('start', { text: 'Bad label', label })).code, 'invalid');
    assert.equal(
      parseOrigin({ kind: 'external', title: label, requestId: 'abcdefgh_12345678', depth: 1 }),
      undefined,
    );
  }
  assert.equal((await f.call('start', { text: 'Ordinary emoji', label: '🧑‍💻 Rowan' })).ok, true);
});

test('failed busy assertions still release the gate, close the fixture and terminate', async () => {
  // Execute the real fixture in a separate process: its intentional assertion
  // failure must exit normally with code 1, not hang until the watchdog kills it.
  const failureFixture = fileURLToPath(
    new URL('../fixtures/external-session-cleanup-failure.ts', import.meta.url),
  );
  const project = fileURLToPath(new URL('../../', import.meta.url));
  let output = '';
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--import', 'tsx', failureFixture], {
      cwd: project,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: externalCliEnvironment(),
    }),
    (error: unknown) => {
      const result = error as { code: number; killed?: boolean; stdout: string };
      assert.equal(result.code, 1, 'The expected assertion must fail without timing out');
      assert.equal(result.killed, false);
      output = result.stdout;
      assert.match(output, /Intentional failure with a busy synthetic turn/);
      return true;
    },
  );
  const directory = output.match(/EXTERNAL_FIXTURE_DIRECTORY=(\S+)/)?.[1];
  assert.ok(directory, 'The failure fixture must report its temporary directory');
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('synthetic external child environments remove inherited authority without changing the parent', () => {
  const keys = [
    'COMPANION_INTERNAL_AGENT',
    'COMPANION_SESSION_TOOLS_TOKEN',
    'COMPANION_SESSION_TOOLS_ENDPOINT',
    'COMPANION_WIDGET_TOKEN',
    'COMPANION_WIDGET_ENDPOINT',
    'COMPANION_EXTERNAL_SOCKET',
  ];
  const original = keys.map((key) => process.env[key]);
  const external = externalCliEnvironment();
  for (const [index, key] of keys.entries()) {
    // Compare booleans only: even a failure must never print inherited secrets.
    assert.equal(Object.hasOwn(external, key), false, `${key} must not reach a fixture CLI`);
    assert.equal(
      process.env[key] === original[index],
      true,
      `${key} must remain unchanged in the parent`,
    );
  }
  assert.equal(external.PATH === process.env.PATH, true);
  assert.equal(
    externalCliEnvironment({ COMPANION_INTERNAL_AGENT: 'synthetic' }).COMPANION_INTERNAL_AGENT,
    'synthetic',
  );
});
