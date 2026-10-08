// Opt-in compositor regression with its own socket, database, QML instance, and
// temporary F12 bindings. The real Companion instance and history stay intact.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PauseControl } from '../../src/core/pause-control.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { activeWindow } from '../../src/sensors/screen/capture.ts';
import { command } from '../../src/system/command.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';

assert.equal(process.env.COMPANION_TEST_NESTED, '1', 'Run through nested-hyprland.py');

const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
const directory = await mkdtemp(join(tmpdir(), 'companion-quick-tap-'));
const identity = `companion-test-${process.pid}`;
const socket = join(directory, 'control.sock');
const databasePath = join(directory, 'utterances.sqlite');
const adapter = process.env.COMPANION_TEST_ADAPTER
  ? pathToFileURL(process.env.COMPANION_TEST_ADAPTER + '/')
  : new URL('../../integrations/omarchy/', import.meta.url);
const runtime = new DesktopRuntime(new PauseControl(), () => {}, signal, {
  database: databasePath,
  captureStorage: CaptureStoragePolicy.enabledForTesting(),
  socket,
  preview: false,
  sounds: false,
});
const children: ReturnType<typeof spawn>[] = [];
const browserEditor = Boolean(process.env.COMPANION_TEST_PLAYWRIGHT);

async function evaluate(lua: string): Promise<void> {
  const reply = (await command('hyprctl', ['eval', lua], signal)).toString();
  assert.equal(reply.trim(), 'ok');
}

async function status(): Promise<{
  online: boolean;
  opened: boolean;
  count: number;
  panelOpened?: boolean;
  panelVisible?: boolean;
  panelMonitor?: string;
}> {
  const reply = await command(
    'qs',
    ['ipc', '-p', directory, 'call', 'companion', 'status'],
    signal,
  );
  return JSON.parse(reply.toString());
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) {
      return;
    }
    await delay(25, undefined, { signal });
  }
  assert.fail(
    'Timed out waiting for isolated desktop fixture: ' +
      JSON.stringify({
        status: await status().catch(() => null),
        fields: await text().catch(() => null),
      }),
  );
}

async function text(): Promise<{ A: string; B: string }> {
  return JSON.parse(await readFile(join(directory, 'text.json'), 'utf8'));
}

async function focus(address: string): Promise<void> {
  await evaluate(`hl.dispatch(hl.dsp.focus({ window = "address:${address}" }))`);
  await delay(100, undefined, { signal });
  assert.equal((await activeWindow(signal)).address, address);
}

function remember(id: number, utterance: string): void {
  runtime.activity.transcribed?.({
    id,
    observedAt: Date.now() + id,
    utterance,
    application: { app: 'fixture', address: '0x123', title: 'Synthetic speech' },
  });
  runtime.activity.intentRecognized?.(id, 'IGNORE');
  runtime.activity.outcome?.(id, 'ignored');
  runtime.activity.finished?.(id);
}

function launch(file: string, args: string[]): void {
  children.push(spawn(file, args, { stdio: ['ignore', 'ignore', 'inherit'] }));
}

// Modifier key events are essential: -M/-m alone only change a virtual keyboard's
// mask and do not reproduce physical key-down/up ordering in the compositor.
const pressModifiers = ['-P', 'Super_L', '-M', 'logo', '-P', 'Alt_L', '-M', 'alt'];
const press = [...pressModifiers, '-P', 'F12'];
const releaseV = ['-p', 'F12'];
const releaseAlt = ['-p', 'Alt_L', '-m', 'alt'];
const releaseSuper = ['-p', 'Super_L', '-m', 'logo'];
const latest = '-k Return; café — naïve! Ελληνικά 🙂\nNext\tfield';
const literal = latest.replace(/[\u0000-\u001f\u007f]/g, ' ');
let expected = '';

