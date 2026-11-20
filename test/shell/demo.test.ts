import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * `npm run shell:demo` (integrations/shell/demo.ts) stopped with Ctrl+C
 * deletes its temporary directory, also when Ctrl+C comes while the demo is
 * still starting. Started exactly as a person would, through npm, in its own
 * process group; Ctrl+C is SIGINT to that whole group, as a terminal sends
 * it (npm, the tsx launcher and the demo all receive it). TMPDIR points at a
 * directory of this test, so the demo's temporary directory can be watched
 * and nothing outside the test is touched. Requires `npm run shell:build`
 * (the demo refuses to start without the built shell).
 */

const root = join(import.meta.dirname, '..', '..');

/** How long the demo may take to start, and to stop after Ctrl+C. */
const startMilliseconds = 30_000;
const stopMilliseconds = 20_000;

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
    const child = spawn('npm', ['run', 'shell:demo', '--', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, TMPDIR: parent },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const group = child.pid!;
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Whatever happens below, nothing of the demo outlives the test.
    context.after(() => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The group has already exited.
      }
    });

    // The temporary directory exists from early in the startup; the banner
    // with the pairing code is printed once everything runs.
    const deadline = Date.now() + startMilliseconds;
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
    process.kill(-group, 'SIGINT');

    // Stopped within the bound, with its temporary directory deleted. (npm
    // can exit before the demo has finished cleaning up, so the directory
    // is watched rather than the exit alone.)
    const stopDeadline = Date.now() + stopMilliseconds;
    let left = await demoDirectories(parent);
    while (left.length > 0 && Date.now() < stopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      left = await demoDirectories(parent);
    }
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, stopDeadline - Date.now()));
        // Not kept waiting for once the demo has exited.
        timer.unref();
      }),
    ]);
    assert.ok(stopped, `the demo did not stop after Ctrl+C: ${output}`);
    assert.deepEqual(left, [], output);
  });
}
