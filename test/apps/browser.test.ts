import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appBrowserArguments } from '../../src/apps/desktop.ts';
import { runApp, type RunResult } from '../../src/apps/launcher.ts';
import { AppProxy } from '../../src/apps/proxy.ts';
import { AppRegistry, type RegisteredApp } from '../../src/apps/registry.ts';
import { chromiumPath, HeadlessChromium, type Page } from './chromium.ts';

/**
 * Trusted local apps in real headless Chromium, with the synthetic CSV
 * notebook backend started by the real lifecycle code:
 *
 * - desktop: the exact per-app profile arguments, storage separation between
 *   app profiles, persistence across browser restarts, Chromium's sandbox;
 * - a CSV chosen through the browser's file chooser and imported durably;
 * - backend stop/restart with the page reconnecting and data retained;
 * - phone: grant → cookie → app through the proxy on synthetic `*.localhost`
 *   origins, sibling-app request forgery, and revocation.
 *
 * Temporary registry, profiles, data and loopback ports only. Headless
 * Chromium is not Safari, a real phone, Wayland or the user's desktop.
 */

const checkout = join(import.meta.dirname, '..', '..');
const tsx = join(checkout, 'node_modules', '.bin', 'tsx');
const fixtureApp = join(checkout, 'src', 'apps', 'demo', 'fixture-app.ts');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(chromiumPath);
    return undefined;
  } catch {
    return 'Chromium not installed';
  }
}

const skip = await prerequisites();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A running backend owned by the real lifecycle manager. */
interface Backend {
  stop(): Promise<RunResult>;
  done: Promise<RunResult>;
}

function startBackend(app: RegisteredApp): Promise<Backend> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const done = runApp(app, {
      signal: controller.signal,
      output: 'ignore',
      onReady: () =>
        resolve({
          done,
          stop: () => {
            controller.abort();
            return done;
          },
        }),
    });
    done.catch(reject);
  });
}

async function setup(context: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'companion-apps-browser-'));
  const registry = new AppRegistry(join(root, 'apps'));
  const cleanups: Array<() => Promise<unknown>> = [];

  context.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function register(id: string): Promise<RegisteredApp> {
    const port = await freePort();
    return registry.add({
      id,
      name: id,
      upstream: `http://127.0.0.1:${port}`,
      launch: {
        argv: [tsx, fixtureApp, '--port', String(port), '--data', join(root, `${id}-data`)],
        cwd: root,
      },
    });
  }

  async function backend(app: RegisteredApp): Promise<Backend> {
    const started = await startBackend(app);
    cleanups.push(() => started.stop());
    return started;
  }

  function browser(profileArguments: string[]): HeadlessChromium {
    const chromium = new HeadlessChromium(profileArguments);
    chromium.start();
    cleanups.push(() => chromium.close());
    return chromium;
  }

  /** The production desktop arguments, minus window-only flags headless cannot use. */
  async function desktopBrowser(app: RegisteredApp): Promise<HeadlessChromium> {
    const profile = await registry.prepareProfile(app);
    const profileArguments = appBrowserArguments(app, profile).filter(
      (argument) => !argument.startsWith('--app=') && !argument.startsWith('--ozone-platform'),
    );
    return browser(profileArguments);
  }

  return { root, registry, register, backend, browser, desktopBrowser, cleanups };
}

async function openNotebook(page: Page, origin: string): Promise<void> {
  await page.navigate(origin + '/');
  await page.waitFor(`document.querySelector('#status')?.dataset.state === 'connected'`);
  await page.waitFor(`document.body.dataset.datasets !== undefined`);
}

function visits(page: Page): Promise<string> {
  return page.evaluate<string>(`document.querySelector('#visits').textContent`);
}

function visitor(page: Page): Promise<string> {
  return page.evaluate<string>(`document.body.dataset.visitor`);
}

async function writeCsv(root: string, rows: number): Promise<string> {
  const lines = ['date,amount,description'];
  for (let index = 1; index <= rows; index++) {
    lines.push(
      `2026-01-${String((index % 28) + 1).padStart(2, '0')},${index}.50,synthetic ${index}`,
    );
  }

  const path = join(root, 'transactions.csv');
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

test('desktop app profiles are separate, persistent and sandboxed', { skip }, async (context) => {
  const { registry, register, backend, desktopBrowser } = await setup(context);
  const alpha = await register('alpha');
  const beta = await register('beta');
  await backend(alpha);
  await backend(beta);

  // Alpha in its own profile.
  let alphaBrowser = await desktopBrowser(alpha);
  let alphaPage = await alphaBrowser.page();
  await openNotebook(alphaPage, alpha.upstream);
  assert.equal(await visits(alphaPage), '1');
  const alphaVisitor = await visitor(alphaPage);
  assert.match(alphaVisitor, /^[0-9a-f-]{36}$/);

  // The browser sandbox is on for the exact production arguments.
  await alphaPage.navigate('chrome://sandbox');
  const sandbox = await alphaPage.evaluate<string>('document.body.innerText');
  assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/);
  assert.match(sandbox, /You are adequately sandboxed/);

  // Beta's profile sees nothing of alpha, even when it opens alpha's very origin.
  const betaBrowser = await desktopBrowser(beta);
  const betaPage = await betaBrowser.page();
  await openNotebook(betaPage, alpha.upstream);
  assert.equal(await visits(betaPage), '1');
  assert.notEqual(await visitor(betaPage), alphaVisitor);
  await openNotebook(betaPage, beta.upstream);
  assert.equal(await visits(betaPage), '1');

  // Closing and reopening alpha's window keeps its storage and cookies.
  await alphaBrowser.close();
  alphaBrowser = await desktopBrowser(alpha);
  alphaPage = await alphaBrowser.page();
  await openNotebook(alphaPage, alpha.upstream);
  assert.equal(await visits(alphaPage), '2');
  assert.equal(await visitor(alphaPage), alphaVisitor);

  // Profiles live in the private apps directory, one per app.
  assert.notEqual(registry.profileDirectory(alpha), registry.profileDirectory(beta));
});

