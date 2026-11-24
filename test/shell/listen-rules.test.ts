/**
 * The rules of Listen here (integrations/shell/README.md, "Listen here"):
 * "Rule: listening states" and "Rule: sending", one test per row and
 * column of those tables, against listen/listen-here.ts with a fake
 * connection and a fake microphone. The browser suite
 * (listen-here.test.ts) checks the same behaviour end to end with the real
 * gateway, listener and Chromium's fake audio device.
 *
 * Also: the conversion to 16 kHz pieces (listen/pcm-pieces.ts).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { UncertainOutcome } from '../../integrations/mobile/src/connection.ts';
import {
  CaptureError,
  type CaptureEnvironment,
  type CaptureHandlers,
  type OpenCapture,
} from '../../integrations/shell/src/listen/capture.ts';
import {
  automaticRestartInterval,
  ListenHere,
  maximumBacklogBytes,
  type ListenEngine,
  type ListenHost,
} from '../../integrations/shell/src/listen/listen-here.ts';
import {
  PcmPieces,
  pieceLevel,
  pieceSamples,
} from '../../integrations/shell/src/listen/pcm-pieces.ts';
import type { AudioEndedMessage, AudioEndReason } from '../../src/remote/protocol.ts';

// ---- Fakes ----------------------------------------------------------------------

interface SentRequest {
  action: 'audio-start' | 'audio-stop';
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** The page's connection: the Store's state, requests and the socket. */
class FakeHost implements ListenHost {
  isAdmitted = true;
  isPaired = true;
  state: ListenEngine | undefined = {
    ready: true,
    paused: false,
    microphones: { computer: true, listening: [], streams: true },
  };
  requests: SentRequest[] = [];
  pieces: ArrayBuffer[] = [];
  warnings: string[] = [];
  buffered = 0;
  private listeners = new Set<() => void>();
  private ended?: (message: AudioEndedMessage) => void;

  admitted() {
    return this.isAdmitted;
  }
  paired() {
    return this.isPaired;
  }
  engine() {
    return this.state;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request(action: 'audio-start' | 'audio-stop') {
    return new Promise<unknown>((resolve, reject) => {
      this.requests.push({ action, resolve, reject });
    });
  }
  sendAudio(piece: ArrayBuffer) {
    if (!this.isAdmitted) {
      return false;
    }
    this.pieces.push(piece);
    return true;
  }
  bufferedAmount() {
    return this.buffered;
  }
  onAudioEnded(listener: (message: AudioEndedMessage) => void) {
    this.ended = listener;
  }
  warn(text: string) {
    this.warnings.push(text);
  }

  /** A new state message (a new engine object, as the Store makes). */
  changeEngine(change: Partial<ListenEngine>) {
    this.state = { ...this.state!, ...change };
    this.notify();
  }
  notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  /** The connection drops (the Store goes offline). */
  disconnect() {
    this.isAdmitted = false;
    for (const request of this.requests.splice(0)) {
      request.reject(new UncertainOutcome('The connection dropped'));
    }
    this.notify();
  }
  reconnect() {
    this.isAdmitted = true;
    this.state = { ...this.state! };
    this.notify();
  }
  audioEnded(streamId: string, reason: AudioEndReason) {
    this.ended?.({ type: 'audio-ended', streamId, reason, message: `ended: ${reason}` });
  }
  actions() {
    return this.requests.map((request) => request.action);
  }
  /** Answer the oldest unanswered request of `action`. */
  answer(action: 'audio-start' | 'audio-stop', value: unknown) {
    const index = this.requests.findIndex((request) => request.action === action);
    assert.ok(index >= 0, `no ${action} to answer; sent: ${this.actions()}`);
    const [request] = this.requests.splice(index, 1);
    request.resolve(value);
  }
  refuse(action: 'audio-start' | 'audio-stop', message: string) {
    const index = this.requests.findIndex((request) => request.action === action);
    assert.ok(index >= 0, `no ${action} to refuse`);
    const [request] = this.requests.splice(index, 1);
    request.reject(Error(message));
  }
}

interface FakeOpening {
  onPiece(piece: ArrayBuffer): void;
  onEnded(): void;
  /** The browser granted the microphone and the worklet runs. */
  grant(): void;
  /** The browser granted the microphone; the worklet still loads. */
  grantOnly(): void;
  /** The worklet finished loading after `grantOnly`. */
  ready(): void;
  deny(error: CaptureError): void;
  /** The browser granted it: its track was live at some point. */
  granted: boolean;
  /** The track was stopped. */
  closed: boolean;
}

/** The browser's microphone, permission prompt and signs. */
class FakeEnvironment implements CaptureEnvironment {
  unavailableReason = '';
  openings: FakeOpening[] = [];
  capturing = false;
  time = 0;
  timers: { at: number; callback: () => void; cancelled: boolean }[] = [];

