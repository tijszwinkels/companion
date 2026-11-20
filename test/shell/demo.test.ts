import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * `npm run shell:demo` (integrations/shell/demo.ts) stopped with Ctrl+C
 * (SIGINT) deletes its temporary directory, also when the signal arrives
 * while the demo is still starting. The demo runs as its own process with
 * TMPDIR pointing at a directory of this test, so its temporary directory
 * can be watched and nothing outside the test is touched. Requires
 * `npm run shell:build` (the demo refuses to start without the built shell).
 */

const root = join(import.meta.dirname, '..', '..');
const demo = join(root, 'integrations', 'shell', 'demo.ts');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(root, 'integrations', 'shell', 'dist', 'index.html'));
  } catch {
    return 'browser shell not built (npm run shell:build)';
  }
  return undefined;
}

const skip = await prerequisites();

/** A loopback port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(Error('No port'));
        }
      });
    });
  });
}

/** The demo's temporary directories inside `parent`. */
async function demoDirectories(parent: string): Promise<string[]> {
  const names = await readdir(parent);
  return names.filter((name) => name.startsWith('companion-shell-demo-'));
}

for (const moment of ['while it starts', 'after it started'] as const) {
  test(`Ctrl+C ${moment} deletes the demo's temporary data`, { skip }, async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'companion-demo-test-'));
    context.after(() => rm(parent, { recursive: true, force: true }));
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', demo, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, TMPDIR: parent },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    context.after(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    });

    // The temporary directory exists from early in the startup; the banner
    // with the pairing code is printed once everything runs.
    const deadline = Date.now() + 30_000;
    for (;;) {
      assert.ok(Date.now() < deadline, `the demo did not get going: ${output}`);
      if (moment === 'while it starts' && (await demoDirectories(parent)).length > 0) {
        break;
      }
      if (moment === 'after it started' && output.includes('Pairing code')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    if (moment === 'while it starts') {
      assert.ok(!output.includes('Pairing code'), 'still starting when interrupted');
    }
    child.kill('SIGINT');
    await exited;

    assert.deepEqual(await demoDirectories(parent), [], output);
  });
}
