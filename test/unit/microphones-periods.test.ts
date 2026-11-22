import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import test from 'node:test';

import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import {
  microphonesFixture,
  pieces,
  utterance,
  type MicrophonesFixtureOptions,
} from '../microphones-fixture.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { deferred } from '../helpers.ts';
import { ComputerMicrophoneSwitch } from '../../src/sensors/audio/computer-microphone.ts';

/**
 * Microphones and listening periods (src/sensors/audio/README.md, "Rules:
 * microphones and periods"), as one table derived from those rules.
 *
 * Each row runs against a real listener control socket (DesktopRuntime),
 * with the computer's microphone loop and listening browsers composed as in
 * src/cli.ts (test/microphones-fixture.ts). Browsers are remote-role control
 * connections that send `audio-start`, `audio-chunk` and `audio-stop`, as the
 * gateway does for them. Sound is synthetic (a square wave per word); the
 * recogniser and voice detector are the fixture's test versions. Every wait
 * is for the state it means, never a fixed time.
 */

/** One line-oriented control connection, as the gateway opens for a browser. */
class ControlClient {
  readonly messages: Record<string, any>[] = [];
  private buffered = '';
  private nextRequest = 0;

  private constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffered += chunk;
      let newline: number;
      while ((newline = this.buffered.indexOf('\n')) >= 0) {
        this.messages.push(JSON.parse(this.buffered.slice(0, newline)));
        this.buffered = this.buffered.slice(newline + 1);
      }
    });
  }

  static async connect(path: string, remote: boolean): Promise<ControlClient> {
    const client = new ControlClient(createConnection(path));
    await once(client.socket, 'connect');
    if (remote) {
      const role = await client.request({ action: 'client-role', role: 'remote' });
      assert.equal(role.result, 'role-recorded');
    }
    return client;
  }

  /** Send a request and wait for its answer. */
  async request(fields: Record<string, unknown>): Promise<Record<string, any>> {
    const requestId = `q${++this.nextRequest}`;
    this.socket.write(JSON.stringify({ ...fields, requestId }) + '\n');
    let reply: Record<string, any> | undefined;
    await waitFor(() => {
      reply = this.messages.find(
        (message) =>
          (message.type === 'result' || message.type === 'error') &&
          message.requestId === requestId,
      );
      return reply !== undefined;
    }, 3000);
    return reply!;
  }

  /** Send sound as `audio-chunk` pieces (no request IDs, never answered). */
  send(bytes: Buffer): void {
    for (const piece of pieces(bytes)) {
      this.socket.write(
        JSON.stringify({ action: 'audio-chunk', data: piece.toString('base64') }) + '\n',
      );
    }
  }

  /** The latest state message. */
  get state(): Record<string, any> {
    return this.messages.filter((message) => message.type === 'state').at(-1)!;
  }

  ended(): Record<string, any>[] {
    return this.messages.filter((message) => message.type === 'audio-ended');
  }

  close(): void {
    this.socket.destroy();
  }
}

/** A listener with microphones, a desktop observer and helpers to speak. */
async function setup(
  options: MicrophonesFixtureOptions & { captureStorage?: CaptureStoragePolicy } = {},
) {
  const desktop = await desktopFixture(
    async () => {
      throw Error('No desktop command expected');
    },
    undefined,
    { captureStorage: options.captureStorage },
  );
  const microphones = microphonesFixture(desktop.runtime, desktop.pause, options);
  const observer = await ControlClient.connect(desktop.socketPath, false);
  const clients: ControlClient[] = [observer];

  async function browser(name: string) {
    const client = await ControlClient.connect(desktop.socketPath, true);
    clients.push(client);
    const started = await client.request({ action: 'audio-start', deviceName: name });
    assert.equal(started.type, 'result', JSON.stringify(started));
    return { client, streamId: started.result.streamId as string };
  }

  /** Activity entries published so far: utterance and the microphone named. */
  function entries(): string[] {
    return observer.messages
      .filter((message) => message.type === 'activity-entry')
      .map((message) => `${message.entry.utterance} (${message.entry.microphone ?? 'computer'})`);
  }

  /** The microphones listening now, by name, from the latest state. */
  function listening(): string[] {
    return (observer.state.microphones?.listening ?? []).map(
      (microphone: { name: string }) => microphone.name,
    );
  }

  async function waitForDispatches(count: number) {
    await waitFor(() => microphones.dispatched.length >= count, 5000);
  }

  async function close() {
    for (const client of clients) {
      client.close();
    }
    await microphones.close();
    await desktop.close();
  }

  await waitFor(() => microphones.computerListening);
  await waitFor(() => observer.state?.microphones?.listening.length === 1);
  return { desktop, microphones, observer, browser, entries, listening, waitForDispatches, close };
}

