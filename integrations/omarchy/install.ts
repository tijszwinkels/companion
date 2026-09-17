import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { command } from '../../src/system/command.ts';

/** Install only this adapter. Existing layout entries and bindings are preserved. */
const source = fileURLToPath(new URL('./', import.meta.url));
const configuration = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const destination = join(configuration, 'omarchy/plugins/companion.desktop');
const bindingsPath = join(configuration, 'hypr/bindings.lua');
const shellPath = join(configuration, 'omarchy/shell.json');
const deadline = AbortSignal.timeout(15000);
const bindingMarker = '-- Companion desktop integration';
const bindings = await readFile(bindingsPath, 'utf8');
const shellContent = await readFile(shellPath, 'utf8');
const shell = JSON.parse(shellContent);

if (shell.version !== 1 || !Array.isArray(shell.bar?.layout?.right)) {
  throw Error('Expected Omarchy shell version 1 with a right bar section');
}

// Check the actual compositor, including packaged bindings not in the user file.
const registered = JSON.parse((await command('hyprctl', ['-j', 'binds'], deadline)).toString());
const conflict = registered.find((binding: { modmask: number; key: string }) => {
  return binding.modmask === 72 && binding.key.toLowerCase() === 'v';
});

if (conflict && !bindings.includes(bindingMarker)) {
  throw Error(`Super+Alt+V is already bound to ${conflict.description || 'another action'}`);
}

const backupSuffix = `.companion-backup-${Date.now()}`;
await cp(bindingsPath, bindingsPath + backupSuffix);
await cp(shellPath, shellPath + backupSuffix);
await mkdir(destination, { recursive: true });

// Qt caches dynamically created service components by URL. Give each source
// revision a stable, distinct URL so updates apply without restarting the shell.
const files = ['Service.qml', 'HistoryPicker.qml', 'BarWidget.qml'];
const hash = createHash('sha256');

for (const file of files) {
  hash.update(await readFile(join(source, 'plugin', file)));
}

const revision = `code-${hash.digest('hex').slice(0, 12)}`;
await mkdir(join(destination, revision), { recursive: true });

for (const file of files) {
  await cp(join(source, 'plugin', file), join(destination, revision, file));
}

const manifest = JSON.parse(await readFile(join(source, 'plugin/manifest.json'), 'utf8'));
manifest.entryPoints.service = `${revision}/Service.qml`;
manifest.entryPoints.barWidget = `${revision}/BarWidget.qml`;
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(join(source, 'bindings.lua'), join(destination, 'bindings.lua'));

if (!bindings.includes(bindingMarker)) {
  // JSON strings are also valid Lua strings for this path. Reject unusual paths
  // instead of turning a configuration path into executable Lua.
  const bindingFile = join(destination, 'bindings.lua');

  if (!/^[\w/ .-]+$/.test(bindingFile)) {
    throw Error('Unsupported characters in Omarchy configuration path');
  }

  await writeFile(
    bindingsPath,
    `${bindings.trimEnd()}\n\n${bindingMarker}\ndofile(${JSON.stringify(bindingFile)})\n`,
  );
}

const sections = Object.values(shell.bar.layout) as { id: string }[][];

if (!sections.some((section) => section.some((entry) => entry.id === 'companion.desktop'))) {
  shell.bar.layout.right.unshift({ id: 'companion.desktop' });
}

shell.plugins ??= [];

if (!shell.plugins.some((entry: { id: string }) => entry.id === 'companion.desktop')) {
  shell.plugins.push({ id: 'companion.desktop' });
}

await writeFile(shellPath, JSON.stringify(shell, null, 2) + '\n');
await command('hyprctl', ['reload'], deadline);
const errors = (await command('hyprctl', ['configerrors'], deadline)).toString().trim();

if (errors) {
  throw Error(`Hyprland config errors: ${errors}. Backups end in ${backupSuffix}`);
}

await command('omarchy-shell', ['shell', 'rescanPlugins'], deadline);
console.log(`Installed Companion's Omarchy adapter at ${destination}`);
console.log('Run npm start in the Companion checkout to connect it.');
