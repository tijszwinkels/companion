/**
 * The widget service's private Unix socket route (src/widgets/socket.ts and
 * src/widgets/README.md): who may connect, which requests it serves, and
 * that its documents never contain the view's capability. Uses a real widget
 * service in temporary directories with the synthetic library and a
 * Node-side renderer (test/frame-fixture.ts). No browser, no network.
 */

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { widgetTools } from '../../src/agents/widget-tools.ts';
import { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import { privateSocketHost } from '../../src/widgets/socket.ts';
import { useNodeRenderer, writeSyntheticLibrary } from '../frame-fixture.ts';

type Json = Record<string, any>;

interface Answer {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

/** One request over the Unix socket with exactly these headers. */
function overSocket(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        setHost: false,
        headers: {
          ...headers,
          ...(encoded ? { 'Content-Type': 'application/json' } : {}),
        },
        agent: false,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
      },
    );
    request.on('error', reject);
    request.end(encoded);
  });
}

async function serviceFixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'companion-widget-socket-'));
  const library = join(root, 'library');
  await writeSyntheticLibrary(library);
  const runtime = join(root, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const socketPath = join(runtime, 'widgets.sock');

  const renderer = new WidgetRenderer();
  useNodeRenderer(renderer);
  const service = new WidgetService(join(root, 'state'), async () => {}, library, renderer);
  const owner = '11111111-1111-4111-8111-111111111111';
  const lease = await service.lease(owner, new AbortController().signal);
  const tools = widgetTools(lease.endpoint, lease.token);
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const published = await tool('companion_widget').execute('publish', {
    widget: 'counter',
    props: { title: 'Clicks', count: 0 },
  });
  const widgetId = JSON.parse(published.content[0].text).id as string;
  await tool('companion_app_apply').execute('apply', { bundle: 'notes', expectedVersion: 0 });

  const restored = await service.restored(owner);
  const widgetView = restored.find((entry) => entry.record.id === widgetId)!.reference.viewUrl!;
  const applicationView = (await service.applications.descriptor(owner))!.viewUrl!;
  await service.listenPrivately(socketPath);

  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, owner, lease, socketPath, runtime, widgetView, applicationView };
}

const fixedHost = { Host: privateSocketHost };

