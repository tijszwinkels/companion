import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { screenshot } from '../helpers.ts';

// W2 through the real CLI assembly in --no-desktop mode: the listener's own
// startup loads the capture-storage choice and hands it to agent sessions.
// Only external programs are simulated: grim/hyprctl for the screenshot and
// the repository's scripted Pi RPC and Claude Code stream fixtures for the
// agents. homedir() points at a temporary directory; no model, provider,
// desktop, microphone or personal data is involved.

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function runNoDesktop(
  context: { after(callback: () => Promise<void>): void },
  options: { saved: boolean; prefix: 'new session' | 'new claude session' },
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-storage-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binaries = join(directory, 'bin');
  const companion = join(directory, 'companion');
  const agents = join(companion, 'agents');
  await mkdir(binaries);
  await mkdir(agents, { recursive: true, mode: 0o700 });

  // Redirect homedir() only in the child, before its ESM imports load.
  const preload = join(directory, 'fixture.cjs');
  await writeFile(
    preload,
    `require('node:os').homedir = () => process.env.COMPANION_TEST_DIRECTORY;
require('node:module').syncBuiltinESMExports();
`,
  );

  const window = {
    address: screenshot.window.address,
    class: screenshot.window.app,
    title: screenshot.window.title,
    at: [0, 0],
    size: [64, 64],
    monitor: 0,
    mapped: true,
    hidden: false,
  };
  const monitors = [{ id: 0, x: 0, y: 0, width: 640, height: 480, scale: 1, transform: 0 }];
  await writeFile(
    join(binaries, 'hyprctl'),
    `#!${process.execPath}
const action = process.argv.slice(2).join(' ');
if (action === '-j activewindow') {
  process.stdout.write(JSON.stringify(${JSON.stringify(window)}));
} else if (action === '-j monitors') {
  process.stdout.write(JSON.stringify(${JSON.stringify(monitors)}));
} else {
  throw Error('Unexpected desktop command: ' + action);
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(binaries, 'grim'),
    `#!${process.execPath}
process.stdout.write(Buffer.from('${screenshot.png.toString('base64')}', 'base64'));
`,
    { mode: 0o700 },
  );

  // Scripted agent programs, configured exactly like real ones.
  const pi = join(directory, 'fixture-pi');
  const claude = join(directory, 'fixture-claude');
  await copyFile(join(root, 'test/fixtures/pi-rpc.mjs'), pi);
  await copyFile(join(root, 'test/fixtures/claude-stream.mjs'), claude);
  await chmod(pi, 0o700);
  await chmod(claude, 0o700);
  await writeFile(
    join(agents, 'companion-agent.json'),
    JSON.stringify({
      ...defaultAgentSettings,
      executable: pi,
      claudeCode: { executable: claude, model: 'claude-opus-5-5', effort: 'high' },
    }),
  );

  if (options.saved) {
    await writeFile(
      join(companion, 'capture-storage.json'),
      JSON.stringify({ version: 1, enabled: true }) + '\n',
      { mode: 0o600 },
    );
  }

  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:1/v1' } }));

  const result = await execute(
    process.execPath,
    [
      '--require',
      preload,
      '--import',
      'tsx',
      'src/cli.ts',
      '--config',
      config,
      '--no-desktop',
      '--text',
      `${options.prefix} Synthetic screen question`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        COMPANION_TEST_DIRECTORY: directory,
        XDG_RUNTIME_DIR: join(directory, 'runtime'),
        XDG_STATE_HOME: join(directory, 'old-state'),
        PATH: `${binaries}:${process.env.PATH}`,
      },
      timeout: 20000,
    },
  );

  const sessions = join(agents, '.companion-sessions');
  const names = await readdir(sessions);
  const archives = names.filter((name) => name.endsWith('.json') && !name.includes('tool'));
  assert.equal(archives.length, 1, `One saved conversation: ${names.join(', ')}`);
  const conversation = JSON.parse(await readFile(join(sessions, archives[0]), 'utf8'));
  const request = JSON.parse(await readFile(join(agents, 'request.json'), 'utf8'));
  return { directory, companion, sessions, names, conversation, request, stdout: result.stdout };
}

for (const saved of [false, true]) {
  for (const prefix of ['new session', 'new claude session'] as const) {
    const harness = prefix === 'new session' ? 'Pi' : 'Claude Code';
    test(`W2: --no-desktop ${harness} conversation ${saved ? 'saves' : 'does not save'} its screenshot copy; the agent always gets it`, async (context) => {
      const run = await runNoDesktop(context, { saved, prefix });
      assert.match(
        run.stdout,
        saved ? /Saving captured audio and screenshots/ : /Captures are not saved/,
      );

      // L1: the live screenshot reached the scripted agent program either way.
      const base64 = screenshot.png.toString('base64');
      assert.ok(JSON.stringify(run.request).includes(base64), 'Agent received the screenshot');

      const question = run.conversation.messages[0];
      assert.equal(question.screenshot, true);
      const pngs = run.names.filter((name) => name.endsWith('.png'));
      if (saved) {
        assert.deepEqual(pngs, [`${run.conversation.id}.png`]);
        assert.deepEqual(await readFile(join(run.sessions, pngs[0])), screenshot.png);
        assert.equal(question.screenshotSaved, undefined);
      } else {
        assert.deepEqual(pngs, [], 'No conversation PNG copy');
        assert.equal(question.screenshotSaved, false);
        assert.deepEqual(
          run.names.filter((name) => name.includes('.tmp')),
          [],
          'No temporary file either',
        );
        // The missing preference is never created or repaired.
        await assert.rejects(readFile(join(run.companion, 'capture-storage.json')), {
          code: 'ENOENT',
        });
      }

      // Without the desktop there is no Activity history or recording tree.
      const companion = await readdir(run.companion);
      assert.equal(companion.includes('data'), false);
      assert.equal(companion.includes('asr-empty'), false);
    });
  }
}
