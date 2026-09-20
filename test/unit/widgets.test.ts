import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { widgetTools } from '../../src/agents/widget-tools.ts';
import { WidgetRegistry, libraryDirectory } from '../../src/widgets/registry.ts';
import { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { Chromium, type BrowserPage } from '../../src/widgets/chromium.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import {
  attachment,
  boundedJson,
  presentation,
  type JsonObject,
  type WidgetBundle,
  type WidgetRecord,
} from '../../src/widgets/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class ControlledRenderer extends WidgetRenderer {
  describeGate?: () => Promise<void>;
  fail = false;
  override async describe(record: WidgetRecord): Promise<string> {
    await this.describeGate?.();
    if (this.fail) {
      throw Error('Broken widget');
    }
    return String(record.props.title || record.name);
  }
  override async reduce(
    record: WidgetRecord,
    _bundle: WidgetBundle,
    _action: string,
    args: JsonObject,
  ) {
    return {
      props: { ...record.props, title: args.title ?? record.props.title },
      result: { applied: true },
    };
  }
}

async function fixture(context: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp('/tmp/companion-widgets-unit-');
  context.after(() => rm(directory, { recursive: true, force: true }));
  const renderer = new ControlledRenderer();
  const changed: WidgetRecord[] = [];
  const service = new WidgetService(
    directory,
    async (record) => {
      changed.push(record);
    },
    undefined,
    renderer,
  );
  context.after(() => service.close());
  const owner = randomUUID();
  const controller = new AbortController();
  const lease = await service.lease(owner, controller.signal);
  let sequence = 0;
  const send = async (body: object, status = 200, signal?: AbortSignal) => {
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({ requestId: 'unit-' + ++sequence, ...body }),
    });
    const value = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  return { directory, renderer, changed, service, owner, controller, lease, send };
}

test('widget validation rejects malformed attachments, layouts and oversized JSON', () => {
  assert.throws(() =>
    attachment({ id: '-'.repeat(36), name: 'todo', revision: 1, presentation: {} }),
  );
  assert.throws(() => presentation({ placement: 'pinned', heightPercent: 101 }));
  assert.throws(() => presentation({ placement: 'pinned', widthPercent: 20 }));
  assert.throws(() => boundedJson({ x: 'x'.repeat(128 * 1024) }));
  assert.deepEqual(presentation({ placement: 'pinned' }), {
    placement: 'pinned',
    heightPercent: 25,
    replaceActivity: true,
  });
});

test('library discovery, schema defaults, immutable bundles and path containment', async (context) => {
  const directory = await mkdtemp('/tmp/companion-library-unit-');
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  await cp(libraryDirectory, library, { recursive: true });
  const registry = new WidgetRegistry(join(directory, 'cache'), library);
  const bundle = await registry.load('todo');
  assert.equal(registry.validate(bundle.manifest.parameters, { items: [] }).title, 'To do');
  assert.throws(() =>
    registry.validate(bundle.manifest.parameters, { items: [], unexpected: true }),
  );
  assert.throws(() => registry.validate(bundle.manifest.actions.add_item.parameters, {}));
  await registry.retain(bundle);
  await writeFile(join(library, 'todo', 'widget.js'), 'throw Error("changed library");');
  assert.equal((await registry.retained(bundle.hash)).javascript, bundle.javascript);
  assert.notEqual((await registry.load('todo')).hash, bundle.hash);
  assert.equal(((await registry.discover('bar')) as any).widgets.length, 1);
  await assert.rejects(registry.load('../todo'));
  await symlink('/tmp', join(library, 'escape'));
  await assert.rejects(registry.load('escape'), /inside the library/);
  const cached = join(directory, 'cache', bundle.hash + '.json');
  const value = JSON.parse(await readFile(cached, 'utf8'));
  value.javascript += ' altered';
  await writeFile(cached, JSON.stringify(value));
  await assert.rejects(registry.retained(bundle.hash), /integrity/);
});

