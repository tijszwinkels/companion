import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { WidgetRegistry } from '../../src/widgets/registry.ts';

/** Real guarded loader, synthetic files only; no browser or model is needed. */
test('application manifests allow only distinct bounded chat capability requests', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-chat-manifest-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const bundle = join(library, 'synthetic');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'widget.js'), 'export function describe() { return "Synthetic"; }');
  await writeFile(join(bundle, 'style.css'), '');
  const registry = new WidgetRegistry(join(directory, 'cache'), library);
  const manifest = {
    name: 'synthetic',
    version: 1,
    description: 'Synthetic manifest',
    parameters: { type: 'object' },
    actions: {},
    example: {},
  };
  async function load(application: unknown) {
    await writeFile(join(bundle, 'widget.json'), JSON.stringify({ ...manifest, application }));
    return registry.load('synthetic');
  }

  for (const capabilities of [
    undefined,
    [],
    ['chat.read'],
    ['chat.send'],
    ['chat.read', 'chat.send'],
  ]) {
    const result = await load({ capabilities });
    assert.deepEqual(result.manifest.application?.capabilities, capabilities);
  }
  for (const capabilities of [
    null,
    'chat.read',
    {},
    ['chat.read', 'chat.read'],
    ['draft.read'],
    ['chat.read', 'chat.send', 'chat.read'],
    [false],
    [null],
  ]) {
    await assert.rejects(load({ capabilities }), /Invalid application manifest block/);
  }
  for (const extra of [{ granted: true }, { trustedComposer: true }, { chatReadAllowed: true }]) {
    await assert.rejects(
      load({ capabilities: ['chat.read'], ...extra }),
      /Invalid application manifest block/,
    );
  }
});
