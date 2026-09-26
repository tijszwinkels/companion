import assert from 'node:assert/strict';
import test from 'node:test';

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

test('a silently dead OPEN socket reconnects and cannot replay mutations or apply stale events', async (context) => {
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

  context.mock.timers.tick(15_000);
  assert.equal(first.sent.at(-1)?.type, 'ping');
  const mutation = connection.request('toggle-pause', {});
  const uncertain = assert.rejects(mutation, UncertainOutcome);

  // No offline/close event arrives, and the heartbeat gets no reply.
  context.mock.timers.tick(15_000);
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