try {
  await runtime.start();
  remember(1, 'Older utterance.');
  remember(2, latest);

  // Run the actual QML and Lua sources under private identities. Only paths,
  // shortcut names, and the chord key are substituted for fixture isolation.
  const service = (await readFile(new URL('plugin/Service.qml', adapter), 'utf8'))
    .replaceAll('appid: "companion"', `appid: "${identity}"`)
    .replaceAll(
      'Quickshell.env("XDG_RUNTIME_DIR") + "/companion/control.sock"',
      JSON.stringify(socket),
    );
  const picker = (await readFile(new URL('plugin/HistoryPicker.qml', adapter), 'utf8')).replaceAll(
    'companion-history',
    identity,
  );
  // Preserve the production layout so SidePanel can import ../../panel. A/B
  // comparisons with older adapters still work: they have no panel to copy or
  // exercise. When present, use the selected adapter's own shared components.
  const pluginDirectory = join(directory, 'omarchy/plugin');
  await cp(new URL('plugin/', adapter), pluginDirectory, { recursive: true });
  let hasPanel = false;

  try {
    await access(new URL('plugin/SidePanel.qml', adapter));
    hasPanel = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (hasPanel) {
    await cp(new URL('../panel/', adapter), join(directory, 'panel'), { recursive: true });
  }

  await writeFile(join(pluginDirectory, 'Service.qml'), service);
  await writeFile(join(pluginDirectory, 'HistoryPicker.qml'), picker);
  await writeFile(
    join(directory, 'shell.qml'),
    'import Quickshell\nimport Quickshell.Hyprland\nimport "omarchy/plugin" as Companion\nShellRoot { property var activeWindow: Hyprland.activeToplevel; Companion.Service {} }\n',
  );
  await symlink('/usr/share/omarchy/shell/Commons', join(directory, 'Commons'));
  await symlink('/usr/share/omarchy/shell/Ui', join(directory, 'Ui'));

  let bindings = await readFile(new URL('bindings.lua', adapter), 'utf8');
  bindings = bindings
    .replaceAll('companion:', `${identity}:`)
    .replaceAll('companion-history', identity)
    .replaceAll('ALT + V', 'ALT + F12')
    .replaceAll('"V"', '"F12"')
    .replaceAll('"v"', '"F12"');

  // This compositor belongs to the fixture. Its entire process is discarded by
  // nested-hyprland.py, including dynamically removed navigation bindings.
  await writeFile(join(directory, 'bindings.lua'), bindings);
  await evaluate('hl.config({ input = { resolve_binds_by_sym = true } })');
  await evaluate(`dofile(${JSON.stringify(join(directory, 'bindings.lua'))})`);
  launch('qs', ['-p', directory]);
  await waitFor(async () => {
    const state = await status().catch(() => null);
    return state?.online === true && state.count === 2;
  });
  if (browserEditor) {
    launch(process.execPath, [
      fileURLToPath(new URL('./browser-field.mjs', import.meta.url)),
      directory,
    ]);
    await waitFor(async () => {
      // The browser child writes this only after creating its disposable pages.
      // An environment variable alone is not evidence that Chromium ran.
      const contents = await readFile(join(directory, 'editor.json'), 'utf8').catch(() => null);
      if (!contents) {
        return false;
      }
      const editor = JSON.parse(contents);
      assert.equal(editor.kind, 'chromium');
      console.log(`EDITOR Chromium ${editor.version}`);
      return true;
    });
  } else {
    launch('/usr/bin/python', [
      fileURLToPath(new URL('./text-field.py', import.meta.url)),
      directory,
    ]);
    console.log('EDITOR GTK 4');
  }
  let windows: { address: string; title: string }[] = [];
  await waitFor(async () => {
    const clients = JSON.parse((await command('hyprctl', ['-j', 'clients'], signal)).toString());
    // Chromium appends its application name to the document title.
    windows = clients.filter(
      (client: { title: string }) =>
        client.title.startsWith('Companion test ') && client.title.includes(directory),
    );
    return windows.length === 2;
  });
  const a = windows.find((window) => window.title.startsWith('Companion test A'))!;
  const b = windows.find((window) => window.title.startsWith('Companion test B'))!;
  await focus(a.address);

  // Establish that this editor accepts literal virtual-keyboard text before
  // involving shortcuts. A failure here is independent of release ordering.
  await command('wtype', ['--', literal], signal);
  expected = literal;
  await waitFor(async () => (await text()).A === expected);
  console.log('PASS direct typing baseline without shortcut modifiers');

  for (const hold of [0, 500]) {
    for (const order of ['v-first', 'modifiers-first']) {
      const releases =
        order === 'v-first'
          ? [...releaseV, '-s', '350', ...releaseAlt, '-s', '80', ...releaseSuper]
          : [...releaseSuper, '-s', '80', ...releaseAlt, ...releaseV];
      assert.equal((await activeWindow(signal)).address, a.address);
      await command(
        'wtype',
        [...press, ...(hold ? ['-s', String(hold)] : []), ...releases],
        signal,
      );
      expected += literal;
      await waitFor(async () => (await text()).A === expected);
      assert.equal((await status()).opened, false);
      console.log(`PASS ${hold} ms hold, ${order}, exact punctuation/Unicode and no Enter`);
    }
  }

  await command(
    'wtype',
    [...press, '-s', '200', '-k', 'Down', ...releaseV, ...releaseAlt, ...releaseSuper],
    signal,
  );
  expected += 'Older utterance.';
  await waitFor(async () => (await text()).A === expected);
  console.log('PASS held history selection');

  await command(
    'wtype',
    [...press, '-s', '200', '-k', 'Escape', ...releaseV, ...releaseAlt, ...releaseSuper],
    signal,
  );
  await delay(300, undefined, { signal });
  assert.equal((await text()).A, expected);
  console.log('PASS Escape cancellation');

  await command(
    'wtype',
    [
      ...press,
      '-s',
      '200',
      ...releaseV,
      '-s',
      '200',
      '-k',
      'Escape',
      ...releaseAlt,
      ...releaseSuper,
    ],
    signal,
  );
  await delay(300, undefined, { signal });
  assert.equal((await text()).A, expected);
  console.log('PASS Escape after V-up while modifiers remain held');

  const changingFocus = command(
    'wtype',
    [...press, '-s', '500', ...releaseV, ...releaseAlt, ...releaseSuper],
    signal,
  );
  await waitFor(async () => (await status()).opened);
  await focus(b.address);
  await changingFocus;
  await delay(350, undefined, { signal });
  assert.deepEqual(await text(), { A: expected, B: '' });
  console.log('PASS focus guard');

  await focus(a.address);
  const selecting = command(
    'wtype',
    [
      ...press,
      '-s',
      '200',
      '-k',
      'Down',
      '-k',
      'Up',
      '-s',
      '500',
      ...releaseAlt,
      ...releaseSuper,
      ...releaseV,
    ],
    signal,
  );
  await waitFor(async () => (await status()).opened);
  remember(3, 'New speech arriving during selection.');
  await selecting;
  expected += literal;
  await waitFor(async () => (await text()).A === expected);
  console.log('PASS Up navigation and frozen rows during new speech');

  if (hasPanel) {
    // Exercise the actual panel chord alongside held history. Cancelling the
    // history overlay must not deliver when its remaining modifiers go up.
    const panelChord = [...pressModifiers, '-k', 'c', ...releaseAlt, ...releaseSuper];
    await command('wtype', panelChord, signal);
    await waitFor(async () => (await status()).panelOpened === true);
    const openedPanel = await status();
    assert.equal(openedPanel.panelVisible, true);
    assert.ok(openedPanel.panelMonitor);
    assert.equal((await activeWindow(signal)).address, a.address);

    const historyBesidePanel = command(
      'wtype',
      [...press, '-s', '500', '-k', 'Escape', ...releaseV, ...releaseAlt, ...releaseSuper],
      signal,
    );
    await waitFor(async () => (await status()).opened);
    assert.equal((await status()).panelOpened, true);
    assert.equal((await status()).panelVisible, true);
    assert.equal((await activeWindow(signal)).address, a.address);
    await historyBesidePanel;
    assert.equal((await status()).opened, false);
    assert.equal((await status()).panelOpened, true);

    await command('wtype', panelChord, signal);
    await waitFor(async () => (await status()).panelVisible === false);

    await command(
      'wtype',
      [...press, '-s', '200', '-k', 'c', ...releaseV, ...releaseAlt, ...releaseSuper],
      signal,
    );
    await waitFor(async () => (await status()).panelOpened === true);
    assert.equal((await status()).opened, false);
    assert.deepEqual(await text(), { A: expected, B: '' });
    assert.equal((await activeWindow(signal)).address, a.address);
    console.log('PASS history alongside the panel, preserved focus, and safe panel toggling');

    // Cancellation alone cannot prove that history's release handlers survived
    // switching overlays. A subsequent chord must deliver the latest row once.
    await command('wtype', [...press, ...releaseV, ...releaseAlt, ...releaseSuper], signal);
    expected += 'New speech arriving during selection.';
    await waitFor(async () => (await text()).A === expected);
    assert.equal((await status()).panelOpened, true);
    assert.equal((await status()).panelVisible, true);
    await command('wtype', panelChord, signal);
    await waitFor(async () => (await status()).panelVisible === false);
    console.log('PASS history delivery with the activity panel still open');
  } else {
    console.log('SKIP panel cases: selected adapter predates the side panel');
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });

  // The final character can appear before wtype releases its last key, exits,
  // and records the result. Wait for delivery to settle before checking it.
  const pendingPastes = database.prepare(
    "SELECT count(*) AS count FROM paste_events WHERE outcome = 'pending'",
  );
  await waitFor(async () => pendingPastes.get()?.count === 0);

  const outcomes = database.prepare('SELECT outcome FROM paste_events ORDER BY rowid').all();
  assert.deepEqual(
    outcomes.map((row) => row.outcome),
    ['sent', 'sent', 'sent', 'sent', 'sent', 'skipped', 'sent', ...(hasPanel ? ['sent'] : [])],
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM utterances WHERE recognized_intent = 'IGNORE' AND outcome = 'ignored'",
      )
      .get()?.count,
    3,
  );
  database.close();
  console.log('PASS exactly-once delivery and unchanged original outcomes');
} finally {
  controller.abort();
  await runtime.close();
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }),
  );
  await rm(directory, { recursive: true, force: true });
}
