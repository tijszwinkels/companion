import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runApp } from '../../src/apps/launcher.ts';
import { AppRegistry } from '../../src/apps/registry.ts';
import { freePort, remoteFixture } from '../remote-fixture.ts';
import { TestBrowser, TestPage, chromiumPath } from './browser.ts';

/**
 * The phone panel's Apps list against the real gateway, app proxy, listener
 * control socket (synthetic agent backend) and the synthetic CSV notebook
 * started by the real lifecycle code, in headless Chromium with phone
 * emulation. Temporary state and loopback ports only.
 *
 * Not covered: Safari's pop-up rules, real TLS host names or a real phone.
 */

const checkout = join(import.meta.dirname, '..', '..');
const appDirectory = join(checkout, 'integrations', 'mobile', 'dist');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(appDirectory, 'index.html'));
  } catch {
    return 'phone app not built (npm run mobile:build)';
  }
  try {
    await access(chromiumPath);
  } catch {
    return 'Chromium not installed';
  }
  return undefined;
}

const skip = await prerequisites();

type Context = { after(callback: () => Promise<unknown> | unknown): void };

/**
 * A running synthetic app with phone access, the gateway with its app proxy,
 * and a phone paired through the real UI. Every resource registers its
 * cleanup as soon as it exists.
 */