test('computer only: its speech is heard and its Activity entries name no browser', async () => {
  const listener = await setup();
  try {
    assert.deepEqual(listener.listening(), ['Computer']);
    assert.equal(listener.observer.state.microphones.computer, true);
    assert.equal(listener.observer.state.microphones.streams, true);

    listener.microphones.sayOnComputer(utterance(0.3));
    await listener.waitForDispatches(1);
    assert.deepEqual(listener.microphones.dispatched, [{ utterance: 'w3' }]);
    await waitFor(() => listener.entries().length === 1);
    assert.deepEqual(listener.entries(), ['w3 (computer)']);
    assert.equal(
      listener.observer.messages.find((message) => message.type === 'activity-entry')!.entry
        .microphone,
      undefined,
      'An entry of the computer has no microphone field',
    );
  } finally {
    await listener.close();
  }
});

test('computer and one browser: both are heard, each entry names its microphone', async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    await waitFor(() => listener.listening().length === 2);
    assert.deepEqual(listener.listening(), ['Computer', 'Phone']);
    assert.equal(listener.observer.state.microphones.listening[1].id, phone.streamId);

    listener.microphones.sayOnComputer(utterance(0.3));
    phone.client.send(utterance(0.5));
    await listener.waitForDispatches(2);
    assert.deepEqual(listener.microphones.dispatched.map((dispatch) => dispatch.utterance).sort(), [
      'w3',
      'w5',
    ]);
    await waitFor(() => listener.entries().length === 2);
    assert.deepEqual(listener.entries().sort(), ['w3 (computer)', 'w5 (Phone)']);
  } finally {
    await listener.close();
  }
});

test('two browsers: each has its own period and voice detector', async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    const laptop = await listener.browser('Laptop');
    await waitFor(() => listener.microphones.detectors.length === 2);
    assert.deepEqual(listener.listening(), ['Computer', 'Phone', 'Laptop']);

    phone.client.send(utterance(0.5));
    laptop.client.send(utterance(0.6));
    await listener.waitForDispatches(2);
    await waitFor(() => listener.entries().length === 2);
    assert.deepEqual(listener.entries().sort(), ['w5 (Phone)', 'w6 (Laptop)']);
  } finally {
    await listener.close();
  }
});

test('browser only: the computer switched off hears nothing; with no browser either, nothing listens', async () => {
  const listener = await setup();
  try {
    const off = await listener.observer.request({
      action: 'set-computer-microphone',
      enabled: false,
    });
    assert.equal(off.result, 'computer-microphone-off');
    await waitFor(() => !listener.microphones.computerListening);
    await waitFor(() => listener.listening().length === 0);
    assert.equal(listener.observer.state.microphones.computer, false);
    // No state ever named the computer as listening once its switch was off.
    for (const message of listener.observer.messages) {
      if (message.type === 'state' && message.microphones?.computer === false) {
        assert.deepEqual(message.microphones.listening, []);
      }
    }
    assert.equal(listener.microphones.sayOnComputer(utterance(0.3)), false, 'Nothing records');

    const phone = await listener.browser('Phone');
    await waitFor(() => listener.listening().length === 1);
    assert.deepEqual(listener.listening(), ['Phone']);
    phone.client.send(utterance(0.5));
    await listener.waitForDispatches(1);
    assert.deepEqual(listener.microphones.dispatched, [{ utterance: 'w5' }]);

    // Switched on again: a new period of the computer's microphone.
    const periods = listener.microphones.computerPeriods;
    await listener.observer.request({ action: 'set-computer-microphone', enabled: true });
    await waitFor(() => listener.microphones.computerPeriods === periods + 1);
    await waitFor(() => listener.listening().length === 2);
  } finally {
    await listener.close();
  }
});

