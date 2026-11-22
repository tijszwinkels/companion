/**
 * Gateway admission of audio (src/remote/README.md, "Rules: audio
 * admission"), as one table of cases derived from those rules.
 *
 * Every case runs the real gateway on loopback in front of a real listener
 * control socket (DesktopRuntime) whose microphones are composed as in
 * src/cli.ts (test/microphones-fixture.ts): synthetic audio, the test
 * recogniser and a synthetic voice detector. Only the slow-listener case
 * uses a fake listener socket that stops reading, which a real listener
 * never does on purpose. The audio rate runs on an injected clock. Every
 * wait is for the state it means.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { microphonesFixture, pieces, utterance } from '../microphones-fixture.ts';
import { connectPhone, remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';
import {
  audioBytesPerSecond,
  maximumAudioChunkBytes,
  minimumAudioPieceBytes,
} from '../../src/remote/protocol.ts';

type Json = Record<string, any>;

/** A gateway and listener with microphones; `now` drives the audio rate clock. */
async function setup(options: { microphones?: boolean } = {}) {
  const clock = { now: 0 };
  const fixture = await remoteFixture({ gateway: { audioClock: () => clock.now } });
  const microphones =
    options.microphones === false
      ? undefined
      : microphonesFixture(fixture.desktop.runtime, fixture.desktop.pause);

  /** A paired device's connection, after its first state arrived. */
  async function device(name: string, token?: string): Promise<PhoneClient & { token: string }> {
    const paired = token ?? (await fixture.pair(name)).token;
    const phone = await fixture.phone(paired, fixture.origin, true);
    await phone.engine('state');
    return Object.assign(phone, { token: paired });
  }

  let requests = 0;
  /** Send a request and return its answer. */
  async function request(phone: PhoneClient, fields: Json): Promise<Json> {
    const requestId = `r${++requests}`;
    phone.send({ requestId, ...fields });
    return (await phone.reply(requestId)) as Json;
  }

  /** Start listening on this connection; returns the stream ID. */
  async function listen(phone: PhoneClient): Promise<string> {
    const answer = await request(phone, { action: 'audio-start' });
    assert.equal(answer.type, 'result', JSON.stringify(answer));
    return answer.result.streamId;
  }

  /** The `audio-ended` messages this connection received. */
  function ended(phone: PhoneClient): Json[] {
    return (phone.messages as Json[]).filter((message) => message.type === 'audio-ended');
  }

  /** Binary refusals: the existing answer to a binary message without a stream. */
  function binaryRefusals(phone: PhoneClient): number {
    return (phone.messages as Json[]).filter(
      (message) => message.type === 'error' && message.message === 'Expected a text message',
    ).length;
  }

  /** Every earlier message of this connection has been handled once a ping is answered. */
  async function handled(phone: PhoneClient): Promise<void> {
    const pongs = (phone.messages as Json[]).filter((message) => message.type === 'pong').length;
    phone.socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(
      () => (phone.messages as Json[]).filter((message) => message.type === 'pong').length > pongs,
    );
  }

  /** Names of the browsers the listener has a stream for. */
  function listenerStreams(): string[] {
    return microphones?.browsers.list.map((browser) => browser.name) ?? [];
  }

  async function close() {
    await microphones?.close();
    await fixture.close();
  }

  return {
    fixture,
    microphones,
    clock,
    device,
    request,
    listen,
    ended,
    binaryRefusals,
    handled,
    listenerStreams,
    close,
  };
}

test('binary without a stream is refused as before and reaches nothing', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    phone.socket.send(Buffer.alloc(3200));
    await waitFor(() => gateway.binaryRefusals(phone) === 1);

    // A stream that has ended refuses again.
    await gateway.listen(phone);
    const stopped = await gateway.request(phone, { action: 'audio-stop' });
    assert.equal(stopped.result, 'stopped');
    phone.socket.send(Buffer.alloc(3200));
    await waitFor(() => gateway.binaryRefusals(phone) === 2);
    assert.deepEqual(gateway.listenerStreams(), []);
    assert.equal(phone.socket.readyState, phone.socket.OPEN);
  } finally {
    await gateway.close();
  }
});

test('binary on an unauthenticated socket closes it as not paired', async () => {
  const gateway = await setup();
  try {
    const stranger = await connectPhone(
      `ws://127.0.0.1:${gateway.fixture.port}/api/socket`,
      undefined,
      gateway.fixture.origin,
    );
    stranger.socket.send(Buffer.alloc(3200));
    assert.equal((await stranger.closed).code, 4401);
    assert.deepEqual(gateway.listenerStreams(), []);
  } finally {
    await gateway.close();
  }
});

