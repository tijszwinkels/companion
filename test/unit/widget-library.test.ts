import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import {
  bundledLibraryDirectory,
  defaultWidgetLibrary,
  userWidgetLibrary,
  widgetLibraryVariable,
} from '../../src/widgets/library-path.ts';
import { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import type { JsonObject, WidgetBundle, WidgetRecord } from '../../src/widgets/types.ts';
import { frame, signal } from '../helpers.ts';

/**
 * The listener's widget source is a configurable user library outside the
 * checkout. Every test here builds its own synthetic library and state under a
 * temporary directory; none reads or writes ~/companion or published widgets.
 */

/** Describes and reduces without Chromium, recording which bundle each reducer used. */
class RecordingRenderer extends WidgetRenderer {
  reducedJavascript: string[] = [];

  override async describe(record: WidgetRecord): Promise<string> {
    return String(record.props.title || record.name);
  }

  override async reduce(
    record: WidgetRecord,
    bundle: WidgetBundle,
    _action: string,
    args: JsonObject,
  ): Promise<{ props: JsonObject; result: JsonObject }> {
    this.reducedJavascript.push(bundle.javascript);

    const items = [...(record.props.items as JsonObject[])];
    const itemId = 'item-' + (items.length + 1);
    items.push({ id: itemId, text: String(args.text), completed: false });

    return { props: { ...record.props, items }, result: { itemId } };
  }
}

/** A temporary root holding a user library with a synthetic copy of `todo`. */
async function temporaryRoot(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'companion-widget-library-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const library = join(root, 'home', 'companion', 'widget-library');
  await mkdir(library, { recursive: true });
  await cp(join(bundledLibraryDirectory, 'todo'), join(library, 'todo'), { recursive: true });

  // A recognizable marker proves which copy of the code a view or reducer used.
  await writeFile(join(library, 'todo', 'widget.js'), 'export const marker = "USER_LIBRARY_V1";');

  return { root, library, state: join(root, 'state') };
}

/** Opens a service and an agent lease for one synthetic conversation. */
async function openService(
  context: TestContext,
  state: string,
  library: string,
  owner: string,
  renderer = new RecordingRenderer(),
) {
  const service = new WidgetService(state, async () => {}, library, renderer);
  context.after(() => service.close());

  const lease = await service.lease(owner, signal());
  let sequence = 0;

  // Returns the parsed body and status; callers assert the status they expect.
  const send = async (body: object) => {
    sequence += 1;
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({ requestId: `library-${owner}-${sequence}`, ...body }),
    });
    return { status: response.status, value: (await response.json()) as any };
  };

  return { service, send, renderer };
}

test('user library path: default home, environment and option overrides, strict validation', () => {
  const home = '/synthetic/home';
  assert.equal(defaultWidgetLibrary(home), '/synthetic/home/companion/widget-library');
  assert.equal(userWidgetLibrary(undefined, undefined, home), defaultWidgetLibrary(home));
  // An empty environment variable counts as unset.
  assert.equal(userWidgetLibrary(undefined, '', home), defaultWidgetLibrary(home));

  // The command-line option wins over the environment; both are normalized lexically.
  assert.equal(userWidgetLibrary(undefined, '/from/environment/', home), '/from/environment');
  assert.equal(
    userWidgetLibrary('/from/option/../chosen', '/from/environment', home),
    '/from/chosen',
  );

  // Relative paths would depend on the launch directory; NUL cannot name a file.
  // An explicitly supplied empty option is invalid, not a request for a fallback.
  assert.throws(() => userWidgetLibrary('widget-library', undefined, home), /--widget-library/);
  assert.throws(() => userWidgetLibrary('', '/from/environment', home), /--widget-library/);
  assert.throws(() => userWidgetLibrary(undefined, './library', home), /COMPANION_WIDGET_LIBRARY/);
  assert.throws(() => userWidgetLibrary('/bad\0path', undefined, home), /absolute/);
});

