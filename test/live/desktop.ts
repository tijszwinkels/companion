// Opt-in Omarchy integration check. Uses disposable GTK fields and a temporary
// database; never opens a microphone, calls an LLM, or writes real history.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PauseControl } from '../../src/core/pause-control.ts';
import { DesktopRuntime, desktopPaths } from '../../src/desktop/runtime.ts';
import { activeWindow } from '../../src/sensors/screen/capture.ts';
import { command } from '../../src/system/command.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';

const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
const directory = await mkdtemp(join(tmpdir(), 'companion-desktop-test-'));
const previous = await activeWindow(signal);
const bindingResolution = JSON.parse(
  (await command('hyprctl', ['-j', 'getoption', 'input:resolve_binds_by_sym'], signal)).toString(),
).bool;
const pause = new PauseControl();
const runtime = new DesktopRuntime(
  pause,
  (stage, text) => console.log(`${stage}: ${text}`),
  signal,
  {
    ...desktopPaths(),
    database: join(directory, 'utterances.sqlite'),
    captureStorage: CaptureStoragePolicy.enabledForTesting(),
    sounds: false,
    preview: false,
  },
);
let gui: ReturnType<typeof spawn> | undefined;
let guiClosed: Promise<void> | undefined;

async function status(): Promise<{
  online: boolean;
  opened: boolean;
  paused: boolean;
  count: number;
  error: string;
}> {
  return JSON.parse((await command('omarchy-shell', ['companion', 'status'], signal)).toString());
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) {
      return;
    }

    await delay(50, undefined, { signal });
  }

  const details = {
    shell: await status().catch(() => null),
    fields: await text().catch(() => null),
  };
  assert.fail(`Timed out waiting for desktop state: ${JSON.stringify(details)}`);
}

