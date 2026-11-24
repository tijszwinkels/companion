import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

import { DeviceStore } from '../../src/remote/devices.ts';
import { ReceiptBook } from '../../src/remote/receipts.ts';
import { Relay } from '../../src/remote/relay.ts';
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

test('relay slots include draining phones and leave listener capacity for desktop clients', async (context) => {
  // The full limit rules are tabled in remote-connection-limits.test.ts; this
  // repeats the draining case against a listener that never answers.
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
  const open = [];
  for (let index = 0; index < 3; index++) {
    const phone = await setup.phone();
    await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
    open.push(phone);
  }
  const fifth = await setup.phone();
  assert.deepEqual(await fifth.closed, { code: 4429, reason: 'device' });
  assert.equal(setup.sockets.size, 4);
  open[0].socket.close();
  await open[0].closed;
  await waitFor(() => setup.sockets.size === 3);
  const replacement = await setup.phone();
  await waitFor(() => replacement.messages.some((message) => message.type === 'authenticated'));
  assert.equal(setup.sockets.size, 4);
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

test('a phone that leaves while the role is pending never reports a visible page', async (context) => {
  const received: Record<string, unknown>[] = [];
  let listener: Socket | undefined;
  const setup = await fixture(context, (socket, request) => {
    listener = socket;
    received.push(request);
  });
  const phone = await setup.phone();
  await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'));
  await waitFor(() => received.length === 1);

  // Queued behind the role; the phone leaves before the listener confirms.
  phone.send({
    action: 'panel-state',
    requestId: 'shown',
    id: '00000000-0000-4000-8000-000000000001',
    visible: true,
  });
  await delay(30);
  phone.socket.terminate();
  await phone.closed;

  roleAccepted(listener!);
  await waitFor(() => received.length === 3);
  assert.equal(received[0].action, 'client-role');
  // The queued report keeps its selection and place, but the page is gone:
  // it must not read anything the listener finished meanwhile.
  assert.deepEqual(received[1], {
    action: 'panel-state',
    id: '00000000-0000-4000-8000-000000000001',
    visible: false,
    requestId: received[1].requestId,
  });
  // Then the withdrawal, which names no conversation.
  assert.deepEqual(received[2], { action: 'withdraw-visibility', requestId: 'withdraw' });
});

/**
 * A stand-in for the gateway's WebSocket to a phone, so a test can hold it
 * in the CLOSING state (closing handshake started, no `close` event yet).
 */
class FakePhone extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readyState = 1;
  readonly sent: string[] = [];

  send(text: string, callback?: (error?: Error) => void): void {
    this.sent.push(text);
    callback?.();
  }

  close(): void {
    this.readyState = this.CLOSING;
  }
}

test('a report forwarded while the phone is closing is never visible', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-relay-closing-'));
  const controlSocket = join(directory, 'control.sock');
  const received: Record<string, unknown>[] = [];
  let listener: Socket | undefined;
  const server = createServer((socket) => {
    listener = socket;
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(controlSocket, resolve));
  const phone = new FakePhone();
  const relay = new Relay(phone as unknown as WebSocket, {
    controlSocket,
    sessionsDirectory: directory,
    deviceId: 'device',
    receipts: new ReceiptBook(),
    takeToken: () => true,
    takeDraftToken: () => true,
    allowScreenshot: () => {},
    onClosed: () => {},
    log: () => {},
  });
  context.after(async () => {
    relay.terminate(4001, 'Test over');
    listener?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => received.length === 1);

  // A visible report waits for the role; then the closing handshake starts.
  const report = {
    type: 'request',
    requestId: 'shown',
    action: 'panel-state',
    id: '00000000-0000-4000-8000-000000000003',
    visible: true,
  };
  phone.emit('message', Buffer.from(JSON.stringify(report)), false);
  phone.readyState = phone.CLOSING;

  // The role is confirmed during the handshake, before any `close` event.
  roleAccepted(listener!);
  await waitFor(() => received.length >= 2);
  assert.equal(received[1].action, 'panel-state');
  assert.equal(received[1].visible, false);
  // The page is already gone: its visibility is withdrawn right after.
  await waitFor(() => received.length === 3);
  assert.equal(received[2].action, 'withdraw-visibility');
});

test('draft events reach only connections that asked for drafts, and panel reports say so', async (context) => {
  // A listener that misbehaves: it sends draft events and a desktop focus
  // request to every connection. The gateway's own filter must hold.
  const reports: Record<string, unknown>[] = [];
  const setup = await fixture(context, (socket, request) => {
    if (request.action === 'client-role') {
      roleAccepted(socket);
      return;
    }
    if (request.action === 'panel-state') {
      reports.push(request);
    }
    const events = [
      {
        type: 'draft-snapshot',
        sequence: 1,
        drafts: [{ id: 'x', text: 'secret', source: '', sequence: 1 }],
      },
      { type: 'draft', id: 'x', text: 'secret', source: '', sequence: 2 },
      { type: 'agent-draft-focus', id: 'x' },
    ];
    for (const event of events) {
      socket.write(JSON.stringify(event) + '\n');
    }
    socket.write(
      JSON.stringify({ type: 'result', requestId: request.requestId, result: 'panel-recorded' }) +
        '\n',
    );
  });
  const url = `ws://${new URL(setup.origin).host}/api/socket`;
  const host = await connectPhone(url, setup.paired.token, setup.origin, false, { drafts: true });
  const plain = await connectPhone(url, setup.paired.token, setup.origin);

  for (const client of [host, plain]) {
    await waitFor(() => client.messages.some((message) => message.type === 'authenticated'));
    client.send({ requestId: 'report', action: 'panel-state', id: '', visible: true });
    await client.reply('report');
  }
  await delay(100);

  const engineTypes = (client: typeof host) =>
    client.messages
      .filter((message) => message.type === 'engine')
      .map((message) => (message as { message: { type: string } }).message.type);
  assert.deepEqual(engineTypes(host), ['draft-snapshot', 'draft']);
  assert.deepEqual(engineTypes(plain), []);

  // The gateway declared only the opted-in connection a draft host.
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((report) => report.draftHost).sort(), [true, undefined].sort());
});

test('a draft host whose phone closes during role negotiation is withdrawn after its queued requests', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-relay-draft-closing-'));
  const controlSocket = join(directory, 'control.sock');
  const received: Record<string, unknown>[] = [];
  let listener: Socket | undefined;
  const server = createServer((socket) => {
    listener = socket;
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(controlSocket, resolve));
  const phone = new FakePhone();
  const relay = new Relay(phone as unknown as WebSocket, {
    controlSocket,
    sessionsDirectory: directory,
    deviceId: 'device',
    receipts: new ReceiptBook(),
    takeToken: () => true,
    takeDraftToken: () => true,
    drafts: true,
    allowScreenshot: () => {},
    onClosed: () => {},
    log: () => {},
  });
  context.after(async () => {
    relay.terminate(4001, 'Test over');
    listener?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => received.length === 1);

  // A report with a pending send and an edit wait for the role; then the
  // closing handshake starts (no `close` event yet).
  const conversation = '00000000-0000-4000-8000-000000000004';
  const requests = [
    { requestId: 'shown', action: 'panel-state', id: '', visible: true, pendingSend: conversation },
    { requestId: 'edit', action: 'draft-set', id: conversation, text: 'typed', editId: 'e1' },
  ];
  for (const request of requests) {
    phone.emit('message', Buffer.from(JSON.stringify({ type: 'request', ...request })), false);
  }
  phone.readyState = phone.CLOSING;
  roleAccepted(listener!);

  // The report and the edit keep their order; the withdrawal follows them.
  await waitFor(() => received.length === 4);
  assert.deepEqual(
    received.slice(1).map((message) => message.action),
    ['panel-state', 'draft-set', 'withdraw-visibility'],
  );
  assert.equal(received[1].visible, false);
  assert.equal(received[1].draftHost, true);

  // The `close` event later does not withdraw a second time.
  phone.emit('close');
  await delay(50);
  assert.equal(received.filter((message) => message.action === 'withdraw-visibility').length, 1);
});

/**
 * The flush deadline after a stream ends (src/remote/README.md, "Rules:
 * audio admission", rule 7): every flush marker has its own 15-second
 * deadline, counted from when it was written. The relay's upstream is
 * replaced by a stand-in whose writes are held until the test flushes them,
 * and timers are mocked, so the times are exact.
 */
async function relayWithHeldUpstream(context: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-relay-flush-'));
  const controlSocket = join(directory, 'control.sock');
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(controlSocket, resolve));
  const relay = new Relay(new FakePhone() as unknown as WebSocket, {
    controlSocket,
    sessionsDirectory: directory,
    deviceId: 'device',
    receipts: new ReceiptBook(),
    takeToken: () => true,
    takeDraftToken: () => true,
    allowScreenshot: () => {},
    onClosed: () => {},
    log: () => {},
  });
  const internals = relay as unknown as Record<string, any>;
  // The real role-negotiation timer would outlive the test once timers are
  // mocked: clear it before.
  clearTimeout(internals.roleTimer);
  const realUpstream = internals.upstream;
  const terminated: number[] = [];
  const held: (() => void)[] = [];
  internals.terminate = (code: number) => terminated.push(code);
  // Something is buffered for a listener that does not read; every write
  // completes only when the test flushes it, in order.
  internals.upstream = {
    destroyed: false,
    writableLength: 4096,
    write(_data: string, callback?: () => void) {
      held.push(() => callback?.());
      return false;
    },
  };
  context.after(async () => {
    realUpstream.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { internals, terminated, held };
}

test('a later stream end keeps its own 15 s flush deadline after an earlier marker flushes', async (context) => {
  const { internals, terminated, held } = await relayWithHeldUpstream(context);
  context.mock.timers.enable({ apis: ['setTimeout'] });

  internals.awaitUpstreamFlush(); // marker A at 0 s
  context.mock.timers.tick(12_000);
  internals.awaitUpstreamFlush(); // marker B at 12 s
  context.mock.timers.tick(1_000);
  held.shift()!(); // A flushed at 13 s

  context.mock.timers.tick(2_000);
  assert.deepEqual(terminated, [], 'At 15 s, B is only 3 s old');
  context.mock.timers.tick(11_999);
  assert.deepEqual(terminated, []);
  context.mock.timers.tick(1);
  assert.deepEqual(terminated, [4503], "B's own deadline, 15 s after it was written");
});

test('an end the listener reported before answering the start also starts the flush deadline', async (context) => {
  const { internals, terminated } = await relayWithHeldUpstream(context);
  context.mock.timers.enable({ apis: ['setTimeout'] });

  const streamId = '00000000-0000-4000-8000-000000000001';
  internals.options.audioStreams = { release() {}, rate() {} };
  internals.audio = { phase: 'starting', token: 1, ended: { streamId, reason: 'paused' } };
  internals.audioStartAnswered(1, 'start', {
    type: 'result',
    requestId: 'start',
    action: 'audio-start',
    result: { streamId },
  });

  assert.equal(internals.audio.phase, 'none');
  context.mock.timers.tick(14_999);
  assert.deepEqual(terminated, []);
  context.mock.timers.tick(1);
  assert.deepEqual(terminated, [4503]);
});