test('a stream carries speech to the listener, named after the paired device', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Kitchen phone');
    const streamId = await gateway.listen(phone);
    const state = await phone.engine('state', (message) =>
      message.microphones?.listening.some((entry: Json) => entry.id === streamId),
    );
    assert.deepEqual(state.microphones.listening, [
      { id: 'computer', kind: 'computer', name: 'Computer' },
      { id: streamId, kind: 'browser', name: 'Kitchen phone' },
    ]);

    for (const piece of pieces(utterance(0.5))) {
      phone.socket.send(piece);
    }
    const entry = await phone.engine('activity-entry');
    assert.equal(entry.entry.utterance, 'w5');
    assert.equal(entry.entry.microphone, 'Kitchen phone');
    assert.deepEqual(gateway.microphones!.dispatched, [{ utterance: 'w5' }]);
  } finally {
    await gateway.close();
  }
});

test('pieces: 8 KiB passes; larger, empty or odd ends the stream, not the connection', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    let streamId = await gateway.listen(phone);
    phone.socket.send(Buffer.alloc(maximumAudioChunkBytes));
    await gateway.handled(phone);
    assert.deepEqual(gateway.ended(phone), [], 'A piece at the bound is accepted');

    const bad = [Buffer.alloc(maximumAudioChunkBytes + 2), Buffer.alloc(0), Buffer.alloc(3201)];
    for (const [index, piece] of bad.entries()) {
      if (index > 0) {
        streamId = await gateway.listen(phone);
      }
      phone.socket.send(piece);
      await waitFor(() => gateway.ended(phone).length === index + 1);
      assert.deepEqual(gateway.ended(phone)[index], {
        type: 'audio-ended',
        streamId,
        reason: 'too-large',
        message: 'A piece of sound was empty, too large or not whole 16-bit samples',
      });

      // The stream is gone (binary refused again), the connection is not.
      phone.socket.send(Buffer.alloc(2));
      await waitFor(() => gateway.binaryRefusals(phone) === index + 1);
      const answer = await gateway.request(phone, { action: 'toggle-sounds' });
      assert.equal(answer.type, 'result');
      await waitFor(() => !gateway.listenerStreams().length);
    }
  } finally {
    await gateway.close();
  }
});

test('rate: 1.5 times real time with two seconds at once passes; one piece more ends the stream', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    const streamId = await gateway.listen(phone);
    const piece = Buffer.alloc(8000);

    // Two seconds of sound at once (the burst), at clock time 0.
    for (let sent = 0; sent < audioBytesPerSecond * 2; sent += piece.length) {
      phone.socket.send(piece);
    }
    await gateway.handled(phone);
    // One second later: 1.5 seconds of sound more.
    gateway.clock.now = 1000;
    for (let sent = 0; sent < audioBytesPerSecond * 1.5; sent += piece.length) {
      phone.socket.send(piece);
    }
    await gateway.handled(phone);
    assert.deepEqual(gateway.ended(phone), [], 'At the bound everything is accepted');

    phone.socket.send(Buffer.alloc(2));
    await waitFor(() => gateway.ended(phone).length === 1);
    assert.equal(gateway.ended(phone)[0].reason, 'too-fast');
    assert.equal(gateway.ended(phone)[0].streamId, streamId);
    assert.equal(phone.socket.readyState, phone.socket.OPEN);
  } finally {
    await gateway.close();
  }
});

test('audio is counted apart from the request bucket; audio-stop is never rate-limited', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    await gateway.listen(phone);
    // Forty pieces: more than the 30-request burst.
    for (let index = 0; index < 40; index++) {
      phone.socket.send(Buffer.alloc(1600));
    }
    const answer = await gateway.request(phone, { action: 'toggle-sounds' });
    assert.equal(answer.type, 'result', 'Requests still have their whole bucket');

    // Use up the request bucket, then stop: the stop is still carried out.
    for (let index = 0; index < 40; index++) {
      phone.socket.send(JSON.stringify({ type: 'ping' }));
    }
    const refused = await gateway.request(phone, { action: 'toggle-sounds' });
    assert.match(refused.message, /Too many requests/);
    const stopped = await gateway.request(phone, { action: 'audio-stop' });
    assert.equal(stopped.result, 'stopped');
    await waitFor(() => gateway.listenerStreams().length === 0);
  } finally {
    await gateway.close();
  }
});

