// Opt-in real Wayland regression. Run only inside a disposable compositor with
// its own runtime, HOME and backend fixture; never on the user's desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { command } from '../../src/system/command.ts';

assert.equal(process.env.COMPANION_TEST_NESTED, '1');
assert.ok(process.env.XDG_RUNTIME_DIR?.startsWith('/tmp/'));
const signal = AbortSignal.timeout(45000);
const directory = await mkdtemp('/tmp/companion-layer-focus-');
const peers = new Set<Socket>();
const requests: any[] = [];
const events: any[] = [];
const processes: ReturnType<typeof spawn>[] = [];
// Every spawned application gets disposable configuration, including on the
// opt-in visible nested runner. Its compositor already owns a private socket.
process.env.HOME = directory;
process.env.XDG_CONFIG_HOME = join(directory, 'config');
process.env.XDG_CACHE_HOME = join(directory, 'cache');
process.env.QT_QPA_PLATFORM = 'wayland';
process.env.GDK_BACKEND = 'wayland';
let uiLog = '';
let status: any = {};
let bridge: Socket | undefined;
const backend = createServer((socket) => {
  peers.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => peers.delete(socket));
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      requests.push(JSON.parse(line));
    }
  });
  socket.write(
    JSON.stringify({
      type: 'state',
      protocol: 1,
      ready: true,
      history: [],
      sessions: [
        { id: 'synthetic', title: 'Synthetic conversation', status: 'completed', messages: [] },
      ],
    }) + '\n',
  );
});

async function until(check: () => boolean | Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    signal.throwIfAborted();
    if (await check()) {
      return;
    }
    await delay(25);
  }
  assert.fail(label + '\n' + JSON.stringify(status) + '\n' + uiLog.slice(-2000));
}

async function hypr(...args: string[]) {
  return (await command('hyprctl', args, signal)).toString();
}

function send(message: object) {
  bridge!.write(JSON.stringify(message) + '\n');
}

async function focusApplication(address: string) {
  await hypr('eval', `hl.dispatch(hl.dsp.focus({window = "address:${address}"}))`);
  await until(
    async () => JSON.parse(await hypr('-j', 'activewindow')).address === address,
    'Application focus',
  );
}

