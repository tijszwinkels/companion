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

test(
  'a paired phone lists local apps and opens one top-level on its own origin',
  { skip },
  async (context) => {
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
    const browser = new TestBrowser();
    await browser.start();
    context.after(async () => {
      await browser.close();
      await fixture.close();
    });

    // Pair through the real UI.
    const panel = await browser.phone();
    await panel.navigate(`${fixture.origin}/`);
    await panel.waitFor(`document.querySelector('#code')`);
    const { code } = await fixture.devices.createPairingCode();
    await panel.tap('#code');
    await panel.type(code);
    await panel.tap('button[type=submit]');
    await panel.waitFor(`document.querySelector('.shell')`, 8000);

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
