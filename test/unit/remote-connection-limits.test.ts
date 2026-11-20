import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import test from 'node:test';

import { maximumClients } from '../../src/desktop/server.ts';
import type { AgentModelCatalog } from '../../src/agents/types.ts';
import {
  maximumConnectionsPerDevice,
  maximumRemoteConnections,
} from '../../src/remote/protocol.ts';
import { deferred } from '../helpers.ts';
import { connectPhone, remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';

/**
 * Connection limits, as one table derived from the rules in
 * src/remote/README.md ("Limits") and src/desktop/README.md ("Remote panels"):
 *
 * - The gateway relays at most 8 authenticated connections in total and at
 *   most 4 per paired device. Draining connections (closed by the client,
 *   still waiting for a reply) count.
 * - A new connection over a limit is refused after authentication with close
 *   code 4429 and the reason `device` (its own device is full, reported first)
 *   or `total`. It receives nothing else: no device name or id.
 * - Open connections are never closed to make room; a close (or the end of a
 *   drain) frees the slot.
 * - A revoked device's connections close (4403) and free their slots; its new
 *   connections are not paired (4401).
 * - At most 8 sockets wait unauthenticated, and at most 16 gateway sockets
 *   exist in all; another upgrade is refused with 503. Waiting sockets hold
 *   no relay slot.
 * - The listener serves 16 clients; the 17th is closed before it receives
 *   anything.
 *
 * Everything runs against a real listener control socket, the real gateway
 * and a synthetic agent backend in temporary directories.
 */

// The rules above are the numbers this table is written for.
assert.equal(maximumRemoteConnections, 8);
assert.equal(maximumConnectionsPerDevice, 4);
assert.equal(maximumClients, 16);

type Device = 'A' | 'B' | 'C';

/** One step of a case. Labels name connections, e.g. `A1` is device A's first. */
type Step =
  /** Connect and authenticate; it must be relayed. */
  | { open: string }
  /** Connect and authenticate; it must be refused with this reason. */
  | { refused: Device; reason: 'device' | 'total' }
  /** Hold a request open in the listener, then close the client: it drains. */
  | { drain: string }
  /** Let the held requests answer, so draining connections finish. */
  | { release: true }
  /** The client closes its connection. */
  | { close: string }
  /** Revoke a device: these of its connections must close with 4403. */
  | { revoke: Device; closes: string[] }
  /** A revoked device's new connection is not paired. */
  | { unpaired: Device }
  /** Open a socket that never authenticates. */
  | { wait: string }
  /** A waiting socket authenticates now as this device; it must be refused. */
  | { authenticateRefused: string; as: Device; reason: 'device' | 'total' }
  /** The next WebSocket upgrade must be refused with HTTP 503. */
  | { upgradeRefused: true }
  /** These connections must still be open. */
  | { stillOpen: string[] };

interface Case {
  rule: string;
  steps: Step[];
}

/** `A1`…`A4` style labels for one device (`U`: unauthenticated sockets). */
function labels(device: Device | 'U', from: number, to: number): string[] {
  const result: string[] = [];
  for (let index = from; index <= to; index++) {
    result.push(`${device}${index}`);
  }
  return result;
}

function openAll(names: string[]): Step[] {
  return names.map((name) => ({ open: name }));
}

const cases: Case[] = [
  {
    rule: 'a device may hold 4 connections',
    steps: [...openAll(labels('A', 1, 4)), { stillOpen: labels('A', 1, 4) }],
  },
  {
    rule: "a device's 5th connection is refused with `device`; its 4 stay open",
    steps: [
      ...openAll(labels('A', 1, 4)),
      { refused: 'A', reason: 'device' },
      { stillOpen: labels('A', 1, 4) },
    ],
  },
  {
    rule: 'with 8 connections in total another device is refused with `total`',
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 4)]),
      { refused: 'C', reason: 'total' },
      { stillOpen: [...labels('A', 1, 4), ...labels('B', 1, 4)] },
    ],
  },
  {
    rule: 'a device at its own limit hears `device` even when the total is full too',
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 4)]),
      { refused: 'A', reason: 'device' },
    ],
  },
  {
    rule: 'a device below its limit hears `total` when the total is full',
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 3), 'C1']),
      { refused: 'B', reason: 'total' },
      { stillOpen: [...labels('A', 1, 4), ...labels('B', 1, 3), 'C1'] },
    ],
  },
  {
    rule: 'a draining connection counts toward its device until it has drained',
    steps: [
      { open: 'A1' },
      { drain: 'A1' },
      ...openAll(labels('A', 2, 4)),
      { refused: 'A', reason: 'device' },
      { release: true },
      { open: 'A5' },
    ],
  },
  {
    rule: 'a draining connection counts toward the total until it has drained',
    steps: [
      ...openAll(labels('A', 1, 4)),
      { open: 'B1' },
      { drain: 'B1' },
      ...openAll(labels('B', 2, 4)),
      { refused: 'C', reason: 'total' },
      { release: true },
      { open: 'C1' },
    ],
  },
  {
    rule: "a close frees a slot for the same device's next connection",
    steps: [...openAll(labels('A', 1, 4)), { close: 'A1' }, { open: 'A5' }],
  },
  {
    rule: 'a close frees a slot in the total for another device',
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 4)]),
      { close: 'B1' },
      { open: 'C1' },
      { stillOpen: [...labels('A', 1, 4), ...labels('B', 2, 4)] },
    ],
  },
  {
    rule: "revoking a device closes its connections and frees their slots; it can't reconnect",
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 4)]),
      { revoke: 'B', closes: labels('B', 1, 4) },
      ...openAll(labels('C', 1, 4)),
      { unpaired: 'B' },
      { stillOpen: labels('A', 1, 4) },
    ],
  },
  {
    rule: 'at most 8 sockets wait unauthenticated; a 9th upgrade is refused until one leaves',
    steps: [
      ...labels('U', 1, 8).map((name) => ({ wait: name })),
      { upgradeRefused: true },
      { close: 'U1' },
      { open: 'A1' },
    ],
  },
  {
    rule: 'waiting sockets hold no relay slot; with 8 relays, 8 more may wait, then 503',
    steps: [
      ...openAll([...labels('A', 1, 4), ...labels('B', 1, 4)]),
      ...labels('U', 1, 8).map((name) => ({ wait: name })),
      { upgradeRefused: true },
      { authenticateRefused: 'U1', as: 'C', reason: 'total' },
      { stillOpen: [...labels('A', 1, 4), ...labels('B', 1, 4)] },
    ],
  },
];

