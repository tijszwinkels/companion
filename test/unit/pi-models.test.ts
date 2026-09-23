import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { piModels } from '../../src/agents/pi-models.ts';

// The executable speaks real line-delimited RPC but uses only synthetic models.
// It records argv locally so discovery cannot quietly acquire a saved session,
// enable tools/automatic extensions or send a prompt in a future refactor.
test('Pi model discovery uses bounded read-only RPC and returns only identifiers, pins and supported effort levels', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-models-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'pi-fixture');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('arguments.json', JSON.stringify(process.argv.slice(2)));
fs.writeSync(3, JSON.stringify({type: 'companion-model-pins', pinned: ['local/two', 'absent/model', 'local/two']}) + '\\n');
process.stdin.once('data', (data) => {
  const request = JSON.parse(data.toString());
  fs.writeFileSync('request.json', JSON.stringify(request));
  const response = JSON.stringify({type: 'response', id: request.id, success: true,
    data: {models: [{provider: 'configured', id: 'one', apiKey: 'synthetic-secret'},
      {provider: 'configured', id: 'one'}, {provider: 'local', id: 'two', reasoning: true, thinkingLevelMap: {off: null, xhigh: 'xhigh'}},
      {provider: 'invalid/provider', id: 'bad'}]}}) + '\\n';
  process.stdout.write(response.slice(0, 25));
  setTimeout(() => process.stdout.write(response.slice(25)), 5);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const catalog = await piModels(executable, directory, new AbortController().signal);
  assert.deepEqual(catalog.models, ['configured/one', 'local/two']);
  assert.deepEqual(catalog.pinned, ['local/two']);
  assert.deepEqual(
    { ...catalog.thinkingLevels },
    {
      'configured/one': ['off'],
      'local/two': ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
  );
  assert.ok(!JSON.stringify(catalog).includes('synthetic-secret'));
  const args = JSON.parse(await readFile(join(directory, 'arguments.json'), 'utf8'));
  assert.match(args[args.indexOf('--extension') + 1], /model-pins-extension\.ts$/);
  assert.equal(args.filter((arg: string) => arg === '--extension').length, 1);
  for (const flag of [
    '--offline',
    '--no-session',
    '--no-extensions',
    '--no-tools',
    '--no-approve',
  ]) {
    assert.ok(args.includes(flag));
  }
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')), {
    type: 'get_available_models',
    id: 'companion-models',
  });
  await assert.rejects(piModels(executable, directory, AbortSignal.abort()));
  await assert.rejects(
    piModels(join(directory, 'missing'), directory, new AbortController().signal),
    /start Pi/,
  );
});

test('Pi discovery reaps unresponsive and oversized synthetic children', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-model-process-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'pi-fixture');
  const pidPath = join(directory, 'pid');
  const prefix = `#!/usr/bin/env node
require('node:fs').writeFileSync('pid', String(process.pid));
`;
  await writeFile(executable, prefix + 'setInterval(() => {}, 1000);\n', { mode: 0o700 });
  const controller = new AbortController();
  const pending = piModels(executable, directory, controller.signal);
  // Read only this synthetic child's PID; never signal another process.
  let pid = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      pid = Number(await readFile(pidPath, 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(pid > 0);
  controller.abort();
  await assert.rejects(pending);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  await writeFile(
    executable,
    prefix +
      `process.stdout.write('x'.repeat(3 * 1024 * 1024));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  await assert.rejects(
    piModels(executable, directory, new AbortController().signal),
    /response limit/,
  );
  const oversizedPid = Number(await readFile(pidPath, 'utf8'));
  assert.throws(() => process.kill(oversizedPid, 0), { code: 'ESRCH' });
});

test('Pi discovery waits for fragmented pin metadata after the full catalog, and rejects malformed pins', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-pins-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'pi-fixture');
  const source = (metadata: string) => `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.once('data', data => {
  const request = JSON.parse(data.toString());
  process.stdout.write(JSON.stringify({type:'response', id:request.id, success:true, data:{models:[{provider:'configured', id:'one'}]}})+'\\n');
  const pins = ${JSON.stringify(metadata + '\n')};
  fs.writeSync(3, pins.slice(0, 8));
  setTimeout(() => fs.writeSync(3, pins.slice(8)), 15);
});
setInterval(() => {}, 1000);
`;
  await writeFile(
    executable,
    source(JSON.stringify({ type: 'companion-model-pins', pinned: ['configured/one'] })),
    { mode: 0o700 },
  );
  const catalog = await piModels(executable, directory, new AbortController().signal);
  assert.deepEqual(catalog.pinned, ['configured/one']);
  await writeFile(
    executable,
    source(JSON.stringify({ type: 'companion-model-pins', pinned: [{ id: 'one' }] })),
    { mode: 0o700 },
  );
  await assert.rejects(
    piModels(executable, directory, new AbortController().signal),
    /invalid pinned model data/,
  );
});
