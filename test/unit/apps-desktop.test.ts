import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appBrowserArguments, browserEnvironment, openAppWindow } from '../../src/apps/desktop.ts';
import { AppRegistry, type RegisteredApp } from '../../src/apps/registry.ts';

/** The desktop window command, with a stand-in executable instead of Chromium. */

const app: RegisteredApp = {
  id: 'budget',
  registrationId: '00000000-0000-4000-8000-000000000001',
  name: 'Budget',
  upstream: 'http://127.0.0.1:8123',
  phoneAccess: false,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
};

test('the app window uses its own profile and never weakens the browser', () => {
  const argumentsList = appBrowserArguments(app, '/home/user/companion/apps/profiles/budget');

  assert.ok(argumentsList.includes('--user-data-dir=/home/user/companion/apps/profiles/budget'));
  assert.ok(argumentsList.includes('--app=http://127.0.0.1:8123/'));
  assert.ok(argumentsList.includes('--class=companion-app-budget'));

  const forbidden = [
    '--no-sandbox',
    '--disable-web-security',
    '--remote-debugging',
    '--load-extension',
    '--proxy',
    '--disable-site-isolation',
    '--allow-running-insecure-content',
    '--user-data-dir=/home/user/.config/chromium',
  ];
  for (const flag of forbidden) {
    assert.equal(
      argumentsList.some((argument) => argument.startsWith(flag)),
      false,
      flag,
    );
  }
});

test('the browser environment drops Companion and Chromium override variables', () => {
  const environment = browserEnvironment({
    WAYLAND_DISPLAY: 'wayland-1',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    COMPANION_WIDGET_TOKEN: 'secret',
    CHROME_DEVEL_SANDBOX: '/tmp/fake-sandbox',
    CHROMIUM_FLAGS: '--no-sandbox',
  });

  assert.deepEqual(environment, {
    WAYLAND_DISPLAY: 'wayland-1',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  });
});

test('opening refuses a profile that is not a private real directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-apps-desktop-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  const link = join(root, 'link');
  await symlink(target, link);
  await assert.rejects(openAppWindow(app, link, '/bin/false'), /symbolic link/);

  await chmod(target, 0o755);
  await assert.rejects(openAppWindow(app, target, '/bin/false'), /chmod 700/);
});

test('opening uses a private persistent profile and starts the browser detached', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-apps-desktop-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const record = join(root, 'arguments.txt');
  const fakeBrowser = join(root, 'fake-chromium');
  await writeFile(fakeBrowser, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
  await chmod(fakeBrowser, 0o755);

  const registry = new AppRegistry(join(root, 'apps'));
  const profile = await registry.prepareProfile(app);
  await openAppWindow(app, profile, fakeBrowser);

  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  assert.equal(profile, join(root, 'apps', 'profiles', `budget-${app.registrationId}`));

  const deadline = Date.now() + 5000;
  let recorded = '';
  while (recorded === '' && Date.now() < deadline) {
    recorded = await readFile(record, 'utf8').catch(() => '');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(recorded.trim().split('\n'), appBrowserArguments(app, profile));
});
