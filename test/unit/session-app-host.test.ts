/**
 * The trusted widget host script (integrations/widgets/host.js) at its
 * ingress from the authored iframe. Authored code can post messages directly,
 * so request bounds must hold there, not only in the frame API. The script
 * runs in a Node VM with a synthetic frame identity and a controllable fetch;
 * no browser, service or authored bundle is involved.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../integrations/widgets/host.js', import.meta.url), 'utf8');

interface PendingFetch {
  url: string;
  method: string;
  resolve(body: unknown, status?: number): void;
  reject(error: Error): void;
}

/** Load host.js once, as a session application view (or a widget view). */
function host(options: { application?: boolean } = {}) {
  let onMessage: ((event: unknown) => void) | undefined;
  const fetches: PendingFetch[] = [];
  const replies: { id: string; result: unknown; error: string }[] = [];
  const child = {
    postMessage(message: { type: string; id: string; result: unknown; error: string }) {
      if (message.type === 'action-result') {
        replies.push({ id: message.id, result: message.result, error: message.error });
      }
    },
  };
  const element = () => ({ contentWindow: child, setAttribute() {}, textContent: '' });
  const context = vm.createContext({
    window: {
      widgetBootstrap: {
        api: 'http://127.0.0.1:1234/view/' + 'a'.repeat(64),
        ...(options.application === false ? {} : { application: { version: 1 } }),
        props: { count: 1 },
        revision: 1,
        theme: {},
        document: '',
        title: 't',
      },
      addEventListener(type: string, callback: (event: unknown) => void) {
        if (type === 'message') {
          onMessage = callback;
        }
      },
    },
    location: { href: 'http://127.0.0.1:1234/view/' + 'a'.repeat(64), reload() {} },
    document: { createElement: element, body: { append() {} }, hidden: false },
    fetch(url: string, init?: { method?: string }) {
      return new Promise((resolve, reject) => {
        fetches.push({
          url,
          method: init?.method ?? 'GET',
          resolve(body, status = 200) {
            resolve({ ok: status === 200, status, json: async () => body });
          },
          reject,
        });
      });
    },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    TextEncoder,
    crypto: globalThis.crypto,
  });
  vm.runInContext(source, context);
  assert.ok(onMessage);
  return {
    fetches,
    replies,
    post(data: Record<string, unknown>) {
      onMessage!({ source: child, data });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('direct state reads share one fetch, wait in a bounded group and release capacity on success', async () => {
  const view = host();
  for (let index = 0; index < 100; index++) {
    view.post({ type: 'state-read', id: `read-${index}` });
  }
  const reads = view.fetches.filter((entry) => entry.url.endsWith('/state'));
  assert.equal(reads.length, 1);
  // The first eight wait; the rest are refused at once.
  assert.equal(view.replies.length, 92);
  assert.ok(view.replies.every((reply) => reply.error === 'Too many pending state reads'));

  reads[0].resolve({ revision: 4, props: { count: 4 } });
  await settle();
  const answered = view.replies.slice(92);
  assert.deepEqual(
    answered.map((reply) => reply.id),
    Array.from({ length: 8 }, (_, index) => `read-${index}`),
  );
  assert.ok(answered.every((reply) => !reply.error));
  // Results come from the VM's realm; compare their JSON.
  assert.equal(JSON.stringify(answered[0].result), '{"revision":4,"data":{"count":4}}');

  // Capacity is free again: the next read starts a new request.
  view.post({ type: 'state-read', id: 'later' });
  assert.equal(view.fetches.filter((entry) => entry.url.endsWith('/state')).length, 2);
});

test('a failed state read answers every waiter with the error and releases capacity', async () => {
  const view = host();
  view.post({ type: 'state-read', id: 'a' });
  view.post({ type: 'state-read', id: 'b' });
  view.fetches[0].resolve({ error: 'Application view is unavailable' }, 404);
  await settle();
  assert.deepEqual(
    view.replies.map((reply) => [reply.id, reply.error]),
    [
      ['a', 'Application view is unavailable'],
      ['b', 'Application view is unavailable'],
    ],
  );
  view.post({ type: 'state-read', id: 'c' });
  view.fetches[1].reject(Error('Failed to fetch'));
  await settle();
  assert.deepEqual(view.replies.at(-1), { id: 'c', result: null, error: 'Failed to fetch' });
  view.post({ type: 'state-read', id: 'd' });
  assert.equal(view.fetches.length, 3);
});

test('state reads, queries and actions share one eight-request budget', async () => {
  const view = host();
  for (let index = 0; index < 7; index++) {
    view.post({ type: 'action', id: `act-${index}`, action: 'add', args: {} });
  }
  view.post({ type: 'state-read', id: 'read' });
  assert.equal(view.fetches.length, 8);
  // The budget is full: a query and an action are refused, a further read
  // joins the in-flight one without another request.
  view.post({ type: 'query', id: 'query', name: 'summary', args: {} });
  view.post({ type: 'action', id: 'act-extra', action: 'add', args: {} });
  view.post({ type: 'state-read', id: 'read-2' });
  assert.equal(view.fetches.length, 8);
  assert.deepEqual(
    view.replies.map((reply) => reply.id),
    ['query', 'act-extra'],
  );

  // When the read settles, its slot is free again; the seven actions still
  // hold theirs, so exactly one more request fits.
  view.fetches.find((entry) => entry.url.endsWith('/state'))!.resolve({ revision: 1, props: {} });
  await settle();
  view.post({ type: 'state-read', id: 'read-3' });
  view.post({ type: 'query', id: 'query-2', name: 'summary', args: {} });
  assert.equal(view.fetches.length, 9);
  assert.equal(view.replies.at(-1)!.id, 'query-2');
  assert.match(view.replies.at(-1)!.error, /Too many/);
});

test('oversized or missing request IDs are ignored, never echoed or fetched', () => {
  const view = host();
  view.post({ type: 'state-read', id: 'x'.repeat(101) });
  view.post({ type: 'state-read' });
  view.post({ type: 'unknown-kind', id: 'y'.repeat(5000) });
  assert.equal(view.fetches.length, 0);
  assert.equal(view.replies.length, 0);
});

test('ordinary widgets keep the generic state read and reject application queries', async () => {
  const view = host({ application: false });
  view.post({ type: 'state-read', id: 'w' });
  view.post({ type: 'query', id: 'q', name: 'summary', args: {} });
  assert.equal(view.fetches.length, 1);
  view.fetches[0].resolve({ revision: 2, props: { count: 2 } });
  await settle();
  assert.deepEqual(
    view.replies.map((reply) => [reply.id, reply.error]),
    [
      ['q', 'Unsupported widget request'],
      ['w', ''],
    ],
  );
});