for (const limitCase of cases) {
  test(`limits: ${limitCase.rule}`, async (context) => {
    // Held `agent-models` requests keep a closed connection draining.
    let modelsHeld = deferred<void>();
    let modelRequests = 0;
    const catalog: AgentModelCatalog = { models: ['local/qwen-synthetic'], thinkingLevels: {} };
    const setup = await remoteFixture({
      models: async () => {
        modelRequests++;
        await modelsHeld.promise;
        return catalog;
      },
    });
    context.after(() => setup.close());

    const url = `ws://127.0.0.1:${setup.port}/api/socket`;
    const tokens = new Map<Device, string>();
    for (const device of ['A', 'B', 'C'] as const) {
      const { code } = await setup.devices.createPairingCode();
      const paired = await setup.devices.redeemPairingCode(code, `Device ${device}`);
      assert.ok(paired.ok);
      tokens.set(device, paired.token);
    }
    const deviceIds = new Map<Device, string>();
    for (const device of await setup.devices.devices()) {
      deviceIds.set(device.name.slice(-1) as Device, device.id);
    }

    const connections = new Map<string, PhoneClient>();
    const relays = () => (setup.gateway as unknown as { relays: Map<unknown, string> }).relays;

    for (const step of limitCase.steps) {
      if ('open' in step) {
        const device = step.open[0] as Device;
        const client = await connectPhone(url, tokens.get(device), setup.origin);
        connections.set(step.open, client);
        await waitFor(() => client.messages.some((message) => message.type === 'authenticated'));
        await client.engine('state');
        continue;
      }

      if ('refused' in step) {
        const client = await connectPhone(url, tokens.get(step.refused), setup.origin);
        const closed = await client.closed;
        assert.deepEqual(closed, { code: 4429, reason: step.reason });
        // Nothing else reaches a refused newcomer: no name, no device id.
        assert.deepEqual(client.messages, []);
        continue;
      }

      if ('drain' in step) {
        const client = connections.get(step.drain)!;
        const before = relays().size;
        const requestsBefore = modelRequests;
        client.send({ action: 'agent-models', requestId: `drain-${step.drain}` });
        // Leave once the listener is working on the request.
        await waitFor(() => modelRequests > requestsBefore);
        client.socket.terminate();
        await client.closed;
        // Still relayed while its request is outstanding.
        assert.equal(relays().size, before);
        continue;
      }

      if ('release' in step) {
        const draining = relays().size;
        modelsHeld.resolve();
        modelsHeld = deferred<void>();
        await waitFor(() => relays().size < draining, 3000);
        continue;
      }

      if ('close' in step) {
        const client = connections.get(step.close)!;
        const before = relays().size;
        client.socket.close();
        await client.closed;
        connections.delete(step.close);
        if (!step.close.startsWith('U')) {
          await waitFor(() => relays().size < before);
        }
        continue;
      }

      if ('revoke' in step) {
        assert.equal(await setup.devices.revoke(deviceIds.get(step.revoke)!), true);
        for (const name of step.closes) {
          assert.equal((await connections.get(name)!.closed).code, 4403);
          connections.delete(name);
        }
        await waitFor(() => relays().size === connections.size, 3000);
        continue;
      }

      if ('unpaired' in step) {
        const client = await connectPhone(url, tokens.get(step.unpaired), setup.origin);
        assert.equal((await client.closed).code, 4401);
        continue;
      }

      if ('wait' in step) {
        connections.set(step.wait, await connectPhone(url, undefined, setup.origin));
        continue;
      }

      if ('authenticateRefused' in step) {
        const client = connections.get(step.authenticateRefused)!;
        client.socket.send(JSON.stringify({ type: 'auth', token: tokens.get(step.as) }));
        assert.deepEqual(await client.closed, { code: 4429, reason: step.reason });
        connections.delete(step.authenticateRefused);
        continue;
      }

      if ('upgradeRefused' in step) {
        await assert.rejects(connectPhone(url, undefined, setup.origin), /HTTP 503/);
        continue;
      }

      for (const name of step.stillOpen) {
        const client = connections.get(name)!;
        assert.equal(client.socket.readyState, client.socket.OPEN, `${name} is still open`);
      }
    }

    // Never more relays than the rule allows, at any point a step observed.
    assert.ok(relays().size <= maximumRemoteConnections);
  });
}