try {
  await new Promise<void>((done) => backend.listen(join(directory, 'backend.sock'), done));
  await hypr('eval', 'hl.config({ input = { follow_mouse = 1 } })');
  const pointerXml = resolve('test/window/wlr-virtual-pointer.xml');
  await command(
    'wayland-scanner',
    ['client-header', pointerXml, join(directory, 'pointer.h')],
    signal,
  );
  await command(
    'wayland-scanner',
    ['private-code', pointerXml, join(directory, 'pointer.c')],
    signal,
  );
  const pointer = join(directory, 'pointer-click');
  await command(
    'cc',
    [
      resolve('test/window/pointer-click.c'),
      join(directory, 'pointer.c'),
      '-I',
      directory,
      '-lwayland-client',
      '-o',
      pointer,
    ],
    signal,
  );
  // Keep one virtual keyboard alive: a truly headless seat has none otherwise.
  const keyboard = spawn('wtype', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  processes.push(keyboard);
  keyboard.stdin!.write(' ');
  const field = spawn('/usr/bin/python', [resolve('test/live/text-field.py'), directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(field);
  field.stderr!.on('data', (chunk) => (uiLog += chunk.toString()));
  let address = '';
  await until(async () => {
    const clients = JSON.parse(await hypr('-j', 'clients'));
    address =
      clients.find((client: any) => client.title === `Companion test A ${directory}`)?.address ||
      '';
    return address !== '';
  }, 'Synthetic application started');
  await hypr('eval', 'hl.dispatch(hl.dsp.cursor.move({x = 80, y = 180}))');
  await focusApplication(address);

  const binary = process.env.COMPANION_TEST_UI || resolve('native/window/build/companion-ui');
  const ui = spawn(
    binary,
    ['--socket', join(directory, 'backend.sock'), '--presentation', 'dock'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  processes.push(ui);
  ui.stdout!.on('data', (chunk) => (uiLog += chunk.toString()));
  ui.stderr!.on('data', (chunk) => (uiLog += chunk.toString()));
  const path = join(process.env.XDG_RUNTIME_DIR!, 'companion/ui.sock');
  await until(async () => {
    try {
      const socket = createConnection(path);
      socket.on('error', () => {});
      await once(socket, 'connect');
      bridge = socket;
      return true;
    } catch {
      return false;
    }
  }, 'Native UI socket');
  let buffer = '';
  bridge!.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.type === 'status') {
        status = message;
      } else {
        events.push(message);
      }
    }
  });
  send({ action: 'bridge' });
  await until(() => status.online && status.sessionId === 'synthetic', 'Conversation ready');

  for (const mode of ['dock', 'sidebar']) {
    send({ action: 'presentation', mode });
    await until(() => status.presentation === mode, mode + ' selected');
    await focusApplication(address);
    events.length = 0;
    send({ action: 'focus', address });
    await until(
      () => status.composerFocusId === 'synthetic' && status.active,
      mode + ' acquires composer focus',
    );
    await delay(400);
    assert.equal(status.composerFocusId, 'synthetic', mode + ' retains focus');
    assert.ok(events.some((event) => event.type === 'pause-media'));
    await command('wtype', ['--', 'hello'], signal);
    await command('wtype', ['-k', 'Return'], signal);
    await until(
      () => requests.some((request) => request.action === 'send-agent' && request.text === 'hello'),
      'Typing reaches composer',
    );
    for (const peer of peers) {
      peer.write(JSON.stringify({ type: 'result', action: 'send-agent', ok: true }) + '\n');
    }
    requests.length = 0;

    send({ action: 'focus', address });
    await until(() => status.composerFocusId === '', 'Toggle releases composer');
    await until(
      () => events.some((event) => event.type === 'resume-media'),
      'Release resumes media',
    );
    assert.ok(events.some((event) => event.type === 'restore-focus' && event.address === address));
    await focusApplication(address);
    await until(() => !status.active, 'Application receives focus after release');
    const previousText = JSON.parse(await readFile(join(directory, 'text.json'), 'utf8')).A;
    await command('wtype', ['--', 'outside'], signal);
    await until(
      async () =>
        JSON.parse(await readFile(join(directory, 'text.json'), 'utf8')).A ===
        previousText + 'outside',
      'Application accepts input',
    );

    send({ action: 'focus', address });
    await until(() => status.composerFocusId === 'synthetic', 'Second focus request');
    await hypr('eval', 'hl.dispatch(hl.dsp.cursor.move({x = 80, y = 180}))');
    await command(pointer, [], signal);
    await until(
      () => status.composerFocusId === '' && !status.active,
      'Outside click clears focus',
    );
    send({ action: 'focus', address });
    await until(() => status.composerFocusId === 'synthetic', 'Focus after outside click');
    send({ action: 'hide' });
    await until(() => !status.opened && status.composerFocusId === '', 'Hide releases focus');
    await focusApplication(address);
    send({ action: 'focus', address });
    await until(
      () => status.opened && status.composerFocusId === 'synthetic',
      'Hidden surface focus',
    );
    send({ action: 'focus', address });
    await until(() => status.composerFocusId === '', 'Final release');
    console.log(mode + ': focus, text, toggle, outside-click, hide/reopen passed');
  }
} finally {
  bridge?.destroy();
  for (const peer of peers) {
    peer.destroy();
  }
  backend.close();
  for (const process of processes.reverse()) {
    if (process.exitCode === null && process.signalCode === null) {
      const closed = once(process, 'close');
      process.kill('SIGTERM');
      const killTimer = setTimeout(() => process.kill('SIGKILL'), 2000);
      await closed;
      clearTimeout(killTimer);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