test("one stream per device: the device's second connection takes it over", async () => {
  const gateway = await setup();
  try {
    const first = await gateway.device('Browser');
    const firstStream = await gateway.listen(first);
    const second = await gateway.device('Browser', first.token);
    const secondStream = await gateway.listen(second);

    await waitFor(() => gateway.ended(first).length === 1);
    assert.deepEqual(gateway.ended(first), [
      {
        type: 'audio-ended',
        streamId: firstStream,
        reason: 'taken-over',
        message: 'Listening moved to another tab or window of this device',
      },
    ]);
    first.socket.send(Buffer.alloc(3200));
    await waitFor(() => gateway.binaryRefusals(first) === 1);
    await waitFor(() => gateway.listenerStreams().length === 1);
    assert.equal(gateway.microphones!.browsers.list[0].id, secondStream);

    for (const piece of pieces(utterance(0.6))) {
      second.socket.send(piece);
    }
    await waitFor(() => gateway.microphones!.dispatched.length === 1);
    assert.deepEqual(gateway.microphones!.dispatched, [{ utterance: 'w6' }]);
    assert.equal(first.socket.readyState, first.socket.OPEN, 'The first connection stays');
  } finally {
    await gateway.close();
  }
});

test('four streams in total: a fifth device is refused until one closes its page', async () => {
  const gateway = await setup();
  try {
    const devices = [];
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      const device = await gateway.device(name);
      await gateway.listen(device);
      devices.push(device);
    }
    const fifth = await gateway.device('Five');
    const refused = await gateway.request(fifth, { action: 'audio-start' });
    assert.equal(refused.type, 'error');
    assert.equal(refused.message, 'Too many browsers are listening (at most 4)');

    // A closed page ends its stream at once and frees its place.
    devices[0].socket.close();
    await waitFor(() => gateway.listenerStreams().length === 3);
    await gateway.listen(fifth);
    await waitFor(() => gateway.listenerStreams().length === 4);
    assert.deepEqual(gateway.listenerStreams().sort(), ['Five', 'Four', 'Three', 'Two']);
  } finally {
    await gateway.close();
  }
});

test('text requests during a stream work as always, including the computer microphone switch', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    const streamId = await gateway.listen(phone);
    phone.socket.send(Buffer.alloc(3200));
    const off = await gateway.request(phone, { action: 'set-computer-microphone', enabled: false });
    assert.equal(off.result, 'computer-microphone-off');
    // The switch is off at once; the computer leaves `listening` when its
    // period has actually ended.
    const state = await phone.engine(
      'state',
      (message) =>
        message.microphones?.computer === false && message.microphones.listening.length === 1,
    );
    assert.deepEqual(
      state.microphones.listening.map((entry: Json) => entry.id),
      [streamId],
    );
    phone.socket.send(Buffer.alloc(3200));
    await gateway.handled(phone);
    assert.deepEqual(gateway.ended(phone), []);
  } finally {
    await gateway.close();
  }
});

test('Pause ends every stream and tells each client; a start while paused is refused', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    const streamId = await gateway.listen(phone);
    const paused = await gateway.request(phone, { action: 'toggle-pause' });
    assert.equal(paused.result, 'paused');
    await waitFor(() => gateway.ended(phone).length === 1);
    assert.deepEqual(gateway.ended(phone), [
      { type: 'audio-ended', streamId, reason: 'paused', message: 'Listening is paused' },
    ]);
    phone.socket.send(Buffer.alloc(3200));
    await waitFor(() => gateway.binaryRefusals(phone) === 1);

    const refused = await gateway.request(phone, { action: 'audio-start' });
    assert.match(refused.message, /paused/);
  } finally {
    await gateway.close();
  }
});

test('revoked while streaming: the connection closes and the stream ends', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    await gateway.listen(phone);
    const authenticated = (phone.messages as Json[]).find(
      (message) => message.type === 'authenticated',
    )!;
    await gateway.fixture.devices.revoke(authenticated.deviceId);
    assert.equal((await phone.closed).code, 4403);
    await waitFor(() => gateway.listenerStreams().length === 0);
    await waitFor(() => gateway.microphones!.detectors.every((detector) => detector.closed));
  } finally {
    await gateway.close();
  }
});

