import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppRegistry, checkLaunch, parseUpstream } from '../../src/apps/registry.ts';

/** Registry persistence and validation, in temporary directories only. */

async function temporaryRegistry(context: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'companion-apps-registry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, registry: new AppRegistry(join(root, 'apps')) };
}

test('upstreams must be literal loopback addresses with an explicit port and no path', () => {
  assert.deepEqual(parseUpstream('http://127.0.0.1:8123'), {
    origin: 'http://127.0.0.1:8123',
    address: '127.0.0.1',
    port: 8123,
  });
  assert.equal(parseUpstream('http://[::1]:9000/').address, '::1');

  const refused = [
    'http://localhost:8123',
    'http://127.0.0.2:8123',
    'http://0x7f.0.0.1:8123',
    'http://2130706433:8123',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:8123/app',
    'http://127.0.0.1:8123/?x=1',
    'http://user@127.0.0.1:8123',
    'https://127.0.0.1:8123',
    'http://10.0.0.5:8123',
    'http://[::ffff:127.0.0.1]:8123',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const upstream of refused) {
    assert.throws(() => parseUpstream(upstream), Error, upstream);
  }
});

test('launch commands are absolute argv arrays with an absolute working directory', () => {
  assert.deepEqual(checkLaunch({ argv: ['/usr/bin/node', 'server.js'], cwd: '/tmp' }), {
    argv: ['/usr/bin/node', 'server.js'],
    cwd: '/tmp',
  });

  assert.throws(() => checkLaunch({ argv: ['node', 'server.js'], cwd: '/tmp' }));
  assert.throws(() => checkLaunch({ argv: [], cwd: '/tmp' }));
  assert.throws(() => checkLaunch({ argv: '/usr/bin/node server.js', cwd: '/tmp' }));
  assert.throws(() => checkLaunch({ argv: ['/usr/bin/node', 'a\0b'], cwd: '/tmp' }));
  assert.throws(() => checkLaunch({ argv: ['/usr/bin/node'], cwd: 'relative' }));
});

test('apps are stored privately, start without phone access and advance revisions', async (context) => {
  const { root, registry } = await temporaryRegistry(context);

  const added = await registry.add({
    id: 'budget',
    name: 'Budget',
    upstream: 'http://127.0.0.1:8123/',
    launch: { argv: ['/usr/bin/node', 'server.js', '--port', '8123'], cwd: root },
  });
  assert.equal(added.phoneAccess, false);
  assert.equal(added.revision, 1);
  assert.equal(added.upstream, 'http://127.0.0.1:8123');

  const directoryMode = (await stat(join(root, 'apps'))).mode & 0o777;
  const fileMode = (await stat(join(root, 'apps', 'registry.json'))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);

  const enabled = await registry.update('budget', { phoneAccess: true });
  assert.equal(enabled.phoneAccess, true);
  assert.equal(enabled.revision, 2);

  const disabled = await registry.update('budget', { phoneAccess: false });
  assert.equal(disabled.revision, 3);

  const withoutLaunch = await registry.update('budget', { launch: null });
  assert.equal(withoutLaunch.launch, undefined);
  assert.equal(withoutLaunch.revision, 4);

  // A second instance (another CLI process) reads the same durable state.
  const reread = await new AppRegistry(join(root, 'apps')).get('budget');
  assert.deepEqual(reread, withoutLaunch);

  await assert.rejects(
    registry.add({ id: 'budget', name: 'Again', upstream: 'http://127.0.0.1:9000' }),
    /already registered/,
  );
  await assert.rejects(
    registry.add({ id: 'Bad_ID', name: 'Bad', upstream: 'http://127.0.0.1:9000' }),
    /App ID/,
  );
  await assert.rejects(registry.update('missing', { phoneAccess: true }), /No app/);
});

test('removing an app keeps its browser profile and data', async (context) => {
  const { registry } = await temporaryRegistry(context);
  await registry.add({ id: 'notes', name: 'Notes', upstream: 'http://127.0.0.1:8124' });

  const profile = registry.profileDirectory('notes');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'marker'), 'kept');

  assert.equal(await registry.remove('notes'), true);
  assert.equal(await registry.remove('notes'), false);
  assert.equal(await readFile(join(profile, 'marker'), 'utf8'), 'kept');
  assert.deepEqual(await registry.list(), []);
});

test('an existing directory readable by others is refused, not repaired', async (context) => {
  const { root } = await temporaryRegistry(context);
  const directory = join(root, 'shared');
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);

  const registry = new AppRegistry(directory);
  await assert.rejects(
    registry.add({ id: 'x', name: 'X', upstream: 'http://127.0.0.1:8125' }),
    /chmod 700/,
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
});

test('hand-edited entries are validated when read', async (context) => {
  const { root, registry } = await temporaryRegistry(context);
  await registry.prepare();

  await writeFile(
    join(root, 'apps', 'registry.json'),
    JSON.stringify({
      version: 1,
      apps: [
        {
          id: 'evil',
          name: 'Evil',
          upstream: 'http://example.com:8080',
          phoneAccess: true,
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
  );

  await assert.rejects(registry.list(), /literal 127\.0\.0\.1/);
});

test('concurrent writers from separate instances do not lose registrations', async (context) => {
  const { root } = await temporaryRegistry(context);
  const directory = join(root, 'apps');

  await Promise.all(
    Array.from({ length: 6 }, (_unused, index) =>
      new AppRegistry(directory).add({
        id: `app-${index}`,
        name: `App ${index}`,
        upstream: `http://127.0.0.1:${9100 + index}`,
      }),
    ),
  );

  const ids = (await new AppRegistry(directory).list()).map((app) => app.id).sort();
  assert.deepEqual(ids, ['app-0', 'app-1', 'app-2', 'app-3', 'app-4', 'app-5']);
});
