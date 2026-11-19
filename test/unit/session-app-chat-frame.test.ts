/** Opaque frame API: handles exist before admission, lost replies never replay. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../../integrations/widgets/frame.js', import.meta.url),
  'utf8',
).replace('await import(window.widgetModuleUrl)', 'globalThis.implementation');
const handle = {
  version: 1,
  grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestId: 'synthetic-request-id',
};

async function frame() {
  let listener: (event: unknown) => Promise<void>;
  let api: any;
  const sent: any[] = [];
  const timers = new Set<() => void>();
  const parent = {
    postMessage(message: unknown) {
      sent.push(structuredClone(message));
    },
  };
  vm.runInNewContext(source, {
    window: {
      addEventListener(type: string, callback: typeof listener) {
        if (type === 'message') listener = callback;
      },
    },
    parent,
    implementation: {
      mount(_root: unknown, value: any) {
        api = value;
        return { update() {} };
      },
    },
    document: {
      getElementById() {
        return {};
      },
      documentElement: { style: { setProperty() {} } },
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    structuredClone,
    console,
    setTimeout(callback: () => void) {
      timers.add(callback);
      return callback;
    },
    clearTimeout(callback: () => void) {
      timers.delete(callback);
    },
  });
  await listener!({
    source: parent,
    data: { type: 'command', kind: 'update', id: 1, props: {}, revision: 1, theme: {} },
  });
  return {
    api,
    sent,
    timers,
    answer(message: any, result: unknown, error?: string, foreign = false) {
      return listener({
        source: foreign ? {} : parent,
        data: { type: 'action-result', id: message.id, result, error },
      });
    },
    expire() {
      for (const timer of [...timers]) timer();
    },
  };
}

test('the frame prepares an immutable handle before sending and keeps it across lost replies/timeouts', async () => {
  const view = await frame();
  const preparing = view.api.chat.prepareSend();
  assert.equal(view.sent.at(-1).type, 'chat-prepare-send');
  assert.equal(view.sent.filter((message) => message.type === 'chat-send').length, 0);
  await view.answer(view.sent.at(-1), structuredClone(handle));
  const prepared = await preparing;
  assert.ok(Object.isFrozen(prepared));
  assert.deepEqual({ ...prepared }, handle);
  assert.equal(view.timers.size, 0);

  const sending = view.api.chat.send(prepared, 'Synthetic text');
  const message = view.sent.at(-1);
  assert.deepEqual(message.handle, handle);
  // Foreign replies cannot settle or clear the genuine pending operation.
  await view.answer(message, { state: 'completed' }, undefined, true);
  assert.equal(view.timers.size, 1);
  const refusal = assert.rejects(sending, /unconfirmed.*original handle/);
  view.expire();
  await refusal;
  assert.deepEqual({ ...prepared }, handle);
  assert.equal(view.sent.filter((message) => message.type === 'chat-send').length, 1);
  await view.answer(message, { state: 'completed' }); // late reply is ignored
  const probing = view.api.chat.receipt(prepared);
  assert.equal(view.sent.at(-1).type, 'chat-receipt');
  assert.deepEqual(view.sent.at(-1).handle, handle);
  await view.answer(view.sent.at(-1), null);
  assert.equal(await probing, null);
  assert.equal(view.sent.filter((message) => message.type === 'chat-send').length, 1);
});

test('sender calls share frame capacity and release it after lost acknowledgements and clone failures', async () => {
  const view = await frame();
  const pending = Array.from({ length: 8 }, () => view.api.chat.receipt(handle));
  await assert.rejects(view.api.chat.prepareSend(), /busy/);
  await assert.rejects(view.api.chat.read(), /busy/);
  const refused = pending.map((promise) => assert.rejects(promise, /not confirmed/));
  view.expire();
  await Promise.all(refused);
  const failure = view.api.chat.send(handle, () => {});
  await assert.rejects(failure); // structured-clone refusal
  const preparing = view.api.chat.prepareSend();
  await view.answer(view.sent.at(-1), handle);
  assert.deepEqual({ ...(await preparing) }, handle);
});
