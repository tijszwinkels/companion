import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { libraryDirectory, WidgetRegistry } from '../../src/widgets/registry.ts';

const inside = 'export const marker = "INSIDE_SENTINEL";';
const outside = 'export const marker = "OUTSIDE_SENTINEL";';

async function fixture(context: TestContext) {
  const temporary = await mkdtemp('/tmp/companion-registry-race-');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const parent = join(temporary, 'parent');
  const library = join(parent, 'library');
  const directory = join(library, 'race');
  await cp(join(libraryDirectory, 'todo'), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, 'widget.json'), 'utf8'));
  manifest.name = 'race';
  await writeFile(join(directory, 'widget.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'widget.js'), inside);

  // Every possible symlink destination is another synthetic fixture. The
  // mutator never references a personal file, system file or browser process.
  const outsideParent = join(temporary, 'outside');
  const outsideDirectory = join(outsideParent, 'library', 'race');
  await cp(parent, outsideParent, { recursive: true });
  await writeFile(join(outsideDirectory, 'widget.js'), outside);
  const registry = new WidgetRegistry(join(temporary, 'cache'), library);
  return { temporary, parent, directory, outsideParent, outsideDirectory, registry };
}

test('registry rejects stable symlinks even when their destination is in the library', async (context) => {
  const { parent, directory, registry } = await fixture(context);
  const javascript = join(directory, 'widget.js');
  await rename(javascript, join(directory, 'shared.js'));
  await symlink('shared.js', javascript);
  await assert.rejects(registry.load('race'), { code: 'ELOOP' });
  await rm(javascript);
  await rename(join(directory, 'shared.js'), javascript);

  await rename(parent, parent + '.original');
  await symlink(parent + '.original', parent);
  await assert.rejects(registry.load('race'), /without symlinks/);
});

test('registry preserves UTF-8 content and rejects oversized and nonregular assets', async (context) => {
  const { directory, registry } = await fixture(context);
  const css = join(directory, 'style.css');
  const allowed = 'é'.repeat(32 * 1024);
  await writeFile(css, allowed);
  assert.equal((await registry.load('race')).css, allowed);
  await writeFile(css, allowed + 'x');
  await assert.rejects(registry.load('race'), /size limit/);
  await writeFile(css, Buffer.alloc(4 * 32 * 1024 + 1));
  await assert.rejects(registry.load('race'), /size limit/);
  await rm(css);
  await mkdir(css);
  await assert.rejects(registry.load('race'), /regular files/);
});

test('registry bounds bytes read when a regular file grows after fstat', async (context) => {
  const { directory, registry } = await fixture(context);
  const css = join(directory, 'style.css');
  await writeFile(css, 'x');
  const probe = await open(css, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const stat = prototype.stat;
  const read = prototype.read;
  const maximum = 4 * 32 * 1024;
  let growingDescriptor = -1;
  let bytesRead = 0;

  // Keep the real descriptor, fstat and reads. Interpose only to schedule an
  // author writing more bytes exactly after the loader's initial size check.
  context.mock.method(prototype, 'stat', async function (this: FileHandle) {
    const metadata = await stat.call(this);
    if ((await readlink(`/proc/self/fd/${this.fd}`)) === css) {
      growingDescriptor = this.fd;
      await writeFile(css, Buffer.alloc(maximum + 8192, 120));
    }
    return metadata;
  });
  context.mock.method(
    prototype,
    'read',
    async function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      const result = await read.call(this, buffer, offset, length, position);
      if (this.fd === growingDescriptor) {
        bytesRead += result.bytesRead;
      }
      return result;
    },
  );
  await assert.rejects(registry.load('race'), /size limit/);
  assert.equal(bytesRead, maximum + 1, 'read only the bound plus one overflow byte');
});

test('registry rejects a substituted FIFO without waiting for a writer', async (context) => {
  const { directory } = await fixture(context);
  const css = join(directory, 'style.css');
  await rm(css);
  await promisify(execFile)('mkfifo', [css]);
  // A child timeout bounds this regression even if O_NONBLOCK is accidentally
  // removed in the future. It only loads the temporary synthetic library.
  const source = `
    import { WidgetRegistry } from ${JSON.stringify(new URL('../../src/widgets/registry.ts', import.meta.url).href)};
    const registry = new WidgetRegistry(${JSON.stringify(join(directory, 'cache'))}, ${JSON.stringify(join(directory, '..'))});
    try { await registry.load('race'); process.exitCode = 1; }
    catch (error) { if (!/regular files/.test(error.message)) throw error; }
  `;
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { timeout: 3000 },
  );
});

