import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { frame, signal } from '../helpers.ts';
import { offscreenPlatform } from '../window/offscreen.ts';

/**
 * The real session application runtime shown by the real native host:
 * HTML chat → agent-applied `task-list` → user edit in the native view →
 * agent replaces the code with `task-board` → same conversation, data and
 * draft. Runs only where the runtime slice is present (the combined
 * integration tree); on the surfaces branch alone it is skipped.
 *
 * Real: AgentSessions, WidgetService and its loopback server, the guarded
 * library loader and isolated renderer, the Pi tool definitions (through the
 * runtime's test fixture), the tracked example bundles, the native host,
 * QML body, trusted chat page and restricted WidgetProfile broker.
 * Injected: the model (a scripted turn), and the listener's desktop socket
 * (the QML test feeds real session snapshots into a scripted transport).
 * Requires `npm run ui:build -- -DBUILD_TESTING=ON`, Chromium and bwrap.
 */

const execute = promisify(execFile);
const build = resolve('native/window/build');
const fixturePath = new URL('../session-apps-runtime/fixture.ts', import.meta.url);

async function runtimeAvailable(): Promise<boolean> {
  try {
    await access(fixturePath);
    return true;
  } catch {
    return false;
  }
}

test(
  'a real agent-applied application runs in the native session view and survives code replacement',
  { skip: !(await runtimeAvailable()) && 'runtime slice not present in this tree' },
  async (context) => {
    // Loaded by URL so the surfaces branch type-checks without the runtime.
    const { applicationFixture } = await import(fixturePath.href);
    const fixture = await applicationFixture(context);
    const { sessions } = fixture;

    // Test hook in the temporary library copy only: on request, the authored
    // page calls api.call/api.query with a refused argument and reports the
    // settled outcome to its host page. Everything else is the shipped bundle.
    const bundlePath = join(fixture.library, 'task-list', 'widget.js');
    const bundle = await readFile(bundlePath, 'utf8');
    const anchor = '  const unsubscribe = api.state.subscribe';
    assert.ok(bundle.includes(anchor));
    await writeFile(
      bundlePath,
      bundle.replace(
        anchor,
        `  window.addEventListener('message', async (event) => {
    if (event.data !== 'refusal-probe') return;
    const outcome = {};
    try { await api.call('move_task', { id: 'missing', column: 'done' }); outcome.action = 'resolved'; }
    catch (error) { outcome.action = 'rejected'; }
    try { await api.query('no_such_query', {}); outcome.query = 'resolved'; }
    catch (error) { outcome.query = 'rejected'; }
    parent.postMessage({ refusalProbe: outcome }, '*');
  });
` + anchor,
      ),
    );

    const id = sessions.start(frame, signal());
    fixture.script(id, async (turn: any) => {
      await turn.tool('companion_app_apply', {
        bundle: 'task-list',
        expectedVersion: 0,
        eventMode: 'next-input',
        initialState: {
          title: 'Release',
          tasks: [
            { id: 'a', text: 'Write notes', column: 'todo' },
            { id: 'b', text: 'Run tests', column: 'doing' },
          ],
        },
      });
    });
    await sessions.idle();
    const first = fixture.view(id);
    assert.equal(first.application.version, 1);

    // The QML test asks for the replacement once the person's edit landed.
    // This runs a real follow-up turn whose scripted agent adds a task and
    // applies a different bundle, then answers with the fresh snapshot.
    const control = createServer(async (request, response) => {
      if (request.url === '/replace') {
        fixture.script(id, async (turn: any) => {
          await turn.tool('companion_app_call', { action: 'add_task', args: { text: 'Ship it' } });
          await turn.tool('companion_app_apply', { bundle: 'task-board', expectedVersion: 1 });
        });
        sessions.followUp(id, 'Add a ship task and switch to a board', signal());
        await sessions.idle();
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(fixture.view(id)));
    });
    await new Promise<void>((done) => control.listen(0, '127.0.0.1', done));
    context.after(() => new Promise<void>((done) => control.close(() => done())));
    const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;

    const directory = await mkdtemp('/tmp/companion-session-runtime-native-');
    context.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = join(directory, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    const template = await readFile(new URL('./runtime-native.qml.in', import.meta.url), 'utf8');
    const path = join(directory, 'tst_runtime_native.qml');
    await writeFile(
      path,
      template
        .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
        .replace('@SESSION@', JSON.stringify(first))
        .replace('@CONTROL_URL@', controlUrl),
    );

    let output = '';
    try {
      const result = await execute(
        join(build, 'companion-window-tests'),
        ['-input', path, '-nocrashhandler'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, 'config'),
            XDG_CACHE_HOME: join(directory, 'cache'),
            XDG_RUNTIME_DIR: runtime,
            QT_QPA_PLATFORM: await offscreenPlatform(directory),
            QT_QUICK_BACKEND: 'software',
            QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
            QML_IMPORT_PATH: join(build, 'qml'),
            COMPANION_TEST_SESSION_SURFACE: 'html',
          },
          timeout: 120_000,
          killSignal: 'SIGKILL',
        },
      );
      output = result.stdout;
    } catch (error) {
      throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'));
    }
    assert.match(output, /Totals: \d+ passed, 0 failed/);

    // The refused action and query changed nothing and created no event:
    // revision 1 → 2 is the single checkbox edit (checked in QML).

    // The native click was a user edit through the view ingress: it was
    // committed and recorded as a pending event (next-input mode) before
    // the agent's turn consumed it. The agent's own edits made no event.
    const final = fixture.view(id);
    assert.equal(final.id, id);
    assert.equal(final.application.version, 2);
    assert.equal(final.application.name, 'task-board');
    assert.equal(final.application.viewUrl, first.application.viewUrl);
    const state = await (await fetch(final.application.viewUrl + '/state')).json();
    assert.equal(state.data.tasks.length, 3);
    assert.equal(state.data.tasks.find((task: any) => task.id === 'a').column, 'done');
    const replacementTurn = fixture.turns[fixture.turns.length - 1];
    assert.match(replacementTurn.text, /\[Companion application event\]/);
  },
);
