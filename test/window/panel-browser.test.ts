// In-panel browser regression (integrations/panel/PanelBrowser.qml).
//
// Drives the real component in the native test runner with offscreen Qt and
// real Chromium, against synthetic loopback HTTP and HTTPS fixtures on
// kernel-chosen ports. Every process gets a temporary HOME, so the persistent
// profile lives under that directory; no personal profile, account, live
// listener, gateway or desktop is used.
//
// The first runner process exercises navigation, refusals, the hidden toolbar
// and lifetime. A second process with the same HOME proves that cookies and
// site storage persisted on disk, while a default-profile view in the same
// process does not see them.
//
// Offscreen software rendering does not establish live Wayland focus, pointer
// hover on a real compositor, GPU behaviour or real-site login compatibility.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const build = resolve('native/window/build');
const evidence = join(build, 'artifacts');

// Everything the fixture pages requested, in order, for server-side checks.
type Visit = { path: string; cookie: string };

function page(title: string, body: string, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body { margin: 0; font: 16px sans-serif; } a.block { display: block; height: 120px; background: #cde; }</style>
</head><body>${body}<script>${script}</script></body></html>`;
}

// Loopback fixture site. Paths are described next to each branch.
function site(visits: Visit[]) {
  let reloads = 0;

  return (request: IncomingMessage, response: import('node:http').ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const path = url.pathname;

    visits.push({ path, cookie: request.headers.cookie ?? '' });
    response.setHeader('Cache-Control', 'no-store');

    if (path === '/') {
      // Sets a persistent cookie and site storage for the persistence check.
      response.setHeader('Set-Cookie', 'panel=persisted; Max-Age=86400; Path=/; SameSite=Lax');
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page(
          'Home',
          '<p>Home</p><a id="second" href="/second">Second</a>',
          "localStorage.setItem('panel', 'stored');",
        ),
      );
    } else if (path === '/second') {
      // Same-origin stylesheet, image and fetch: ordinary subresources.
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page(
          'Second',
          '<link rel="stylesheet" href="/style.css"><p id="styled">Second</p><img id="pixel" src="/pixel.svg">',
          `Promise.all([
             new Promise((done) => { const image = document.getElementById('pixel');
               if (image.complete) done(); else image.onload = image.onerror = done; }),
             fetch('/data.json').then((reply) => reply.json()),
           ]).then(([, data]) => {
             const image = document.getElementById('pixel');
             const color = getComputedStyle(document.getElementById('styled')).color;
             document.title = 'subresources ' + image.naturalWidth + ' ' + color + ' ' + data.value;
           });`,
        ),
      );
    } else if (path === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('#styled { color: rgb(1, 2, 3); }');
    } else if (path === '/pixel.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7"></svg>');
    } else if (path === '/data.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"value":"fetched"}');
    } else if (path === '/reload') {
      reloads++;
      response.setHeader('Content-Type', 'text/html');
      response.end(page('Reload ' + reloads, '<p>Reload counter</p>'));
    } else if (path === '/redirect') {
      response.writeHead(302, { Location: '/second' });
      response.end();
    } else if (path === '/redirect-public-http') {
      response.writeHead(302, { Location: 'http://example.invalid/' });
      response.end();
    } else if (path === '/redirect-file') {
      response.writeHead(302, { Location: 'file:///etc/hostname' });
      response.end();
    } else if (path === '/redirect-widget') {
      response.writeHead(302, { Location: 'companion-widget://view/document' });
      response.end();
    } else if (path === '/popup') {
      // A large target=_blank link, clicked with a real pointer event.
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page(
          'Popup',
          '<div style="height: 80px"></div><a class="block" id="blank" href="/popup-target" target="_blank">New tab</a>',
        ),
      );
    } else if (path === '/features') {
      // File input and download link, clicked with real pointer events.
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page(
          'Features',
          '<div style="height: 80px"></div>' +
            '<input id="file" type="file" style="display: block; width: 300px; height: 80px">' +
            '<a class="block" id="download" href="/download">Download</a>',
        ),
      );
    } else if (path === '/download') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.bin"');
      response.end('synthetic');
    } else if (path === '/counter') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page(
          '0',
          '<p>Counter</p>',
          'let ticks = 0; setInterval(() => { document.title = String(++ticks); }, 50);',
        ),
      );
    } else if (path === '/echo') {
      // Reports what this profile sends and stores, for isolation checks.
      response.setHeader('Content-Type', 'text/html');
      const cookie = JSON.stringify(request.headers.cookie ?? '');
      response.end(
        page(
          'Echo',
          '<p>Echo</p>',
          `document.title = 'cookie=' + ${cookie} + ' storage=' + localStorage.getItem('panel');`,
        ),
      );
    } else {
      response.statusCode = 404;
      response.end();
    }
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

// Chromium keeps idle connections open; close them so close() cannot hang.
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test(
  'panel browser navigates, refuses privileged features and persists its own profile',
  { timeout: 180000 },
  async () => {
    const directory = await mkdtemp('/tmp/companion-panel-browser-test-');
    const servers: Server[] = [];

    try {
      const runtime = join(directory, 'runtime');
      await mkdir(runtime, { mode: 0o700 });
      const env = {
        PATH: process.env.PATH,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, 'config'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        XDG_DATA_HOME: join(directory, 'data'),
        XDG_RUNTIME_DIR: runtime,
        QT_QPA_PLATFORM: 'offscreen',
        QT_QUICK_BACKEND: 'software',
        QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
        QML_IMPORT_PATH: join(build, 'qml'),
        LD_LIBRARY_PATH: join(build, 'staged/usr/lib'),
      };

      // A self-signed certificate that Chromium must refuse, never bypass.
      await execute(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-keyout',
          join(directory, 'key.pem'),
          '-out',
          join(directory, 'cert.pem'),
        ],
        { timeout: 20000, killSignal: 'SIGKILL' },
      );

      const visits: Visit[] = [];
      const http = createHttpServer(site(visits));
      servers.push(http);
      const origin = `http://127.0.0.1:${await listen(http)}`;

      const httpsVisits: Visit[] = [];
      const https = createHttpsServer(
        {
          key: await readFile(join(directory, 'key.pem')),
          cert: await readFile(join(directory, 'cert.pem')),
        },
        site(httpsVisits),
      );
      servers.push(https);
      const httpsOrigin = `https://127.0.0.1:${await listen(https)}`;

      const template = await readFile(new URL('./panel-browser.qml.in', import.meta.url), 'utf8');

      async function run(phase: 'first' | 'second', expected: RegExp) {
        const path = join(directory, `tst_panel_browser_${phase}.qml`);
        await writeFile(
          path,
          template
            .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
            .replaceAll('@ORIGIN@', JSON.stringify(origin))
            .replaceAll('@HTTPS_ORIGIN@', JSON.stringify(httpsOrigin))
            .replaceAll('@PHASE@', JSON.stringify(phase)),
        );
        let output = '';
        try {
          const result = await execute(
            'prlimit',
            [
              '--core=0',
              '--',
              join(build, 'companion-window-tests'),
              '-input',
              path,
              '-nocrashhandler',
            ],
            { env, timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
          );
          output = result.stdout + result.stderr;
          assert.match(result.stdout, expected);
        } catch (error) {
          output =
            output || [String(error), (error as any).stdout, (error as any).stderr].join('\n');
          throw Error(output, { cause: error });
        } finally {
          // Keep the runner output for failure analysis and review.
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, `panel-browser-${phase}.log`), output);
        }
      }

      await run('first', /Totals: \d+ passed, 0 failed, 1 skipped/);

      // Chromium created the named profile under the temporary data directory,
      // privately, and nowhere near widget, app or personal browser storage.
      const storage = join(
        directory,
        'data/companion-window-tests/QtWebEngine/companion-panel-browser',
      );
      const cache = join(
        directory,
        'cache/companion-window-tests/QtWebEngine/companion-panel-browser',
      );
      assert.equal((await stat(storage)).mode & 0o777, 0o700);
      assert.equal((await stat(cache)).mode & 0o777, 0o700);
      await assert.rejects(stat(join(directory, 'companion')), { code: 'ENOENT' });

      // Typed navigation, links, redirects and subresources reached the server.
      const paths = visits.map((visit) => visit.path);
      for (const expected of [
        '/',
        '/second',
        '/style.css',
        '/pixel.svg',
        '/data.json',
        '/redirect',
      ]) {
        assert.ok(paths.includes(expected), `${expected} was requested: ${paths.join(' ')}`);
      }
      // Two loads of /reload: the typed navigation and the toolbar reload.
      assert.equal(paths.filter((path) => path === '/reload').length, 2);
      // Refused pop-ups and downloads never produced a page or a file.
      assert.ok(!paths.includes('/popup-target'), paths.join(' '));
      await assert.rejects(stat(join(directory, 'Downloads/fixture.bin')), { code: 'ENOENT' });
      // The certificate was refused before any HTTPS request was served.
      assert.deepEqual(httpsVisits, []);

      const reached = visits.length;
      await run('second', /Totals: \d+ passed, 0 failed, \d+ skipped/);
      const echoes = visits.slice(reached).filter((visit) => visit.path === '/echo');
      assert.deepEqual(
        echoes.map((visit) => visit.cookie),
        ['panel=persisted', ''],
        'the panel profile sends its persisted cookie; a default-profile view does not',
      );
    } finally {
      for (const server of servers) {
        await close(server);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
