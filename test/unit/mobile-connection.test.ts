import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Connection, UncertainOutcome } from '../../integrations/mobile/src/connection.ts';

/** Browser transport double: an OPEN socket can silently drop all traffic. */
class SilentSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly instances: SilentSocket[] = [];
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    super();
    SilentSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  message(message: object): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }));
  }
}

/** Install synthetic browser globals and restore them after each isolated test. */
function connectedBrowser(context: TestContext): {
  connection: Connection;
  socket: SilentSocket;
  events: unknown[];
} {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let connection: Connection | undefined;
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  context.after(() => {
    connection?.forget();
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  install(
    'window',
    Object.assign(new EventTarget(), { location: { origin: 'http://127.0.0.1:8787' } }),
  );
  install('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  install('navigator', { onLine: true });
  install('localStorage', {
    getItem: () => JSON.stringify({ token: 'synthetic', deviceId: 'fixture', server: '' }),
    removeItem: () => {},
  });
  install('WebSocket', SilentSocket);
  SilentSocket.instances.length = 0;
  const events: unknown[] = [];
  connection = new Connection(
    (event) => events.push(event),
    () => {},
    () => {},
  );
  connection.start();
  const first = SilentSocket.instances[0];
  first.open();
  first.message({ type: 'authenticated', deviceId: 'fixture', deviceName: 'Fixture' });
  assert.equal(connection.state.status, 'online');
  return { connection, socket: first, events };
}

test('a silently dead OPEN socket reconnects and cannot replay mutations or apply stale events', async (context) => {
  const { connection, socket: first, events } = connectedBrowser(context);

  context.mock.timers.tick(15_000);
  assert.equal(first.sent.at(-1)?.type, 'ping');
  const mutation = connection.request('toggle-pause', {});
  const uncertain = assert.rejects(mutation, UncertainOutcome);

  // No offline/close event arrives, and the heartbeat gets no reply.
  context.mock.timers.tick(15_000);
  assert.equal(first.readyState, WebSocket.OPEN);
  context.mock.timers.tick(5000);
  await uncertain;
  assert.equal(connection.state.status, 'reconnecting');
  first.message({ type: 'engine', message: { type: 'agent-removed', id: 'stale' } });
  assert.deepEqual(events, []);

  context.mock.timers.tick(1201);
  assert.equal(SilentSocket.instances.length, 2);
  const second = SilentSocket.instances[1];
  second.open();
  second.message({ type: 'authenticated', deviceId: 'fixture', deviceName: 'Fixture' });
  assert.equal(connection.state.status, 'online');
  assert.equal(second.sent.filter((message) => message.type === 'request').length, 0);

  // Foregrounding a healthy connection probes without losing a pending reply.
  const delivered = connection.request('toggle-sounds', {});
  const request = second.sent.at(-1)!;
  window.dispatchEvent(new Event('online'));
  assert.equal(SilentSocket.instances.length, 2);
  assert.equal(second.readyState, WebSocket.OPEN);
  assert.equal(second.sent.at(-1)?.type, 'ping');
  second.message({ type: 'pong' });
  second.message({
    type: 'result',
    requestId: request.requestId,
    action: 'toggle-sounds',
    result: 'sounds-enabled',
  });
  assert.equal(await delivered, 'sounds-enabled');
  context.mock.timers.tick(5001);
  assert.equal(connection.state.status, 'online');
});

test('an overdue heartbeat probes before discarding a buffered reply on resume', async (context) => {
  const { connection, socket } = connectedBrowser(context);
  const delivered = connection.request('toggle-sounds', {});
  const request = socket.sent.at(-1)!;

  // Simulate a wall-clock jump while JS was suspended. The heartbeat is the
  // first resumed callback; visibilitychange and a buffered reply arrive next.
  context.mock.method(Date, 'now', () => 60_000);
  context.mock.timers.tick(15_000);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(connection.state.status, 'online');
  assert.equal(socket.sent.at(-1)?.type, 'ping');
  const sentBeforeVisibility = socket.sent.length;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(socket.sent.length, sentBeforeVisibility);

  socket.message({
    type: 'result',
    requestId: request.requestId,
    action: 'toggle-sounds',
    result: 'sounds-enabled',
  });
  assert.equal(await delivered, 'sounds-enabled');
  context.mock.timers.tick(5001);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(SilentSocket.instances.length, 1);
});

test('a foreground probe refuses new mutations until the connection answers', async (context) => {
  const { connection, socket } = connectedBrowser(context);
  document.dispatchEvent(new Event('visibilitychange'));

  await assert.rejects(connection.request('toggle-pause', {}), (error: Error) => {
    assert.ok(!(error instanceof UncertainOutcome));
    assert.match(error.message, /Checking connection/);
    return true;
  });
  assert.equal(socket.sent.filter((message) => message.type === 'request').length, 0);

  socket.message({ type: 'pong' });
  const delivered = connection.request('toggle-pause', {});
  const request = socket.sent.at(-1)!;
  socket.message({ type: 'result', requestId: request.requestId, result: 'paused' });
  assert.equal(await delivered, 'paused');

  // A later probe with no reply must still retire an idle, half-open socket.
  connection.connectNow();
  context.mock.timers.tick(5000);
  assert.equal(socket.readyState, 3);
  assert.equal(connection.state.status, 'reconnecting');
  assert.equal(connection.paired, true);
});

test('an overdue request deadline permits a buffered reply but grants only one grace period', async (context) => {
  const { connection, socket } = connectedBrowser(context);
  const delivered = connection.request('toggle-sounds', {});
  const request = socket.sent.at(-1)!;
  context.mock.timers.tick(15_000);
  socket.message({ type: 'pong' });

  context.mock.method(Date, 'now', () => 60_000);
  context.mock.timers.tick(5000);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(socket.sent.at(-1)?.type, 'ping');
  socket.message({ type: 'result', requestId: request.requestId, result: 'sounds-enabled' });
  assert.equal(await delivered, 'sounds-enabled');

  const unacknowledged = connection.request('toggle-pause', {});
  const uncertain = assert.rejects(unacknowledged, UncertainOutcome);
  context.mock.timers.tick(15_000);
  socket.message({ type: 'pong' });
  context.mock.method(Date, 'now', () => 120_000);
  context.mock.timers.tick(5000);
  socket.message({ type: 'pong' });
  context.mock.timers.tick(5000);
  await uncertain;
  assert.equal(connection.state.status, 'reconnecting');
  assert.equal(socket.sent.filter((message) => message.type === 'request').length, 2);
});
