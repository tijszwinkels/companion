// Opt-in native focus regression. The parent runner owns a separate compositor;
// no real Companion socket, transcript, clipboard, microphone or model is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { command } from '../../src/system/command.ts';

assert.equal(process.env.COMPANION_TEST_NESTED, '1', 'Run through nested-hyprland.py --focus');
const signal = AbortSignal.timeout(20000);
const directory = await mkdtemp(join(tmpdir(), 'companion-panel-focus-'));
const identity = `companion-focus-${process.pid}`;
let shell: ReturnType<typeof spawn> | undefined;
let shellLog = '';
const clients = new Set<Socket>();
const backend = createServer((client) => {
  clients.add(client);
  client.on('close', () => clients.delete(client));
  client.on('error', () => {});
  client.on('data', () => {});
  client.write(
    JSON.stringify({
      type: 'state',
      protocol: 1,
      ready: true,
      paused: false,
      processing: 0,
      history: [],
      sessions: ['local-one', 'local-two'].map((id) => ({
        id,
        title: id,
        status: 'completed',
        error: '',
        messages: [],
      })),
    }) + '\n',
  );
});

interface FocusState {
  toggles: number;
  focused: string;
  phase: string;
  applicationActive: boolean;
  otherApplicationActive: boolean;
  applicationText: string;
  composerText: string;
}

async function state(): Promise<FocusState> {
  const result = await command('qs', ['ipc', '-p', directory, 'call', 'fixture', 'state'], signal);
  return JSON.parse(result.toString());
}

async function adapterState() {
  const result = await command(
    'qs',
    ['ipc', '-p', directory, 'call', 'companion', 'status'],
    signal,
  );
  return JSON.parse(result.toString()) as {
    online: boolean;
    panelOpened: boolean;
    selectedSessionId: string;
    composerFocusId: string;
  };
}

async function panelKey(key: string, superKey = true): Promise<void> {
  const modifiers = superKey ? ['-M', 'logo', '-M', 'alt'] : ['-M', 'alt'];
  const releases = superKey ? ['-m', 'alt', '-m', 'logo'] : ['-m', 'alt'];
  await command('wtype', [...modifiers, '-k', key, ...releases], signal);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) {
      return;
    }
    await delay(25, undefined, { signal });
  }
  assert.fail('Focus fixture timed out: ' + JSON.stringify(await state().catch(() => null)));
}

async function toggle(): Promise<void> {
  const previous = (await state()).toggles;
  await command(
    'wtype',
    [
      '-P',
      'Super_L',
      '-M',
      'logo',
      '-P',
      'Alt_L',
      '-M',
      'alt',
      '-k',
      'F10',
      '-p',
      'Alt_L',
      '-m',
      'alt',
      '-p',
      'Super_L',
      '-m',
      'logo',
    ],
    signal,
  );
  await waitFor(async () => (await state()).toggles === previous + 1);
}

