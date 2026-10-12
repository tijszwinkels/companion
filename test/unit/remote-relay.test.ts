import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeviceStore } from '../../src/remote/devices.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { connectPhone, delay, freePort, waitFor } from '../remote-fixture.ts';

/** Adversarial upstream and network input; all state and sockets are synthetic. */
async function fixture(
  context: { after(callback: () => Promise<void>): void },
  onRequest: (socket: Socket, message: Record<string, unknown>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-relay-'));
  const sockets = new Set<Socket>();
  const controlSocket = join(directory, 'control.sock');
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        onRequest(socket, message);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(controlSocket, resolve));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const gateway = new Gateway({
    host: '127.0.0.1',
    port,
    origins: [origin],
    stateDirectory: join(directory, 'state'),
    controlSocket,
    sessionsDirectory: directory,
    appDirectory: directory,
    revocationCheckMilliseconds: 20,
    log: () => {},
  });
  await gateway.start();
  const devices = new DeviceStore(join(directory, 'state'));
  const { code } = await devices.createPairingCode();
  const paired = await devices.redeemPairingCode(code, 'Fixture');
  assert.ok(paired.ok);

  context.after(async () => {
    await gateway.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    devices,
    paired,
    sockets,
    origin,
    phone: (token: string | undefined = paired.token) =>
      connectPhone(`ws://127.0.0.1:${port}/api/socket`, token, origin),
  };
}

function roleAccepted(socket: Socket): void {
  socket.write(
    JSON.stringify({ type: 'result', requestId: 'role', result: 'role-recorded' }) + '\n',
  );
}

test('two relay slots include draining phones and leave listener capacity for desktop clients', async (context) => {
  let forwarded = false;
  const setup = await fixture(context, (socket, request) => {
    if (request.action === 'client-role') {
      roleAccepted(socket);
    } else {
      forwarded = true;
    }
  });
  const first = await setup.phone();
  await waitFor(() => first.messages.some((message) => message.type === 'authenticated'));
  first.send({ action: 'toggle-pause', requestId: 'draining' });
  await waitFor(() => forwarded);
  first.socket.terminate();
  await first.closed;
  const second = await setup.phone();
  await waitFor(() => second.messages.some((message) => message.type === 'authenticated'));
  const third = await setup.phone();
  assert.equal((await third.closed).code, 4429);
  assert.equal(setup.sockets.size, 2);
  second.socket.close();
  await second.closed;
  await waitFor(() => setup.sockets.size === 1);
  const replacement = await setup.phone();
  await waitFor(() => replacement.messages.some((message) => message.type === 'authenticated'));
  assert.equal(setup.sockets.size, 2);
});

test('a listener that rejects the role cannot leak its initial snapshot', async (context) => {
  const setup = await fixture(context, (socket) => {
    socket.write(
      JSON.stringify({ type: 'state', history: [], sessions: [], marker: 'private' }) + '\n',
    );
    socket.write(
      JSON.stringify({ type: 'error', requestId: 'role', message: 'unknown action' }) + '\n',
    );
  });
  const phone = await setup.phone();
  assert.equal((await phone.closed).code, 4503);
  assert.equal(phone.messages.filter((message) => message.type === 'engine').length, 0);
});

test('a listener that never confirms the role times out without exposing events', async (context) => {
  const setup = await fixture(context, (socket) => {
    socket.write(JSON.stringify({ type: 'state', history: [], sessions: [] }) + '\n');
  });
  const phone = await setup.phone();
  assert.equal((await phone.closed).code, 4503);
  assert.equal(phone.messages.filter((message) => message.type === 'engine').length, 0);
});

test('unknown and desktop-only events are withheld after role confirmation', async (context) => {
  const setup = await fixture(context, (socket) => {
    roleAccepted(socket);
    for (const type of [
      'future-private-event',
      'agent-draft',
      'agent-select',
      'agent-actions',
      'recording-append',
      'recording-finished',
    ]) {
      socket.write(JSON.stringify({ type, text: 'private fixture' }) + '\n');
    }
    socket.write(
      JSON.stringify({
        type: 'state',
        history: ['private fixture'],
        sessions: [],
        recordingAvailable: true,
        recording: { recordingId: 'r', sessionId: 's', state: 'recording' },
      }) + '\n',
    );
  });
  const phone = await setup.phone();
  await phone.engine('state');
  const events = phone.messages.filter((message) => message.type === 'engine');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].message.type === 'state' && events[0].message.history, []);
  // Manual recording is a desktop microphone/composer feature.
  assert.equal('recording' in events[0].message, false);
  assert.equal('recordingAvailable' in events[0].message, false);
});

test('oversized WebSocket input only disconnects the offending client', async (context) => {
  const setup = await fixture(context, roleAccepted);
  const phone = await setup.phone('');
  phone.socket.send('x'.repeat(33 * 1024));
  await phone.closed;
  const next = await setup.phone();
  await waitFor(() => next.messages.some((message) => message.type === 'authenticated'));
  next.socket.terminate();
});

test('revocation also closes a relay draining a disconnected phone', async (context) => {
  let forwarded = false;
  const setup = await fixture(context, (socket, message) => {
    if (message.action === 'client-role') {
      roleAccepted(socket);
    } else {
      forwarded = true;
    }
  });
  const phone = await setup.phone();
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
  phone.send({ action: 'toggle-pause', requestId: 'pending' });
  await waitFor(() => forwarded);
  phone.socket.terminate();
  await phone.closed;
  await delay(30);
  assert.equal(setup.sockets.size, 1, 'upstream is draining the pending reply');
  await setup.devices.revoke(setup.paired.device.id);
  await waitFor(() => setup.sockets.size === 0);
});

test('a stalled mutation times out with a replayable uncertain result', async (context) => {
  let executionCount = 0;
  const setup = await fixture(context, (socket, message) => {
    if (message.action === 'client-role') {
      roleAccepted(socket);
    } else {
      executionCount++;
    }
  });
  const phone = await setup.phone();
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
  phone.send({ action: 'toggle-pause', requestId: 'stalled' });
  assert.equal((await phone.closed).code, 4503);
  const retry = await setup.phone();
  await waitFor(() => retry.messages.some((message) => message.type === 'authenticated'));
  retry.send({ action: 'toggle-pause', requestId: 'stalled' });
  const reply = await retry.reply('stalled');
  assert.equal(reply.type, 'error');
  assert.ok(reply.type === 'error' && reply.duplicate);
  assert.equal(executionCount, 1);
});

test('an authenticated heartbeat replies without forwarding a listener request', async (context) => {
  let upstreamRequests = 0;
  const setup = await fixture(context, (socket) => {
    upstreamRequests++;
    roleAccepted(socket);
  });
  const phone = await setup.phone();
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
  phone.socket.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => phone.messages.some((message) => message.type === 'pong'));
  assert.equal(upstreamRequests, 1, 'only the role declaration reaches the listener');
});
