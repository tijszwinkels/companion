import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { defaultViewport, widgetDocument } from '../../src/widgets/document.ts';
import { WidgetRegistry } from '../../src/widgets/registry.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import type { WidgetAttachment } from '../../src/widgets/types.ts';

const execute = promisify(execFile);
const build = resolve('native/window/build');

async function fixture() {
  const directory = await mkdtemp('/tmp/companion-window-test-');
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  return {
    directory,
    runtime,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_RUNTIME_DIR: runtime,
      QT_QPA_PLATFORM: 'offscreen',
      QT_QUICK_BACKEND: 'software',
      QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
      QML_IMPORT_PATH: join(build, 'qml'),
      LD_LIBRARY_PATH: join(build, 'staged/usr/lib'),
    },
  };
}

async function until(condition: () => boolean, detail: () => string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await delay(25);
  }
  assert.fail(detail());
}

test('prepared shortcuts preserve ordinary desktop actions and route the native window', async () => {
  const result = await execute('lua', [
    resolve('test/window/bindings.lua'),
    resolve('integrations/omarchy/bindings.lua'),
  ]);
  assert.match(result.stdout, /BINDINGS_PASS/);
});

test('CLI rejects invalid or conflicting presentation options before starting a UI', async () => {
  const setup = await fixture();
  try {
    for (const args of [
      ['--presentation', 'nonsense'],
      ['--command', 'show', '--presentation', 'window'],
    ]) {
      await assert.rejects(
        execute(join(build, 'companion-ui'), args, {
          env: setup.env,
          timeout: 3000,
          killSignal: 'SIGKILL',
        }),
        (error: any) => {
          assert.equal(error.code, 1, 'reject the arguments, rather than start or time out');
          assert.match(
            error.stderr,
            args.includes('--command')
              ? /Use --presentation and --command in separate invocations/
              : /Choose window, sidebar or dock/,
          );
          return true;
        },
      );
    }
    await assert.rejects(stat(join(setup.runtime, 'companion/ui.sock')), { code: 'ENOENT' });
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('stock Quickshell bridge connects to the isolated native control socket', async () => {
  const setup = await fixture();
  const calls: any[] = [];
  const peers: Socket[] = [];
  const runtime = join(setup.runtime, 'companion');
  await mkdir(runtime, { mode: 0o700 });
  const server = createServer((socket) => {
    peers.push(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        calls.push(JSON.parse(line));
      }
      if (calls.some((entry) => entry.action === 'theme')) {
        socket.write(
          JSON.stringify({ type: 'status', protocol: 1, opened: true, sessionId: 'synthetic' }) +
            '\n',
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(runtime, 'ui.sock'), resolve));
  const commons = join(setup.directory, 'Commons');
  await mkdir(commons);
  await writeFile(
    join(commons, 'qmldir'),
    'module qs.Commons\nsingleton Color 1.0 Color.qml\nsingleton Style 1.0 Style.qml\n',
  );
  await writeFile(
    join(commons, 'Color.qml'),
    `pragma Singleton
import QtQuick
QtObject {
  property QtObject menu: QtObject {
    property color background: "#123456"
    property color text: "#ffffff"
    property color selectedText: "#aabbcc"
    property color selectedBackground: "#223344"
  }
  property QtObject tooltip: QtObject {
    property color background: "#123456"
    property color text: "#ffffff"
    property color border: "#556677"
  }
}
`,
  );
  await writeFile(
    join(commons, 'Style.qml'),
    `pragma Singleton
import QtQuick
QtObject {
  property QtObject font: QtObject { property string menuFamily: "monospace" }
  function space(value) { return value * 1.25 }
}
`,
  );
  const adapter = new URL('../../integrations/omarchy/plugin', import.meta.url).href;
  const path = join(setup.directory, 'shell.qml');
  await writeFile(
    path,
    `import QtQuick
import Quickshell
import "${adapter}" as Adapter
Scope {
  Adapter.NativeBridge {
    onReadyChanged: if (ready && status.sessionId === "synthetic") {
      console.log("NATIVE_BRIDGE_PASS")
      Qt.quit()
    }
  }
  Timer { interval: 4000; running: true; onTriggered: Qt.exit(1) }
}
`,
  );
  try {
    const result = await execute('/usr/bin/quickshell', ['--path', path], {
      env: setup.env,
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    assert.match(result.stdout + result.stderr, /NATIVE_BRIDGE_PASS/);
    assert.equal(calls[0].action, 'bridge');
    const theme = calls.find((entry) => entry.action === 'theme').values;
    assert.equal(theme.background, '#123456');
    assert.equal(theme.unit, 1.25);
  } finally {
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('Qt window connects, hands off ownership, reconnects and accepts a single-instance command', async () => {
  const setup = await fixture();
  const stage = join(setup.directory, 'stage');
  await execute('cmake', ['--install', build, '--prefix', '/usr'], {
    env: { ...process.env, DESTDIR: stage },
    timeout: 15000,
  });
  const executable = join(stage, 'usr/bin/companion-ui');
  const sockets: Socket[] = [];
  const requests: any[] = [];
  const backendPath = join(setup.directory, 'backend.sock');
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // This test deliberately tears down Qt's socket during reconnect. A
      // concurrent snapshot write can observe EPIPE instead of ECONNRESET;
      // both mean the same peer closure, while other socket errors still fail.
      assert.ok(
        error.code === 'ECONNRESET' || error.code === 'EPIPE',
        `Unexpected error during forced Qt connection teardown: ${error.code}`,
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        requests.push(JSON.parse(line));
      }
    });
    const state =
      JSON.stringify({
        type: 'state',
        protocol: 1,
        ready: true,
        activitySessionId: 'test',
        activityHistoryCount: 0,
        sessions: [{ id: 'one', title: 'Synthetic session', status: 'idle', messages: [] }],
      }) + '\n';
    socket.write(state.slice(0, 40));
    setTimeout(() => socket.write(state.slice(40)), 10);
  });
  await new Promise<void>((resolve) => server.listen(backendPath, resolve));
  // Use installed resources and module lookup, without a QML path into the
  // build tree. This is a staged installation only, never a live package install.
  const env = { ...setup.env, QML_IMPORT_PATH: '', QT_SCALE_FACTOR: '1.25' };
  const child = spawn(
    executable,
    ['--socket', backendPath, '--render-diagnostics', '--widget-rendering', 'supersampled'],
    { env },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let bridge: Socket | undefined;
  try {
    await until(
      () => requests.some((entry) => entry.action === 'panel-state' && entry.id === 'one'),
      () => output,
    );
    const control = join(setup.runtime, 'companion/ui.sock');
    assert.equal((await stat(control)).mode & 0o077, 0);
    bridge = createConnection(control);
    bridge.on('error', (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ECONNRESET', 'oversized input is disconnected');
    });
    const statuses: any[] = [];
    let buffer = '';
    bridge.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        statuses.push(JSON.parse(line));
      }
    });
    await new Promise<void>((resolve) => bridge!.once('connect', resolve));
    bridge.write(JSON.stringify({ action: 'bridge' }) + '\n');
    bridge.write(
      JSON.stringify({ action: 'theme', values: { unit: 1.2, fontFamily: 'sans-serif' } }) + '\n',
    );
    await until(
      () => output.includes('"themeUnit":1.2') && output.includes('"windowDpr":1.25'),
      () => output,
    );
    const diagnosticLines = output
      .split('\n')
      .filter((line) => line.startsWith('COMPANION_RENDER '));
    assert.ok(diagnosticLines.length > 0);
    assert.ok(diagnosticLines.every((line) => !line.includes('Synthetic session')));
    const metrics = JSON.parse(diagnosticLines.at(-1)!.slice('COMPANION_RENDER '.length));
    assert.equal(metrics.kind, 'window');
    assert.equal(metrics.fontFamily, 'sans-serif');
    assert.equal(metrics.windowDpr, 1.25);
    assert.equal(metrics.effectiveDpr, 1.25);
    assert.equal(metrics.themeUnit, 1.2);
    assert.equal(metrics.widgetRendering, 'supersampled');
    assert.ok(metrics.timeMs > 0);
    await assert.rejects(
      execute(executable, ['--render-diagnostics'], { env, timeout: 5000 }),
      /Stop the existing UI process before starting with --render-diagnostics/,
    );
    await assert.rejects(
      execute(executable, ['--widget-rendering', 'supersampled'], { env, timeout: 5000 }),
      /Use the running UI's rendering controls/,
    );
    await assert.rejects(
      execute(executable, ['--widget-rendering', 'unbounded'], { env, timeout: 5000 }),
      /Choose normal, supersampled or filtered/,
    );
    await execute(executable, ['--command', 'hide'], {
      env,
      timeout: 5000,
    });
    await until(
      () => statuses.some((entry) => entry.type === 'status' && entry.opened === false),
      () => output,
    );
    assert.equal(requests.at(-1).id, '');
    await assert.rejects(
      execute(executable, ['--presentation', 'nonsense'], { env, timeout: 5000 }),
      /Choose window, sidebar or dock/,
    );
    await assert.rejects(
      execute(executable, ['--command', 'show', '--presentation', 'window'], {
        env,
        timeout: 5000,
      }),
      /Use --presentation and --command in separate invocations/,
    );
    // The rejected combination must not partially show or change the running UI.
    // Send two explicit operations when both a mode change and visibility matter.
    await execute(executable, ['--presentation', 'window'], { env, timeout: 5000 });
    assert.equal(statuses.filter((entry) => entry.type === 'status').at(-1).opened, false);
    assert.equal(requests.at(-1).id, '');
    await execute(executable, ['--command', 'show'], {
      env,
      timeout: 5000,
    });
    await until(
      () => requests.at(-1)?.id === 'one',
      () => output,
    );
    assert.equal(sockets.length, 1, 'secondary invocation must not create another backend client');
    sockets[0].destroy();
    await until(
      () => sockets.length === 2 && requests.at(-1)?.id === 'one',
      () => output,
    );
    bridge.write('x'.repeat(65537));
    await new Promise<void>((resolve) => bridge!.once('close', resolve));
    assert.equal(child.exitCode, null);
    assert.doesNotMatch(output, /ReferenceError|TypeError|Binding loop|Required property/);
  } finally {
    bridge?.destroy();
    child.kill('SIGTERM');
    await exited;
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('portable client handles ordered replies and reconnects', async () => {
  const setup = await fixture();
  try {
    const result = await execute(
      '/usr/lib/qt6/bin/qmltestrunner',
      ['-input', resolve('test/window/tst_client.qml'), '-nocrashhandler'],
      {
        env: setup.env,
        timeout: 20000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /9 passed, 0 failed/);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('native UI preserves its QML body and Chromium view across presentation changes', async () => {
  const setup = await fixture();
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(setup.directory, async (_, value) => {
    reference = value;
  });
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        requestId: 'native-window',
        props: {
          title: 'Standalone Qt',
          items: [{ id: 'one', text: 'Retained browser', completed: false }],
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const template = await readFile(new URL('./host.qml.in', import.meta.url), 'utf8');
    const path = join(setup.directory, 'tst_host.qml');
    await writeFile(
      path,
      template
        .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
        .replace('@REFERENCE@', JSON.stringify(reference))
        .replaceAll('@CAPTURE@', join(setup.directory, 'window.png')),
    );
    try {
      const result = await execute(
        join(build, 'companion-window-tests'),
        ['-input', path, '-nocrashhandler'],
        {
          env: setup.env,
          timeout: 30000,
          killSignal: 'SIGKILL',
        },
      );
      assert.match(result.stdout, /7 passed, 0 failed/);
      const artifacts = join(build, 'artifacts');
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, 'window.png'),
        await readFile(join(setup.directory, 'window.png')),
      );
      await writeFile(
        join(artifacts, 'window-model-menu.png'),
        await readFile(join(setup.directory, 'window.png.menu.png')),
      );
    } catch (error) {
      throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'));
    }
  } finally {
    await service.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('translucent themes survive native widget creation, pinning, close and reopen', async () => {
  const setup = await fixture();
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(setup.directory, async (_, value) => {
    reference = value;
  });

  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        requestId: 'translucent',
        props: { title: 'Synthetic translucent theme', items: [] },
      }),
    });
    assert.equal(response.status, 200, await response.text());

    const template = await readFile(new URL('./translucent.qml.in', import.meta.url), 'utf8');
    const path = join(setup.directory, 'tst_translucent.qml');
    await writeFile(
      path,
      template
        .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
        .replace('@REFERENCE@', JSON.stringify(reference)),
    );

    // The regression used to hit Chromium's fatal alpha check. Suppress core
    // files for this synthetic child, including when checking the old version.
    const result = await execute(
      'prlimit',
      ['--core=0', '--', join(build, 'companion-window-tests'), '-input', path, '-nocrashhandler'],
      {
        env: { ...setup.env, QT_SCALE_FACTOR: '1.25', COMPANION_TEST_RENDER_DIAGNOSTICS: '1' },
        timeout: 30000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /3 passed, 0 failed/);
    const metrics = result.stdout
      .split('\n')
      .filter((line) => line.includes('COMPANION_RENDER '))
      .map((line) =>
        JSON.parse(line.slice(line.indexOf('COMPANION_RENDER ') + 'COMPANION_RENDER '.length)),
      );
    assert.ok(metrics.length > 0, 'embedded Chromium reports its viewport density');
    assert.ok(metrics.every((entry) => entry.kind === 'widget' && entry.browserDpr === 2.5));
    assert.ok(metrics.every((entry) => entry.rendering === 'filtered' && entry.renderScale === 2));
    assert.ok(metrics.every((entry) => Math.abs(entry.displayWidth - entry.viewportWidth) <= 1));
    assert.ok(metrics.every((entry) => entry.timeMs > 0 && !('viewUrl' in entry)));
  } catch (error) {
    throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'), {
      cause: error,
    });
  } finally {
    await service.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('diagnostic rendering modes keep native widget layout and interaction at fractional density', async () => {
  const setup = await fixture();
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(setup.directory, async (_, value) => {
    reference = value;
  });

  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        requestId: 'rendering-modes',
        props: {
          title: 'Rendering comparison',
          items: [{ id: 'one', text: 'Sharpness fixture', completed: false }],
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const template = await readFile(new URL('./rendering.qml.in', import.meta.url), 'utf8');
    const path = join(setup.directory, 'tst_rendering.qml');
    await writeFile(
      path,
      template
        .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
        .replace('@REFERENCE@', JSON.stringify(reference)),
    );
    const result = await execute(
      'prlimit',
      ['--core=0', '--', join(build, 'companion-window-tests'), '-input', path, '-nocrashhandler'],
      {
        env: { ...setup.env, QT_SCALE_FACTOR: '1.25', COMPANION_TEST_RENDER_DIAGNOSTICS: '1' },
        timeout: 30000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /3 passed, 0 failed/);
    for (const mode of ['normal', 'supersampled', 'filtered']) {
      assert.ok(result.stdout.includes(`"rendering":"${mode}"`), mode);
    }
  } catch (error) {
    throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'), {
      cause: error,
    });
  } finally {
    await service.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('native widget metadata callbacks tolerate removal of their QML context', async () => {
  const setup = await fixture();
  // This synthetic document delays metadata replies without using user widgets,
  // a compositor, or the backend. The real native profile and browser still run.
  const server = createHttpServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<html><body>Callback fixture<script>window.widgetReady = true; window.widgetContentHeight = 120; window.widgetHost = {setTheme() {}};</script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const viewUrl = `http://127.0.0.1:${address.port}/view/${'a'.repeat(64)}`;
    const template = await readFile(new URL('./callback-lifetime.qml.in', import.meta.url), 'utf8');
    const path = join(setup.directory, 'tst_callback_lifetime.qml');
    await writeFile(
      path,
      template
        .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
        .replace('@VIEW_URL@', JSON.stringify(viewUrl)),
    );
    const result = await execute(
      'prlimit',
      ['--core=0', '--', join(build, 'companion-window-tests'), '-input', path, '-nocrashhandler'],
      { env: setup.env, timeout: 30000, killSignal: 'SIGKILL' },
    );
    assert.match(result.stdout, /4 passed, 0 failed/);
  } catch (error) {
    throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'), {
      cause: error,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test('native widget profile decodes embedded images and never fetches network images', async () => {
  const setup = await fixture();
  const original = await new WidgetRegistry(join(setup.directory, 'bundles')).load('comparison');
  // The probe runs in the real nested widget documents inside the production
  // WebEngine profile and request interceptor. It reports through the normal
  // action broker because the opaque iframe is unreachable from QML.
  const probe = {
    ...original,
    javascript: `
      const violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
      });

      function load(source) {
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve({ loaded: true, width: image.naturalWidth });
          image.onerror = () => resolve({ loaded: false, width: image.naturalWidth });
          image.src = source;
          document.body.append(image);
        });
      }

      async function measure(localImage) {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const context = canvas.getContext('2d');
        context.fillStyle = '#823dc4';
        context.fillRect(0, 0, 2, 2);

        const png = await load(canvas.toDataURL('image/png'));
        const jpeg = await load(canvas.toDataURL('image/jpeg'));
        const remote = await load('https://example.invalid/blocked-image.png');
        const local = await load(localImage);

        // Violation events are dispatched asynchronously after the error.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { png, jpeg, remote, local, violations };
      }

      export const actions = {};
      export function describe() {
        return 'Embedded image probe';
      }
      export function mount(root, api) {
        let reported = false;
        return {
          async update(props) {
            if (reported) {
              return;
            }
            reported = true;
            await api.call('report', await measure(props.localImage));
          },
        };
      }
    `,
  };

  let report: unknown = null;
  let networkImageRequests = 0;
  const token = 'b'.repeat(64);
  const server = createHttpServer((request, response) => {
    void (async () => {
      const path = request.url ?? '';
      if (path === '/view/' + token && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          await widgetDocument(
            probe,
            { name: 'comparison', props: { localImage }, revision: 1 },
            defaultViewport,
            viewUrl,
          ),
        );
      } else if (path === '/view/' + token + '/state') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ revision: 1, props: { localImage }, textScale: null }));
      } else if (path === '/view/' + token + '/action' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        report = JSON.parse(body).args;
        response.setHeader('Content-Type', 'application/json');
        response.end('{}');
      } else if (path === '/report') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ report }));
      } else {
        // Anything else, including the blocked image below, must never arrive.
        networkImageRequests++;
        response.statusCode = 404;
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const viewUrl = `${origin}/view/${token}`;
  const localImage = `${origin}/blocked-image.png`;

  try {
    const template = await readFile(new URL('./embedded-images.qml.in', import.meta.url), 'utf8');
    const path = join(setup.directory, 'tst_embedded_images.qml');
    await writeFile(
      path,
      template
        .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
        .replace('@VIEW_URL@', JSON.stringify(viewUrl))
        .replace('@REPORT_URL@', JSON.stringify(origin + '/report')),
    );
    const result = await execute(
      join(build, 'companion-window-tests'),
      ['-input', path, '-nocrashhandler'],
      { env: setup.env, timeout: 30000, killSignal: 'SIGKILL' },
    );
    assert.match(result.stdout, /3 passed, 0 failed/);
    assert.equal(networkImageRequests, 0);
  } catch (error) {
    throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'), {
      cause: error,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(setup.directory, { recursive: true, force: true });
  }
});
