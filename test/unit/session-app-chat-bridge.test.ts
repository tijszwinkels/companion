/** Trusted host ingress with synthetic iframe identity, clock and deferred IO. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../integrations/widgets/host.js', import.meta.url), 'utf8');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (revision = 'a', text = 'Synthetic earlier text') => ({
  changed: true,
  revision: revision.repeat(64),
  status: 'running',
  truncated: false,
  messages: [
    {
      id: 'row',
      role: 'assistant',
      source: 'assistant',
      text,
      state: 'streaming',
      truncated: false,
    },
  ],
});

function host(application = true) {
  let now = 1000;
  let tick = () => {};
  const events = new Map<string, (event?: unknown) => void>();
  const messages: any[] = [];
  const requests: {
    url: string;
    body: any;
    resolve: (value: unknown, status?: number) => void;
    reject: (error: Error) => void;
  }[] = [];
  const child = {
    postMessage(message: any) {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.type === 'command') {
        queueMicrotask(() => post({ type: 'result', id: message.id, result: true }));
      }
    },
  };
  const element = () => ({ contentWindow: child, setAttribute() {}, textContent: '' });
  const document = {
    hidden: false,
    createElement: element,
    body: { append() {} },
    addEventListener(type: string, callback: () => void) {
      events.set(type, callback);
    },
  };
  const context = vm.createContext({
    window: {
      widgetBootstrap: {
        api: true,
        ...(application ? { application: { version: 7 } } : {}),
        props: {},
        revision: 1,
        theme: {},
        document: '',
        title: 'Synthetic',
      },
      addEventListener(type: string, callback: (event?: unknown) => void) {
        events.set(type, callback);
      },
    },
    document,
    location: { href: 'http://127.0.0.1:1234/view/' + 'a'.repeat(64), reload() {} },
    performance: { now: () => now },
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout() {},
    clearTimeout() {},
    setInterval(callback: () => void) {
      tick = callback;
    },
    fetch(url: string, init?: { body?: string }) {
      return new Promise((resolve, reject) =>
        requests.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
          reject,
          resolve(value, status = 200) {
            resolve({
              ok: status === 200,
              json: async () => value,
              text: async () => JSON.stringify(value),
            });
          },
        }),
      );
    },
  });
  function post(data: unknown, source: unknown = child) {
    events.get('message')!({ source, data });
  }
  vm.runInContext(source, context);
  post({ type: 'ready' });
  return {
    messages,
    requests,
    post,
    replies: () => messages.filter((message) => message.type === 'action-result'),
    updates: () => messages.filter((message) => message.type === 'chat-update'),
    advance() {
      now += 401;
    },
    tick() {
      tick();
    },
    hide() {
      document.hidden = true;
      events.get('visibilitychange')!();
    },
    show() {
      document.hidden = false;
      events.get('visibilitychange')!();
    },
    async access(allowed: boolean, version = 7) {
      post({ type: 'state-read', id: 'permission-probe' });
      requests.at(-1)!.resolve({ version, chatReadAllowed: allowed, revision: 1, props: {} });
      await settle();
    },
  };
}

test('chat permission cannot be granted by raw frame messages, arguments, another frame or ordinary widgets', async () => {
  const view = host();
  view.post({ type: 'chat-read', id: 'denied' });
  view.post({ type: 'chat-read', id: 'forged', allowed: true, version: 7 });
  view.post({ type: 'chat-grant', id: 'grant', allowed: true });
  view.post({ type: 'chat-read', id: 'foreign' }, {});
  view.post({ type: 'chat-read', id: 'x'.repeat(101) });
  assert.equal(view.requests.length, 0);
  assert.equal(view.replies().length, 3);
  assert.ok(view.replies().every((reply) => reply.error));
  const widget = host(false);
  await widget.access(true);
  widget.post({ type: 'chat-read', id: 'ordinary' });
  assert.match(widget.replies().at(-1).error, /not currently permitted/);
  assert.equal(widget.requests.filter((request) => request.url.endsWith('/chat-read')).length, 0);
});

test('one bounded flight uses host version, serves eight readers and enforces the polling interval', async () => {
  const view = host();
  await view.access(true);
  for (let index = 0; index < 100; index++) {
    view.post({ type: 'chat-read', id: String(index) });
  }
  assert.equal(view.requests.length, 2);
  assert.deepEqual(view.requests[1].body, { version: 7 });
  assert.equal(view.replies().filter((reply) => reply.error).length, 92);
  view.requests[1].resolve(snapshot());
  await settle();
  assert.equal(view.replies().filter((reply) => reply.result?.messages).length, 8);
  view.post({ type: 'chat-read', id: 'cached' });
  assert.equal(view.requests.length, 2);
  assert.equal(view.replies().at(-1).result.messages[0].text, 'Synthetic earlier text');
  view.advance();
  view.post({ type: 'chat-read', id: 'next' });
  assert.deepEqual(view.requests[2].body, { version: 7, after: 'a'.repeat(64) });
  view.requests[2].resolve({ changed: false, revision: 'a'.repeat(64) });
  await settle();
  assert.equal(view.replies().at(-1).id, 'next');
  assert.equal(view.replies().at(-1).result.messages.length, 1);
});

test('observed revoke and stale code discard pending replies and clear the complete window', async () => {
  for (const version of [7, 8]) {
    const view = host();
    view.post({ type: 'chat-watch', watching: true });
    await view.access(true);
    view.post({ type: 'chat-read', id: 'old' });
    const late = view.requests.at(-1)!;
    await view.access(version === 8, version);
    late.resolve(snapshot());
    await settle();
    assert.ok(view.replies().find((reply) => reply.id === 'old').error);
    assert.ok(!view.replies().some((reply) => reply.result?.messages));
    assert.equal(view.updates().at(-1).available, false);
    assert.equal(view.updates().at(-1).snapshot, null);
  }
});

test('hidden views withdraw cached and in-flight history, stop polling and require a fresh state observation', async () => {
  const view = host();
  view.post({ type: 'chat-watch', watching: true });
  await view.access(true);
  view.post({ type: 'chat-read', id: 'pending' });
  const late = view.requests.at(-1)!;
  view.hide();
  view.tick();
  assert.equal(view.requests.length, 2);
  late.resolve(snapshot());
  await settle();
  assert.equal(view.updates().at(-1).snapshot, null);
  view.show();
  view.post({ type: 'chat-read', id: 'before-state' });
  assert.ok(view.replies().at(-1).error);
  await view.access(true);
  view.advance();
  view.post({ type: 'chat-read', id: 'after-state' });
  view.requests.at(-1)!.resolve(snapshot('b'));
  await settle();
  assert.equal(view.replies().at(-1).result.revision, 'b'.repeat(64));
});

test('subscriptions replace complete windows and re-subscription receives an unchanged snapshot', async () => {
  const view = host();
  view.post({ type: 'chat-watch', watching: true });
  await view.access(true);
  view.post({ type: 'chat-read', id: 'first' });
  view.requests.at(-1)!.resolve(snapshot());
  await settle();
  view.advance();
  view.post({ type: 'chat-read', id: 'removed' });
  view.requests.at(-1)!.resolve({ ...snapshot('b'), messages: [] });
  await settle();
  assert.deepEqual(view.updates().at(-1).snapshot.messages, []);
  view.post({ type: 'chat-watch', watching: false });
  view.post({ type: 'chat-watch', watching: true });
  assert.equal(view.updates().at(-1).snapshot, null);
  view.advance();
  view.tick();
  view.requests.at(-1)!.resolve({ version: 7, chatReadAllowed: true, revision: 1, props: {} });
  await settle();
  assert.ok(view.requests.at(-1)!.url.endsWith('/chat-read'));
  view.requests.at(-1)!.resolve({ changed: false, revision: 'b'.repeat(64) });
  await settle();
  assert.equal(view.updates().at(-1).snapshot.revision, 'b'.repeat(64));
});

test('chat shares the eight-operation budget and backend denial fails closed without silent retry', async () => {
  const view = host();
  await view.access(true);
  for (let index = 0; index < 8; index++) {
    view.post({ type: 'query', id: 'q' + index, name: 'q', args: {} });
  }
  view.post({ type: 'chat-read', id: 'full' });
  assert.match(view.replies().at(-1).error, /Too many widget/);
  view.requests[1].resolve({ result: true });
  await settle();
  view.post({ type: 'chat-read', id: 'denied' });
  view.requests.at(-1)!.resolve({ error: 'Forbidden' }, 403);
  await settle();
  const count = view.requests.length;
  view.advance();
  view.post({ type: 'chat-read', id: 'retry' });
  assert.equal(view.requests.length, count);
  assert.match(view.replies().at(-1).error, /not currently permitted/);
});

test('oversized chat responses are discarded rather than delivered', async () => {
  const view = host();
  await view.access(true);
  view.post({ type: 'chat-read', id: 'large' });
  view.requests.at(-1)!.resolve(snapshot('a', 'x'.repeat(65536)));
  await settle();
  assert.match(view.replies().at(-1).error, /exceeds/);
  assert.ok(!view.replies().some((reply) => reply.result?.messages));
});