test('failed or cancelled publication cannot unpin the current widget or persist partial state', async (context) => {
  const { renderer, send, changed, directory, owner, controller } = await fixture(context);
  const first = await send({
    method: 'publish',
    widget: 'todo',
    props: { items: [] },
    presentation: { placement: 'pinned' },
  });
  renderer.fail = true;
  await send(
    {
      method: 'publish',
      widget: 'todo',
      props: { items: [] },
      presentation: { placement: 'pinned' },
    },
    400,
  );
  renderer.fail = false;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  renderer.describeGate = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const pending = send(
    {
      method: 'publish',
      widget: 'todo',
      props: { items: [] },
      presentation: { placement: 'pinned' },
    },
    400,
  );
  await entering;
  controller.abort();
  release();
  await pending;
  assert.equal(changed.length, 1);
  const disk = JSON.parse(await readFile(join(directory, owner + '.json'), 'utf8'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].id, first.id);
  assert.equal(disk[0].presentation.placement, 'pinned');
});

test('turn lease release rejects in-flight changes', async (context) => {
  const { renderer, send, changed, lease } = await fixture(context);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  renderer.describeGate = () => {
    enter();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const pending = send({ method: 'publish', widget: 'todo', props: { items: [] } }, 400);
  await entered;
  lease.release();
  release();
  await pending;
  assert.equal(changed.length, 0);
});

test('tool transport uses schemas and refuses cross-conversation instance access', async (context) => {
  const { service, send, lease, owner } = await fixture(context);
  const tools = widgetTools(lease.endpoint, lease.token);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'companion_widgets',
      'companion_widget',
      'companion_widget_update',
      'companion_widget_call',
      'companion_widget_present',
    ],
  );
  assert.ok(tools.every((tool) => tool.promptSnippet && tool.description && tool.parameters));
  const publication = await tools[1].execute('native-publish', {
    widget: 'todo',
    props: { items: [] },
  });
  const result = JSON.parse(publication.content[0].text);
  assert.equal((await send({ method: 'discover', id: result.id })).revision, 1);
  await assert.rejects(
    service.restore(randomUUID(), { id: result.id, name: 'todo', revision: 1, presentation: {} }),
    /unavailable/,
  );
  const restored = await service.restored(owner);
  assert.equal(restored.length, 1);
  lease.release();
  await assert.rejects(
    tools[1].execute('after-turn', { widget: 'todo', props: { items: [] } }),
    /expired/,
  );
});

test('invalid reducer results cannot alter canonical state', async (context) => {
  const { send, changed } = await fixture(context);
  const created = await send({ method: 'publish', widget: 'todo', props: { items: [] } });
  await send(
    {
      method: 'call',
      id: created.id,
      action: 'set_completed',
      args: { itemId: 'one', completed: true },
    },
    400,
  );
  assert.equal(changed.length, 1);
  assert.equal((await send({ method: 'discover', id: created.id })).revision, 1);
});

test('late input cannot revive a closed conversation or reuse its capability after reopen', async (context) => {
  const { renderer, service, send, owner, changed } = await fixture(context);
  const inputs: string[] = [];
  renderer.input = async (record, _bundle, event) => {
    inputs.push(record.id + ':' + event.type);
    return {};
  };
  const created = await send({ method: 'publish', widget: 'todo', props: { items: [] } });
  const original = (await service.restored(owner))[0].reference;
  const input = async (viewUrl: string, type: string) => {
    const response = await fetch(viewUrl + '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, x: 40, y: 60, button: 'left', buttons: 0 }),
    });
    await response.json();
    return response.status;
  };

  assert.equal(await input(original.viewUrl!, 'mousePressed'), 200);
  await service.deactivate(owner);

  // A surface can still drain an accepted release to its original URL. The
  // service, rather than visibility, decides whether that capability is alive.
  assert.equal(await input(original.viewUrl!, 'mouseReleased'), 404);
  assert.deepEqual(inputs, [created.id + ':mousePressed']);
  assert.equal(changed.length, 1);

  const reopened = (await service.restored(owner))[0].reference;
  assert.notEqual(reopened.viewUrl, original.viewUrl);
  assert.equal(await input(original.viewUrl!, 'mouseReleased'), 404);
  assert.equal(await input(reopened.viewUrl!, 'mousePressed'), 200);
  assert.deepEqual(inputs, [created.id + ':mousePressed', created.id + ':mousePressed']);
  assert.equal(changed.length, 1);
});