test('an older listener: audio-start is answered "not available" and nothing else changes', async () => {
  const gateway = await setup({ microphones: false });
  try {
    const phone = await gateway.device('Phone');
    const state = await phone.engine('state');
    assert.equal(state.microphones, undefined);
    const refused = await gateway.request(phone, { action: 'audio-start' });
    assert.equal(refused.type, 'error');
    assert.equal(refused.message, 'Listening here is not available on this computer');
    phone.socket.send(Buffer.alloc(3200));
    await waitFor(() => gateway.binaryRefusals(phone) === 1);
    const answer = await gateway.request(phone, { action: 'toggle-sounds' });
    assert.equal(answer.type, 'result');
  } finally {
    await gateway.close();
  }
});

test('a listener that stops reading ends the stream as slow-listener', async () => {
  const listener = await fakeListener((request, reply, socket) => {
    if (request.action === 'audio-start') {
      reply({ type: 'result', requestId: request.requestId, result: { streamId: randomUUID() } });
      // From now on the listener reads nothing.
      socket.pause();
    }
  });

  // Every read of the audio clock is a second later: the rate never binds.
  let seconds = 0;
  const fixture = await remoteFixture({
    gateway: { controlSocket: listener.socketPath, audioClock: () => ++seconds * 1000 },
  });
  try {
    const phone = await fakeListenerPhone(fixture);
    phone.send({ requestId: 'start', action: 'audio-start' });
    const started = (await phone.reply('start')) as Json;
    assert.equal(started.type, 'result');

    const count = (type: string) =>
      (phone.messages as Json[]).filter((message) => message.type === type).length;
    // Send in rounds, each confirmed by a pong, until the gateway gives up.
    for (let round = 0; round < 40 && count('audio-ended') === 0; round++) {
      for (let piece = 0; piece < 20; piece++) {
        phone.socket.send(Buffer.alloc(maximumAudioChunkBytes));
      }
      const pongs = count('pong');
      phone.socket.send(JSON.stringify({ type: 'ping' }));
      await waitFor(() => count('pong') > pongs);
    }
    await waitFor(() => count('audio-ended') > 0);
    const endedMessage = (phone.messages as Json[]).find(
      (message) => message.type === 'audio-ended',
    )!;
    assert.equal(endedMessage.reason, 'slow-listener');
    assert.equal(phone.socket.readyState, phone.socket.OPEN);
  } finally {
    await fixture.close();
    await listener.close();
  }
});

test("restarting a stream does not refill the device's audio budget", async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    await gateway.listen(phone);
    for (let sent = 0; sent < audioBytesPerSecond * 2; sent += 8000) {
      phone.socket.send(Buffer.alloc(8000));
    }
    await gateway.handled(phone);
    assert.deepEqual(gateway.ended(phone), []);
    await gateway.request(phone, { action: 'audio-stop' });

    // A new stream, at the same moment, from the same device: no budget left.
    const streamId = await gateway.listen(phone);
    phone.socket.send(Buffer.alloc(2));
    await waitFor(() => gateway.ended(phone).length === 1);
    assert.deepEqual(
      [gateway.ended(phone)[0].streamId, gateway.ended(phone)[0].reason],
      [streamId, 'too-fast'],
    );
  } finally {
    await gateway.close();
  }
});

test('every piece costs at least 20 ms of sound: tiny pieces cannot multiply the work', async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    await gateway.listen(phone);
    const allowed = (audioBytesPerSecond * 2) / minimumAudioPieceBytes;
    for (let index = 0; index < allowed; index++) {
      phone.socket.send(Buffer.alloc(2));
    }
    await gateway.handled(phone);
    assert.deepEqual(gateway.ended(phone), [], `${allowed} tiny pieces fit the burst`);
    phone.socket.send(Buffer.alloc(2));
    await waitFor(() => gateway.ended(phone).length === 1);
    assert.equal(gateway.ended(phone)[0].reason, 'too-fast');
  } finally {
    await gateway.close();
  }
});

