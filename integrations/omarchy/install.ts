import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { command } from '../../src/system/command.ts';
import { assertShortcutsAvailable } from './shortcuts.ts';

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
const registered = (await command('hyprctl', ['-j', 'binds'], deadline)).toString();
assertShortcutsAvailable(registered, bindings.includes(bindingMarker));

// A QML-only update needs a plugin rescan, not a compositor configuration reload.
// Do not even rewrite the Lua file when unchanged: file watchers can reload it.
const installedBindingsPath = join(destination, 'bindings.lua');
const desiredBindings = await readFile(join(source, 'bindings.lua'), 'utf8');
let installedBindings = '';
try {
  installedBindings = await readFile(installedBindingsPath, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}
const bindingsChanged = desiredBindings !== installedBindings;
const reloadRequired = bindingsChanged || !bindings.includes(bindingMarker);

const backupSuffix = `.companion-backup-${Date.now()}`;
await mkdir(destination, { recursive: true });

// Qt caches dynamically created service components by URL. Give each source
// revision a stable, distinct URL so updates apply without restarting the shell.
// Preserve the source layout so relative imports also work in a checkout or an
// isolated test host. Shared panel content is deliberately outside Omarchy.
const integrationSource = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'omarchy/plugin/Service.qml',
  'omarchy/plugin/NativeBridge.qml',
  'panel/CollapsibleSection.qml',
  'panel/ActivityHistoryState.qml',
  'panel/ActivityHistoryView.qml',
  'panel/HistoryCard.qml',
  'omarchy/plugin/HistoryPicker.qml',
  'omarchy/plugin/PlaybackState.qml',
  'omarchy/plugin/BarWidget.qml',
  'omarchy/plugin/SidePanel.qml',
  'omarchy/plugin/ScreenshotWindow.qml',
  'omarchy/plugin/MonitorSelection.js',
  'panel/PanelContent.qml',
  'panel/PanelSurface.qml',
  'panel/ComposerFocus.qml',
  'panel/StatusView.qml',
  'panel/ActivityView.qml',
  'panel/IntentControls.qml',
  'panel/CodingDefaults.qml',
  'panel/ActivityStrip.qml',
  'panel/PhraseActivity.qml',
  'panel/AgentSessionState.qml',
  'panel/AgentChoices.qml',
  'panel/ModelPicker.qml',
  'panel/PanelAction.qml',
  'panel/SessionView.qml',
  'panel/HistoryRows.mjs',
  'panel/TimerControl.qml',
  'panel/ConversationMenu.qml',
  'panel/ToolDetails.qml',
  'panel/WidgetSurface.qml',
  'panel/NativeWidgetView.qml',
  // Native-window only and loaded by URL, like NativeWidgetView; the Omarchy
  // panel never enables it, but every shared panel type must be present.
  'panel/PanelBrowser.qml',
  'panel/PanelBrowserPolicy.mjs',
  'panel/Markdown.mjs',
  'panel/vendor/markdown-it.mjs',
  'panel/vendor/markdown-it.LICENSE',
  'panel/vendor/THIRD-PARTY-LICENSES.md',
  'panel/vendor/README.md',
  'panel/SessionTab.qml',
  'panel/PreviousSessionsView.qml',
  'panel/ScreenshotViewer.qml',
];
const hash = createHash('sha256');

for (const file of files) {
  hash.update(file);
  hash.update(await readFile(join(integrationSource, file)));
}

const revision = `code-${hash.digest('hex').slice(0, 12)}`;
await mkdir(join(destination, revision), { recursive: true });

for (const file of files) {
  const installedFile = join(destination, revision, file);
  await mkdir(dirname(installedFile), { recursive: true });
  await cp(join(integrationSource, file), installedFile);
}

const manifest = JSON.parse(await readFile(join(source, 'plugin/manifest.json'), 'utf8'));
manifest.entryPoints.service = `${revision}/omarchy/plugin/Service.qml`;
manifest.entryPoints.barWidget = `${revision}/omarchy/plugin/BarWidget.qml`;
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (bindingsChanged) {
  await writeFile(installedBindingsPath, desiredBindings);
}

if (!bindings.includes(bindingMarker)) {
  // JSON strings are also valid Lua strings for this path. Reject unusual paths
  // instead of turning a configuration path into executable Lua.
  const bindingFile = join(destination, 'bindings.lua');

  if (!/^[\w/ .-]+$/.test(bindingFile)) {
    throw Error('Unsupported characters in Omarchy configuration path');
  }

  await cp(bindingsPath, bindingsPath + backupSuffix);
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

const desiredShell = JSON.stringify(shell, null, 2) + '\n';
if (desiredShell !== shellContent) {
  // A UI-only reinstall must not accumulate identical backups or needlessly
  // trigger the shell's configuration watcher.
  await cp(shellPath, shellPath + backupSuffix);
  await writeFile(shellPath, desiredShell);
}
if (reloadRequired) {
  await command('hyprctl', ['reload'], deadline);
  const errors = (await command('hyprctl', ['configerrors'], deadline)).toString().trim();

  if (errors) {
    throw Error(`Hyprland config errors: ${errors}. Backups end in ${backupSuffix}`);
  }
}

await command('omarchy-shell', ['shell', 'rescanPlugins'], deadline);
console.log(`Installed Companion's Omarchy adapter at ${destination}`);
console.log('Run npm start in the Companion checkout to connect it.');
console.log('Super+Alt+C toggles the side panel; Super+Alt+V opens speech history.');
console.log('Super+Alt+P pauses or resumes listening.');
console.log('Inside the focused panel: Super+minus widens it; Super+equals narrows it.');
console.log(
  'Inside the focused panel: Super+Alt+0 selects Activity, Super+Alt+Tab cycles tabs, Alt+1–9 selects conversations.',
);
console.log(
  'Super+Alt+D toggles focus between the current Companion input and the previous application.',
);
