import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { offscreenPlatform } from '../window/offscreen.ts';

/**
 * The trusted HTML session surface in the real native host and QML body
 * (surface.qml.in), offscreen. Requires `npm run ui:build -- -DBUILD_TESTING=ON`.
 *
 * Real: native host, WindowContent/Client/PanelContent/SessionView/pop-out
 * controller, trusted chat page with its ShellProfile and QWebChannel bridge,
 * restricted WidgetProfile broker for the application view.
 * Injected: the listener transport (scripted messages) and the application
 * endpoint below, a synthetic stand-in for the listener's application
 * service. It serves two hand-written layouts for code versions 1 and 2.
 */

const execute = promisify(execFile);
const build = resolve('native/window/build');

interface ApplicationEndpoint {
  viewUrl: string;
  controlUrl: string;
  requests: { path: string; body: unknown }[];
  close(): Promise<void>;
}

function applicationDocument(version: number): string {
  // Two different layouts: version 1 is a list, version 2 a board.
  const layout = version === 1 ? 'list' : 'board';
  return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src companion-widget: companion-shell: http: file:">
</head>
<body data-layout="${layout}"><main id="app">${layout}</main>
<script>
window.widgetHost = { setTheme() {} };
window.widgetContentHeight = 300;
window.widgetReady = true;
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return response.json();
}
window.runChecks = async () => {
  const checks = {};
  checks.state = await (await fetch('state')).json();
  checks.query = await post('query', { name: 'count_tasks', args: {}, version: ${version} });
  checks.action = await post('action', { action: 'complete', args: { id: 't1' }, version: ${version}, requestId: 'r1' });
  try {
    await fetch('http://127.0.0.1:9/');
    checks.blocked = false;
  } catch (error) {
    checks.blocked = true;
  }
  checks.done = true;
  window.checks = checks;
};
</script>
</body></html>`;
}

async function startEndpoint(): Promise<ApplicationEndpoint> {
  const capability = randomBytes(32).toString('hex');
  const requests: { path: string; body: unknown }[] = [];
  let version = 1;
  let revision = 3;

  async function body(request: IncomingMessage): Promise<unknown> {
    let text = '';
    for await (const part of request) {
      text += part.toString();
    }
    return text ? JSON.parse(text) : null;
  }

  function json(response: ServerResponse, value: unknown) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  }

  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    const received = request.method === 'POST' ? await body(request) : null;
    requests.push({ path, body: received });

    if (path.startsWith('/control/version/')) {
      version = Number(path.slice('/control/version/'.length));
      json(response, { version });
    } else if (path === `/view/${capability}`) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(applicationDocument(version));
    } else if (path === `/view/${capability}/state`) {
      const data = { tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] };
      json(response, {
        kind: 'application',
        version,
        revision,
        data,
        props: data,
        textScale: null,
      });
    } else if (path === `/view/${capability}/query`) {
      json(response, { result: { count: 3 }, revision });
    } else if (path === `/view/${capability}/action`) {
      revision++;
      json(response, { result: { done: true }, id: 'app-1', revision });
    } else {
      response.writeHead(404);
      response.end();
    }
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return {
    viewUrl: `http://127.0.0.1:${port}/view/${capability}`,
    controlUrl: `http://127.0.0.1:${port}/control`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('HTML chat, session application and code replacement share one conversation model', async () => {
  const directory = await mkdtemp('/tmp/companion-session-surface-test-');
  const endpoint = await startEndpoint();

  try {
    const runtime = join(directory, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    const template = await readFile(new URL('./surface.qml.in', import.meta.url), 'utf8');
    const path = join(directory, 'tst_surface.qml');
    await writeFile(
      path,
      template
        .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
        .replace('@VIEW_URL@', endpoint.viewUrl)
        .replace('@CONTROL_URL@', endpoint.controlUrl),
    );

    try {
      const result = await execute(
        join(build, 'companion-window-tests'),
        ['-input', path, '-nocrashhandler'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, 'config'),
            XDG_CACHE_HOME: join(directory, 'cache'),
            XDG_RUNTIME_DIR: runtime,
            QT_QPA_PLATFORM: await offscreenPlatform(directory),
            QT_QUICK_BACKEND: 'software',
            QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
            QML_IMPORT_PATH: join(build, 'qml'),
            COMPANION_TEST_SESSION_SURFACE: 'html',
          },
          timeout: 120_000,
          killSignal: 'SIGKILL',
        },
      );
      assert.match(result.stdout, /Totals: \d+ passed, 0 failed/);
    } catch (error) {
      throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'));
    }

    // The restricted view reached only its own capability, through the
    // fixed broker paths, with the loaded code version in each body.
    const viewPaths = endpoint.requests.filter((entry) => entry.path.startsWith('/view/'));
    assert.ok(viewPaths.length > 0);
    const capability = new URL(endpoint.viewUrl).pathname;
    for (const entry of viewPaths) {
      assert.ok(
        [capability, capability + '/state', capability + '/query', capability + '/action'].includes(
          entry.path,
        ),
        entry.path,
      );
    }
    const query = viewPaths.find((entry) => entry.path.endsWith('/query'));
    assert.deepEqual(query?.body, { name: 'count_tasks', args: {}, version: 1 });
  } finally {
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});