async function pairedPhoneWithApp(context: Context) {
  const root = await mkdtemp(join(tmpdir(), 'companion-mobile-apps-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  // The synthetic app, registered and started like a real one.
  const registry = new AppRegistry(join(root, 'apps'));
  const backendPort = await freePort();
  await registry.add({
    id: 'notebook',
    name: 'CSV notebook',
    upstream: `http://127.0.0.1:${backendPort}`,
    launch: {
      argv: [
        join(checkout, 'node_modules', '.bin', 'tsx'),
        join(checkout, 'src', 'apps', 'demo', 'fixture-app.ts'),
        '--port',
        String(backendPort),
        '--data',
        join(root, 'notebook-data'),
      ],
      cwd: root,
    },
  });
  const app = await registry.update('notebook', { phoneAccess: true });

  const stopBackend = new AbortController();
  const backendReady = new Promise<void>((resolve, reject) => {
    runApp(app, { signal: stopBackend.signal, output: 'ignore', onReady: resolve }).catch(reject);
  });
  context.after(() => stopBackend.abort());
  await backendReady;

  const appsPort = await freePort();
  const notebookOrigin = `http://notebook.localhost:${appsPort}`;
  const fixture = await remoteFixture({
    appDirectory,
    gateway: {
      apps: {
        host: '127.0.0.1',
        port: appsPort,
        origins: [['notebook', notebookOrigin]],
        registryDirectory: join(root, 'apps'),
      },
    },
  });
  context.after(() => fixture.close());
  // Registered before start, so a browser that fails to start is still reaped.
  const browser = new TestBrowser();
  context.after(() => browser.close());
  await browser.start();

  // Pair through the real UI.
  const panel = await browser.phone();
  await panel.navigate(`${fixture.origin}/`);
  await panel.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  await panel.tap('#code');
  await panel.type(code);
  await panel.tap('button[type=submit]');
  await panel.waitFor(`document.querySelector('.shell')`, 8000);

  return { fixture, browser, panel, notebookOrigin };
}

/** Sign out through the phone's Settings sheet, then pair again with a new code. */
async function signOutAndPairAgain(
  fixture: Awaited<ReturnType<typeof remoteFixture>>,
  panel: TestPage,
): Promise<void> {
  const clickButton = (text: string) =>
    panel.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );

  await panel.tap('button[aria-label="Phone settings"]');
  await panel.waitFor(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sign out…')`,
  );
  await clickButton('Sign out…');
  await clickButton('Sign out');
  await panel.waitFor(`document.querySelector('#code')`, 8000);

  const { code } = await fixture.devices.createPairingCode();
  await panel.tap('#code');
  await panel.type(code);
  await panel.tap('button[type=submit]');
  await panel.waitFor(`document.querySelector('.shell')`, 8000);
}

test(
  'a paired phone lists local apps and opens one top-level on its own origin',
  { skip },
  async (context) => {
    const { fixture, browser, panel, notebookOrigin } = await pairedPhoneWithApp(context);

    // The Apps button appears because the gateway offers an app.
    await panel.waitFor(`document.querySelector('button[aria-label="Apps"]')`, 8000);
    await panel.tap('button[aria-label="Apps"]');
    await panel.waitFor(`document.querySelector('button[aria-label="Open CSV notebook"]')`);
    assert.match(
      await panel.evaluate<string>(`document.querySelector('.sheet').textContent`),
      /CSV notebook.*Running/,
    );

    // Tapping Open opens a new top-level tab on the app's own origin.
    await browser.call('Target.setDiscoverTargets', { discover: true });
    const created = new Promise<string>((resolve) => {
      const stop = browser.on((message) => {
        if (
          message.method === 'Target.targetCreated' &&
          message.params.targetInfo.type === 'page' &&
          message.params.targetInfo.openerId === panel.targetId
        ) {
          stop();
          resolve(message.params.targetInfo.targetId);
        }
      });
    });
    await panel.tap('button[aria-label="Open CSV notebook"]');
    const targetId = await created;

    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
    const tab = new TestPage(browser, targetId, sessionId);
    await tab.call('Runtime.enable');
    await tab.waitFor(
      `location.origin === ${JSON.stringify(notebookOrigin)} && location.pathname === '/' && document.querySelector('#status')?.dataset.state === 'connected'`,
      10_000,
    );

    // The app tab has no way back to the panel and none of its storage.
    assert.equal(await tab.evaluate('window.opener === null'), true);
    const credentialKey = 'companion.remote.device';
    assert.equal(await panel.evaluate(`localStorage.getItem('${credentialKey}') !== null`), true);
    assert.equal(await tab.evaluate(`localStorage.getItem('${credentialKey}')`), null);
    assert.equal(await tab.evaluate('document.cookie'), '');
    assert.equal(await tab.evaluate('Object.keys(localStorage).includes("visits")'), true);

    // The panel stayed on the gateway origin with its session intact.
    assert.equal(await panel.evaluate('location.origin'), fixture.origin);
    assert.equal(await panel.evaluate(`Boolean(document.querySelector('.shell'))`), true);
    assert.deepEqual(panel.errors, []);
  },
);

test(
  'an app list answered after sign-out never replaces the list of the new pairing',
  { skip },
  async (context) => {
    const { fixture, panel, browser } = await pairedPhoneWithApp(context);
    await panel.waitFor(`document.querySelector('button[aria-label="Apps"]')`, 8000);

    // Hold every app-list request so their answers can be ordered by hand.
    const held: string[] = [];
    browser.on((message) => {
      if (message.sessionId === panel.sessionId && message.method === 'Fetch.requestPaused') {
        held.push(message.params.requestId);
      }
    });
    await panel.call('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/apps', requestStage: 'Request' }],
    });
    const nextHeld = async (): Promise<string> => {
      await panel.waitFor('true');
      const deadline = Date.now() + 8000;
      while (held.length === 0) {
        if (Date.now() > deadline) {
          throw Error('No app-list request was made');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return held.shift()!;
    };

    // 1. A list request from the first pairing is still in flight…
    await panel.tap('button[aria-label="Apps"]');
    const stale = await nextHeld();
    await panel.tap('.sheet button[aria-label="Close"]');

    // 2. …while the phone signs out and pairs again; the new pairing's list
    //    request is answered normally.
    await signOutAndPairAgain(fixture, panel);
    await panel.call('Fetch.continueRequest', { requestId: await nextHeld() });
    await panel.waitFor(`document.querySelector('button[aria-label="Apps"]')`, 8000);

    // 3. Only now does the old request answer, with a different list.
    const staleBody = JSON.stringify({
      apps: [
        { id: 'stale', name: 'Stale app', origin: 'http://stale.localhost:8790', running: true },
      ],
    });
    await panel.call('Fetch.fulfillRequest', {
      requestId: stale,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(staleBody).toString('base64'),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The sheet shows the list it already holds while its own refresh stays held.
    await panel.tap('button[aria-label="Apps"]');
    await nextHeld();
    await panel.waitFor(`document.querySelector('.sheet')`);
    const listed = await panel.evaluate<string>(`document.querySelector('.sheet').textContent`);
    assert.match(listed, /CSV notebook/);
    assert.doesNotMatch(listed, /Stale app/);

    await panel.call('Fetch.disable');
  },
);
