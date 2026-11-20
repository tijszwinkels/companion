import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import test from 'node:test';

import { maximumRequestLineCharacters } from '../../src/desktop/server.ts';
import {
  draftTextLimit,
  maximumClientMessageBytes,
  maximumUnauthenticatedBytes,
  sendTextLimit,
} from '../../src/remote/protocol.ts';
import {
  DeviceRequestRate,
  draftEditBurst,
  draftEditRateLimit,
  draftEditsPerSecond,
  requestBurst,
} from '../../src/remote/request-rate.ts';
import { frame, signal } from '../helpers.ts';
import {
  connectPhone,
  remoteFixture,
  waitFor,
  within,
  type PhoneClient,
} from '../remote-fixture.ts';

/**
 * Message sizes, the draft-edit rate, receipts and the send length, as one
 * table derived from the rules in src/remote/README.md ("Limits", "Drafts")
 * and src/desktop/README.md ("Remote panels"):
 *
 * - An authenticated client message may be 128 KiB; a larger one closes that
 *   connection. A 16,000-unit draft written as escaped JSON fits, through
 *   the gateway and the listener's 128 Ki-character request line.
 * - Before its relay starts, a socket may send 32 KiB + 8 bytes on the wire
 *   (one 32 KiB message in one frame), also while it is still closing after a
 *   refusal; past that it is cut at once.
 * - `draft-set` draws from its own per-device bucket: bursts of 120, then 40
 *   per second, shared by the device's connections. A refused edit is
 *   answered "not saved", the connection stays open, and the request bucket
 *   is untouched. Ordinary typing (key repeat in one tab, four tabs at a fast
 *   pace) is never refused.
 * - Draft edits have no receipt and leave other requests' receipts alone.
 * - `send-agent` allows 1–8,000 characters for every remote connection.
 */

// The rules above are the numbers this table is written for.
assert.equal(maximumClientMessageBytes, 128 * 1024);
assert.equal(maximumUnauthenticatedBytes, 32 * 1024 + 8);
assert.equal(maximumRequestLineCharacters, 128 * 1024);
assert.equal(draftTextLimit, 16_000);
assert.equal(sendTextLimit, 8000);
assert.equal(draftEditBurst, 120);
assert.equal(draftEditsPerSecond, 40);
assert.equal(requestBurst, 30);

type Message = Record<string, any>;

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

/** A JSON text padded with spaces (still valid JSON) to exactly `bytes`. */
function padded(message: object, bytes: number): string {
  const text = JSON.stringify(message);
  assert.ok(text.length <= bytes, 'the message itself fits');
  return text + ' '.repeat(bytes - Buffer.byteLength(text));
}

/** Connect through the gateway; `drafts` opts in to draft hosting. */
async function connect(fixture: Fixture, token: string, drafts: boolean): Promise<PhoneClient> {
  const client = await fixture.phone(token, fixture.origin, false, drafts ? { drafts } : {});
  await waitFor(() => client.messages.some((message) => message.type === 'authenticated'), 3000);
  return client;
}

/** Send a request and return its answer. */
async function ask(client: PhoneClient, requestId: string, request: object): Promise<Message> {
  client.send({ requestId, ...request });
  return (await client.reply(requestId)) as Message;
}

/** Make `client` a draft host: its first panel report. */
async function report(client: PhoneClient, requestId = 'report'): Promise<void> {
  const answer = await ask(client, requestId, { action: 'panel-state', id: '' });
  assert.equal(answer.result, 'panel-recorded');
}

// ---------------------------------------------------------------------------
// Message sizes at and over each bound.
// ---------------------------------------------------------------------------

interface SizeCase {
  rule: string;
  /** `relayed`: an authenticated relay; `waiting`: before authentication. */
  socket: 'relayed' | 'waiting';
  /** Whether the relayed connection asked for drafts. */
  drafts?: boolean;
  /** Bytes of the WebSocket message payload (one frame). */
  bytes: number;
  expect: 'answered' | 'cut';
}

