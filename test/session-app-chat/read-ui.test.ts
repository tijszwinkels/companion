/** Real native adapters, sandbox host/frame and authored API, with synthetic IO. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { defaultViewport, widgetDocument } from '../../src/widgets/document.ts';
import type { WidgetBundle } from '../../src/widgets/types.ts';
import { offscreenPlatform } from '../window/offscreen.ts';

const execute = promisify(execFile);
const build = resolve('native/window/build');

test('trusted sidebar and pop-out consent reaches the real sandboxed chat API without draft access', async (context) => {
  const directory = await mkdtemp('/tmp/companion-chat-read-ui-');
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = '/view/' + randomBytes(32).toString('hex');
  let allowed = false;
  let version = 1;
  let sequence = 1;
  const reads: { body: any; allowed: boolean; version: number }[] = [];
  const manifest = {
    name: 'synthetic-reader',
    version: 1,
    description: 'Synthetic',
    parameters: { type: 'object' },
    actions: {},
    example: {},
  };
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk.toString();
    const body = text ? JSON.parse(text) : null;
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url?.startsWith('/control/')) {
      const command = request.url.slice('/control/'.length);
      if (command === 'grant') {
        allowed = true;
      }
      if (command === 'revoke') {
        allowed = false;
      }
      if (command === 'stream') {
        sequence++;
      }
      if (command === 'replace') {
        version++;
        allowed = false;
      }
      json({ allowed, version });
    } else if (request.url === path) {
      // Actual production document, CSP, host script, opaque frame and API.
      // The synthetic bundle reports its received view only via describe().
      const bundle: WidgetBundle = {
        hash: 'a'.repeat(64),
        manifest,
        css: '',
        javascript: `let view = {available:false,snapshot:null};
          let reader;
          export async function describe(props) {
            let read;
            let readError;
            if (props.read) {
              try { read = await reader.chat.read(); }
              catch (error) { readError = error.message; }
            }
            return JSON.stringify({version:${version},view,read,readError});
          }
          export function mount(root, api) {
            reader = api;
            const unsubscribe = api.chat.subscribe(value => { view = value; root.textContent = JSON.stringify(value); });
            return {update() {}, dispose() { unsubscribe(); }};
          }`,
      };
      const document = await widgetDocument(
        bundle,
        { name: manifest.name, props: {}, revision: 1 },
        defaultViewport,
        'http://127.0.0.1:' + (server.address() as AddressInfo).port + path,
        { version },
      );
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(document);
    } else if (request.url === path + '/state') {
      json({
        kind: 'application',
        version,
        revision: 1,
        props: {},
        chatReadAllowed: allowed,
        textScale: null,
      });
    } else if (request.url === path + '/chat-read') {
      reads.push({ body, allowed, version });
      if (!allowed || body.version !== version) {
        json({ error: 'Denied' }, 403);
      } else {
        const revision = String(sequence).repeat(64);
        json(
          body.after === revision
            ? { changed: false, revision }
            : {
                changed: true,
                revision,
                status: 'running',
                truncated: false,
                messages: [
                  {
                    id: 'synthetic-row',
                    role: 'assistant',
                    source: 'assistant',
                    text: sequence === 1 ? 'Synthetic earlier history' : 'Synthetic streamed reply',
                    state: 'streaming',
                    truncated: false,
                  },
                ],
              },
        );
      }
    } else {
      json({ error: 'Not found' }, 404);
    }
  });
  context.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const template = await readFile(new URL('./read-ui.qml.in', import.meta.url), 'utf8');
  const qml = join(directory, 'tst_read_ui.qml');
  await writeFile(
    qml,
    template
      .replaceAll('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
      .replaceAll('@VIEW_URL@', origin + path)
      .replaceAll('@CONTROL_URL@', origin + '/control'),
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
          COMPANION_TEST_SESSION_SURFACE: 'html',
        },
        timeout: 90_000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /Totals: 3 passed, 0 failed/);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw Error([String(error), output.stdout, output.stderr].join('\n'));
  }
  assert.ok(reads.length > 0);
  assert.ok(reads.some((read) => read.body.after !== undefined));
  assert.ok(
    reads.every((read) =>
      Object.keys(read.body).every((key) => ['version', 'after'].includes(key)),
    ),
  );
  // Revocation can race an already admitted read; its service denial is valid.
  // No successor read may succeed using the predecessor's code version.
  assert.ok(!reads.some((read) => read.allowed && read.body.version !== read.version));
});