async function focus(address: string): Promise<void> {
  assert.match(address, /^0x[0-9a-f]+$/i);
  await command('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`], signal);
  await delay(120, undefined, { signal });
  assert.equal((await activeWindow(signal)).address, address);
}

async function text(): Promise<{ A: string; B: string }> {
  return JSON.parse(await readFile(join(directory, 'text.json'), 'utf8'));
}

function remember(id: number, utterance: string): void {
  runtime.activity.transcribed?.({
    id,
    observedAt: Date.now() + id,
    utterance,
    application: { app: 'fixture', address: '0x123', title: 'Ignored speech' },
  });
  runtime.activity.intentRecognized?.(id, 'IGNORE');
  runtime.activity.outcome?.(id, 'ignored');
  runtime.activity.finished?.(id);
}

try {
  // wtype supplies a synthetic keymap rather than physical keyboard keycodes.
  // Temporarily resolve symbols so it can exercise the installed global binding.
  await command(
    'hyprctl',
    ['eval', 'hl.config({ input = { resolve_binds_by_sym = true } })'],
    signal,
  );
  await runtime.start();
  remember(1, 'Older utterance.');
  remember(2, 'Latest utterance.');
  await waitFor(async () => {
    try {
      const state = await status();
      return state.online && state.count === 2;
    } catch {
      // The shell may still be finishing the installer's plugin hot reload.
      return false;
    }
  });

  gui = spawn(
    '/usr/bin/python',
    [fileURLToPath(new URL('./text-field.py', import.meta.url)), directory],
    { stdio: 'ignore' },
  );
  guiClosed = new Promise<void>((resolve) => gui!.once('close', () => resolve()));
  let windows: { address: string; title: string }[] = [];

  await waitFor(async () => {
    const clients = JSON.parse((await command('hyprctl', ['-j', 'clients'], signal)).toString());
    windows = clients.filter((client: { title: string }) => client.title.endsWith(directory));
    return windows.length === 2;
  });

  const a = windows.find((window) => window.title.startsWith('Companion test A'))!;
  const b = windows.find((window) => window.title.startsWith('Companion test B'))!;
  await focus(a.address);

  await command(
    'wtype',
    ['-M', 'logo', '-M', 'alt', '-P', 'v', '-m', 'alt', '-m', 'logo', '-p', 'v'],
    signal,
  );
  await waitFor(async () => (await text()).A === 'Latest utterance.');
  assert.equal((await status()).opened, false);
  console.log('PASS quick tap pastes the newest ignored utterance');

  await command(
    'wtype',
    [
      '-M',
      'logo',
      '-M',
      'alt',
      '-P',
      'v',
      '-s',
      '250',
      '-k',
      'Down',
      '-s',
      '100',
      '-p',
      'v',
      '-m',
      'alt',
      '-m',
      'logo',
    ],
    signal,
  );
  await waitFor(async () => (await text()).A === 'Latest utterance.Older utterance.');
  console.log('PASS hold, Down, release pastes the selected row');

  await command(
    'wtype',
    [
      '-M',
      'logo',
      '-M',
      'alt',
      '-P',
      'v',
      '-s',
      '150',
      '-k',
      'Escape',
      '-p',
      'v',
      '-m',
      'alt',
      '-m',
      'logo',
    ],
    signal,
  );
  await delay(300, undefined, { signal });
  assert.equal((await text()).A, 'Latest utterance.Older utterance.');
  console.log('PASS Escape cancels without typing');

  // The bar calls this same adapter method. Confirm that a socket round-trip
  // changes the backend and then updates the shell, rather than optimistic UI.
  await command('omarchy-shell', ['companion', 'togglePause'], signal);
  await waitFor(async () => (await status()).paused);
  assert.equal(pause.paused, true);
  await command('omarchy-shell', ['companion', 'togglePause'], signal);
  await waitFor(async () => !(await status()).paused);
  console.log('PASS pause/resume reaches Companion and updates the shell');

  // Move focus during the delay between release and delivery. Recovery should
  // not follow a different window or force the old window back into focus.
  await command(
    'wtype',
    ['-M', 'logo', '-M', 'alt', '-P', 'v', '-s', '100', '-p', 'v', '-m', 'alt', '-m', 'logo'],
    signal,
  );
  await focus(b.address);
  await delay(250, undefined, { signal });
  assert.deepEqual(await text(), { A: 'Latest utterance.Older utterance.', B: '' });
  console.log('PASS focus change suppresses recovery');

  const database = new DatabaseSync(join(directory, 'utterances.sqlite'), { readOnly: true });
  const pastes = database
    .prepare('SELECT outcome, target_application FROM paste_events ORDER BY attempted_at')
    .all();
  assert.deepEqual(
    pastes.map((row) => row.outcome),
    ['sent', 'sent', 'skipped'],
  );
  assert.ok(
    pastes.slice(0, 2).every((row) => row.target_application === 'org.companion.InputTest'),
  );
  assert.equal(pastes[2].target_application, null);
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM utterances WHERE recognized_intent = 'IGNORE' AND outcome = 'ignored'",
      )
      .get()?.count,
    2,
  );
  database.close();
  console.log('PASS SQLite preserves original decisions and linked recovery outcomes');

  await focus(a.address);
  const held = command(
    'wtype',
    [
      '-M',
      'logo',
      '-M',
      'alt',
      '-P',
      'v',
      '-s',
      '250',
      '-k',
      'Down',
      '-k',
      'Up',
      '-s',
      '400',
      '-m',
      'alt',
      '-m',
      'logo',
      '-p',
      'v',
    ],
    signal,
  );
  await waitFor(async () => (await status()).opened);
  remember(3, 'New speech arriving during selection.');
  await held;
  await waitFor(
    async () => (await text()).A === 'Latest utterance.Older utterance.Latest utterance.',
  );
  console.log('PASS Up navigation, frozen rows, and releasing modifiers before V');

  await command('wtype', ['--', 'v'], signal);
  await waitFor(async () => (await text()).A.endsWith('Latest utterance.v'));
  assert.equal((await status()).opened, false);
  console.log('PASS ordinary V input is unaffected');
} finally {
  await command('omarchy-shell', ['companion', 'cancel'], AbortSignal.timeout(2000)).catch(
    () => {},
  );
  controller.abort();
  await runtime.close();
  gui?.kill('SIGKILL');
  await guiClosed;
  await command(
    'hyprctl',
    [
      'eval',
      `hl.config({ input = { resolve_binds_by_sym = ${bindingResolution ? 'true' : 'false'} } })`,
    ],
    AbortSignal.timeout(2000),
  ).catch(() => {});
  await command(
    'hyprctl',
    ['dispatch', `hl.dsp.focus({ window = "address:${previous.address}" })`],
    AbortSignal.timeout(2000),
  ).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