test('registry releases anchored descriptors after success and each failure stage', async (context) => {
  const { temporary, directory, registry, outsideDirectory } = await fixture(context);
  const initialDescriptorCount = (await readdir('/proc/self/fd')).length;
  const openFixtureHandles = async () => {
    const targets = await Promise.all(
      (await readdir('/proc/self/fd')).map(async (fd) => {
        return readlink('/proc/self/fd/' + fd).catch(() => '');
      }),
    );
    return targets.filter((target) => target.startsWith(temporary + '/')).length;
  };
  const manifest = join(directory, 'widget.json');
  const original = await readFile(manifest, 'utf8');
  for (let iteration = 0; iteration < 8; iteration++) {
    await registry.load('race');
    assert.equal(await openFixtureHandles(), 0);
    await writeFile(manifest, '{');
    await assert.rejects(registry.load('race'));
    assert.equal(await openFixtureHandles(), 0);
    await writeFile(manifest, original);
  }
  await rm(join(directory, 'style.css'));
  await symlink(join(outsideDirectory, 'style.css'), join(directory, 'style.css'));
  await assert.rejects(registry.load('race'));
  assert.equal(await openFixtureHandles(), 0);
  await rename(directory, directory + '.original');
  await symlink(outsideDirectory, directory);
  await assert.rejects(registry.load('race'));
  assert.equal(await openFixtureHandles(), 0);
  // Include handles for / and /tmp, not just directories inside the fixture.
  assert.equal((await readdir('/proc/self/fd')).length, initialDescriptorCount);
});

for (const kind of ['asset', 'resolved asset', 'widget directory', 'library ancestor'] as const) {
  test(`registry containment under concurrent ${kind} symlink replacement`, async (context) => {
    const { parent, directory, outsideParent, outsideDirectory, registry } = await fixture(context);
    assert.equal((await registry.load('race')).javascript, inside);
    let target = join(directory, 'widget.js');
    let destination = join(outsideDirectory, 'widget.js');
    if (kind === 'resolved asset') {
      await rename(target, join(directory, 'slot.js'));
      await symlink('slot.js', target);
      target = join(directory, 'slot.js');
    } else if (kind === 'widget directory') {
      target = directory;
      destination = outsideDirectory;
    } else if (kind === 'library ancestor') {
      target = parent;
      destination = outsideParent;
    }

    let stop = false;
    let swaps = 0;
    let loaded = 0;
    let rejected = 0;
    let leaked = false;
    const parked = target + '.parked';
    const mutator = (async () => {
      while (!stop) {
        await rename(target, parked);
        try {
          await symlink(destination, target);
          swaps++;
          await setImmediate();
        } finally {
          await rm(target, { force: true });
          await rename(parked, target);
        }
        await setImmediate();
      }
    })();
    try {
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          for (let attempt = 0; attempt < 64 && !leaked; attempt++) {
            try {
              const bundle = await registry.load('race');
              loaded++;
              leaked ||= bundle.javascript.includes('OUTSIDE_SENTINEL');
            } catch {
              // A path absent or replaced by a symlink during authoring may fail.
              rejected++;
            }
          }
        }),
      );
    } finally {
      stop = true;
      await mutator;
    }
    context.diagnostic(`${swaps} swaps; ${loaded} loaded; ${rejected} rejected; leaked=${leaked}`);
    assert.ok(swaps > 0);
    assert.equal(leaked, false, 'a returned bundle must never include the outside sentinel');

    if (kind === 'resolved asset') {
      await rm(join(directory, 'widget.js'));
      await rename(target, join(directory, 'widget.js'));
    }
    assert.equal((await registry.load('race')).javascript, inside);
  });
}
