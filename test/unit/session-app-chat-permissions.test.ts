/** Deterministic permission races at the service boundary; no authored code executes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SessionApplications } from '../../src/session-apps/applications.ts';
import { SessionApplicationError } from '../../src/session-apps/errors.ts';
import { WidgetRegistry } from '../../src/widgets/registry.ts';
import type { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { deferred } from '../helpers.ts';

async function fixtureFor(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-chat-permissions-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const path = join(library, 'synthetic');
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'widget.json'),
    JSON.stringify({
      name: 'synthetic',
      version: 1,
      description: 'Synthetic',
      application: { capabilities: ['chat.read'] },
      parameters: { type: 'object' },
      actions: {},
      example: {},
    }),
  );
  await writeFile(join(path, 'widget.js'), '');
  await writeFile(join(path, 'style.css'), '');
  const registry = new WidgetRegistry(join(directory, 'bundles'), library);
  const bundle = await registry.load('synthetic');
  await registry.retain(bundle);
  const owner = randomUUID();
  const applicationId = randomUUID();
  await mkdir(join(directory, 'applications'));
  await writeFile(
    join(directory, 'applications', owner + '.json'),
    JSON.stringify({
      format: 1,
      id: applicationId,
      owner,
      name: 'synthetic',
      bundle: bundle.hash,
      version: 1,
      revision: 1,
      data: {},
      text: 'Synthetic',
      eventMode: 'next-input',
      receipts: [],
      batches: [],
      updatedAt: 1,
    }),
  );

  let queue: Promise<unknown> = Promise.resolve();
  let reads = 0;
  let now = 0;
  const service = new SessionApplications(
    directory,
    {
      registry,
      // No code execution: only unload calls discard in these policy tests.
      renderer: { discard: async () => {} } as unknown as WidgetRenderer,
      origin: async () => 'http://127.0.0.1:1234',
      check: () => {},
      serialized(_owner, task) {
        const result = queue.then(task);
        queue = result.catch(() => {});
        return result;
      },
    },
    {
      changed: () => {},
      userEdit: () => {},
      readChat: () => {
        reads++;
        return { changed: false, revision: 'a'.repeat(64) };
      },
    },
    () => now,
  );
  context.after(() => service.close());

  async function descriptor() {
    const value = await service.descriptor(owner);
    assert.ok(value?.viewUrl && value.chatAccess);
    return value;
  }
  async function command(allowed: boolean) {
    const value = await descriptor();
    return { applicationId, version: value.version, revision: value.chatAccess!.revision, allowed };
  }
  return {
    service,
    owner,
    descriptor,
    command,
    reads: () => reads,
    advance() {
      now += 300;
    },
    hold() {
      const gate = deferred<void>();
      queue = queue.then(() => gate.promise);
      return gate;
    },
  };
}

const denied = (error: unknown) => error instanceof SessionApplicationError && error.status === 403;

test('revocation during a request body wait is rechecked before reading canonical text', async (context) => {
  const fixture = await fixtureFor(context);
  const { service, owner } = fixture;
  await service.setChatRead(owner, await fixture.command(true));
  const descriptor = await fixture.descriptor();
  const entered = deferred<void>();
  const body = deferred<Record<string, unknown>>();
  const pending = service.view(owner, descriptor.viewUrl!.slice(-64), 'chat-read', 'POST', () => {
    entered.resolve();
    return body.promise;
  });
  await entered.promise;
  await service.setChatRead(owner, await fixture.command(false));
  body.resolve({ version: 1 });
  await assert.rejects(pending, denied);
  assert.equal(fixture.reads(), 0, 'Denied reads must not even obtain the source projection');
});

test('a body from an old view cannot read after close/reopen and a fresh grant', async (context) => {
  const fixture = await fixtureFor(context);
  const { service, owner } = fixture;
  await service.setChatRead(owner, await fixture.command(true));
  const old = await fixture.descriptor();
  const entered = deferred<void>();
  const body = deferred<Record<string, unknown>>();
  const pending = service.view(owner, old.viewUrl!.slice(-64), 'chat-read', 'POST', () => {
    entered.resolve();
    return body.promise;
  });
  await entered.promise;
  await service.unload(owner);
  const reopened = await fixture.descriptor();
  assert.notEqual(reopened.viewUrl, old.viewUrl);
  await service.setChatRead(owner, await fixture.command(true));
  body.resolve({ version: 1 });
  await assert.rejects(pending, denied);
  assert.equal(fixture.reads(), 0);
});

test('trusted view validity is checked again after a queued permission confirmation', async (context) => {
  const fixture = await fixtureFor(context);
  const command = await fixture.command(true);
  const gate = fixture.hold();
  let visible = true;
  const pending = fixture.service.setChatRead(fixture.owner, command, () => {
    if (!visible) {
      throw Error('Trusted view is no longer shown');
    }
  });
  visible = false;
  gate.resolve();
  await assert.rejects(pending, /no longer shown/);
  assert.equal((await fixture.descriptor()).chatAccess!.read, false);
});

test('agent ingress cannot grant or read chat, even with valid-looking permission fields', async (context) => {
  const fixture = await fixtureFor(context);
  for (const method of ['app_set_chat_read', 'app_chat_read', 'app_grant']) {
    await assert.rejects(
      fixture.service.agent(
        fixture.owner,
        undefined,
        {
          ...(await fixture.command(true)),
          method,
        },
        new AbortController().signal,
      ),
      /Unknown application method/,
    );
  }
  assert.equal((await fixture.descriptor()).chatAccess!.read, false);
  assert.equal(fixture.reads(), 0);
});

test('raw read requests are rate-bounded and revocation wins over the cooldown', async (context) => {
  const fixture = await fixtureFor(context);
  const { service, owner } = fixture;
  await service.setChatRead(owner, await fixture.command(true));
  const descriptor = await fixture.descriptor();
  const read = () =>
    service.view(owner, descriptor.viewUrl!.slice(-64), 'chat-read', 'POST', async () => ({
      version: 1,
    }));
  await read();
  await assert.rejects(
    read(),
    (error: unknown) => error instanceof SessionApplicationError && error.status === 429,
  );
  assert.equal(fixture.reads(), 1);
  fixture.advance();
  await read();
  assert.equal(fixture.reads(), 2);
  await service.setChatRead(owner, await fixture.command(false));
  await assert.rejects(read(), denied);
  assert.equal(fixture.reads(), 2);
});