test(
  'a CSV chosen in the file chooser is imported durably and survives a backend restart',
  { skip },
  async (context) => {
    const { root, register, backend, desktopBrowser, cleanups } = await setup(context);
    const app = await register('notebook');
    let running = await backend(app);

    const page = await (await desktopBrowser(app)).page();
    await openNotebook(page, app.upstream);
    const firstStart = await page.evaluate<string>('document.body.dataset.backendStartedAt');

    const csv = await writeCsv(root, 2500);
    await page.chooseFiles('#file', [csv]);
    await page.click('#upload');
    await page.waitFor(`document.querySelector('#result').textContent === 'Imported 2500 rows.'`);
    await page.waitFor(
      `document.querySelector('#log').textContent.includes('Imported transactions.csv')`,
    );
    await page.waitFor(`document.body.dataset.datasets === '1'`);

    const index = JSON.parse(await readFile(join(root, 'notebook-data', 'datasets.json'), 'utf8'));
    assert.equal(index.length, 1);
    assert.equal(index[0].rows, 2500);
    assert.deepEqual(index[0].columns, ['date', 'amount', 'description']);

    // Stop the backend: the page notices and keeps retrying.
    const stopped = await running.stop();
    assert.equal(stopped.stoppedByRequest, true);
    await page.waitFor(`document.querySelector('#status').dataset.state === 'reconnecting'`);

    // Start it again: the page reconnects by itself and the data is still there.
    running = await backend(app);
    cleanups.push(() => running.stop());
    await page.waitFor(`document.querySelector('#status').dataset.state === 'connected'`, 15_000);
    await page.waitFor(`document.body.dataset.backendStartedAt !== ${JSON.stringify(firstStart)}`);
    await page.waitFor(`document.body.dataset.datasets === '1'`);
  },
);