test('a stream the listener ended before answering its start is reported ended, not open', async () => {
  // Like a Pause in the same moment: the end of the new stream arrives
  // before the answer to its start.
  const listener = await fakeListener((request, reply) => {
    if (request.action === 'audio-start') {
      const streamId = randomUUID();
      reply({ type: 'audio-ended', streamId, reason: 'paused' });
      reply({ type: 'result', requestId: request.requestId, result: { streamId } });
    }
  });
  const fixture = await remoteFixture({ gateway: { controlSocket: listener.socketPath } });
  try {
    const phone = await fakeListenerPhone(fixture);
    phone.send({ requestId: 'start', action: 'audio-start' });
    const started = (await phone.reply('start')) as Json;
    assert.equal(started.type, 'result');
    await waitFor(() =>
      (phone.messages as Json[]).some((message) => message.type === 'audio-ended'),
    );
    const ended = (phone.messages as Json[]).find((message) => message.type === 'audio-ended')!;
    assert.deepEqual([ended.streamId, ended.reason], [started.result.streamId, 'paused']);

    // Nothing is open: binary is refused again and reaches nothing.
    phone.socket.send(Buffer.alloc(3200));
    await waitFor(() =>
      (phone.messages as Json[]).some(
        (message) => message.type === 'error' && message.message === 'Expected a text message',
      ),
    );
    assert.equal(listener.received.filter((request) => request.action === 'audio-chunk').length, 0);
  } finally {
    await fixture.close();
    await listener.close();
  }
});

test('a stop while the start is still unanswered stops the listener at once', async () => {
  // A listener that opens the stream but answers the start only when told.
  let answer!: () => void;
  const listener = await fakeListener((request, reply) => {
    if (request.action === 'audio-start') {
      answer = () => reply({ type: 'result', requestId: request.requestId, result: { streamId } });
    }
  });
  const streamId = randomUUID();
  const fixture = await remoteFixture({ gateway: { controlSocket: listener.socketPath } });
  try {
    const phone = await fakeListenerPhone(fixture);
    phone.send({ requestId: 'start', action: 'audio-start' });
    await waitFor(() => listener.received.some((request) => request.action === 'audio-start'));

    phone.send({ requestId: 'stop', action: 'audio-stop' });
    assert.equal(((await phone.reply('stop')) as Json).result, 'stopped');
    // The listener is told now, on the same socket, right after the start.
    await waitFor(() => listener.received.some((request) => request.action === 'audio-stop'));
    const stops = () => listener.received.filter((request) => request.action === 'audio-stop');
    assert.equal(stops()[0].streamId, undefined);

    // The late answer: the start is answered as ended, and the stream is
    // stopped again by its ID (harmless when it has already ended).
    answer();
    const started = (await phone.reply('start')) as Json;
    assert.equal(started.type, 'error');
    await waitFor(() => stops().length === 2);
    assert.equal(stops()[1].streamId, streamId);
  } finally {
    await fixture.close();
    await listener.close();
  }
});

test("reconnecting does not restore the device's spent audio budget", async () => {
  const gateway = await setup();
  try {
    const phone = await gateway.device('Phone');
    await gateway.listen(phone);
    for (let sent = 0; sent < audioBytesPerSecond * 2; sent += 8000) {
      phone.socket.send(Buffer.alloc(8000));
    }
    await gateway.handled(phone);
    phone.socket.close();
    await waitFor(() => gateway.listenerStreams().length === 0);
    // The gateway has let go of the device's last connection (and so had
    // its chance to forget the budget).
    const relays = (gateway.fixture.gateway as unknown as { relays: Map<unknown, string> }).relays;
    await waitFor(() => relays.size === 0);

    const again = await gateway.device('Phone', phone.token);
    await gateway.listen(again);
    again.socket.send(Buffer.alloc(2));
    await waitFor(() => gateway.ended(again).length === 1);
    assert.equal(gateway.ended(again)[0].reason, 'too-fast');
  } finally {
    await gateway.close();
  }
});

/**
 * A fake listener control socket: confirms the remote role, sends a state
 * that offers audio streams, and passes every other request to `handle`.
 * Only for what a real listener never does on purpose.
 */
async function fakeListener(
  handle: (request: Json, reply: (value: Json) => void, socket: Socket) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-fake-listener-'));
  const socketPath = join(directory, 'control.sock');
  const sockets: Socket[] = [];
  const received: Json[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    const reply = (value: Json) => socket.write(JSON.stringify(value) + '\n');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        received.push(request);
        if (request.action === 'client-role') {
          reply({ type: 'result', requestId: request.requestId, result: 'role-recorded' });
          reply({
            type: 'state',
            paused: false,
            microphones: { computer: true, listening: [], streams: true },
          });
          continue;
        }
        handle(request, reply, socket);
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');

  return {
    socketPath,
    received,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A paired phone of `fixture`, after the fake listener's state arrived. */
async function fakeListenerPhone(fixture: Awaited<ReturnType<typeof remoteFixture>>) {
  const { token } = await fixture.pair('Phone');
  const phone = await fixture.phone(token, fixture.origin, true);
  await phone.engine('state');
  return phone;
}