  unavailable() {
    return this.unavailableReason;
  }
  open(handlers: CaptureHandlers, signal: AbortSignal): Promise<OpenCapture> {
    return new Promise((resolve, reject) => {
      const opening: FakeOpening = {
        onPiece: (piece) => handlers.onPiece(piece),
        onEnded: () => handlers.onEnded(),
        granted: false,
        closed: false,
        grantOnly: () => {
          if (signal.aborted) {
            // As capture.ts: a microphone granted after the page gave up is
            // released at once.
            opening.granted = true;
            opening.closed = true;
            reject(new CaptureError('failed', 'Cancelled'));
            return;
          }
          opening.granted = true;
          handlers.onGranted();
          signal.addEventListener('abort', () => {
            opening.closed = true;
            reject(new CaptureError('failed', 'Cancelled'));
          });
        },
        ready: () => {
          if (signal.aborted) {
            return;
          }
          resolve({
            close: () => {
              opening.closed = true;
            },
          });
        },
        grant: () => {
          opening.grantOnly();
          opening.ready();
        },
        deny: (error) => reject(error),
      };
      this.openings.push(opening);
    });
  }
  setCapturing(capturing: boolean) {
    this.capturing = capturing;
  }
  now() {
    return this.time;
  }
  setTimeout(callback: () => void, milliseconds: number) {
    const timer = { at: this.time + milliseconds, callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(milliseconds: number) {
    this.time += milliseconds;
    for (const timer of this.timers) {
      if (!timer.cancelled && timer.at <= this.time) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  }
  /** The microphone opened most recently. */
  get latest(): FakeOpening {
    const opening = this.openings.at(-1);
    assert.ok(opening, 'the microphone was never asked for');
    return opening;
  }
  /** Whether a microphone is open now (granted and not closed). */
  get openCount(): number {
    return this.openings.filter((opening) => !opening.closed).length;
  }
}

/** Promise callbacks run: answers and grants take effect. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await Promise.resolve();
  }
}

const piece = () => new Int16Array(1600).fill(8000).buffer;

function setup() {
  const host = new FakeHost();
  const environment = new FakeEnvironment();
  const listen = new ListenHere(host, environment);
  return { host, environment, listen };
}

/** Listen here switched on, permission granted, stream `s1` open. */
async function listening() {
  const parts = setup();
  parts.listen.setWanted(true);
  parts.environment.latest.grant();
  await settle();
  parts.host.answer('audio-start', { streamId: 's1' });
  await settle();
  assert.equal(parts.listen.view.phase, 'listening');
  assert.equal(parts.listen.view.streamId, 's1');
  return parts;
}

/** Nothing is captured: no sign shows, and every granted microphone was released. */
function assertClosed(parts: ReturnType<typeof setup>) {
  assert.equal(parts.environment.capturing, false);
  for (const opening of parts.environment.openings) {
    if (opening.granted) {
      assert.equal(opening.closed, true, 'a granted microphone is still open');
    }
  }
}

// ---- Rule: listening states --------------------------------------------------------

test('off: nothing is asked for; the page starts with Listen here off (not remembered)', () => {
  const { listen, environment, host } = setup();
  assert.equal(listen.view.phase, 'off');
  assert.equal(environment.openings.length, 0);
  assert.deepEqual(host.actions(), []);
});

test('off → switch on: asking permission, nothing captured, no stream yet', () => {
  const { listen, environment, host } = setup();
  listen.setWanted(true);
  assert.equal(listen.view.phase, 'asking');
  assert.equal(environment.openings.length, 1);
  assert.equal(environment.capturing, false);
  assert.deepEqual(host.actions(), []);
});

test('asking → granted: listening; the stream starts; pieces go out only once it is open', async () => {
  const { listen, environment, host } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  assert.equal(listen.view.phase, 'listening');
  assert.equal(environment.capturing, true, 'the mark and the title sign');
  assert.deepEqual(host.actions(), ['audio-start']);

  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 0, 'no stream is open yet');

  host.answer('audio-start', { streamId: 's1' });
  await settle();
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 1);
  assert.ok(listen.currentLevel > 0.2);
});

test('asking → switch off: the microphone, once granted, is closed at once', async () => {
  const { listen, environment, host } = setup();
  listen.setWanted(true);
  listen.setWanted(false);
  environment.latest.grant();
  await settle();
  assert.equal(environment.latest.closed, true);
  assert.equal(listen.view.phase, 'off');
  assert.deepEqual(host.actions(), []);
});

test('asking → Pause: closed once granted; listens on Resume', async () => {
  const { listen, environment, host } = setup();
  listen.setWanted(true);
  host.changeEngine({ paused: true });
  environment.latest.grant();
  await settle();
  assert.equal(environment.latest.closed, true);
  assert.equal(listen.view.phase, 'waiting');
  assert.equal(listen.view.waitingFor, 'paused');

  host.changeEngine({ paused: false });
  assert.equal(listen.view.phase, 'asking');
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('asking → refused: off with "refused"; other microphones unaffected', async () => {
  const { listen, environment, host } = setup();
  listen.setWanted(true);
  environment.latest.deny(new CaptureError('refused', 'The browser refused the microphone'));
  await settle();
  assert.equal(listen.view.phase, 'off');
  assert.equal(listen.view.problem?.kind, 'refused');
  assert.deepEqual(host.actions(), []);
});

test('refused → switch on: asked again; the problem is cleared', async () => {
  const { listen, environment } = setup();
  listen.setWanted(true);
  environment.latest.deny(new CaptureError('refused', 'The browser refused the microphone'));
  await settle();
  listen.setWanted(true);
  assert.equal(listen.view.phase, 'asking');
  assert.equal(listen.view.problem, undefined);
  assert.equal(environment.openings.length, 2);
});

test('asking → no microphone: off with "no-microphone"', async () => {
  const { listen, environment } = setup();
  listen.setWanted(true);
  environment.latest.deny(new CaptureError('no-microphone', 'No microphone was found'));
  await settle();
  assert.equal(listen.view.problem?.kind, 'no-microphone');
});

test('listening → switch off: audio-stop; the microphone is released', async () => {
  const parts = await listening();
  parts.listen.setWanted(false);
  assert.deepEqual(parts.host.actions(), ['audio-stop']);
  assert.equal(parts.environment.latest.closed, true);
  assert.equal(parts.listen.view.phase, 'off');
  assertClosed(parts);
});

test('listening → Pause (from any panel): microphone released, stream stopped; Resume starts again', async () => {
  const parts = await listening();
  const { host, environment, listen } = parts;
  host.changeEngine({ paused: true });
  assert.deepEqual(host.actions(), ['audio-stop']);
  assert.equal(environment.latest.closed, true);
  assert.equal(listen.view.phase, 'waiting');
  assert.equal(listen.view.waitingFor, 'paused');
  // The gateway's end of that stream arrives late: changes nothing.
  host.audioEnded('s1', 'paused');

  host.changeEngine({ paused: false });
  assert.equal(environment.openings.length, 2, 'the microphone is asked for again');
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-stop', 'audio-start']);
});

test('listening → the gateway ends the stream as paused before the state says so: released at once; no start until the next state', async () => {
  const parts = await listening();
  const { host, environment, listen } = parts;
  host.audioEnded('s1', 'paused');
  assert.deepEqual(host.actions(), [], 'no new start while the pause is still on its way');
  assert.equal(environment.latest.closed, true, 'the microphone is released at once');
  assert.equal(listen.view.phase, 'waiting');
  assert.equal(listen.view.waitingFor, 'paused');
  assertClosed(parts);
  host.changeEngine({ paused: true });
  host.changeEngine({ paused: false });
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('a start refused as paused waits for the next state instead of switching off', async () => {
  const { host, environment, listen } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  host.refuse('audio-start', 'Listening is paused');
  await settle();
  assert.equal(listen.view.problem, undefined);
  assert.deepEqual(host.actions(), []);
  assert.equal(environment.latest.closed, true);
  host.changeEngine({});
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('paused → switch off: off; Resume then starts nothing', async () => {
  const { host, environment, listen } = await listening();
  host.changeEngine({ paused: true });
  listen.setWanted(false);
  host.changeEngine({ paused: false });
  assert.equal(listen.view.phase, 'off');
  assert.equal(environment.openings.length, 1);
});

test('listening → tab hidden and back: nothing changes (the page does not read visibility)', async () => {
  const { host, environment, listen } = await listening();
  // A hidden tab only changes what the connection does (a probe on return);
  // the state stays the same, so the stream goes on.
  host.notify();
  assert.equal(listen.view.phase, 'listening');
  assert.equal(environment.latest.closed, false);
  assert.deepEqual(host.actions(), []);
});

test('listening → connection lost and back: released while offline, listening again after the reconnect', async () => {
  const parts = await listening();
  const { host, environment, listen } = parts;
  host.disconnect();
  assert.equal(listen.view.phase, 'waiting');
  assert.equal(listen.view.waitingFor, 'connection');
  assert.equal(environment.latest.closed, true);
  assertClosed(parts);
  assert.deepEqual(
    host.actions(),
    [],
    'no stop without a connection: the gateway ended the stream',
  );

  host.reconnect();
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('a start whose answer is lost with the connection starts again after the reconnect', async () => {
  const { host, environment, listen } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  host.disconnect();
  await settle();
  assert.equal(listen.view.problem, undefined);
  host.reconnect();
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('listening → sign-out: off and released; the next pairing starts off', async () => {
  const { host, environment, listen } = await listening();
  host.isPaired = false;
  host.isAdmitted = false;
  host.notify();
  assert.equal(listen.view.phase, 'off');
  assert.equal(environment.latest.closed, true);
  host.isPaired = true;
  host.reconnect();
  assert.equal(listen.view.phase, 'off');
  assert.equal(environment.openings.length, 1);
});

test('listening → another tab takes over: off with "moved", released, never taken back by itself', async () => {
  const { host, environment, listen } = await listening();
  host.audioEnded('s1', 'taken-over');
  assert.equal(listen.view.phase, 'off');
  assert.equal(listen.view.problem?.kind, 'moved');
  assert.equal(environment.latest.closed, true);
  host.changeEngine({});
  assert.deepEqual(host.actions(), [], 'no stop for an ended stream, and no new start');
});

test('moved → switch on: takes the stream back', async () => {
  const { host, environment, listen } = await listening();
  host.audioEnded('s1', 'taken-over');
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('listening → permission withdrawn (the track ends): off with "lost"', async () => {
  const { host, environment, listen } = await listening();
  environment.latest.onEnded();
  assert.equal(listen.view.phase, 'off');
  assert.equal(listen.view.problem?.kind, 'lost');
  assert.equal(environment.latest.closed, true);
  assert.deepEqual(host.actions(), ['audio-stop']);
});

test('listening → no sound reached Companion (stalled): off with "lost"', async () => {
  const { host, listen } = await listening();
  host.audioEnded('s1', 'stalled');
  assert.equal(listen.view.problem?.kind, 'lost');
  assert.deepEqual(host.actions(), []);
});

test('listening → Companion ends the stream (failed, shutdown): off with its message', async () => {
  for (const reason of ['failed', 'shutdown', 'replaced'] as const) {
    const { host, listen } = await listening();
    host.audioEnded('s1', reason);
    assert.equal(listen.view.problem?.kind, 'stopped');
    assert.equal(listen.view.problem?.message, `ended: ${reason}`);
  }
});

test('a start refused by Companion (too many browsers): off with its message', async () => {
  const { host, environment, listen } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  host.refuse('audio-start', 'Too many browsers are listening (at most 4)');
  await settle();
  assert.equal(listen.view.phase, 'off');
  assert.equal(listen.view.problem?.message, 'Too many browsers are listening (at most 4)');
  assert.equal(environment.latest.closed, true);
});

test('not available: no switch; switching on is refused', () => {
  const reasons: [string, (parts: ReturnType<typeof setup>) => void][] = [
    [
      'no secure page or policy',
      (parts) => (parts.environment.unavailableReason = 'Needs a secure (HTTPS) page'),
    ],
    ['older listener', (parts) => parts.host.changeEngine({ microphones: undefined })],
    [
      'listener without streams',
      (parts) =>
        parts.host.changeEngine({ microphones: { computer: true, listening: [], streams: false } }),
    ],
  ];
  for (const [name, make] of reasons) {
    const parts = setup();
    make(parts);
    parts.listen.setWanted(true);
    assert.equal(parts.listen.view.phase, 'unavailable', name);
    assert.ok(parts.listen.view.unavailable, name);
    assert.equal(parts.environment.openings.length, 0, name);
  }
});

test('switching on is refused while requests are not admitted; off is always possible', async () => {
  const { host, listen } = await listening();
  host.disconnect();
  listen.setWanted(false);
  assert.equal(listen.view.phase, 'off');
  listen.setWanted(true);
  assert.equal(listen.view.phase, 'off');
});

test('listening, then the listener restarts as an older version: off, without a problem', async () => {
  const { host, environment, listen } = await listening();
  host.changeEngine({ microphones: undefined });
  assert.equal(listen.view.phase, 'unavailable');
  assert.equal(environment.latest.closed, true);
});

test('granted while the worklet still loads: the mark shows; switching off releases the track at once', async () => {
  const parts = setup();
  const { listen, environment, host } = parts;
  listen.setWanted(true);
  environment.latest.grantOnly();
  assert.equal(listen.view.phase, 'listening');
  assert.equal(environment.capturing, true, 'the mark and the title sign show while it loads');
  assert.deepEqual(host.actions(), [], 'no stream before the worklet runs');

  listen.setWanted(false);
  assert.equal(environment.latest.closed, true, 'released without waiting for the worklet');
  assert.equal(environment.capturing, false);
  environment.latest.ready();
  await settle();
  assertClosed(parts);
  assert.deepEqual(host.actions(), []);
});

test('granted after the page gave up (switched off while asking): released at once', async () => {
  const parts = setup();
  parts.listen.setWanted(true);
  parts.listen.setWanted(false);
  parts.environment.latest.grantOnly();
  await settle();
  assertClosed(parts);
});

test('a start refused because another tab took over meanwhile: off with "moved"', async () => {
  const { host, environment, listen } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  host.refuse('audio-start', 'Listening moved to another tab or window of this device');
  await settle();
  assert.equal(listen.view.problem?.kind, 'moved');
  assert.equal(environment.latest.closed, true);
});

// ---- Rule: sending -------------------------------------------------------------

test('sending: normal pieces go out in order while the stream is open', async () => {
  const { host, environment } = await listening();
  for (let index = 0; index < 5; index++) {
    environment.latest.onPiece(new Int16Array(1600).fill(index).buffer);
  }
  assert.deepEqual(
    host.pieces.map((sent) => new Int16Array(sent)[0]),
    [0, 1, 2, 3, 4],
  );
});

test('sending: a backlog over two seconds ends the stream, says so and starts a new one after the stop', async () => {
  const { host, environment, listen } = await listening();
  environment.latest.onPiece(piece());
  host.buffered = maximumBacklogBytes; // exactly 2 s: still sent
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 2);

  host.buffered = maximumBacklogBytes + 1;
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 2, 'not sent: the stream ends here');
  assert.deepEqual(host.actions(), ['audio-stop']);
  assert.equal(listen.view.notice, 'Connection too slow: some speech was lost');
  assert.deepEqual(host.warnings, ['Connection too slow: some speech was lost'], 'also a toast');

  // Until the stop is answered nothing is sent, and no start is sent.
  host.buffered = 0;
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 2);
  host.answer('audio-stop', 'stopped');
  await settle();
  assert.deepEqual(host.actions(), ['audio-start']);
  host.answer('audio-start', { streamId: 's2' });
  await settle();
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 3);
  assert.equal(environment.latest.closed, false, 'the microphone stays open across the restart');

  environment.advance(10_000);
  assert.equal(listen.view.notice, '', 'the notice passes');
});

test('sending: the gateway ends the stream for a limit: a new stream at once, then off if it happens again soon', async () => {
  for (const reason of ['too-large', 'too-fast', 'slow-listener', 'slow'] as const) {
    const { host, environment, listen } = await listening();
    host.audioEnded('s1', reason);
    assert.deepEqual(host.actions(), ['audio-start'], reason);
    assert.match(listen.view.notice, /^Some speech was lost/);
    assert.match(host.warnings[0], /^Some speech was lost/);
    host.answer('audio-start', { streamId: 's2' });
    await settle();

    environment.advance(automaticRestartInterval - 1);
    host.audioEnded('s2', reason);
    assert.equal(listen.view.phase, 'off', reason);
    assert.equal(listen.view.problem?.kind, 'stopped');
  }
});

test('sending: a limit end long after the last restart starts again', async () => {
  const { host, environment } = await listening();
  host.audioEnded('s1', 'too-fast');
  host.answer('audio-start', { streamId: 's2' });
  await settle();
  environment.advance(automaticRestartInterval);
  host.audioEnded('s2', 'too-fast');
  assert.deepEqual(host.actions(), ['audio-start']);
});

test('sending: the connection drops in the middle of a piece: nothing more is sent; a new stream after the reconnect', async () => {
  const { host, environment } = await listening();
  environment.latest.onPiece(piece());
  host.disconnect();
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 1);
  host.reconnect();
  environment.latest.grant();
  await settle();
  host.answer('audio-start', { streamId: 's2' });
  await settle();
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 2);
});

test('sending: an end that arrives before the start is answered is applied when the answer names its stream', async () => {
  const { host, environment, listen } = setup();
  listen.setWanted(true);
  environment.latest.grant();
  await settle();
  host.audioEnded('s1', 'taken-over');
  host.answer('audio-start', { streamId: 's1' });
  await settle();
  assert.equal(listen.view.problem?.kind, 'moved');
  environment.latest.onPiece(piece());
  assert.equal(host.pieces.length, 0);
});

test('sending: an end of an earlier stream changes nothing', async () => {
  const { host, listen } = await listening();
  host.audioEnded('s0', 'taken-over');
  assert.equal(listen.view.phase, 'listening');
});

// ---- Conversion to 16 kHz pieces ---------------------------------------------------

test('pieces: 48 kHz and 44.1 kHz become 16,000 samples a second in pieces of 100 ms', () => {
  for (const rate of [48_000, 44_100, 16_000, 8_000]) {
    const pieces: ArrayBuffer[] = [];
    const converter = new PcmPieces(rate, (piece) => pieces.push(piece));
    // One second in render quanta of 128 samples.
    const block = new Float32Array(128).fill(0.5);
    for (let sent = 0; sent < rate; sent += 128) {
      converter.push(block.subarray(0, Math.min(128, rate - sent)));
    }
    assert.equal(pieces.length, 10, `${rate} Hz`);
    for (const piece of pieces) {
      assert.equal(piece.byteLength, pieceSamples * 2);
      assert.equal(new Int16Array(piece)[0], Math.round(0.5 * 32767));
    }
  }
});

test('pieces: samples are averaged per interval and clamped to 16 bits', () => {
  const pieces: ArrayBuffer[] = [];
  const converter = new PcmPieces(48_000, (piece) => pieces.push(piece));
  const input = new Float32Array(pieceSamples * 3);
  for (let index = 0; index < input.length; index++) {
    input[index] = index % 3 === 0 ? 3 : 0; // average 1 → full scale
  }
  converter.push(input);
  assert.equal(pieces.length, 1);
  assert.equal(new Int16Array(pieces[0])[0], 32767);
  assert.equal(pieceLevel(pieces[0]) > 0.99, true);
  assert.equal(pieceLevel(new Int16Array(10).buffer), 0);
});