test('discovery and publication both use the injected user library, not the checkout', async (context) => {
  const { library, state } = await temporaryRoot(context);
  const { send } = await openService(context, state, library, randomUUID());

  const listing = await send({ method: 'discover' });
  assert.equal(listing.status, 200);
  assert.equal(listing.value.directory, library);
  assert.deepEqual(
    listing.value.widgets.map((widget: { name: string }) => widget.name),
    ['todo'],
    'Bundled checkout widgets such as bar-chart are not offered',
  );

  const published = await send({
    method: 'publish',
    widget: 'todo',
    props: { title: 'Synthetic', items: [] },
  });
  assert.equal(published.status, 200, JSON.stringify(published.value));

  // A widget that exists only in the checkout cannot be published from here.
  const checkoutOnly = await send({ method: 'publish', widget: 'bar-chart', props: {} });
  assert.equal(checkoutOnly.status, 400);
  assert.match(checkoutOnly.value.error, /"bar-chart" was not found in/);
  assert.ok(checkoutOnly.value.error.includes(library));

  // Path-shaped names never leave the library.
  const traversal = await send({ method: 'publish', widget: '../todo', props: {} });
  assert.equal(traversal.status, 400);
  assert.match(traversal.value.error, /Unknown widget name/);
});

test('a missing or empty library lists nothing and refuses new publications', async (context) => {
  const { root, state } = await temporaryRoot(context);
  const missing = join(root, 'does-not-exist', 'widget-library');
  const { send } = await openService(context, state, missing, randomUUID());

  const listing = await send({ method: 'discover' });
  assert.equal(listing.status, 200);
  assert.equal(listing.value.directory, missing);
  assert.deepEqual(listing.value.widgets, []);
  assert.match(listing.value.note, /does not exist/);

  const published = await send({ method: 'publish', widget: 'todo', props: { items: [] } });
  assert.equal(published.status, 400);
  assert.match(published.value.error, /"todo" was not found/);

  const empty = join(root, 'empty-library');
  await mkdir(empty);
  const emptyService = await openService(context, join(root, 'empty-state'), empty, randomUUID());
  const emptyListing = await emptyService.send({ method: 'discover' });
  assert.equal(emptyListing.status, 200);
  assert.deepEqual(emptyListing.value, { directory: empty, widgets: [] });
});

test('symlinked libraries, ancestors and widget directories are refused by discovery and publication', async (context) => {
  const { root, library, state } = await temporaryRoot(context);

  // The library itself is a link to a real synthetic library.
  const linkedLibrary = join(root, 'linked-library');
  await symlink(library, linkedLibrary);
  const direct = await openService(context, state, linkedLibrary, randomUUID());
  const directListing = await direct.send({ method: 'discover' });
  assert.equal(directListing.status, 400);
  assert.match(directListing.value.error, /without symlinks/);
  const directPublish = await direct.send({ method: 'publish', widget: 'todo', props: {} });
  assert.equal(directPublish.status, 400);
  assert.match(directPublish.value.error, /without symlinks/);

  // An ancestor of the library is a link.
  const linkedHome = join(root, 'linked-home');
  await symlink(join(root, 'home'), linkedHome);
  const ancestor = await openService(
    context,
    join(root, 'ancestor-state'),
    join(linkedHome, 'companion', 'widget-library'),
    randomUUID(),
  );
  const ancestorListing = await ancestor.send({ method: 'discover' });
  assert.equal(ancestorListing.status, 400);
  assert.match(ancestorListing.value.error, /without symlinks/);

  // A linked widget directory inside a regular library is neither listed nor published.
  const outside = join(root, 'outside-widget');
  await cp(join(library, 'todo'), outside, { recursive: true });
  const outsideManifest = JSON.parse(await readFile(join(outside, 'widget.json'), 'utf8'));
  outsideManifest.name = 'linked';
  await writeFile(join(outside, 'widget.json'), JSON.stringify(outsideManifest));
  await symlink(outside, join(library, 'linked'));
  const regular = await openService(context, join(root, 'regular-state'), library, randomUUID());
  const regularListing = await regular.send({ method: 'discover' });
  assert.deepEqual(
    regularListing.value.widgets.map((widget: { name: string }) => widget.name),
    ['todo'],
  );
  const linkedPublish = await regular.send({ method: 'publish', widget: 'linked', props: {} });
  assert.equal(linkedPublish.status, 400);
  assert.match(linkedPublish.value.error, /without symlinks/);
});