test("a stream that starts or ends mid-utterance on the computer leaves the computer's utterance whole", async () => {
  const listener = await setup();
  try {
    // The computer is in the middle of an utterance (speech, no silence yet).
    listener.microphones.sayOnComputer(utterance(0.3, 640, 0));
    await waitFor(() => listener.observer.state.speaking === true);

    const phone = await listener.browser('Phone');
    phone.client.send(utterance(0.5, 640, 0));
    // The browser's stream ends mid-utterance: its open candidate is discarded.
    const stopped = await phone.client.request({ action: 'audio-stop' });
    assert.equal(stopped.result, 'stopped');
    await waitFor(() => listener.listening().length === 1);
    assert.equal(listener.observer.state.speaking, true, 'The computer still hears speech');

    // The computer's utterance ends and is processed as one.
    listener.microphones.sayOnComputer(utterance(0.3, 160, 480));
    await listener.waitForDispatches(1);
    await waitFor(() => listener.observer.state.speaking === false);
    assert.deepEqual(listener.microphones.dispatched, [{ utterance: 'w3' }]);
    assert.equal(phone.client.ended().length, 0, 'A stop that was asked for is not reported');
  } finally {
    await listener.close();
  }
});

test("a browser's utterance in progress survives the computer being switched off", async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    phone.client.send(utterance(0.5, 640, 0));
    await waitFor(() => listener.observer.state.speaking === true);

    await listener.observer.request({ action: 'set-computer-microphone', enabled: false });
    await waitFor(() => !listener.microphones.computerListening);

    phone.client.send(utterance(0.5, 160, 480));
    await listener.waitForDispatches(1);
    assert.deepEqual(listener.microphones.dispatched, [{ utterance: 'w5' }]);
  } finally {
    await listener.close();
  }
});

for (const combination of ['computer only', 'computer and browser', 'browser only'] as const) {
  test(`Pause stops every microphone and Resume starts them again (${combination})`, async () => {
    const listener = await setup();
    try {
      if (combination === 'browser only') {
        await listener.observer.request({ action: 'set-computer-microphone', enabled: false });
        await waitFor(() => !listener.microphones.computerListening);
      }
      const phone = combination === 'computer only' ? undefined : await listener.browser('Phone');
      await waitFor(
        () => listener.listening().length === (combination === 'computer and browser' ? 2 : 1),
      );

      const paused = await listener.observer.request({ action: 'toggle-pause' });
      assert.equal(paused.result, 'paused');
      await waitFor(() => listener.observer.state.paused === true);
      assert.deepEqual(listener.listening(), []);
      await waitFor(() => !listener.microphones.computerListening);
      if (phone) {
        await waitFor(() => phone.client.ended().length === 1);
        assert.deepEqual(phone.client.ended(), [
          { type: 'audio-ended', streamId: phone.streamId, reason: 'paused' },
        ]);
        await waitFor(() => listener.microphones.detectors.every((detector) => detector.closed));

        // A browser cannot start listening while paused.
        const refused = await phone.client.request({ action: 'audio-start', deviceName: 'Phone' });
        assert.equal(refused.type, 'error');
        assert.match(refused.message, /paused/);
      }

      await listener.observer.request({ action: 'toggle-pause' });
      await waitFor(() => listener.observer.state.paused === false);
      if (combination === 'browser only') {
        assert.equal(listener.microphones.computerListening, false, 'Its switch is still off');
      } else {
        await waitFor(() => listener.microphones.computerListening);
      }
      if (phone) {
        // The browser opens a new stream once the state says listening.
        const again = await phone.client.request({ action: 'audio-start', deviceName: 'Phone' });
        assert.equal(again.type, 'result');
        assert.notEqual(again.result.streamId, phone.streamId);
        phone.client.send(utterance(0.5));
        await listener.waitForDispatches(1);
      } else {
        listener.microphones.sayOnComputer(utterance(0.3));
        await listener.waitForDispatches(1);
      }
    } finally {
      await listener.close();
    }
  });
}

test("the connection's second audio-start replaces its stream; a late stop never ends the newer one", async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    const second = await phone.client.request({ action: 'audio-start', deviceName: 'Phone' });
    assert.equal(second.type, 'result');
    await waitFor(() => phone.client.ended().length === 1);
    assert.deepEqual(phone.client.ended(), [
      { type: 'audio-ended', streamId: phone.streamId, reason: 'replaced' },
    ]);
    assert.deepEqual(listener.listening(), ['Computer', 'Phone']);

    const late = await phone.client.request({ action: 'audio-stop', streamId: phone.streamId });
    assert.equal(late.result, 'not-streaming');
    phone.client.send(utterance(0.5));
    await listener.waitForDispatches(1);
  } finally {
    await listener.close();
  }
});