try {
  await cp(
    new URL('../../integrations/omarchy/plugin/', import.meta.url),
    join(directory, 'omarchy/plugin'),
    { recursive: true },
  );
  await cp(new URL('../../integrations/panel/', import.meta.url), join(directory, 'panel'), {
    recursive: true,
  });

  // Compare the same native fixture with the committed timer-based regression.
  // Only the two focus implementation files change; fixture and input stay fixed.
  const reference = process.env.COMPANION_FOCUS_REF;
  if (reference) {
    for (const file of ['omarchy/plugin/SidePanel.qml', 'panel/ComposerFocus.qml']) {
      const source = await command('git', ['show', `${reference}:integrations/${file}`], signal);
      await writeFile(join(directory, file), source);
    }
  }

  const fixture = (
    await readFile(new URL('./panel-focus.qml', import.meta.url), 'utf8')
  ).replaceAll('FOCUS_FIXTURE_ID', identity);
  await writeFile(join(directory, 'shell.qml'), fixture);
  await symlink('/usr/share/omarchy/shell/Commons', join(directory, 'Commons'));
  await symlink('/usr/share/omarchy/shell/Ui', join(directory, 'Ui'));
  const bindings = `hl.config({ input = { resolve_binds_by_sym = true } }); hl.bind("SUPER + ALT + F10", hl.dsp.global("${identity}:focus"), { transparent = true })`;
  assert.equal((await command('hyprctl', ['eval', bindings], signal)).toString().trim(), 'ok');

  shell = spawn('qs', ['-p', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  shell.stdout?.on('data', (data: Buffer) => {
    shellLog += data.toString();
  });
  shell.stderr?.on('data', (data: Buffer) => {
    shellLog += data.toString();
  });
  await waitFor(async () => (await state().catch(() => null))?.composerText === '');

  // Leave the pointer over the ordinary application, outside the compact card.
  // follow_mouse=1 is essential: follow_mouse=0 hides the old 75ms focus loss.
  await command(
    'hyprctl',
    ['eval', 'hl.dispatch(hl.dsp.cursor.move({ x = 80, y = 180 }))'],
    signal,
  );
  await command(
    'hyprctl',
    ['eval', 'hl.dispatch(hl.dsp.focus({ window = "title:Companion focus fixture" }))'],
    signal,
  );
  await waitFor(async () => (await state()).applicationActive);
  await toggle();
  await delay(350, undefined, { signal });
  const focused = await state();
  console.log('After focus shortcut:', JSON.stringify(focused));
  assert.equal(focused.focused, 'fixture', 'Composer must retain focus beyond the old 75ms prime');
  assert.equal(focused.applicationActive, false);

  await command(
    'hyprctl',
    ['eval', 'hl.dispatch(hl.dsp.cursor.move({ x = 120, y = 220 }))'],
    signal,
  );
  await command('wtype', ['--', 'Inside the conversation.'], signal);
  await waitFor(async () => (await state()).composerText === 'Inside the conversation.');
  assert.equal((await state()).applicationText, '');

  // Copy through the focused composer, but inspect only this compositor's
  // private clipboard. The user's clipboard is on a different Wayland socket.
  await command('qs', ['ipc', '-p', directory, 'call', 'fixture', 'selectAnswer'], signal);
  await command('wtype', ['-M', 'ctrl', '-k', 'c', '-m', 'ctrl'], signal);
  assert.equal((await command('wl-paste', ['--no-newline'], signal)).toString(), 'useful');
  assert.equal((await state()).focused, 'fixture');

  await command('wtype', ['-M', 'alt', '-k', '2', '-m', 'alt'], signal);
  await waitFor(async () => (await state()).focused === 'fixture-two');
  await delay(350, undefined, { signal });
  assert.equal((await state()).focused, 'fixture-two');
  assert.equal((await state()).composerText, '');
  await command('wtype', ['--', 'Draft in the second conversation.'], signal);
  await waitFor(async () => (await state()).composerText === 'Draft in the second conversation.');
  await command('wtype', ['-M', 'alt', '-k', '1', '-m', 'alt'], signal);
  await waitFor(async () => (await state()).focused === 'fixture');
  assert.equal((await state()).composerText, 'Inside the conversation.');

  await toggle();
  await waitFor(async () => (await state()).applicationActive);
  await command('wtype', ['--', 'Back in the application.'], signal);
  await waitFor(async () => (await state()).applicationText === 'Back in the application.');
  assert.equal((await state()).composerText, 'Inside the conversation.');

  await command('qs', ['ipc', '-p', directory, 'call', 'fixture', 'closePanel'], signal);
  await delay(250, undefined, { signal });
  await toggle();
  await waitFor(async () => (await state()).focused === 'fixture');
  await delay(350, undefined, { signal });
  assert.equal((await state()).focused, 'fixture', 'A hidden panel must acquire stable focus too');
  await toggle();
  await waitFor(async () => (await state()).applicationActive);
  // Merely dropping layer focus can return to the last application by itself.
  // Wait for the explicit restore too before deliberately focusing another
  // window; otherwise its pending callback can undo this fixture's next step.
  await waitFor(async () => (await state()).phase === 'idle');
  // Move to a different window first, proving the production restore command
  // actually selects its captured address rather than relying on that fallback.
  await command(
    'hyprctl',
    ['eval', 'hl.dispatch(hl.dsp.focus({ window = "title:Companion other focus fixture" }))'],
    signal,
  );
  await waitFor(async () => (await state()).otherApplicationActive);
  await command('qs', ['ipc', '-p', directory, 'call', 'fixture', 'restoreApplication'], signal);
  await waitFor(async () => (await state()).applicationActive);

  // Connect the production Service to synthetic sessions in this compositor's
  // private runtime. Its real Lua adapter handles the otherwise desktop-owned
  // Super+Alt+Tab; ordinary Alt+numbers and Super+Alt+0 stay within Qt.
  await command('qs', ['ipc', '-p', directory, 'call', 'fixture', 'closePanel'], signal);
  const socketDirectory = join(process.env.XDG_RUNTIME_DIR!, 'companion');
  await mkdir(socketDirectory);
  backend.listen(join(socketDirectory, 'control.sock'));
  await once(backend, 'listening');
  await command(
    'hyprctl',
    ['eval', `dofile(${JSON.stringify(join(process.cwd(), 'integrations/omarchy/bindings.lua'))})`],
    signal,
  );
  await waitFor(async () => (await adapterState()).online);
  await command('qs', ['ipc', '-p', directory, 'call', 'companion', 'toggleComposerFocus'], signal);
  await waitFor(async () => (await adapterState()).composerFocusId === 'local-two');

  await panelKey('0');
  await waitFor(async () => (await adapterState()).selectedSessionId === '');
  await delay(150, undefined, { signal });
  assert.equal((await state()).applicationActive, false, 'Activity keeps native panel focus');
  assert.equal(
    (await adapterState()).composerFocusId,
    '',
    'Activity has no voice/text destination',
  );
  await panelKey('1', false);
  await waitFor(async () => (await adapterState()).composerFocusId === 'local-one');
  await panelKey('Tab');
  await waitFor(async () => (await adapterState()).composerFocusId === 'local-two');
  await panelKey('Tab');
  await waitFor(async () => (await adapterState()).selectedSessionId === '');
  await panelKey('Tab');
  await waitFor(async () => (await adapterState()).composerFocusId === 'local-one');
  await panelKey('9', false);
  assert.equal((await adapterState()).selectedSessionId, 'local-one', 'Missing numbers do nothing');

  await command('qs', ['ipc', '-p', directory, 'call', 'companion', 'toggleComposerFocus'], signal);
  await waitFor(async () => (await state()).applicationActive);
  for (const key of ['Tab', '0']) {
    await panelKey(key);
    assert.equal(
      (await adapterState()).selectedSessionId,
      'local-one',
      'An unfocused panel cannot receive navigation',
    );
  }
  await panelKey('2', false);
  assert.equal((await adapterState()).selectedSessionId, 'local-one');
  await command('qs', ['ipc', '-p', directory, 'call', 'companion', 'closePanel'], signal);
  await delay(250, undefined, { signal });
  await panelKey('Tab');
  assert.equal(
    (await adapterState()).panelOpened,
    false,
    'Local shortcuts cannot open a hidden panel',
  );
  console.log(
    'PASS: local Super+Alt+0/Tab and Alt+numbers, Activity focus, tab wrap, outside/hidden panel gating and focus return',
  );
  console.log(
    'PASS: held focus, private clipboard copy, numbered tabs/drafts, typed destinations, toggle back, and hidden-panel activation',
  );
} catch (error) {
  console.error(shellLog.slice(-6000));
  throw error;
} finally {
  // The parent discards the compositor and its binding. Never unbind an expired
  // Lua handle during cleanup, and never touch the user's compositor.
  if (shell && shell.exitCode === null) {
    const closed = new Promise<void>((resolve) => shell!.once('exit', () => resolve()));
    shell.kill('SIGTERM');
    await closed;
  }
  for (const client of clients) client.destroy();
  if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