for (const shutdown of ['conversation', 'service'] as const) {
  test(`${shutdown} close drains an accepted pop-out before returning`, async (context) => {
    const { renderer, service, send, owner } = await fixture(context);
    await send({ method: 'publish', widget: 'todo', props: { items: [] } });
    const reference = (await service.restored(owner))[0].reference;
    const entered = deferred();
    const resume = deferred();
    const open = new Set<string>();
    renderer.popout = async (id, _url, validate?: () => void) => {
      entered.resolve();
      await resume.promise;
      validate?.();
      open.add(id);
    };
    renderer.discard = async (ids) => {
      for (const id of ids) {
        open.delete(id);
      }
    };
    renderer.close = async () => {
      open.clear();
    };

    const pending = fetch(reference.viewUrl + '/popout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(async (response) => {
        await response.json();
        return response.status;
      })
      .catch(() => 0); // Service shutdown may close the HTTP connection.
    await entered.promise;
    let closed = false;
    const closing = (
      shutdown === 'conversation' ? service.deactivate(owner) : service.close()
    ).then(() => {
      closed = true;
    });
    await setImmediate();
    const closedBeforeResume = closed;
    resume.resolve();
    const [status] = await Promise.all([pending, closing]);

    assert.equal(
      closedBeforeResume,
      false,
      'close must own work paused before browser registration',
    );
    assert.equal(open.size, 0, 'no browser may appear after close completes');
    if (shutdown === 'conversation') {
      assert.equal(status, 400);
    }
  });
}

test(
  'repeated accepted pop-outs serialize, including recovery from an earlier failure',
  { timeout: 5000 },
  async (context) => {
    const { renderer, service, send, owner } = await fixture(context);
    await send({ method: 'publish', widget: 'todo', props: { items: [] } });
    const reference = (await service.restored(owner))[0].reference;
    const entered = deferred();
    const resume = deferred();
    context.after(() => resume.resolve());
    let active = 0;
    let maximum = 0;
    let calls = 0;
    renderer.popout = async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (calls === 1) {
          entered.resolve();
          await resume.promise;
          throw Error('First pop-out failed');
        }
      } finally {
        active--;
      }
    };
    const popout = async () => {
      const response = await fetch(reference.viewUrl + '/popout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      await response.json();
      return response.status;
    };
    const first = popout();
    await entered.promise;
    const second = popout();
    // The service's accepted-work counter makes this ordering deterministic;
    // there is no browser, compositor, sleep-based scheduling or live input.
    while ((service as any).queued.get(owner) !== 2 && calls !== 2 && !context.signal.aborted) {
      await setImmediate();
    }
    resume.resolve();
    assert.deepEqual(await Promise.all([first, second]), [400, 200]);
    assert.equal(maximum, 1, 'an earlier completion must not race a successor registration');
  },
);

test('pop-out revalidates its view after browser startup and before navigation', async (context) => {
  const entered = deferred();
  const resume = deferred();
  let navigations = 0;
  let closed = 0;
  context.mock.method(Chromium.prototype, 'page', async () => {
    entered.resolve();
    await resume.promise;
    return {
      call: async () => {
        navigations++;
      },
    } as unknown as BrowserPage;
  });
  context.mock.method(Chromium.prototype, 'close', async () => {
    closed++;
  });
  const renderer = new WidgetRenderer();
  let valid = true;
  const pending = renderer.popout('widget', 'http://127.0.0.1:9/view/test', () => {
    if (!valid) {
      throw Error('View revoked during startup');
    }
  });
  await entered.promise;
  valid = false;
  resume.resolve();
  await assert.rejects(pending, /revoked during startup/);
  assert.equal(navigations, 0);
  assert.equal(closed, 1);
  assert.equal((renderer as any).popouts.size, 0);
});