test('a closed connection (revoked, page closed) ends its stream; accepted speech still completes', async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    phone.client.send(utterance(0.5));
    await waitFor(() => listener.microphones.logs.some((log) => log.stage === 'utterance'));
    phone.client.close();

    await waitFor(() => listener.listening().length === 1);
    await listener.waitForDispatches(1);
    assert.deepEqual(listener.microphones.dispatched, [{ utterance: 'w5' }]);
    await waitFor(() => listener.microphones.detectors.every((detector) => detector.closed));
  } finally {
    await listener.close();
  }
});

test('the listener restarts: every stream and detector ends, and the computer switch starts on', async () => {
  const listener = await setup();
  const phone = await listener.browser('Phone');
  await listener.observer.request({ action: 'set-computer-microphone', enabled: false });
  await listener.close();

  assert.ok(listener.microphones.detectors.every((detector) => detector.closed));
  assert.equal(listener.microphones.browsers.list.length, 0);
  assert.equal(phone.client.socket.destroyed, true);
  assert.equal(new ComputerMicrophoneSwitch().enabled, true, 'The switch is not stored');
});

test('limits: eight periods, whole samples of at most 8 KiB, a stream per remote connection only', async () => {
  const listener = await setup();
  try {
    const streams = [];
    // The gateway allows four streams; the listener's own bound is eight
    // periods, so a takeover's start never meets a stop still on its way.
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']) {
      streams.push(await listener.browser(name));
    }
    const fifth = await ControlClient.connect(listener.desktop.socketPath, true);
    const refused = await fifth.request({ action: 'audio-start', deviceName: 'Nine' });
    assert.equal(refused.type, 'error');
    assert.match(refused.message, /Too many/);

    // Desktop connections never stream; a remote one without a stream cannot feed one.
    const desktopStart = await listener.observer.request({
      action: 'audio-start',
      deviceName: 'Desk',
    });
    assert.match(desktopStart.message, /Only remote panels/);
    const chunk = await fifth.request({ action: 'audio-chunk', data: 'AAAAAA==' });
    assert.match(chunk.message, /No audio stream/);
    fifth.close();

    // Malformed pieces are refused one by one; the stream stays open.
    const one = streams[0].client;
    for (const [data, reason] of [
      ['AAA', /base64/],
      ['AA==', /whole 16-bit samples/],
      [Buffer.alloc(8194).toString('base64'), /8 KiB/],
      ['', /base64/],
    ] as const) {
      const answer = await one.request({ action: 'audio-chunk', data });
      assert.equal(answer.type, 'error');
      assert.match(answer.message, reason);
    }
    // At the bound: 8 KiB of whole samples is accepted, and never answered.
    // Requests are handled in order, so once a later request is answered,
    // an error for the piece would already have arrived.
    one.socket.write(
      JSON.stringify({
        action: 'audio-chunk',
        data: Buffer.alloc(8192).toString('base64'),
        requestId: 'at-bound',
      }) + '\n',
    );
    await one.request({ action: 'set-computer-microphone', enabled: true });
    assert.equal(
      one.messages.some((message) => message.requestId === 'at-bound'),
      false,
      'The piece at the bound is accepted without an answer',
    );
    assert.equal(listener.listening().length, 9);
    assert.equal(one.ended().length, 0);
  } finally {
    await listener.close();
  }
});

test('a listener that falls behind ends the stream as slow instead of dropping sound', async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    await waitFor(() => listener.microphones.detectors.length === 1);
    // Hold the stream's voice detector, then send more than five seconds.
    let release!: () => void;
    listener.microphones.detectors[0].gate = new Promise((resolve) => {
      release = resolve;
    });
    phone.client.send(Buffer.alloc(16_000 * 2 * 6));
    await waitFor(() => phone.client.ended().length === 1);
    assert.equal(phone.client.ended()[0].reason, 'slow');
    release();
    await waitFor(() => listener.listening().length === 1);
  } finally {
    await listener.close();
  }
});

test('"hearing speech" is on while any microphone hears speech', async () => {
  const listener = await setup();
  try {
    const phone = await listener.browser('Phone');
    listener.microphones.sayOnComputer(utterance(0.3, 640, 0));
    phone.client.send(utterance(0.5, 640, 0));
    await waitFor(() => listener.observer.state.speaking === true);

    // The computer's utterance ends; the phone still hears speech.
    listener.microphones.sayOnComputer(utterance(0.3, 160, 480));
    await listener.waitForDispatches(1);
    assert.equal(listener.observer.state.speaking, true);

    phone.client.send(utterance(0.5, 160, 480));
    await waitFor(() => listener.observer.state.speaking === false);
  } finally {
    await listener.close();
  }
});

