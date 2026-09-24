import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  openRigTools,
  previewConfirmationRefusal,
  truncateHead,
} from '../../src/agents/claude/parity/openrig/openrig-tools.ts';

/** Calls recorded by the fake demo library below (it runs in this process). */
interface FakeCall {
  function: string;
  args: unknown[];
}

declare global {
  // eslint-disable-next-line no-var
  var openRigFakeCalls: FakeCall[];
  // eslint-disable-next-line no-var
  var openRigFakeImports: string[];
}

/**
 * A fake OpenRig demo checkout: `lib/tasks.mjs` and `lib/previews.mjs` with
 * the demo's exported functions. The fake queue keeps its own idempotency
 * rule (same id + same content → not created again; changed content →
 * refused), so the test can show the adapter passes both through unchanged.
 * Nothing contacts a real OpenRig instance or starts a preview.
 */
async function fakeDemo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'companion-openrig-fake-'));
  await mkdir(join(directory, 'lib'));

  await writeFile(
    join(directory, 'lib', 'tasks.mjs'),
    `
globalThis.openRigFakeImports.push('tasks');
const queue = new Map();
const record = (name, args) => globalThis.openRigFakeCalls.push({ function: name, args });

export async function submitTask(params, signal) {
  record('submitTask', [params, signal instanceof AbortSignal]);
  const existing = queue.get(params.id);
  if (existing) {
    if (existing.goal !== params.goal) {
      throw new Error('Task id already exists with different content; inspect it, then use a new id for new work');
    }
    return { created: false, item: existing };
  }
  queue.set(params.id, { qitemId: params.id, goal: params.goal, state: 'pending' });
  return { created: null, outcome: 'submitted-or-already-present', item: queue.get(params.id) };
}
export async function listTasks(signal) {
  record('listTasks', [signal instanceof AbortSignal]);
  return { items: [...queue.values()], limit: 100, possiblyMore: false };
}
export async function getTask(id, signal) {
  record('getTask', [id, signal instanceof AbortSignal]);
  return { item: queue.get(id) ?? null, transitions: [] };
}
export async function watchTask(id, seconds, signal) {
  record('watchTask', [id, seconds, signal instanceof AbortSignal]);
  return { item: { qitemId: id, state: 'done' }, transitions: [] };
}
`,
  );

  await writeFile(
    join(directory, 'lib', 'previews.mjs'),
    `
globalThis.openRigFakeImports.push('previews');
const record = (name, args) => globalThis.openRigFakeCalls.push({ function: name, args });

export async function preparePreview(id, ref, signal) {
  record('preparePreview', [id, ref, signal instanceof AbortSignal]);
  return { prepared: id, ref, lines: Array.from({ length: 800 }, (_, index) => 'line ' + index) };
}
export async function buildPreview(id, signal, onUpdate) {
  record('buildPreview', [id, signal instanceof AbortSignal, typeof onUpdate]);
  return { built: id };
}
export async function previewStatus(id) {
  record('previewStatus', [id]);
  return { id, running: false };
}
export async function startPreview() { throw new Error('the fake must never start a preview'); }
export async function stopPreview() { throw new Error('the fake must never stop a preview'); }
`,
  );

  return directory;
}

function call(
  tools: ReturnType<typeof openRigTools>,
  name: string,
  parameters: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name)!;
  return tool.execute('toolu_openrig', parameters, new AbortController().signal) as Promise<string>;
}

test('the OpenRig tools keep the demo’s names, order and required fields', () => {
  const tools = openRigTools({ directory: '/nonexistent' });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['openrig_submit', 'openrig_progress', 'openrig_preview'],
  );
  assert.deepEqual(tools[0].inputSchema.required, ['id', 'title', 'goal', 'acceptance']);
  assert.deepEqual(tools[2].inputSchema.required, ['action', 'id']);
  assert.match(tools[2].description, /Start\/stop require direct human confirmation/);
});

