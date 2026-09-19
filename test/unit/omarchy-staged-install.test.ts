import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
const checkout = fileURLToPath(new URL('../../', import.meta.url));

/** Exercise the real installer against disposable config and inert commands. */
async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-installer-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const configuration = join(directory, 'config');
  const binaries = join(directory, 'bin');
  const callsPath = join(directory, 'calls.jsonl');
  const registeredPath = join(directory, 'registered.json');
  const bindingsPath = join(configuration, 'hypr/bindings.lua');
  const shellPath = join(configuration, 'omarchy/shell.json');
  const destination = join(configuration, 'omarchy/plugins/companion.desktop');

  await mkdir(binaries);
  await mkdir(join(configuration, 'hypr'), { recursive: true });
  await mkdir(join(configuration, 'omarchy'), { recursive: true });
  await writeFile(bindingsPath, '-- Existing user bindings\n');
  await writeFile(
    shellPath,
    JSON.stringify({
      version: 1,
      bar: { layout: { right: [{ id: 'existing.widget' }] } },
      plugins: [{ id: 'existing.plugin' }],
      customSetting: 'preserved',
    }),
  );
  await writeFile(registeredPath, '[]');
  await writeFile(callsPath, '');

  // Never invoke the installed desktop tools. Both executable names resolve to
  // this recorder, even on a developer machine with a running compositor.
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const call = [path.basename(process.argv[1]), ...process.argv.slice(2)];
fs.appendFileSync(process.env.COMPANION_INSTALL_CALLS, JSON.stringify(call) + '\\n');
if (call[0] === 'hyprctl' && call[1] === '-j') {
  process.stdout.write(fs.readFileSync(process.env.COMPANION_INSTALL_BINDS));
}
`;
  for (const name of ['hyprctl', 'omarchy-shell']) {
    await writeFile(join(binaries, name), stub, { mode: 0o700 });
  }

  return {
    bindingsPath,
    shellPath,
    destination,
    registeredPath,
    calls: async () => {
      const content = await readFile(callsPath, 'utf8');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    install: () =>
      execute(process.execPath, ['--import', 'tsx', 'integrations/omarchy/install.ts'], {
        cwd: checkout,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configuration,
          PATH: `${binaries}:${process.env.PATH}`,
          COMPANION_INSTALL_CALLS: callsPath,
          COMPANION_INSTALL_BINDS: registeredPath,
          HYPRLAND_INSTANCE_SIGNATURE: '',
          WAYLAND_DISPLAY: '',
        },
        timeout: 20000,
      }),
  };
}

test('staged install preserves config and reloads only when Lua integration changes', async (context) => {
  const setup = await fixture(context);
  await setup.install();

  const firstCalls = await setup.calls();
  assert.deepEqual(firstCalls, [
    ['hyprctl', '-j', 'binds'],
    ['hyprctl', 'reload'],
    ['hyprctl', 'configerrors'],
    ['omarchy-shell', 'shell', 'rescanPlugins'],
  ]);
  const shell = JSON.parse(await readFile(setup.shellPath, 'utf8'));
  assert.equal(shell.customSetting, 'preserved');
  assert.deepEqual(shell.bar.layout.right, [
    { id: 'companion.desktop' },
    { id: 'existing.widget' },
  ]);
  assert.deepEqual(shell.plugins, [{ id: 'existing.plugin' }, { id: 'companion.desktop' }]);

  const manifest = JSON.parse(await readFile(join(setup.destination, 'manifest.json'), 'utf8'));
  const revision = manifest.entryPoints.service.split('/')[0];
  for (const file of [
    'omarchy/plugin/Service.qml',
    'omarchy/plugin/PlaybackState.qml',
    'omarchy/plugin/ScreenshotWindow.qml',
    'panel/ComposerFocus.qml',
    'panel/AgentChoices.qml',
    'panel/ActivityStrip.qml',
    'panel/Markdown.mjs',
    'panel/vendor/markdown-it.mjs',
    'panel/vendor/markdown-it.LICENSE',
    'panel/PanelSurface.qml',
    'panel/ScreenshotViewer.qml',
    'panel/SessionTab.qml',
    'panel/PreviousSessionsView.qml',
  ]) {
    assert.ok((await stat(join(setup.destination, revision, file))).isFile());
  }

  const installedBindings = join(setup.destination, 'bindings.lua');
  const sourceBindings = await readFile(installedBindings, 'utf8');
  const oldTimestamp = new Date('2000-01-01T00:00:00Z');
  await utimes(installedBindings, oldTimestamp, oldTimestamp);
  const backups = async () =>
    (await Promise.all([setup.bindingsPath, setup.shellPath].map((path) => readdir(dirname(path)))))
      .flat()
      .filter((name) => name.includes('.companion-backup-'))
      .sort();
  const firstBackups = await backups();
  assert.equal(firstBackups.length, 2, 'First install preserves both changed configurations');
  await utimes(setup.bindingsPath, oldTimestamp, oldTimestamp);
  await utimes(setup.shellPath, oldTimestamp, oldTimestamp);
  await setup.install();
  assert.deepEqual(await backups(), firstBackups, 'Reinstall creates no duplicate backups');
  assert.equal((await stat(setup.bindingsPath)).mtimeMs, oldTimestamp.getTime());
  assert.equal((await stat(setup.shellPath)).mtimeMs, oldTimestamp.getTime());
  assert.deepEqual((await setup.calls()).slice(firstCalls.length), [
    ['hyprctl', '-j', 'binds'],
    ['omarchy-shell', 'shell', 'rescanPlugins'],
  ]);
  assert.equal((await stat(installedBindings)).mtimeMs, oldTimestamp.getTime());
  assert.deepEqual(JSON.parse(await readFile(setup.shellPath, 'utf8')), shell);
  const bindings = await readFile(setup.bindingsPath, 'utf8');
  assert.ok(bindings.startsWith('-- Existing user bindings\n'));
  assert.equal(bindings.split('-- Companion desktop integration').length, 2);

  // A later shortcut change must still reload and validate the compositor config.
  await writeFile(installedBindings, sourceBindings + '\n-- Previous revision\n');
  await setup.install();
  assert.equal((await setup.calls()).filter((call) => call[1] === 'reload').length, 2);
  assert.equal(await readFile(installedBindings, 'utf8'), sourceBindings);
});

test('staged install rejects a conflicting focus shortcut before writing config', async (context) => {
  const setup = await fixture(context);
  const beforeBindings = await readFile(setup.bindingsPath, 'utf8');
  const beforeShell = await readFile(setup.shellPath, 'utf8');
  await writeFile(
    setup.registeredPath,
    JSON.stringify([{ modmask: 72, key: 'SUPER + ALT + D', description: 'Existing action' }]),
  );

  await assert.rejects(setup.install(), /Super\+Alt\+D is already bound/);
  assert.equal(await readFile(setup.bindingsPath, 'utf8'), beforeBindings);
  assert.equal(await readFile(setup.shellPath, 'utf8'), beforeShell);
  await assert.rejects(stat(setup.destination), { code: 'ENOENT' });
  assert.deepEqual(await setup.calls(), [['hyprctl', '-j', 'binds']]);
});
