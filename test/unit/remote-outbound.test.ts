import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { PhoneOutput, type PhoneOutputLimits } from '../../src/remote/outbound.ts';
import type { GatewayMessage } from '../../src/remote/protocol.ts';

function fixture(limits?: PhoneOutputLimits) {
  const written: string[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  let failures = 0;
  const output = new PhoneOutput(
    {
      send(text: string, callback: (error?: Error) => void) {
        written.push(JSON.parse(text).message?.marker ?? JSON.parse(text).type);
        callbacks.push(callback);
      },
    } as Pick<WebSocket, 'send'>,
    () => {
      failures++;
    },
    limits,
  );
  function state(marker: string, replaceable = true) {
    output.send(
      { type: 'engine', message: { type: 'state', marker } } as unknown as GatewayMessage,
      replaceable,
    );
  }
  return { output, state, written, callbacks, failures: () => failures };
}

test('slow output keeps hydration and receipts ordered while replacing routine state', () => {
  const setup = fixture();
  setup.state('hydration', false);
  setup.state('obsolete');
  setup.output.send({ type: 'pong' });
  setup.state('latest');
  assert.deepEqual(setup.written, ['hydration']);
  setup.callbacks.shift()!();
  setup.callbacks.shift()!();
  setup.callbacks.shift()!();
  assert.deepEqual(setup.written, ['hydration', 'pong', 'latest']);
  assert.equal(setup.failures(), 0);
  setup.output.close();
});

test('queued bytes and message count are bounded independently', () => {
  for (const limits of [
    { queuedBytes: 1, queuedMessages: 10, stallMilliseconds: 1000 },
    { queuedBytes: 1024, queuedMessages: 1, stallMilliseconds: 1000 },
  ]) {
    const setup = fixture(limits);
    setup.state('hydration', false);
    setup.output.send({ type: 'pong' });
    setup.output.send({ type: 'pong' });
    assert.equal(setup.failures(), 1);
    setup.callbacks.shift()!();
    assert.deepEqual(setup.written, ['hydration']);
  }
});

test('stalled output closes once and disposal cancels its timer and queued data', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const setup = fixture({ queuedBytes: 1024, queuedMessages: 10, stallMilliseconds: 50 });
  setup.state('hydration', false);
  setup.state('pending');
  context.mock.timers.tick(50);
  assert.equal(setup.failures(), 1);
  setup.callbacks.shift()!();
  context.mock.timers.tick(50);
  assert.equal(setup.failures(), 1);

  const closed = fixture({ queuedBytes: 1024, queuedMessages: 10, stallMilliseconds: 50 });
  closed.state('hydration', false);
  closed.state('pending');
  closed.output.close();
  closed.callbacks.shift()!();
  context.mock.timers.tick(50);
  assert.equal(closed.failures(), 0);
  assert.deepEqual(closed.written, ['hydration']);
});

test('a write error releases all pending output', () => {
  const setup = fixture();
  setup.state('hydration', false);
  setup.state('pending');
  setup.callbacks.shift()!(Error('synthetic broken pipe'));
  assert.equal(setup.failures(), 1);
  assert.deepEqual(setup.written, ['hydration']);
});