const sizeCases: SizeCase[] = [
  {
    rule: 'a 128 KiB message is answered (draft host)',
    socket: 'relayed',
    drafts: true,
    bytes: 128 * 1024,
    expect: 'answered',
  },
  {
    rule: 'a 128 KiB message is answered (no drafts)',
    socket: 'relayed',
    bytes: 128 * 1024,
    expect: 'answered',
  },
  {
    rule: 'a message over 128 KiB closes the connection (draft host)',
    socket: 'relayed',
    drafts: true,
    bytes: 128 * 1024 + 1,
    expect: 'cut',
  },
  {
    rule: 'a message over 128 KiB closes the connection (no drafts)',
    socket: 'relayed',
    bytes: 128 * 1024 + 1,
    expect: 'cut',
  },
  {
    rule: 'a 32 KiB first message authenticates',
    socket: 'waiting',
    bytes: 32 * 1024,
    expect: 'answered',
  },
  {
    rule: 'a first message over 32 KiB is cut before authentication',
    socket: 'waiting',
    bytes: 32 * 1024 + 1,
    expect: 'cut',
  },
  {
    rule: 'a 128 KiB first message is cut before authentication',
    socket: 'waiting',
    bytes: 128 * 1024,
    expect: 'cut',
  },
];

for (const sizeCase of sizeCases) {
  test(`limits: ${sizeCase.rule}`, async (context) => {
    const fixture = await remoteFixture({ backend: async () => {} });
    context.after(() => fixture.close());
    const { token } = await fixture.pair();

    if (sizeCase.socket === 'relayed') {
      const client = await connect(fixture, token, sizeCase.drafts === true);
      // A heartbeat padded with spaces is answered with a pong.
      client.socket.send(padded({ type: 'ping' }, sizeCase.bytes));
      if (sizeCase.expect === 'answered') {
        await waitFor(() => client.messages.some((message) => message.type === 'pong'), 3000);
        assert.equal(client.socket.readyState, client.socket.OPEN);
      } else {
        const closed = await within(client.closed, 3000, 'the oversized connection closes');
        assert.ok([1006, 1009].includes(closed.code), `closed with ${closed.code}`);
        assert.equal(
          client.messages.some((message) => message.type === 'pong'),
          false,
        );
      }
      return;
    }

    const waiting = await connectPhone(
      `ws://127.0.0.1:${fixture.port}/api/socket`,
      undefined,
      fixture.origin,
    );
    context.after(() => waiting.socket.terminate());
    waiting.socket.send(padded({ type: 'auth', token }, sizeCase.bytes));
    if (sizeCase.expect === 'answered') {
      await waitFor(
        () => waiting.messages.some((message) => message.type === 'authenticated'),
        3000,
      );
    } else {
      const closed = await within(waiting.closed, 3000, 'the unauthenticated socket is cut');
      assert.equal(closed.code, 1006, 'cut, not closed by handshake');
      assert.deepEqual(waiting.messages, [], 'it received nothing');
    }
  });
}

test('limits: a 16,000-unit draft written as escaped JSON passes the gateway and the listener', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Long draft' }, signal());
  await fixture.sessions.idle();
  const { token } = await fixture.pair();
  const host = await connect(fixture, token, true);
  await report(host);

  // Control characters are written as six JSON characters each: 96,000+
  // bytes on the wire, and as long again on the listener's request line.
  const text = '\u0001'.repeat(draftTextLimit);
  const request = JSON.stringify({
    type: 'request',
    requestId: 'long',
    action: 'draft-set',
    id,
    text,
    editId: 'long-edit',
  });
  assert.ok(Buffer.byteLength(request) > 96_000);
  host.socket.send(request);
  const answer = (await host.reply('long')) as Message;
  assert.equal(answer.type, 'result', String(answer.message));
  assert.equal(answer.result.accepted, true);
  const change = await host.engine('draft', (event) => event.editId === 'long-edit');
  assert.equal(change.text, text);
  assert.equal(host.socket.readyState, host.socket.OPEN);
});

