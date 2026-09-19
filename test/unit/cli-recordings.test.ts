import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { findArtifact } from '../desktop-fixture.ts';
import { screenshot } from '../helpers.ts';

test('--text records its screenshot by utterance UUID without an audio file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-cli-recordings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binaries = join(directory, 'bin');
  await mkdir(binaries);

  // Redirect homedir() only in the child process, before its ESM imports load.
  // This exercises the real CLI/default paths without reading personal history.
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

  // Only capture commands are simulated. The child runs its actual CLI, desktop
  // service, SQLite migration, prefix routing, file writer, and cleanup paths.
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
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:1/v1' } }));

  const execute = promisify(execFile);
  const utterance = 'insert Supplied text for evaluation';
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
      '--preview',
      '--text',
      utterance,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        COMPANION_TEST_DIRECTORY: directory,
        XDG_RUNTIME_DIR: join(directory, 'runtime'),
        XDG_STATE_HOME: join(directory, 'old-state'),
        PATH: `${binaries}:${process.env.PATH}`,
      },
      timeout: 10000,
    },
  );
  assert.match(result.stdout, /SEND_TEXT_TO_APPLICATION/);

  const storage = join(directory, 'companion');
  const database = new DatabaseSync(join(storage, 'utterances.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT * FROM utterances').all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.transcript, utterance);
    assert.equal(row.recognized_intent, 'SEND_TEXT_TO_APPLICATION');
    assert.equal(row.outcome, 'preview');
    assert.equal('screenshot_path' in row, false);
    assert.equal('audio_path' in row, false);
    const path = await findArtifact(storage, String(row.id), 'screenshots');
    assert.deepEqual(await readFile(path), screenshot.png);
    assert.deepEqual(await readdir(dirname(dirname(path))), ['screenshots']);
  } finally {
    database.close();
  }
});
