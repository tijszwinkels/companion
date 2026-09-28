import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

/**
 * The real `bin/companion-app` executable against a temporary apps directory
 * and a temporary XDG_DATA_HOME, so no live registry or launcher is touched.
 * Options go before the command: everything after `--` is the app's argv.
 */

const run = promisify(execFile);
const executable = join(import.meta.dirname, '..', '..', 'bin', 'companion-app');

async function companionApp(
  root: string,
  argumentsList: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      executable,
      ['--apps-directory', join(root, 'apps'), ...argumentsList],
      {
        env: { ...process.env, XDG_DATA_HOME: join(root, 'share') },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

test('registers, toggles phone access and writes a launcher entry in temporary directories', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-apps-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const added = await companionApp(root, [
    'add',
    'notes',
    '--name',
    'Notes "100%"',
    '--upstream',
    'http://127.0.0.1:18931',
    '--cwd',
    root,
    '--',
    'node',
    'server.js',
    '; rm -rf /',
  ]);
  assert.equal(added.code, 0, added.stderr);
  const app = JSON.parse(added.stdout);
  assert.equal(app.phoneAccess, false);
  assert.ok(app.launch.argv[0].startsWith('/'), 'executable resolved to an absolute path');
  assert.deepEqual(app.launch.argv.slice(1), ['server.js', '; rm -rf /']);

  const enabled = await companionApp(root, ['phone', 'notes', 'on']);
  assert.match(enabled.stdout, /may now be opened from a paired phone/);
  const disabled = await companionApp(root, ['phone', 'notes', 'off']);
  assert.match(disabled.stdout, /no longer available on phones/);

  const refused = await companionApp(root, [
    'add',
    'other',
    '--name',
    'Other',
    '--upstream',
    'http://localhost:9000',
  ]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not a hostname/);

  const notRunning = await companionApp(root, ['open', 'notes']);
  assert.equal(notRunning.code, 1);
  assert.match(notRunning.stderr, /not running/);

  const entry = await companionApp(root, ['desktop-entry', 'notes']);
  assert.equal(entry.code, 0, entry.stderr);
  const desktopFile = await readFile(
    join(root, 'share', 'applications', 'companion-app-notes.desktop'),
    'utf8',
  );
  assert.match(desktopFile, /^\[Desktop Entry\]\nType=Application\nName=Notes "100%"\n/);
  assert.match(
    desktopFile,
    new RegExp(`\nExec="${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "open" "notes" `),
  );
  assert.match(desktopFile, /\nStartupWMClass=companion-app-notes\n/);

  const removed = await companionApp(root, ['remove', 'notes']);
  assert.match(removed.stdout, /browser profile .* and data were kept/);
});
