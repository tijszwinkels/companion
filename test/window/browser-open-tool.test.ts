// companion_browser_open in the native UI (offscreen Qt, real Chromium).
//
// 1. The real window body with a synthetic backend: every panel-side case
//    (selection, busy, refusals, failures, slow pages, hidden window,
//    reuse of a frozen page, retained chat state).
// 2. End to end: a real agent tool call through the turn lease, the real
//    listener runtime and socket, and the real companion-ui executable,
//    loading a loopback fixture page.
//
// Temporary HOME/XDG/runtime directories, kernel-chosen loopback ports and a
// synthetic agent backend; no model, account, live listener or desktop.
// Offscreen rendering does not establish live Wayland or GPU behaviour.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import type { WidgetAttachment } from '../../src/widgets/types.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

const execute = promisify(execFile);
const build = resolve('native/window/build');
const evidence = join(build, 'artifacts');

function page(title: string, body = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

// Loopback fixture site; records every requested path.
function site(visits: string[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    visits.push(path);
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(page('Home', '<p>Home</p>'));
    } else if (path === '/second') {
      response.setHeader('Content-Type', 'text/html');
      response.end(page('Second', '<p>Second</p>'));
    } else if (path === '/slow') {
      // Answers only after the panel's bounded wait; closed at cleanup.
      setTimeout(() => {
        if (!response.writableEnded) {
          response.setHeader('Content-Type', 'text/html');
          response.end(page('Slow'));
        }
      }, 10000).unref();
    } else if (path === '/redirect-public-http') {
      response.writeHead(302, { Location: 'http://example.invalid/' });
      response.end();
    } else {
      response.statusCode = 404;
      response.end();
    }
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

// Chromium keeps idle connections open; close them so close() cannot hang.
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function environment(directory: string) {
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  return {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_RUNTIME_DIR: runtime,
    QT_QPA_PLATFORM: 'offscreen',
    QT_QUICK_BACKEND: 'software',
    QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
    QML_IMPORT_PATH: join(build, 'qml'),
    LD_LIBRARY_PATH: join(build, 'staged/usr/lib'),
  };
}

async function publishPinnedWidget(directory: string) {
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(join(directory, 'widgets'), async (_, value) => {
    reference = value;
  });
  const lease = await service.lease(randomUUID(), new AbortController().signal);
  const response = await fetch(lease.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
    body: JSON.stringify({
      method: 'publish',
      widget: 'todo',
      requestId: 'browser-open-tool',
      props: { title: 'Pinned', items: [{ id: 'one', text: 'Retained', completed: false }] },
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.ok(reference);
  return { service, reference };
}

test(
  'the native panel opens agent-requested pages only for the selected conversation',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp('/tmp/companion-browser-open-host-');
    let service: WidgetService | undefined;
    let server: Server | undefined;
    let output = '';

    try {
      const env = await environment(directory);
      const published = await publishPinnedWidget(directory);
      service = published.service;
      const visits: string[] = [];
      server = createHttpServer(site(visits));
      const origin = await listen(server);

      const template = await readFile(
        new URL('./browser-open-tool-host.qml.in', import.meta.url),
        'utf8',
      );
      const path = join(directory, 'tst_browser_open_tool_host.qml');
      await writeFile(
        path,
        template
          .replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
          .replace('@ORIGIN@', JSON.stringify(origin))
          .replace('@REFERENCE@', JSON.stringify(published.reference)),
      );
      try {
        const result = await execute(
          'prlimit',
          [
            '--core=0',
            '--',
            join(build, 'companion-window-tests'),
            '-input',
            path,
            '-nocrashhandler',
          ],
          { env, timeout: 100000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
        );
        output = result.stdout + result.stderr;
        assert.match(result.stdout, /Totals: 10 passed, 0 failed/);
      } catch (error) {
        output = output || [String(error), (error as any).stdout, (error as any).stderr].join('\n');
        throw Error(output, { cause: error });
      }

      // Refused callers and addresses never reached the page server.
      assert.ok(!visits.includes('/etc/passwd'));
      assert.equal(visits.filter((path) => path === '/').length >= 1, true);
    } finally {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'browser-open-tool-host.log'), output);
      await Promise.allSettled([server ? close(server) : undefined, service?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a real tool call opens a page in the real native UI through the listener',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp('/tmp/companion-browser-open-e2e-');
    let server: Server | undefined;
    let desktop: Awaited<ReturnType<typeof desktopFixture>> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> = Promise.resolve();
    const releases: (() => void)[] = [];
    let output = '';

    try {
      const env = await environment(directory);
      const visits: string[] = [];
      server = createHttpServer(site(visits));
      const origin = await listen(server);

      // Two conversations whose turns stay open while the test uses their
      // leases: "Background" first, then "Requester", which a newly connected
      // UI selects as the newest conversation the user started.
      const agentDirectory = join(directory, 'agents');
      await mkdir(agentDirectory);
      await writeFile(
        join(agentDirectory, 'companion-agent.json'),
        JSON.stringify(defaultAgentSettings),
      );
      const leases = new Map<string, { endpoint: string; token: string }>();
      const sessions = new AgentSessions(
        {
          pi: {
            id: 'browser-open-e2e',
            label: 'Browser open end-to-end fixture',
            dependencies: {},
            async run(request) {
              leases.set(request.prompt.text, request.sessionTools!);
              await new Promise<void>((resolve) => releases.push(resolve));
            },
          },
        },
        () => {},
        agentDirectory,
      );
      desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
      const background = sessions.start({ ...frame, utterance: 'Background' }, signal());
      const requester = sessions.start({ ...frame, utterance: 'Requester' }, signal());
      for (let attempt = 0; attempt < 200 && leases.size < 2; attempt++) {
        await delay(25);
      }
      assert.equal(leases.size, 2);

      const control = join(directory, 'ui.sock');
      child = spawn(
        join(build, 'companion-ui'),
        ['--socket', desktop.socketPath, '--control-socket', control],
        { env },
      );
      exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.stdout!.on('data', (chunk) => (output += chunk));
      child.stderr!.on('data', (chunk) => (output += chunk));

      async function open(caller: string, url: string) {
        const lease = leases.get(caller)!;
        const tool = sessionTools(lease.endpoint, lease.token).find(
          (candidate) => candidate.name === 'companion_browser_open',
        )!;
        try {
          return (await tool.execute(randomUUID(), { url } as never)).details as Record<
            string,
            unknown
          >;
        } catch (error) {
          return { error: (error as Error).message };
        }
      }

      // Wait until the UI has connected, selected Requester and offered its browser.
      let first: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 120; attempt++) {
        first = await open('Requester', origin + '/');
        if (!/\[(offline|not-selected)\]$/.test(String(first.error ?? ''))) {
          break;
        }
        await delay(250);
      }
      assert.equal(first.outcome, 'loaded', JSON.stringify(first) + '\n' + output);
      assert.equal(first.title, undefined, 'no page content reaches the agent');
      assert.equal(first.url, origin + '/');
      assert.ok(visits.includes('/'), 'the real browser fetched the page');

      // The background conversation cannot replace what the user sees.
      const before = visits.length;
      const refused = await open('Background', origin + '/second');
      assert.match(String(refused.error), /\[not-selected\]$/);
      // Chromium may still fetch the first page's icon; no page was requested.
      assert.deepEqual(
        visits.slice(before).filter((path) => path !== '/favicon.ico'),
        [],
      );
      assert.ok(background);

      // With the window hidden, the page opens without showing it.
      await execute(
        join(build, 'companion-ui'),
        ['--control-socket', control, '--command', 'hide'],
        {
          env,
          timeout: 10000,
          killSignal: 'SIGKILL',
        },
      );
      const hidden = await open('Requester', origin + '/second');
      assert.equal(hidden.outcome, 'loaded', JSON.stringify(hidden));
      assert.equal(hidden.url, origin + '/second');
      assert.equal(hidden.panelVisible, false);
      assert.ok(requester);
      assert.doesNotMatch(output, /ReferenceError|TypeError|Binding loop|Required property/);
    } finally {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'browser-open-tool-e2e.log'), output);
      for (const release of releases) {
        release();
      }
      child?.kill('SIGTERM');
      await Promise.race([exited, delay(10000)]);
      child?.kill('SIGKILL');
      await Promise.allSettled([server ? close(server) : undefined, desktop?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