test('the socket is 0600 in a private directory and refuses a second listener', async (context) => {
  const fixture = await serviceFixture(context);
  const mode = (await lstat(fixture.socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  await assert.rejects(fixture.service.listenPrivately(fixture.socketPath));

  const other = new WidgetService(join(fixture.runtime, '..', 'other-state'), async () => {});
  context.after(() => other.close());
  await assert.rejects(other.listenPrivately(fixture.socketPath), /lock|running|use/i);
});

test('the socket refuses a directory other users can enter', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-widget-socket-open-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const open = join(root, 'runtime');
  await mkdir(open);
  await chmod(open, 0o755);
  const service = new WidgetService(join(root, 'state'), async () => {});
  context.after(() => service.close());
  await assert.rejects(service.listenPrivately(join(open, 'widgets.sock')));
});

test('socket route table: host, origin and operations', async (context) => {
  const fixture = await serviceFixture(context);
  const widget = new URL(fixture.widgetView).pathname;
  const application = new URL(fixture.applicationView).pathname;
  const loopbackHost = new URL(fixture.widgetView).host;

  const cases: Array<{
    name: string;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    status: number;
  }> = [
    { name: 'widget document', method: 'GET', path: widget, status: 200 },
    { name: 'widget state', method: 'GET', path: widget + '/state', status: 200 },
    {
      name: 'widget action',
      method: 'POST',
      path: widget + '/action',
      body: { action: 'increment', args: {}, requestId: 'socket-action' },
      status: 200,
    },
    {
      name: 'widget present',
      method: 'POST',
      path: widget + '/present',
      body: { presentation: { placement: 'inline' }, requestId: 'socket-present' },
      status: 200,
    },
    {
      name: 'widget viewport',
      method: 'POST',
      path: widget + '/viewport',
      body: { widthCssPixels: 300, heightCssPixels: 200, textScale: 1 },
      status: 200,
    },
    { name: 'application document', method: 'GET', path: application, status: 200 },
    { name: 'application state', method: 'GET', path: application + '/state', status: 200 },
    {
      name: 'application query',
      method: 'POST',
      path: application + '/query',
      body: { name: 'count_notes', args: {}, version: 1 },
      status: 200,
    },
    {
      name: 'application chat-read (grant applies)',
      method: 'POST',
      path: application + '/chat-read',
      body: { version: 1 },
      status: 403,
    },
    ...['frame', 'layout'].map((operation) => ({
      name: `${operation} is not served`,
      method: 'GET',
      path: `${widget}/${operation}?width=300&height=200`,
      status: 404,
    })),
    ...['input', 'popout'].map((operation) => ({
      name: `${operation} is not served`,
      method: 'POST',
      path: `${widget}/${operation}`,
      body: {},
      status: 404,
    })),
    {
      name: '/agent is not served, even with a valid lease',
      method: 'POST',
      path: '/agent',
      headers: { ...fixedHost, Authorization: `Bearer ${fixture.lease.token}` },
      body: { method: 'discover' },
      status: 404,
    },
    {
      name: 'an unknown capability',
      method: 'GET',
      path: '/view/' + 'b'.repeat(64) + '/state',
      status: 404,
    },
    {
      name: 'the loopback Host',
      method: 'GET',
      path: widget + '/state',
      headers: { Host: loopbackHost },
      status: 403,
    },
    // Node's HTTP server refuses HTTP/1.1 without Host before any handler runs.
    { name: 'no Host', method: 'GET', path: widget + '/state', headers: {}, status: 400 },
    {
      name: 'an Origin, even the loopback one',
      method: 'GET',
      path: widget + '/state',
      headers: { ...fixedHost, Origin: 'http://' + loopbackHost },
      status: 403,
    },
    {
      name: 'an Origin on POST',
      method: 'POST',
      path: widget + '/action',
      headers: { ...fixedHost, Origin: 'https://frames.example' },
      body: { action: 'increment', args: {}, requestId: 'socket-origin' },
      status: 403,
    },
  ];

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const answer = await overSocket(
        fixture.socketPath,
        entry.method,
        entry.path,
        entry.headers ?? fixedHost,
        entry.body,
      );
      assert.equal(answer.status, entry.status, answer.body);
    });
  }
});

test('socket documents never contain the capability; loopback documents are unchanged', async (context) => {
  const fixture = await serviceFixture(context);
  for (const view of [fixture.widgetView, fixture.applicationView]) {
    const capability = view.slice(-64);
    const viaSocket = await overSocket(
      fixture.socketPath,
      'GET',
      new URL(view).pathname,
      fixedHost,
    );
    assert.equal(viaSocket.status, 200);
    assert.ok(!viaSocket.body.includes(capability));
    assert.ok(!viaSocket.body.includes('127.0.0.1'));
    const bootstrap = decodedBootstrap(viaSocket.body);
    assert.equal(bootstrap.api, 'location');
    assert.ok(!JSON.stringify(bootstrap).includes(capability));

    const loopback = await fetch(view);
    const html = await loopback.text();
    assert.equal(loopback.headers.get('x-frame-options'), 'DENY');
    assert.equal(decodedBootstrap(html).api, view);
  }
});

test('a closed conversation is refused on the socket at once', async (context) => {
  const fixture = await serviceFixture(context);
  await fixture.service.deactivate(fixture.owner);
  for (const view of [fixture.widgetView, fixture.applicationView]) {
    const answer = await overSocket(
      fixture.socketPath,
      'GET',
      new URL(view).pathname + '/state',
      fixedHost,
    );
    assert.equal(answer.status, 404);
  }
});

/** The bootstrap object inside a widget document's first data: script. */
function decodedBootstrap(html: string): Json {
  const encoded = /src="data:text\/javascript;base64,([^"]+)"/.exec(html)![1];
  const code = Buffer.from(encoded, 'base64').toString('utf8');
  const literal = /^window\.widgetBootstrap=JSON\.parse\((".*?")\);\n/s.exec(code)![1];
  return JSON.parse(JSON.parse(literal)) as Json;
}