test('limits: the listener serves 16 clients, 8 of them through the gateway; the 17th is closed unread', async (context) => {
  const setup = await remoteFixture();
  context.after(() => setup.close());

  // Eight gateway relays from two devices.
  const url = `ws://127.0.0.1:${setup.port}/api/socket`;
  const phones: PhoneClient[] = [];
  for (const device of ['A', 'B']) {
    const { code } = await setup.devices.createPairingCode();
    const paired = await setup.devices.redeemPairingCode(code, `Device ${device}`);
    assert.ok(paired.ok);
    for (let index = 0; index < 4; index++) {
      const phone = await connectPhone(url, paired.token, setup.origin);
      await phone.engine('state');
      phones.push(phone);
    }
  }

  // The fixture's own desktop client plus seven more fill the other half.
  const desktops: { socket: Socket; received: () => boolean }[] = [];
  async function desktop() {
    const socket = createConnection(setup.desktop.socketPath);
    let data = false;
    socket.on('data', () => {
      data = true;
    });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const client = { socket, received: () => data };
    desktops.push(client);
    return client;
  }
  for (let index = 0; index < 7; index++) {
    const client = await desktop();
    await waitFor(() => client.received());
  }

  // The 17th client is closed before it receives anything.
  const extra = await desktop();
  await once(extra.socket, 'close');
  assert.equal(extra.received(), false);

  // A freed slot is usable again.
  desktops[0].socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const replacement = await desktop();
  await waitFor(() => replacement.received());

  // Every phone kept its connection throughout.
  for (const phone of phones) {
    assert.equal(phone.socket.readyState, phone.socket.OPEN);
  }
  for (const client of desktops) {
    client.socket.destroy();
  }
});

test("limits: a device's connections share one request rate; another device has its own", async (context) => {
  const setup = await remoteFixture();
  context.after(() => setup.close());
  const url = `ws://127.0.0.1:${setup.port}/api/socket`;

  async function device(name: string, count: number): Promise<PhoneClient[]> {
    const { code } = await setup.devices.createPairingCode();
    const paired = await setup.devices.redeemPairingCode(code, name);
    assert.ok(paired.ok);
    const clients: PhoneClient[] = [];
    for (let index = 0; index < count; index++) {
      const client = await connectPhone(url, paired.token, setup.origin);
      await client.engine('state');
      clients.push(client);
    }
    return clients;
  }

  const [first, second] = await device('Tabs', 2);
  const [other] = await device('Phone', 1);
  const pongs = (client: PhoneClient) =>
    client.messages.filter((message) => message.type === 'pong').length;

  // 25 heartbeats from each of the device's two tabs: one bucket of 30.
  for (let index = 0; index < 25; index++) {
    first.socket.send(JSON.stringify({ type: 'ping' }));
    second.socket.send(JSON.stringify({ type: 'ping' }));
  }
  // The other device's 25 all fit in its own bucket.
  for (let index = 0; index < 25; index++) {
    other.socket.send(JSON.stringify({ type: 'ping' }));
  }

  await waitFor(() => pongs(other) === 25);
  await waitFor(() => pongs(first) + pongs(second) >= 30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const shared = pongs(first) + pongs(second);
  // 30 from the burst, plus at most a few refilled while the test ran.
  assert.ok(shared >= 30 && shared <= 34, `shared device answered ${shared} heartbeats`);
});