test('limits: a refused socket that is still closing cannot send more than 32 KiB', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());

  // A hand-written client that never answers the gateway's close frame, so
  // the gateway's socket stays in the closing handshake.
  const raw = createConnection(fixture.port, '127.0.0.1');
  context.after(() => raw.destroy());
  // The gateway resets the connection when it cuts it.
  raw.on('error', () => {});
  await once(raw, 'connect');
  raw.write(
    [
      'GET /api/socket HTTP/1.1',
      `Host: 127.0.0.1:${fixture.port}`,
      `Origin: ${fixture.origin}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  let received = Buffer.alloc(0);
  raw.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
  });
  const ended = new Promise<void>((resolve) => raw.once('close', () => resolve()));
  await waitFor(() => received.includes('\r\n\r\n'), 3000);
  assert.match(received.toString('latin1'), /^HTTP\/1\.1 101/);

  // A wrong token: the gateway answers with a close frame (4401) and waits.
  raw.write(maskedFrame(Buffer.from(JSON.stringify({ type: 'auth', token: 'wrong' }))));
  await waitFor(() => received.includes(Buffer.from([0x88])), 3000);

  // While closing it would otherwise read a message up to 128 KiB. The
  // unauthenticated budget is spent long before: the socket is cut at once.
  raw.write(maskedFrame(Buffer.alloc(100 * 1024, 0x20)));
  await within(ended, 3000, 'the gateway cuts the closing socket');
});

/** One masked text frame, as a browser sends it. */
function maskedFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

test("limits: the listener's request line holds a long draft; several in one read are all kept", async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Lines' }, signal());
  await fixture.sessions.idle();

  const socket: Socket = createConnection(fixture.desktop.socketPath);
  context.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk: string) => {
    buffered += chunk;
  });
  const replies = () =>
    buffered
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Message)
      .filter((message) => message.action === 'draft-set');

  const write = (requests: object[]) => {
    socket.write(requests.map((request) => JSON.stringify(request) + '\n').join(''));
  };
  write([{ action: 'panel-state', id: '', composerFocused: false, draftHost: true }]);

  // Five edits of 15,000 control characters in one write: each line is
  // about 90,000 characters (six per escaped unit), within the bound, and
  // together 450,000. All are applied, in order, and none is refused with
  // "Previous request is still running".
  const edits = [1, 2, 3, 4, 5].map((number) => ({
    action: 'draft-set',
    requestId: `batch-${number}`,
    id,
    text: '\u0001'.repeat(15_000 - number),
    editId: `batch-${number}`,
  }));
  write(edits);
  await waitFor(() => replies().length === 5, 3000);
  assert.deepEqual(
    replies().map((reply) => [reply.requestId, reply.type, reply.result?.accepted]),
    edits.map((edit) => [edit.requestId, 'result', true]),
  );

  // One line over the bound disconnects the client.
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write('"' + 'x'.repeat(maximumRequestLineCharacters) + '"\n');
  await within(closed, 3000, 'the listener closes an oversized line');
});

// ---------------------------------------------------------------------------
// The draft-edit rate, per device.
// ---------------------------------------------------------------------------

interface RateCase {
  rule: string;
  /** Connections of one device that take part (each a draft host). */
  connections: 1 | 4;
  /** Edits sent in total, spread round-robin over the connections. */
  edits: number;
  /** How many must be accepted (the rest are refused as not saved). */
  accepted: number;
}

const rateCases: RateCase[] = [
  {
    rule: 'one connection: the whole burst is accepted',
    connections: 1,
    edits: 120,
    accepted: 120,
  },
  {
    rule: 'one connection: the edit after the burst is refused',
    connections: 1,
    edits: 125,
    accepted: 120,
  },
  { rule: 'four connections share the burst', connections: 4, edits: 120, accepted: 120 },
  {
    rule: 'four connections: edits past the shared burst are refused',
    connections: 4,
    edits: 140,
    accepted: 120,
  },
];

for (const rateCase of rateCases) {
  test(`limits: ${rateCase.rule}`, async (context) => {
    // Hold the refill clock still, so the counts are exact.
    context.mock.method(performance, 'now', () => 0);
    const fixture = await remoteFixture({ backend: async () => {} });
    context.after(() => fixture.close());
    const id = fixture.sessions.start({ ...frame, utterance: 'Typing' }, signal());
    await fixture.sessions.idle();
    const { token } = await fixture.pair();

    const clients: PhoneClient[] = [];
    for (let index = 0; index < rateCase.connections; index++) {
      const client = await connect(fixture, token, true);
      await report(client);
      clients.push(client);
    }

    for (let index = 0; index < rateCase.edits; index++) {
      clients[index % clients.length].send({
        requestId: `edit-${index}`,
        action: 'draft-set',
        id,
        text: `typed ${index}`,
        editId: `edit-${index}`,
      });
    }
    const answers: Message[] = [];
    for (let index = 0; index < rateCase.edits; index++) {
      answers.push((await clients[index % clients.length].reply(`edit-${index}`)) as Message);
    }

    const accepted = answers.filter((answer) => answer.type === 'result');
    const refused = answers.filter((answer) => answer.type === 'error');
    assert.equal(accepted.length, rateCase.accepted);
    for (const answer of accepted) {
      assert.equal(answer.result.accepted, true);
    }
    for (const answer of refused) {
      assert.equal(answer.action, 'draft-set');
      assert.equal(answer.message, 'Too many draft edits; this edit was not saved');
    }

    // Every connection stays open, and the request bucket is untouched: a
    // full burst of requests is still answered.
    for (const client of clients) {
      assert.equal(client.socket.readyState, client.socket.OPEN);
    }
    // Each connection's first report took one request token.
    for (let index = 0; index < requestBurst - rateCase.connections; index++) {
      const answer = await ask(clients[0], `request-${index}`, { action: 'panel-state', id: '' });
      assert.equal(answer.result, 'panel-recorded', `request ${index}`);
    }
  });
}

test('limits: another device has its own draft-edit bucket', async (context) => {
  context.mock.method(performance, 'now', () => 0);
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Two devices' }, signal());
  await fixture.sessions.idle();

  const first = await connect(fixture, (await fixture.pair('First')).token, true);
  const second = await connect(fixture, (await fixture.pair('Second')).token, true);
  await report(first);
  await report(second);
  for (let index = 0; index <= draftEditBurst; index++) {
    first.send({ requestId: `f${index}`, action: 'draft-set', id, text: 'a', editId: `f${index}` });
  }
  assert.equal(((await first.reply(`f${draftEditBurst}`)) as Message).type, 'error');
  const answer = await ask(second, 's', { action: 'draft-set', id, text: 'b', editId: 's' });
  assert.equal(answer.result.accepted, true);
});

/**
 * Typing patterns against the bucket itself, with a simulated clock:
 * `[edits per second per tab, tabs, seconds]` → refused edits.
 */
const typingCases: {
  rule: string;
  perSecond: number;
  tabs: number;
  seconds: number;
  refused: 'none' | 'some';
}[] = [
  {
    rule: 'a held key (33/s) in one tab for a minute',
    perSecond: 33,
    tabs: 1,
    seconds: 60,
    refused: 'none',
  },
  {
    rule: 'fast typing (10/s) in four tabs for a minute',
    perSecond: 10,
    tabs: 4,
    seconds: 60,
    refused: 'none',
  },
  { rule: 'a flood (1000/s) for a second', perSecond: 1000, tabs: 1, seconds: 1, refused: 'some' },
  {
    rule: 'four tabs flooding (100/s each) for ten seconds',
    perSecond: 100,
    tabs: 4,
    seconds: 10,
    refused: 'some',
  },
];

for (const typing of typingCases) {
  test(`limits: draft-edit bucket, ${typing.rule}`, () => {
    let now = 0;
    const rate = new DeviceRequestRate(() => now, draftEditRateLimit);
    const total = typing.perSecond * typing.tabs * typing.seconds;
    let refused = 0;
    for (let index = 0; index < total; index++) {
      now = (index / (typing.perSecond * typing.tabs)) * 1000;
      if (!rate.take('device')) {
        refused++;
      }
    }
    if (typing.refused === 'none') {
      assert.equal(refused, 0);
    } else {
      // At most the burst plus the refill over the time is ever accepted.
      const accepted = total - refused;
      assert.ok(accepted <= draftEditBurst + draftEditsPerSecond * typing.seconds + 1);
      assert.ok(refused > 0);
    }
  });
}

// ---------------------------------------------------------------------------
// Receipts and the send length.
// ---------------------------------------------------------------------------

test('limits: draft edits have no receipt and leave other receipts alone', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Receipts' }, signal());
  await fixture.sessions.idle();
  const { token } = await fixture.pair();
  const host = await connect(fixture, token, true);
  await report(host);

  // A mutation with a receipt.
  const paused = await ask(host, 'pause-1', { action: 'toggle-pause' });
  assert.equal(paused.result, 'paused');

  // Draft edits reusing one request ID are each applied: no receipt answers
  // them, and nothing is marked as a duplicate.
  for (const text of ['one', 'two', 'three']) {
    const answer = await ask(host, 'same-id', { action: 'draft-set', id, text, editId: text });
    assert.equal(answer.type, 'result');
    assert.equal(answer.result.accepted, true);
    assert.equal(answer.duplicate, undefined);
  }
  const latest = await host.engine('draft', (event) => event.editId === 'three');
  assert.equal(latest.text, 'three');

  // The mutation's receipt still answers its repeat without toggling again.
  const repeated = await ask(host, 'pause-1', { action: 'toggle-pause' });
  assert.equal(repeated.result, 'paused');
  assert.equal(repeated.duplicate, true);
  assert.equal(fixture.desktop.pause.paused, true);
});

const sendCases: { length: number; drafts: boolean; expect: 'submitted' | RegExp }[] = [
  { length: 8000, drafts: false, expect: 'submitted' },
  { length: 8001, drafts: false, expect: /^Invalid or missing field: text$/ },
  { length: 8000, drafts: true, expect: 'submitted' },
  { length: 8001, drafts: true, expect: /^Invalid or missing field: text$/ },
];

for (const sendCase of sendCases) {
  test(`limits: send-agent with ${sendCase.length} characters (${sendCase.drafts ? 'draft host' : 'no drafts'})`, async (context) => {
    const fixture = await remoteFixture({ backend: async () => {} });
    context.after(() => fixture.close());
    const id = fixture.sessions.start({ ...frame, utterance: 'Long send' }, signal());
    await fixture.sessions.idle();
    const { token } = await fixture.pair();
    const client = await connect(fixture, token, sendCase.drafts);

    const answer = await ask(client, 'send', {
      action: 'send-agent',
      id,
      text: 'w'.repeat(sendCase.length),
    });
    if (sendCase.expect === 'submitted') {
      assert.equal(answer.result, 'submitted', String(answer.message));
    } else {
      assert.match(String(answer.message), sendCase.expect);
    }
  });
}

test('limits: the listener itself allows a remote send of 8,000 characters, not 8,001', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Listener bound' }, signal());
  await fixture.sessions.idle();

  const socket = createConnection(fixture.desktop.socketPath);
  context.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk: string) => {
    buffered += chunk;
  });
  const answer = async (requestId: string) => {
    const find = () =>
      buffered
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Message)
        .find((message) => message.requestId === requestId);
    await waitFor(() => find() !== undefined, 3000);
    return find()!;
  };
  const send = (request: object) => socket.write(JSON.stringify(request) + '\n');

  send({ action: 'client-role', role: 'remote', requestId: 'role' });
  assert.equal((await answer('role')).result, 'role-recorded');
  send({ action: 'send-agent', id, text: 'v'.repeat(8000), requestId: 'at' });
  assert.equal((await answer('at')).result, 'submitted');
  send({ action: 'send-agent', id, text: 'v'.repeat(8001), requestId: 'over' });
  assert.match(String((await answer('over')).message), /A follow-up requires 1–8000 characters/);
});