test('submissions and progress go to the demo library with its idempotency intact', async (context) => {
  globalThis.openRigFakeCalls = [];
  globalThis.openRigFakeImports = [];
  const directory = await fakeDemo();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tools = openRigTools({ directory });

  const task = {
    id: 'companion-synthetic-task',
    title: 'Synthetic',
    goal: 'Do a synthetic thing',
    acceptance: 'It is done',
  };
  const first = JSON.parse(await call(tools, 'openrig_submit', task));
  assert.equal(first.outcome, 'submitted-or-already-present');

  // Retrying the same id with the same content is not a second submission.
  const retry = JSON.parse(await call(tools, 'openrig_submit', task));
  assert.equal(retry.created, false);

  // The same id with different content is refused by the library.
  await assert.rejects(
    call(tools, 'openrig_submit', { ...task, goal: 'Something else' }),
    /already exists with different content/,
  );

  assert.equal(JSON.parse(await call(tools, 'openrig_progress', {})).items.length, 1);
  await assert.rejects(
    call(tools, 'openrig_progress', { watchSeconds: 5 }),
    /An id is required to watch/,
  );
  await call(tools, 'openrig_progress', { id: task.id });
  await call(tools, 'openrig_progress', { id: task.id, watchSeconds: 0 });
  await call(tools, 'openrig_progress', { id: task.id, watchSeconds: 30 });

  assert.deepEqual(
    globalThis.openRigFakeCalls.map((recorded) => recorded.function),
    ['submitTask', 'submitTask', 'submitTask', 'listTasks', 'getTask', 'getTask', 'watchTask'],
  );
  assert.deepEqual(globalThis.openRigFakeCalls[0].args, [task, true]);
  assert.deepEqual(globalThis.openRigFakeCalls[6].args, [task.id, 30, true]);

  // Result text is Pi's pretty JSON.
  const listed = await call(tools, 'openrig_progress', {});
  assert.ok(listed.startsWith('{\n  "items": ['));
  assert.deepEqual(globalThis.openRigFakeImports, ['tasks']);
});

test('preview start/stop are always refused without loading the demo', async (context) => {
  globalThis.openRigFakeCalls = [];
  globalThis.openRigFakeImports = [];
  const directory = await fakeDemo();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tools = openRigTools({ directory });

  for (const action of ['start', 'stop']) {
    await assert.rejects(call(tools, 'openrig_preview', { action, id: 'synthetic' }), (error) => {
      assert.equal((error as Error).message, previewConfirmationRefusal);
      return true;
    });
  }
  assert.deepEqual(globalThis.openRigFakeImports, []);
  assert.deepEqual(globalThis.openRigFakeCalls, []);
  assert.match(previewConfirmationRefusal, /direct human confirmation/);
  assert.match(previewConfirmationRefusal, /Nothing was started or stopped/);

  await assert.rejects(
    call(tools, 'openrig_preview', { action: 'prepare', id: 'synthetic' }),
    /ref is required/,
  );

  // A long result keeps its first 500 lines / 24 KB, then the notice.
  const prepared = await call(tools, 'openrig_preview', {
    action: 'prepare',
    id: 'synthetic',
    ref: 'feature/synthetic',
  });
  assert.equal(prepared.split('\n').length, 501);
  assert.ok(
    prepared.endsWith(
      '\n[Truncated; inspect the named task/preview through bin/demo or bin/rig for full output.]',
    ),
  );

  await call(tools, 'openrig_preview', { action: 'build', id: 'synthetic' });
  await call(tools, 'openrig_preview', { action: 'status', id: 'synthetic' });
  assert.deepEqual(globalThis.openRigFakeCalls, [
    { function: 'preparePreview', args: ['synthetic', 'feature/synthetic', true] },
    { function: 'buildPreview', args: ['synthetic', true, 'function'] },
    { function: 'previewStatus', args: ['synthetic'] },
  ]);
});

test('a missing demo checkout fails only the call', async () => {
  const tools = openRigTools({ directory: join(tmpdir(), 'companion-openrig-missing-demo') });
  await assert.rejects(
    call(tools, 'openrig_progress', {}),
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
  );
});

test('truncateHead keeps whole leading lines within 24 KB and 500 lines, like Pi', () => {
  assert.deepEqual(truncateHead('short'), { text: 'short', truncated: false });

  const manyLines = Array.from({ length: 600 }, () => 'x').join('\n');
  const byLines = truncateHead(manyLines);
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.text.split('\n').length, 500);

  const wideLines = Array.from({ length: 10 }, () => 'y'.repeat(5000)).join('\n');
  const byBytes = truncateHead(wideLines);
  assert.equal(byBytes.text.split('\n').length, 4);
  assert.ok(Buffer.byteLength(byBytes.text) <= 24000);

  // A first line over the byte limit leaves nothing, as in Pi.
  assert.deepEqual(truncateHead('z'.repeat(24001)), { text: '', truncated: true });

  // Multibyte characters count in UTF-8 bytes.
  const euros = truncateHead(['€'.repeat(7000), '€'.repeat(7000)].join('\n'));
  assert.equal(euros.text, '€'.repeat(7000));
});
