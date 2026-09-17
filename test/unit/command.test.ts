import assert from 'node:assert/strict';
import test from 'node:test';
import { command } from '../../src/system/command.ts';

test(
  'cancelling a command kills and reaps the child before rejecting',
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    const pid = await command(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      controller.signal,
    );
    assert.ok(Number(pid.toString()) > 0);
    assert.throws(() => process.kill(Number(pid.toString()), 0), /ESRCH/);
    await assert.rejects(
      command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], AbortSignal.timeout(100)),
      /timeout/i,
    );
  },
);

test('missing executables and nonzero exits produce actionable errors', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(command('/nonexistent/companion-test', [], signal), /ENOENT/);
  await assert.rejects(
    command(
      process.execPath,
      ['-e', 'console.log("capture unavailable"); process.exit(1)'],
      signal,
    ),
    /capture unavailable/,
  );
});