test('a stream begun with storage off stays unsaved, even if storage turns on before its detector is ready', async () => {
  const captureStorage = new CaptureStoragePolicy();
  const loaded = deferred<void>();
  const listener = await setup({ captureStorage, detectorsLoaded: loaded.promise });
  try {
    const phone = await listener.browser('Phone');
    phone.client.send(utterance(0.5));
    await captureStorage.setEnabled(true);
    loaded.resolve();
    await listener.waitForDispatches(1);
    await waitFor(() => listener.entries().length === 1);

    // A stream started now, with storage on, is saved.
    await phone.client.request({ action: 'audio-stop' });
    const again = await phone.client.request({ action: 'audio-start', deviceName: 'Phone' });
    assert.equal(again.type, 'result');
    phone.client.send(utterance(0.6));
    await listener.waitForDispatches(2);
    await waitFor(() => listener.entries().length === 2);

    const rows = listener.desktop.database
      .prepare('SELECT transcript, capture_storage, audio_saved FROM utterances ORDER BY rowid')
      .all();
    assert.deepEqual(
      rows.map((row) => [row.transcript, row.capture_storage, row.audio_saved]),
      [
        ['w5', 'off', 0],
        ['w6', 'on', 1],
      ],
    );
  } finally {
    await listener.close();
  }
});

test("a stalled stream ends, so its held attempt cannot block the other microphones' speech", async () => {
  const listener = await setup({ maximumLagMs: 300 });
  try {
    const phone = await listener.browser('Phone');
    // A whole utterance, then speech that resumes (holding it) and stops
    // arriving: the phone's capture stopped while its page stays connected.
    phone.client.send(Buffer.concat([utterance(0.5), utterance(0.5, 320, 0)]));
    await waitFor(() => listener.microphones.logs.some((log) => log.stage === 'utterance'));
    listener.microphones.sayOnComputer(utterance(0.3));

    await waitFor(() => phone.client.ended().length === 1);
    assert.equal(phone.client.ended()[0].reason, 'stalled');
    await listener.waitForDispatches(2);
    assert.deepEqual(
      listener.microphones.dispatched.map((dispatch) => dispatch.utterance),
      ['w5', 'w3'],
    );
  } finally {
    await listener.close();
  }
});

test('a stream that delivers far too little sound ends as stalled, though pieces keep arriving', async () => {
  const listener = await setup({ maximumLagMs: 300 });
  const tiny = Buffer.alloc(320); // 10 ms of sound
  const trickle = setInterval(() => {
    phone.client.send(tiny);
  }, 50);
  const phone = await listener.browser('Phone');
  try {
    await waitFor(() => phone.client.ended().length === 1, 5000);
    assert.equal(phone.client.ended()[0].reason, 'stalled');
  } finally {
    clearInterval(trickle);
    await listener.close();
  }
});

test('an ended stream releases its hold at once, even while its detector is busy', async () => {
  const listener = await setup();
  let release = () => {};
  try {
    const phone = await listener.browser('Phone');
    phone.client.send(Buffer.concat([utterance(0.5), utterance(0.5, 320, 0)]));
    await waitFor(() => listener.microphones.logs.some((log) => log.stage === 'hold'));

    // The phone's detector is stuck on its next frame when the stream ends.
    listener.microphones.detectors[0].gate = new Promise((resolve) => {
      release = resolve;
    });
    phone.client.send(utterance(0.5, 64, 0));
    await waitFor(() => listener.microphones.detectors[0].held > 0);
    const stopped = await phone.client.request({ action: 'audio-stop' });
    assert.equal(stopped.result, 'stopped');

    listener.microphones.sayOnComputer(utterance(0.3));
    await listener.waitForDispatches(2);
    assert.deepEqual(
      listener.microphones.dispatched.map((dispatch) => dispatch.utterance),
      ['w5', 'w3'],
    );
    assert.equal(listener.microphones.detectors[0].closed, false, 'Its detector is still busy');
    release();
    await waitFor(() => listener.microphones.detectors[0].closed);
  } finally {
    // Never leave the detector held: cleanup waits for it.
    release();
    await listener.close();
  }
});