test(
  'a phone opens an app through a single-use grant and loses it on revocation',
  { skip },
  async (context) => {
    const { root, registry, register, backend, browser } = await setup(context);
    const notebook = await register('notebook');
    const other = await register('other');
    await registry.update('notebook', { phoneAccess: true });
    await registry.update('other', { phoneAccess: true });
    await backend((await registry.get('notebook'))!);
    const otherBackend = await backend((await registry.get('other'))!);

    const port = await freePort();
    const notebookOrigin = `http://notebook.localhost:${port}`;
    const otherOrigin = `http://other.localhost:${port}`;
    const paired = new Set(['phone-1']);

    const proxy = new AppProxy({
      host: '127.0.0.1',
      port,
      appOrigins: [
        ['notebook', notebookOrigin],
        ['other', otherOrigin],
      ],
      sources: { apps: () => registry.list(), pairedDeviceIds: async () => new Set(paired) },
      log: () => {},
      sweepMilliseconds: 60_000,
    });
    await proxy.start();
    context.after(() => proxy.close());

    const phoneProfile = await mkdtemp(join(root, 'phone-profile-'));
    const phoneBrowser = browser(['--user-data-dir=' + phoneProfile, '--no-first-run']);
    const phone = await phoneBrowser.page();

    // Before any grant: the app is not reachable.
    await phone.navigate(notebookOrigin + '/');
    assert.match(
      await phone.evaluate<string>('document.body.innerText'),
      /Open this app from Companion/,
    );

    // Grant → cookie → app. The fixture forbids framing; top-level opening works.
    const { url } = await proxy.openForDevice('phone-1', 'notebook');
    await phone.navigate(url);
    await phone.waitFor(`location.pathname === '/' && document.querySelector('#status')`);
    await phone.waitFor(`document.querySelector('#status').dataset.state === 'connected'`);
    assert.equal(await phone.evaluate<string>('document.cookie'), '');

    // The one-time grant URL was replaced in the tab's history before the app ran.
    const history = await phone.call('Page.getNavigationHistory');
    const visited = (history.entries as Array<{ url: string }>).map((entry) => entry.url);
    assert.equal(
      visited.some((url) => url.includes('__companion_app_grant')),
      false,
      visited.join(' '),
    );
    assert.equal(visited.at(-1), notebookOrigin + '/');

    // The same grant URL does not work twice (for example from history).
    const replay = await proxy.openForDevice('phone-1', 'notebook');
    const replayPage = await browser([
      '--user-data-dir=' + (await mkdtemp(join(root, 'p2-'))),
      '--no-first-run',
    ]).page();
    await replayPage.navigate(replay.url);
    await replayPage.waitFor(`document.querySelector('#status')`);
    await replayPage.navigate(replay.url);
    assert.match(await replayPage.evaluate<string>('document.body.innerText'), /expired/);

    // CSV upload through the phone's file chooser and the proxy; the backend's
    // own Origin/Host check passes because both are preserved.
    const csv = await writeCsv(root, 300);
    await phone.chooseFiles('#file', [csv]);
    await phone.click('#upload');
    await phone.waitFor(`document.querySelector('#result').textContent === 'Imported 300 rows.'`);

    // Also open the other app, so the phone holds sessions for both.
    const otherGrant = await proxy.openForDevice('phone-1', 'other');
    // Same phone browser, second tab: the phone now holds sessions for both apps.
    const otherPage = await phoneBrowser.page();
    await otherPage.navigate(otherGrant.url);
    await otherPage.waitFor(`document.querySelector('#status')?.dataset.state === 'connected'`);

    // From the notebook page, a sibling-origin state change is refused before
    // reaching the other backend (it would otherwise stop that backend).
    await phone.evaluate(
      `fetch(${JSON.stringify(otherOrigin + '/api/crash')}, { method: 'POST', mode: 'no-cors', credentials: 'include' }).catch(() => null)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillRunning = await Promise.race([
      otherBackend.done.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
    ]);
    assert.equal(stillRunning, true);

    // Revoke the phone: live WebSocket closes, reload shows the "open again" page.
    paired.delete('phone-1');
    await proxy.sweep();
    await phone.waitFor(`document.querySelector('#status').dataset.state === 'reconnecting'`);
    await phone.navigate(notebookOrigin + '/');
    assert.match(
      await phone.evaluate<string>('document.body.innerText'),
      /Open this app from Companion/,
    );
  },
);

test(
  'app pages reach other loopback services only as an ordinary web page would',
  { skip },
  async (context) => {
    const { register, backend, desktopBrowser } = await setup(context);
    const app = await register('alpha');
    await backend(app);

    // A synthetic stand-in for a privileged local service (like Companion's
    // gateway): bearer token plus exact Origin. And one careless service
    // that acts on any request. No real local port is probed.
    const actions = { protected: 0, careless: 0 };
    const service = createHttpServer((request, response) => {
      const url = request.url ?? '';
      if (url === '/protected') {
        const origin = request.headers.origin;
        const token = request.headers.authorization;
        if (token === 'Bearer stand-in-secret' && origin === `http://127.0.0.1:${port}`) {
          actions.protected += 1;
        }
      }
      if (url === '/careless') {
        actions.careless += 1;
      }
      response.end('ok');
    });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    const port = (service.address() as { port: number }).port;
    context.after(() => new Promise<void>((resolve) => service.close(() => resolve())));

    const page = await (await desktopBrowser(app)).page();
    const base = `http://127.0.0.1:${port}`;
    const probe = `(async () => {
      const result = {};
      try {
        await fetch('${base}/protected', { method: 'POST', mode: 'no-cors', body: 'x' });
        result.noCors = 'sent';
      } catch (error) { result.noCors = 'blocked'; }
      try {
        const reply = await fetch('${base}/protected', {
          method: 'POST',
          headers: { Authorization: 'Bearer guessed' },
          body: 'x',
        });
        result.cors = 'read ' + (await reply.text());
      } catch (error) { result.cors = 'blocked'; }
      try {
        await fetch('${base}/careless', { method: 'POST', mode: 'no-cors', body: 'x' });
        result.careless = 'sent';
      } catch (error) { result.careless = 'blocked'; }
      return result;
    })()`;

    // The fixture sends its own CSP (connect-src 'self'), which already stops
    // its page from contacting other local services.
    await openNotebook(page, app.upstream);
    const withAppCsp = await page.evaluate<Record<string, string>>(probe);
    assert.deepEqual(withAppCsp, { noCors: 'blocked', cors: 'blocked', careless: 'blocked' });
    assert.deepEqual(actions, { protected: 0, careless: 0 });

    // Model an app without such a CSP: only ordinary browser rules remain.
    await page.call('Page.setBypassCSP', { enabled: true });
    await openNotebook(page, app.upstream);
    const withoutCsp = await page.evaluate<Record<string, string>>(probe);

    // The protected service never acted: no token, and the credentialed
    // request needs a CORS preflight the service does not grant.
    assert.equal(withoutCsp.cors, 'blocked');
    assert.equal(actions.protected, 0);

    // Documented limit: a service that acts on credential-less simple
    // requests is reachable from any page on this computer, apps included.
    assert.equal(withoutCsp.careless, 'sent');
    assert.equal(actions.careless, 1);
  },
);
