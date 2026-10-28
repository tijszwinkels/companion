/**
 * Dedicated app-chat native checks, independent of presentation's shared fixtures.
 * Requires an isolated native build with BUILD_TESTING=ON. All endpoints, profiles
 * and data are temporary; no live desktop, model, microphone or clipboard use.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { offscreenPlatform } from '../window/offscreen.ts';

const execute = promisify(execFile);
const build = resolve('native/window/build');
const replyLimit = 64 * 1024;

const document = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src companion-widget: http:; style-src 'unsafe-inline'">
</head><body>Synthetic application chat broker probe<script>
window.widgetHost = {setTheme() {}};
window.widgetReady = true;
window.widgetContentHeight = 100;
window.runChatChecks = async () => {
  const checks = {};
  const settle = (request) => Promise.race([
    request.then(async response => { await response.text(); return 'ok'; }, () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 3000)),
  ]);
  const post = (version, path = 'chat-read', encoded) => settle(fetch(path, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: encoded || JSON.stringify({version}),
  }));
  checks.allowed = await post(1);
  checks.denied = await post(2);
  checks.oversizedReply = await post(3);
  checks.redirect = await post(4);
  checks.exactReply = await post(5);
  const prefix = JSON.stringify({version: 1, pad: ''});
  const exactBody = JSON.stringify({version: 1, pad: 'x'.repeat(1024 - prefix.length)});
  checks.exactBody = await post(1, 'chat-read', exactBody);
  checks.oversizedBody = await post(1, 'chat-read', exactBody + ' ');
  checks.wrongMethod = await settle(fetch('chat-read'));
  checks.grant = await post(1, 'chat-grant');
  checks.send = await post(1, 'chat-send');
  checks.queryString = await post(1, 'chat-read?version=1');
  checks.otherHost = await post(1, 'companion-widget://other/chat-read');
  checks.network = await settle(fetch('http://127.0.0.1:9/'));
  checks.recovered = await post(1);
  checks.done = true;
  window.checks = checks;
};
</script></body></html>`;

function encodedReply(bytes: number): string {
  const overhead = JSON.stringify({ text: '' }).length;
  return JSON.stringify({ text: 'x'.repeat(bytes - overhead) });
}

test('native app-chat consent and broker obey their separate trust boundaries', async (context) => {
  const directory = await mkdtemp('/tmp/companion-app-chat-native-');
  context.after(() => rm(directory, { recursive: true, force: true }));
  const capability = randomBytes(32).toString('hex');
  const root = '/view/' + capability;
  const requests: { method: string; path: string; bytes: number; version?: number }[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += chunk.toString();
    }
    const body = text ? JSON.parse(text) : {};
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      bytes: Buffer.byteLength(text),
      version: body.version,
    });
    if (request.url === root) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(document);
      return;
    }
    if (request.url === root + '/chat-read' && request.method === 'POST') {
      const version = body.version;
      response.writeHead(version === 2 ? 403 : version === 4 ? 302 : 200, {
        'Content-Type': 'application/json',
        ...(version === 4 ? { Location: 'http://127.0.0.1:9/must-not-follow' } : {}),
      });
      response.end(
        version === 3
          ? encodedReply(replyLimit + 1)
          : version === 5
            ? encodedReply(replyLimit)
            : JSON.stringify({ changed: false, revision: 'a'.repeat(64) }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  context.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const template = await readFile(new URL('./native.qml.in', import.meta.url), 'utf8');
  const qml = join(directory, 'tst_app_chat.qml');
  await writeFile(
    qml,
    template
      .replaceAll('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
      .replaceAll('@VIEW_URL@', `http://127.0.0.1:${port}${root}`),
  );
  try {
    const result = await execute(
      join(build, 'companion-window-tests'),
      ['-input', qml, '-nocrashhandler'],
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
        },
        timeout: 90_000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /Totals: 8 passed, 0 failed/);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw Error([String(error), output.stdout, output.stderr].join('\n'));
  }

  assert.ok(
    requests.some((request) => request.path === root + '/chat-read' && request.bytes === 1024),
  );
  assert.ok(!requests.some((request) => request.bytes > 1024));
  assert.ok(
    requests
      .filter((request) => request.path !== root)
      .every((request) => request.path === root + '/chat-read' && request.method === 'POST'),
  );
  assert.deepEqual(
    requests
      .filter((request) => request.path === root + '/chat-read')
      .map((request) => request.version),
    [1, 2, 3, 4, 5, 1, 1],
  );
});
