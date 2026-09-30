/**
 * The listener's opt-in `--phone` hook (src/remote/service/desktop-hook.ts)
 * against a fake `companion-phone`, and the listener's validation of the
 * flag. The fake records each call, with the behavior chosen per test:
 * success, failure, hanging, or a start that is still running at shutdown.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PhoneAccessHook } from '../../src/remote/service/desktop-hook.ts';

const run = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const preload = fileURLToPath(new URL('../fixtures/no-audio.cjs', import.meta.url));

interface FakePhone {
  executable: string;
  /** Stands in for the service: created by a (late) start, removed by stop. */
  unit: string;
  calls(): Promise<string[]>;
  lines: string[];
  hook(options?: {
    startMilliseconds?: number;
    stopMilliseconds?: number;
    graceMilliseconds?: number;
    settleMilliseconds?: number;
  }): PhoneAccessHook;
}

/**
 * A shell script standing in for companion-phone. START/STOP choose what
 * each command does: ok, fail, or hang (sleep until killed). Every step is
 * appended to `calls`, including a start that was terminated.
 */
async function fakePhone(
  context: { after(callback: () => Promise<void>): void },
  behavior: {
    start: 'ok' | 'fail' | 'hang' | 'stubborn' | 'escaped';
    stop: 'ok' | 'fail' | 'hang';
  },
): Promise<FakePhone> {
  const directory = await mkdtemp(join(tmpdir(), 'companion-phone-hook-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, 'calls');
  const unit = join(directory, 'unit');
  const executable = join(directory, 'companion-phone');
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      `echo "$1 begin" >> ${calls}`,
      `behavior=${behavior.start}`,
      `[ "$1" = stop ] && behavior=${behavior.stop}`,
      `trap 'echo "$1 terminated" >> ${calls}; kill $sleeper 2>/dev/null; exit 143' TERM`,
      'case $behavior in',
      // stop removes the stand-in service, as companion-phone stop would.
      `  ok) [ "$1" = stop ] && rm -f ${unit}; echo "companion-phone: $1 done"; exit 0 ;;`,
      '  fail) echo "companion-phone: $1 refused" >&2; exit 1 ;;',
      // A background sleep plus wait, so the TERM trap runs promptly.
      '  hang) sleep 60 >/dev/null 2>&1 & sleeper=$!; wait $sleeper; exit 0 ;;',
      // Ignores SIGTERM; a descendant in its process group (like systemd-run)
      // would create the service one second later unless it is killed too.
      `  stubborn) trap '' TERM; (sleep 1; touch ${unit}) >/dev/null 2>&1 & sleep 60 >/dev/null 2>&1 ; exit 0 ;;`,
      // Ignores SIGTERM, and its request has already left the process group
      // (like a start systemd accepted): the service appears one second later
      // whatever happens to the client.
      `  escaped) trap '' TERM; setsid sh -c 'sleep 1; touch ${unit}' >/dev/null 2>&1 & sleep 60 >/dev/null 2>&1 ; exit 0 ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const lines: string[] = [];
  return {
    executable,
    unit,
    lines,
    async calls() {
      try {
        return (await readFile(calls, 'utf8')).trim().split('\n');
      } catch {
        return [];
      }
    },
    hook(options = {}) {
      return new PhoneAccessHook({
        executable,
        log: (line) => lines.push(line),
        startTimeoutMilliseconds: options.startMilliseconds,
        stopTimeoutMilliseconds: options.stopMilliseconds,
        cancelGraceMilliseconds: options.graceMilliseconds,
        settleMilliseconds: options.settleMilliseconds,
      });
    },
  };
}

async function eventually(check: () => Promise<boolean>, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('start runs in the background and stop confirms phone access is off', async (context) => {
  const phone = await fakePhone(context, { start: 'ok', stop: 'ok' });
  const hook = phone.hook();

  hook.start();
  await eventually(async () => phone.lines.includes('companion-phone: start done'));
  assert.equal(await hook.stop(), true);

  assert.deepEqual(await phone.calls(), ['start begin', 'stop begin']);
  assert.ok(phone.lines.includes('companion-phone: stop done'));
});

test('a failed start is reported and leaves the desktop alone; stop still runs', async (context) => {
  const phone = await fakePhone(context, { start: 'fail', stop: 'ok' });
  const hook = phone.hook();

  hook.start();
  await eventually(async () =>
    phone.lines.some((line) => line.startsWith('Phone access did not start')),
  );
  assert.ok(phone.lines.includes('companion-phone: start refused'));
  assert.ok(phone.lines.some((line) => line.includes('(exit 1); the desktop is unaffected')));

  assert.equal(await hook.stop(), true);
  assert.deepEqual(await phone.calls(), ['start begin', 'stop begin']);
});

test('shutdown during a start terminates the start before stopping', async (context) => {
  const phone = await fakePhone(context, { start: 'hang', stop: 'ok' });
  const hook = phone.hook();

  hook.start();
  await eventually(async () => (await phone.calls()).includes('start begin'));
  assert.equal(await hook.stop(), true);

  assert.deepEqual(await phone.calls(), ['start begin', 'start terminated', 'stop begin']);
});

test('a failed or hanging stop is reported, bounded, and never throws', async (context) => {
  const failing = await fakePhone(context, { start: 'ok', stop: 'fail' });
  assert.equal(await failing.hook().stop(), false);
  assert.ok(
    failing.lines.some((line) =>
      line.startsWith('Phone access may still be on (companion-phone stop: exit 1)'),
    ),
  );

  const hanging = await fakePhone(context, { start: 'ok', stop: 'hang' });
  const started = Date.now();
  assert.equal(await hanging.hook({ stopMilliseconds: 300 }).stop(), false);
  assert.ok(Date.now() - started < 3000);
  assert.ok(hanging.lines.some((line) => line.includes('companion-phone stop: timed out')));
});

test('a start that overruns its time limit is cancelled and followed by a stop', async (context) => {
  const phone = await fakePhone(context, { start: 'hang', stop: 'ok' });
  phone.hook({ startMilliseconds: 300 }).start();
  await eventually(async () => (await phone.calls()).includes('stop begin'));
  assert.ok(phone.lines.includes('Phone access did not start in time; cancelling it'));
  assert.deepEqual(await phone.calls(), ['start begin', 'start terminated', 'stop begin']);
});

test('a start that ignores cancellation is killed with its whole process group', async (context) => {
  const phone = await fakePhone(context, { start: 'stubborn', stop: 'ok' });
  const hook = phone.hook({ graceMilliseconds: 200, settleMilliseconds: 1500 });

  hook.start();
  await eventually(async () => (await phone.calls()).includes('start begin'));
  assert.equal(await hook.stop(), true);
  assert.ok(phone.lines.includes('The phone access start did not stop in time; killing it'));

  // Its descendant died with it: the service never appears.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(lstat(phone.unit), { code: 'ENOENT' });
  assert.deepEqual(await phone.calls(), ['start begin', 'stop begin', 'stop begin']);
});

test('a start request that escaped the kill is caught by the settle stop', async (context) => {
  const phone = await fakePhone(context, { start: 'escaped', stop: 'ok' });
  const hook = phone.hook({ graceMilliseconds: 200, settleMilliseconds: 1500 });

  hook.start();
  await eventually(async () => (await phone.calls()).includes('start begin'));
  assert.equal(await hook.stop(), true);

  // It appeared after the first stop; the confirming stop removed it.
  await assert.rejects(lstat(phone.unit), { code: 'ENOENT' });
  assert.deepEqual(await phone.calls(), ['start begin', 'stop begin', 'stop begin']);
});

test('a missing companion-phone is reported, not thrown', async () => {
  const lines: string[] = [];
  const hook = new PhoneAccessHook({
    executable: '/nonexistent/companion-phone',
    log: (line) => lines.push(line),
  });
  hook.start();
  assert.equal(await hook.stop(), false);
  assert.ok(lines.some((line) => line.startsWith('Could not run /nonexistent/companion-phone')));
});

test('the listener accepts --phone only in ordinary listener mode, and documents it', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-phone-flag-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      asr: { workerBinary: '/nonexistent/asr-worker', modelDir: '/nonexistent/model' },
      vadModel: '/nonexistent/vad.onnx',
      llm: { baseUrl: 'http://127.0.0.1:1/v1' },
    }),
  );
  const listener = (args: string[]) =>
    run(
      process.execPath,
      ['--require', preload, '--import', 'tsx', 'src/cli.ts', '--config', configPath, ...args],
      {
        cwd: project,
        env: { ...process.env, PATH: '/nonexistent' },
        timeout: 10000,
      },
    );

  const { stdout } = await listener(['--help']);
  assert.match(stdout, /--phone +Opt-in/);

  for (const args of [
    ['--phone', '--no-desktop'],
    ['--phone', '--preview'],
    ['--phone', '--graph', 'json'],
    ['--phone', '--text', 'insert fixture'],
    ['--phone', '--wav', join(directory, 'missing.wav')],
  ]) {
    await assert.rejects(listener(args), (error: { stdout: string }) => {
      assert.match(error.stdout, /--phone requires ordinary listener mode with desktop control/);
      return true;
    });
  }
});