test('existing widgets restore and run actions from their retained bundle after the library changes or disappears', async (context) => {
  const { root, library, state } = await temporaryRoot(context);
  const owner = randomUUID();

  const first = await openService(context, state, library, owner);
  const published = await first.send({
    method: 'publish',
    widget: 'todo',
    props: { title: 'Retained', items: [] },
  });
  assert.equal(published.status, 200, JSON.stringify(published.value));
  await first.service.close();

  // Simulate an edited library, then moving it away entirely.
  await writeFile(join(library, 'todo', 'widget.js'), 'export const marker = "EDITED_LATER";');
  await rename(library, join(root, 'moved-library'));

  const renderer = new RecordingRenderer();
  const restarted = await openService(context, state, library, owner, renderer);

  const restored = await restarted.service.restored(owner);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].record.id, published.value.id);

  const inspected = await restarted.send({ method: 'discover', id: published.value.id });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.value.manifest.name, 'todo');

  const called = await restarted.send({
    method: 'call',
    id: published.value.id,
    action: 'add_item',
    args: { text: 'Still works' },
  });
  assert.equal(called.status, 200, JSON.stringify(called.value));
  assert.equal(called.value.itemId, 'item-1');
  assert.equal(called.value.revision, 2);
  assert.equal(renderer.reducedJavascript.length, 1);
  assert.match(renderer.reducedJavascript[0], /USER_LIBRARY_V1/);

  // New publications still depend on the (now missing) library.
  const listing = await restarted.send({ method: 'discover' });
  assert.deepEqual(listing.value.widgets, []);
});

/** A backend whose single turn lists the library through its real widget lease. */
function discoveringBackend(listings: unknown[]): AgentBackend {
  return {
    id: 'widget-library-fixture',
    label: 'Widget library fixture',
    dependencies: {},
    async run(request) {
      assert.ok(request.widgets, 'the turn receives a widget lease');
      const response = await fetch(request.widgets.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + request.widgets.token,
        },
        body: JSON.stringify({ method: 'discover', requestId: 'fixture-discover' }),
      });
      listings.push(await response.json());
    },
  };
}

test('agent sessions use the injected library, otherwise the bundled examples', async (context) => {
  const { root, library } = await temporaryRoot(context);

  // Explicit injection, as the listener does after resolving --widget-library.
  const explicitListings: unknown[] = [];
  const explicitDirectory = join(root, 'agents-explicit');
  await mkdir(explicitDirectory);
  const explicit = new AgentSessions(
    { backend: discoveringBackend(explicitListings) },
    () => {},
    explicitDirectory,
    library,
  );
  context.after(() => explicit.close());
  explicit.start(frame, signal());
  await explicit.idle();
  assert.equal((explicitListings[0] as { directory: string }).directory, library);

  // Without an explicit library, sessions use the checkout's bundled examples,
  // even when the environment names another library: tests and harnesses that
  // construct AgentSessions directly must never read the user's real widgets.
  const previous = process.env[widgetLibraryVariable];
  process.env[widgetLibraryVariable] = join(root, 'must-not-be-used');
  let withDefault: AgentSessions;
  try {
    const defaultDirectory = join(root, 'agents-default');
    await mkdir(defaultDirectory);
    const defaultListings: unknown[] = [];
    withDefault = new AgentSessions(
      { backend: discoveringBackend(defaultListings) },
      () => {},
      defaultDirectory,
    );
    context.after(() => withDefault.close());
    withDefault.start(frame, signal());
    await withDefault.idle();
    assert.equal((defaultListings[0] as { directory: string }).directory, bundledLibraryDirectory);
  } finally {
    if (previous === undefined) {
      delete process.env[widgetLibraryVariable];
    } else {
      process.env[widgetLibraryVariable] = previous;
    }
  }
});

for (const [description, value] of [
  ['a relative', 'relative/library'],
  ['an empty', ''],
]) {
  test(`the listener refuses ${description} --widget-library before starting anything`, async () => {
    // Run from the checkout so the tsx loader resolves; validation fails before
    // configuration, sessions, the microphone or any desktop service are touched.
    // A valid environment value must not rescue an invalid explicit option.
    const checkout = new URL('../../', import.meta.url).pathname;
    const run = promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--widget-library', value, '--graph', 'json'],
      {
        timeout: 10000,
        cwd: checkout,
        env: { ...process.env, [widgetLibraryVariable]: '/synthetic/environment-library' },
      },
    );

    // The listener logs fatal errors on stdout and exits with status 1.
    await assert.rejects(run, (error: { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /--widget-library must be an absolute directory path/);
      return true;
    });
  });
}
