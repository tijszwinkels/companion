// Opt-in real Wayland regression. Run only inside a disposable compositor with
// its own runtime, HOME and backend fixture; never on the user's desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
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
const browserEvents: any[] = [];
const widgetServer = createHttpServer((request, response) => {
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/action')) {
        browserEvents.push(JSON.parse(body));
      }
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<html><body style="margin:0"><select id="choice" style="position:absolute;left:40px;top:40px;width:220px;height:40px"><option>First</option><option>Second</option></select><script>
    window.widgetReady = true; window.widgetContentHeight = 160; window.widgetHost = {setTheme() {}};
    choice.addEventListener('pointerdown', () => {
      fetch('/action', {method:'POST',body:JSON.stringify({kind:'pointer'})});
      setTimeout(() => fetch('/action', {method:'POST',body:JSON.stringify({kind:'menu',open:choice.matches(':open')})}), 200);
    });
    choice.addEventListener('change', () => fetch('/action', {method:'POST',body:JSON.stringify({kind:'selected',value:choice.value})}));
  </script></body></html>`);
});
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
  await new Promise<void>((done) => widgetServer.listen(0, '127.0.0.1', done));
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
  const pointerProcess = spawn(pointer, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  processes.push(pointerProcess);
  let pointerReplies = '';
  pointerProcess.stdout!.on('data', (chunk) => (pointerReplies += chunk.toString()));
  await until(() => pointerReplies.includes('ready'), 'Private pointer ready');

  async function click() {
    const count = pointerReplies.length;
    pointerProcess.stdin!.write('c');
    await until(() => pointerReplies.length > count, 'Pointer click acknowledged');
  }

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
    ['--socket', join(directory, 'backend.sock'), '--presentation', 'dock', '--render-diagnostics'],
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

  async function layerGeometry() {
    const monitors = JSON.parse(await hypr('-j', 'layers'));
    for (const monitor of Object.values(monitors) as any[]) {
      for (const layers of Object.values(monitor.levels) as any[]) {
        const layer = layers.find((value: any) => value.namespace === 'companion-panel');
        if (layer) {
          return layer;
        }
      }
    }
    assert.fail('Native layer is mapped');
  }

  async function clickAt(x: number, y: number) {
    await hypr(
      'eval',
      `hl.dispatch(hl.dsp.cursor.move({x = ${Math.round(x)}, y = ${Math.round(y)}}))`,
    );
    await click();
  }

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
    const geometry = await layerGeometry();
    await clickAt(geometry.x + 200, geometry.y + geometry.h - 100);
    await delay(100);
    assert.equal(status.active, true, 'Composer click keeps layer focus');
    assert.equal(status.composerFocusId, 'synthetic');
    await clickAt(geometry.x + 32, geometry.y + 200);
    await delay(100);
    assert.equal(status.active, true, 'Session-tab click keeps layer focus');
    assert.equal(status.composerFocusId, 'synthetic');
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
    await click();
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
  // The real native WebEngine view renders a synthetic select control. Its
  // control must remain interactive under the layer's focus grab. Popup state
  // is reported separately: this headless backend may not open a native menu.
  const widgetAddress = widgetServer.address();
  assert.ok(widgetAddress && typeof widgetAddress !== 'string');
  const widget = {
    id: 'dropdown',
    name: 'dropdown',
    revision: 1,
    presentation: { placement: 'pinned', heightPercent: 30, replaceActivity: true },
    viewUrl: `http://127.0.0.1:${widgetAddress.port}/view/${'a'.repeat(64)}`,
  };
  for (const peer of peers) {
    peer.write(
      JSON.stringify({
        type: 'agent-session',
        session: {
          id: 'synthetic',
          title: 'Synthetic conversation',
          status: 'completed',
          messages: [
            {
              id: 'dropdown',
              role: 'assistant',
              kind: 'widget',
              widget,
              text: 'Synthetic dropdown',
              toolName: '',
              input: '',
              state: '',
              screenshot: '',
            },
          ],
        },
      }) + '\n',
    );
  }
  await until(() => uiLog.includes('"kind":"widget"'), 'Native widget rendered');
  for (const mode of ['dock', 'sidebar']) {
    send({ action: 'presentation', mode });
    await until(() => status.presentation === mode, 'Widget mode selected');
    await focusApplication(address);
    send({ action: 'focus', address });
    await until(
      () => status.composerFocusId === 'synthetic',
      'Widget interaction begins with focus grab',
    );
    const metrics = uiLog
      .split('\n')
      .filter((line) => line.includes('COMPANION_RENDER '))
      .map((line) => JSON.parse(line.slice(line.indexOf('COMPANION_RENDER ') + 17)))
      .filter((entry) => entry.kind === 'widget')
      .at(-1);
    const geometry = await layerGeometry();
    browserEvents.length = 0;
    await clickAt(geometry.x + metrics.x + 80, geometry.y + metrics.y + 60);

    await until(
      () => browserEvents.some((event) => event.kind === 'pointer'),
      'Browser select receives inside click',
    );
    await until(
      () => browserEvents.some((event) => event.kind === 'menu'),
      'Popup status received',
    );
    console.log(
      mode + ': native select popup status',
      JSON.stringify(browserEvents.find((event) => event.kind === 'menu')),
    );
    await hypr('eval', 'hl.dispatch(hl.dsp.cursor.move({x = 80, y = 180}))');
    await delay(100);
    assert.equal(
      status.active,
      true,
      'Clicking the browser select retains the grab while the pointer moves outside',
    );
    await command('wtype', ['-k', mode === 'dock' ? 'Down' : 'Up', '-k', 'Return'], signal);
    await until(
      () =>
        browserEvents.some(
          (event) =>
            event.kind === 'selected' && event.value === (mode === 'dock' ? 'Second' : 'First'),
        ),
      'Browser select accepts keyboard selection',
    );
    assert.equal(status.active, true, 'Browser selection keeps layer focus');
    await clickAt(80, 180);
    await until(() => !status.active, 'Outside click after popup returns focus to the application');
    await delay(150);
    assert.equal(status.active, false, 'Popup restoration does not reclaim an outside click');
    console.log(mode + ': native select interaction passed');
    send({ action: 'hide' });
    await until(() => !status.opened, 'Hide after widget interaction');
    send({ action: 'show' });
    await until(() => status.opened, 'Show after widget interaction');
  }
} finally {
  bridge?.destroy();
  for (const peer of peers) {
    peer.destroy();
  }
  backend.close();
  widgetServer.close();
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
