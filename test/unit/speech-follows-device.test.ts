/**
 * Speech follows the device that recorded it (src/desktop/README.md, "Speech
 * follows the device that recorded it"), as one table of cases derived from
 * the rule:
 *
 *   microphone (the computer's; browser A; browser B)
 *   × what is open where (the desktop shows X; A shows Y; B shows nothing;
 *     A in the background or under its settings screen)
 *   × utterance (follow-up; go to session N; N out of range or the order
 *     changed since speech end; pop out session N; new session; quick
 *     question)
 *   × what happens meanwhile (between speech end and delivery)
 *   → where the speech goes, which view changes, what is refused.
 *
 * Every case runs the real gateway on loopback in front of a real listener
 * control socket (DesktopRuntime) with the real processors, synthetic agent
 * conversations, synthetic audio and the test recogniser
 * (test/microphones-fixture.ts). Each utterance's transcription is held
 * until the case's "meanwhile" step has been applied, so that step happens
 * exactly between speech end and delivery. Every wait is for the state it
 * means; no case waits a fixed time.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { microphonesFixture, pieces, utterance } from '../microphones-fixture.ts';
import { remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { CloseAgentSession } from '../../src/processors/close-agent-session.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { PopOutSession } from '../../src/processors/pop-out-session.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';

type Json = Record<string, any>;

/** What the test recogniser hears for each marker (utterance(0.N) → "wN"). */
const phrases: Record<string, string> = {
  w1: 'please also add tests',
  w2: 'go to session 3',
  w3: 'go to session 9',
  w4: 'pop out session 1',
  w5: 'new session write a poem',
  w6: 'quick question what time is it',
  w7: 'go to session 1',
  w8: 'close session',
};

type Utterance =
  'follow-up' | 'go to 3' | 'go to 9' | 'go to 1' | 'pop out 1' | 'new' | 'quick' | 'close';

const markers: Record<Utterance, number> = {
  'follow-up': 0.1,
  'go to 3': 0.2,
  'go to 9': 0.3,
  'pop out 1': 0.4,
  new: 0.5,
  quick: 0.6,
  'go to 1': 0.7,
  close: 0.8,
};

const followUpText = phrases.w1;

/** A listening browser: its connection and its stream. */
interface Browser {
  phone: PhoneClient;
  streamId: string;
}

/**
 * The listener, gateway and microphones with three open conversations
 * (X, Y, Z in this order), a desktop panel showing X, browser A showing Y,
 * browser B showing nothing, and a phone panel (no stream) showing X.
 */
async function createWorld() {
  // The gateway's audio rate runs a hundred times faster than real time, so
  // several utterances in a row from one browser never meet its rate bound
  // (that bound is tested in remote-audio.test.ts).
  const fixture = await remoteFixture({ gateway: { audioClock: () => performance.now() * 100 } });
  const { desktop, sessions } = fixture;
  const detected: { id: string; conversation?: string }[] = [];

  const microphones = microphonesFixture(desktop.runtime, desktop.pause, {
    holdTranscriptions: true,
    // Cases wait between utterances; the stream must not end as stalled.
    maximumLagMs: 600_000,
    phrases,
    detect: async (input) => {
      // What the intent request would name: the conversation and its text.
      detected.push({
        id: input.interaction?.agentSessionId ?? '',
        conversation: input.interaction?.agentConversation?.title,
      });
      return input.interaction?.agentSessionId ? 'CONTINUE_OPEN_AGENT_CONVERSATION' : 'IGNORE';
    },
    processors: (router, activity) => {
      const log = () => {};
      new StartCodingAgentSession({ sessions }, log, false, activity).subscribe(router);
      new QuickQuestion({ sessions }, log, false, activity).subscribe(router);
      new GoToSession(log, false, activity).subscribe(router);
      new PopOutSession(log, false, activity).subscribe(router);
      new ContinueOpenAgentConversation({ sessions }, log, false, activity).subscribe(router);
      new CloseAgentSession({ sessions }, log, false, activity).subscribe(router);
    },
  });

  // Three conversations whose first turns have finished.
  const ids: string[] = [];
  for (const title of ['X conversation', 'Y conversation', 'Z conversation']) {
    ids.push(sessions.start({ ...frame, utterance: title }, signal()));
  }
  await waitFor(() => fixture.runs.length === 3);
  for (const run of fixture.runs) {
    run.finish();
  }
  await waitFor(() => sessions.snapshot().every((session) => session.status === 'completed'));
  const [x, y, z] = ids;

  // The desktop panel shows X and owns voice navigation.
  let desktopToken = 0;
  async function desktopShows(id: string): Promise<void> {
    desktopToken++;
    desktop.send({
      action: 'panel-state',
      id,
      composerFocused: false,
      visible: true,
      navigationToken: `desktop-${desktopToken}`,
    });
    const reply = await desktop.reply('panel-state');
    assert.equal(reply.type, 'result', JSON.stringify(reply));
  }
  await desktopShows(x);

  let requests = 0;
  async function request(phone: PhoneClient, fields: Json): Promise<Json> {
    const requestId = `r${++requests}`;
    phone.send({ requestId, ...fields });
    return (await phone.reply(requestId)) as Json;
  }

  /** A connection's report of what it shows; answered once the listener recorded it. */
  async function shows(phone: PhoneClient, id: string, visible = true): Promise<void> {
    const reply = await request(phone, { action: 'panel-state', id, visible });
    assert.equal(reply.type, 'result', JSON.stringify(reply));
  }

  async function browser(name: string, id: string): Promise<Browser> {
    const { token } = await fixture.pair(name);
    const phone = await fixture.phone(token, fixture.origin, true);
    await phone.engine('state');
    await shows(phone, id);
    const answer = await request(phone, { action: 'audio-start' });
    assert.equal(answer.type, 'result', JSON.stringify(answer));
    return { phone, streamId: answer.result.streamId };
  }

  const a = await browser('Browser A', y);
  const b = await browser('Browser B', '');

  // A phone panel: never opens a stream.
  const { token: phoneToken } = await fixture.pair('Phone panel');
  const phonePanel = await fixture.phone(phoneToken, fixture.origin, true);
  await phonePanel.engine('state');
  await shows(phonePanel, x);

  /** Speak `what` into a microphone; resolves once its transcription is held. */
  async function say(microphone: 'computer' | Browser, what: Utterance): Promise<void> {
    const held = microphones.transcriptions.length;
    const sound = utterance(markers[what]);
    if (microphone === 'computer') {
      await waitFor(() => microphones.computerListening);
      assert.ok(microphones.sayOnComputer(sound));
    } else {
      for (const piece of pieces(sound)) {
        microphone.phone.socket.send(piece);
      }
    }
    await waitFor(() => microphones.transcriptions.length === held + 1, 5000);
  }

  /** Release the held transcription and wait until its utterance has been handled. */
  async function deliver(): Promise<void> {
    microphones.transcriptions.shift()!();
    await microphones.pipeline.idle();
  }

  /**
   * Everything the listener sent before now has reached each client: a
   * request answered through the listener's ordered socket of each
   * connection, sent after the utterance was handled.
   */
  async function settled(): Promise<void> {
    desktop.send({ action: 'agent-models' });
    await desktop.reply('agent-models', 5000);
    for (const phone of [a.phone, b.phone, phonePanel]) {
      if (phone.socket.readyState !== phone.socket.OPEN) {
        continue;
      }
      const reply = await request(phone, {
        action: 'activity-history',
        sessionId: 'x',
        after: 0,
        through: 0,
      });
      assert.ok(reply.type === 'result' || reply.type === 'error');
    }
  }

  function selects(phone: PhoneClient): Json[] {
    return (phone.messages as Json[]).filter(
      (message) =>
        message.type === 'agent-select' ||
        (message.type === 'engine' && message.message.type === 'agent-select'),
    );
  }

  function desktopSelects(): Json[] {
    return desktop.messages.filter((message) => message.type === 'agent-select');
  }

  /** Which conversations received the follow-up text. */
  function followedUp(): string[] {
    return sessions
      .snapshot()
      .filter((session) =>
        session.messages.some(
          (message) => message.kind === 'user' && message.text === followUpText,
        ),
      )
      .map((session) => session.id);
  }

  async function close() {
    for (const run of fixture.runs) {
      run.finish();
    }
    await microphones.close();
    await fixture.close();
  }

  return {
    fixture,
    sessions,
    microphones,
    detected,
    browser,
    ids: { x, y, z },
    a,
    b,
    phonePanel,
    desktopShows,
    shows,
    request,
    say,
    deliver,
    settled,
    selects,
    desktopSelects,
    followedUp,
    close,
  };
}

type Setup = Awaited<ReturnType<typeof createWorld>>;

/** What should have happened, by conversation name (X, Y, Z) or `new`. */
interface Expected {
  /** The conversation the follow-up was delivered to, or none. */
  followUp?: 'X' | 'Y' | 'Z' | 'none';
  /** The conversation the desktop panel was asked to select, or none. */
  desktop?: 'X' | 'Y' | 'Z' | 'new' | 'none';
  /** What browser A was asked to show, or none. */
  a?: 'X' | 'Y' | 'Z' | 'new' | 'none';
  /** What browser B was asked to show, or none. */
  b?: 'X' | 'Y' | 'Z' | 'none';
  /** The conversations still open afterwards, when a case closes one. */
  open?: ('X' | 'Y' | 'Z')[];
  /** A new conversation was started in the background (true) or as before (false). */
  startedInBackground?: boolean;
}

interface Case {
  name: string;
  microphone: 'computer' | 'A' | 'B';
  /** What is open where, beyond the defaults (desktop X, A Y, B nothing). */
  before?: (setup: Setup) => Promise<void>;
  say: Utterance;
  /** What happens between speech end and delivery. */
  meanwhile?: (setup: Setup) => Promise<void>;
  expected: Expected;
}

const cases: Case[] = [
  // ---- The computer's microphone: exactly as before -----------------------
  {
    name: 'computer, follow-up: the conversation the desktop shows',
    microphone: 'computer',
    say: 'follow-up',
    expected: { followUp: 'X', desktop: 'none', a: 'none', b: 'none' },
  },
  {
    name: 'computer, go to session 3: the desktop moves, no browser',
    microphone: 'computer',
    say: 'go to 3',
    expected: { desktop: 'Z', a: 'none', b: 'none' },
  },
  {
    name: 'computer, new session: opens on the desktop as before, no browser',
    microphone: 'computer',
    say: 'new',
    expected: { startedInBackground: false, desktop: 'none', a: 'none', b: 'none' },
  },
  {
    name: 'computer, follow-up; browser A selects another meanwhile: still X',
    microphone: 'computer',
    say: 'follow-up',
    meanwhile: async (setup) => setup.shows(setup.a.phone, setup.ids.z),
    expected: { followUp: 'X', a: 'none' },
  },
  {
    name: 'computer, follow-up; the desktop selects another meanwhile: refused as before',
    microphone: 'computer',
    say: 'follow-up',
    meanwhile: async (setup) => setup.desktopShows(setup.ids.z),
    expected: { followUp: 'none' },
  },

  // ---- Browser A: what A shows ------------------------------------------
  {
    name: 'A, follow-up: the conversation A shows, not the desktop’s',
    microphone: 'A',
    say: 'follow-up',
    expected: { followUp: 'Y', desktop: 'none', a: 'none', b: 'none' },
  },
  {
    name: 'A in the background (or under its settings screen), follow-up: still Y',
    microphone: 'A',
    // The page reports `visible: false` for both (the shell's settings screen
    // and a hidden tab); the listener sees the same report.
    before: async (setup) => setup.shows(setup.a.phone, setup.ids.y, false),
    say: 'follow-up',
    expected: { followUp: 'Y' },
  },
  {
    name: 'A, go to session 3: only A is asked, from Y',
    microphone: 'A',
    say: 'go to 3',
    expected: { a: 'Z', desktop: 'none', b: 'none' },
  },
  {
    name: 'A, go to session 9 (out of range): nothing',
    microphone: 'A',
    say: 'go to 9',
    expected: { a: 'none', desktop: 'none', b: 'none' },
  },
  {
    name: 'A, go to session 3; the order changed meanwhile: refused',
    microphone: 'A',
    say: 'go to 3',
    meanwhile: async (setup) => {
      const order = setup.sessions.order();
      setup.sessions.move(setup.ids.z, setup.ids.x, order.revision);
    },
    expected: { a: 'none', desktop: 'none' },
  },
  {
    name: 'A, pop out session 1: refused (a browser has no windows)',
    microphone: 'A',
    say: 'pop out 1',
    expected: { a: 'none', desktop: 'none', b: 'none' },
  },
  {
    name: 'A, new session: in the background, shown in A only',
    microphone: 'A',
    say: 'new',
    expected: { startedInBackground: true, a: 'new', desktop: 'none', b: 'none' },
  },
  {
    name: 'A, quick question: in the background, shown in A only',
    microphone: 'A',
    say: 'quick',
    expected: { startedInBackground: true, a: 'new', desktop: 'none', b: 'none' },
  },

  {
    name: 'A, close session: closes what A shows, not the desktop’s',
    microphone: 'A',
    say: 'close',
    expected: { open: ['X', 'Z'] },
  },
  {
    name: 'computer, close session: closes what the desktop shows, as before',
    microphone: 'computer',
    say: 'close',
    expected: { open: ['Y', 'Z'] },
  },

  // ---- Browser A: what happens meanwhile --------------------------------
  {
    name: 'A, follow-up; A selects another conversation meanwhile: refused',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => setup.shows(setup.a.phone, setup.ids.z),
    expected: { followUp: 'none' },
  },
  {
    name: 'A, follow-up; A goes away and back meanwhile: refused',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      await setup.shows(setup.a.phone, setup.ids.z);
      await setup.shows(setup.a.phone, setup.ids.y);
    },
    expected: { followUp: 'none' },
  },
  {
    name: 'A, follow-up; the desktop selects another meanwhile: still Y',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => setup.desktopShows(setup.ids.z),
    expected: { followUp: 'Y' },
  },
  {
    name: 'A, follow-up; A’s stream ends meanwhile: still Y (accepted speech continues)',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      const stopped = await setup.request(setup.a.phone, { action: 'audio-stop' });
      assert.equal(stopped.result, 'stopped');
    },
    expected: { followUp: 'Y' },
  },
  {
    name: 'A, go to session 3; A’s stream ends meanwhile: refused',
    microphone: 'A',
    say: 'go to 3',
    meanwhile: async (setup) => {
      const stopped = await setup.request(setup.a.phone, { action: 'audio-stop' });
      assert.equal(stopped.result, 'stopped');
    },
    expected: { a: 'none', desktop: 'none' },
  },
  {
    name: 'A, new session; A selects another meanwhile: started in the background, not shown',
    microphone: 'A',
    say: 'new',
    meanwhile: async (setup) => setup.shows(setup.a.phone, setup.ids.z),
    expected: { startedInBackground: true, a: 'none', desktop: 'none' },
  },
  {
    name: 'A, follow-up; A’s connection closes meanwhile: refused',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      setup.a.phone.socket.close();
      await setup.a.phone.closed;
      await waitFor(() =>
        setup.microphones.browsers.list.every((entry) => entry.name !== 'Browser A'),
      );
    },
    expected: { followUp: 'none' },
  },
  {
    name: 'A, follow-up; the conversation closes meanwhile: refused',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      await setup.sessions.remove(setup.ids.y);
    },
    expected: { followUp: 'none' },
  },
  {
    name: 'A, follow-up; Pause meanwhile: cancelled',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      setup.fixture.desktop.pause.toggle();
    },
    expected: { followUp: 'none' },
  },

  {
    name: 'A, follow-up; a selection report of A the gateway refuses meanwhile: refused',
    microphone: 'A',
    say: 'follow-up',
    meanwhile: async (setup) => {
      // Malformed (not a lowercase conversation ID): refused by the gateway
      // itself, which tells the listener that A's selection has ended.
      const reply = await setup.request(setup.a.phone, {
        action: 'panel-state',
        id: setup.ids.z.toUpperCase(),
        visible: true,
      });
      assert.equal(reply.type, 'error');
    },
    expected: { followUp: 'none' },
  },

  // ---- Browser B: shows nothing -----------------------------------------
  {
    name: 'B (shows nothing), follow-up: no conversation, never the desktop’s',
    microphone: 'B',
    say: 'follow-up',
    expected: { followUp: 'none', desktop: 'none', a: 'none', b: 'none' },
  },
  {
    name: 'B, go to session 1: only B is asked',
    microphone: 'B',
    say: 'go to 1',
    expected: { b: 'X', a: 'none', desktop: 'none' },
  },
];

for (const row of cases) {
  test(`speech follows the device: ${row.name}`, async () => {
    const setup = await createWorld();
    try {
      await row.before?.(setup);
      const before = new Set(setup.sessions.snapshot().map((session) => session.id));
      const microphone =
        row.microphone === 'computer' ? 'computer' : row.microphone === 'A' ? setup.a : setup.b;

      await setup.say(microphone, row.say);
      await row.meanwhile?.(setup);
      await setup.deliver();
      if (setup.fixture.desktop.pause.paused) {
        setup.fixture.desktop.pause.toggle();
      }
      await setup.settled();

      const names: Record<string, string> = {
        [setup.ids.x]: 'X',
        [setup.ids.y]: 'Y',
        [setup.ids.z]: 'Z',
      };
      const started = setup.sessions.snapshot().filter((session) => !before.has(session.id));
      for (const session of started) {
        names[session.id] = 'new';
      }
      const nameOf = (messages: Json[]): string => {
        if (messages.length === 0) {
          return 'none';
        }
        assert.equal(messages.length, 1, JSON.stringify(messages));
        const message = messages[0].type === 'engine' ? messages[0].message : messages[0];
        return names[message.id] ?? `unknown ${message.id}`;
      };

      const expected = row.expected;
      if (expected.followUp !== undefined) {
        const delivered = setup.followedUp().map((id) => names[id]);
        assert.deepEqual(delivered, expected.followUp === 'none' ? [] : [expected.followUp]);
      }
      if (expected.desktop !== undefined) {
        assert.equal(nameOf(setup.desktopSelects()), expected.desktop, 'desktop agent-select');
      }
      if (expected.a !== undefined) {
        assert.equal(nameOf(setup.selects(setup.a.phone)), expected.a, 'browser A agent-select');
      }
      if (expected.b !== undefined) {
        assert.equal(nameOf(setup.selects(setup.b.phone)), expected.b, 'browser B agent-select');
      }
      if (expected.open !== undefined) {
        const open = setup.sessions.snapshot().map((session) => names[session.id]);
        assert.deepEqual(open, expected.open);
      }
      if (expected.startedInBackground !== undefined) {
        assert.equal(started.length, 1, 'one conversation started');
        assert.equal(started[0].openInBackground === true, expected.startedInBackground);
      }

      // A gateway message, never an engine event; the stream ID stays at the gateway.
      for (const browser of [setup.a, setup.b]) {
        for (const message of setup.selects(browser.phone)) {
          assert.equal(message.type, 'agent-select');
          assert.equal(message.streamId, undefined);
        }
      }
      // The phone panel never opened a stream and never receives one.
      assert.deepEqual(setup.selects(setup.phonePanel), []);
    } finally {
      await setup.close();
    }
  });
}

test('a go-to from A carries what A showed and the order it was counted in', async () => {
  const setup = await createWorld();
  try {
    await setup.say(setup.a, 'go to 3');
    await setup.deliver();
    await setup.settled();
    assert.deepEqual(setup.selects(setup.a.phone), [
      {
        type: 'agent-select',
        id: setup.ids.z,
        from: setup.ids.y,
        orderRevision: setup.sessions.order().revision,
      },
    ]);
  } finally {
    await setup.close();
  }
});

test('the gateway passes agent-select only for the connection’s own open stream', async () => {
  const setup = await createWorld();
  try {
    // Ask every remote connection of the listener to select, naming A's
    // stream, another stream and none: only A's own open stream passes.
    const runtime = setup.fixture.desktop.runtime as unknown as {
      server: { publishTo(clientId: number, message: unknown): boolean };
      remoteClients: Map<number, unknown>;
    };
    const order = setup.sessions.order();
    for (const clientId of runtime.remoteClients.keys()) {
      for (const streamId of [
        setup.a.streamId,
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
        undefined,
      ]) {
        runtime.server.publishTo(clientId, {
          type: 'agent-select',
          id: setup.ids.x,
          streamId,
          from: setup.ids.y,
          orderRevision: order.revision,
        });
      }
    }
    // Malformed ones on A's own stream are dropped too.
    for (const clientId of runtime.remoteClients.keys()) {
      runtime.server.publishTo(clientId, {
        type: 'agent-select',
        id: 'not-a-conversation',
        streamId: setup.a.streamId,
        from: setup.ids.y,
        orderRevision: order.revision,
      });
      runtime.server.publishTo(clientId, {
        type: 'agent-select',
        id: setup.ids.x,
        streamId: setup.a.streamId,
        from: setup.ids.y,
        orderRevision: order.revision,
        presentation: 'window',
      });
      runtime.server.publishTo(clientId, {
        type: 'agent-select',
        id: setup.ids.x,
        streamId: setup.a.streamId,
        from: setup.ids.y,
        started: true,
        presentation: 'window',
      });
    }
    await setup.settled();

    assert.deepEqual(setup.selects(setup.a.phone), [
      { type: 'agent-select', id: setup.ids.x, from: setup.ids.y, orderRevision: order.revision },
    ]);
    assert.deepEqual(setup.selects(setup.b.phone), []);
    assert.deepEqual(setup.selects(setup.phonePanel), []);

    // After A's stream ended, nothing passes for it any more.
    const stopped = await setup.request(setup.a.phone, { action: 'audio-stop' });
    assert.equal(stopped.result, 'stopped');
    for (const clientId of runtime.remoteClients.keys()) {
      runtime.server.publishTo(clientId, {
        type: 'agent-select',
        id: setup.ids.z,
        streamId: setup.a.streamId,
        from: setup.ids.y,
        orderRevision: order.revision,
      });
    }
    await setup.settled();
    assert.equal(setup.selects(setup.a.phone).length, 1);
  } finally {
    await setup.close();
  }
});

test('a connection without a stream, and the phone panel, receive what they received before', async () => {
  const setup = await createWorld();
  try {
    // Everything browsers can now cause: a go-to and a started conversation
    // from A, a go-to from B, and the computer's own go-to.
    await setup.say(setup.a, 'go to 3');
    await setup.deliver();
    await setup.say(setup.b, 'go to 1');
    await setup.deliver();
    await setup.say(setup.a, 'new');
    await setup.deliver();
    await setup.say('computer', 'go to 3');
    await setup.deliver();
    await setup.settled();

    // The phone panel receives only the message kinds of the base revision,
    // and engine events of the listener's remote boundary only.
    const kinds = new Set((setup.phonePanel.messages as Json[]).map((message) => message.type));
    for (const kind of kinds) {
      assert.ok(['authenticated', 'engine', 'result', 'error', 'pong'].includes(kind), kind);
    }
    const engineKinds = new Set(
      (setup.phonePanel.messages as Json[])
        .filter((message) => message.type === 'engine')
        .map((message) => message.message.type),
    );
    for (const kind of engineKinds) {
      assert.ok(
        [
          'state',
          'agent-session',
          'agent-removed',
          'agent-restored',
          'agent-order',
          'agent-history',
          'agent-turn-completed',
          'remote-agent-actions',
          'activity-entry',
          'history-deleted',
        ].includes(kind),
        kind,
      );
    }
    // The new conversation reaches it, as every conversation does.
    assert.ok(engineKinds.has('agent-session'));
  } finally {
    await setup.close();
  }
});

test('sound that waited for the voice detector counts from when it arrived', async () => {
  const setup = await createWorld();
  try {
    // A's voice detector is behind: its whole utterance arrives (and waits)
    // while A shows Y; then A selects Z; only then the detector reaches the
    // speech end. The speaker saw Y, so nothing goes to Z (or to Y).
    const detector = setup.microphones.detectors[0];
    let release!: () => void;
    detector.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const piece of pieces(utterance(markers['follow-up']))) {
      setup.a.phone.socket.send(piece);
    }
    await waitFor(() => detector.held > 0, 5000);
    // Every piece has reached the listener before A's next report.
    await setup.shows(setup.a.phone, setup.ids.y);
    await setup.shows(setup.a.phone, setup.ids.z);
    detector.gate = undefined;
    release();

    await waitFor(() => setup.microphones.transcriptions.length === 1, 5000);
    await setup.deliver();
    await setup.settled();
    assert.deepEqual(setup.followedUp(), []);
    // Z's title and text were not part of the intent request either.
    assert.deepEqual(setup.detected, [{ id: '', conversation: undefined }]);

    // A later utterance, heard while A shows Z, goes to Z.
    await setup.say(setup.a, 'follow-up');
    await setup.deliver();
    await setup.settled();
    assert.deepEqual(setup.followedUp(), [setup.ids.z]);
  } finally {
    await setup.close();
  }
});

test('a buffered "go to session N" is refused when the order changed after its sound arrived', async () => {
  const setup = await createWorld();
  try {
    const detector = setup.microphones.detectors[0];
    let release!: () => void;
    detector.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const piece of pieces(utterance(markers['go to 3']))) {
      setup.a.phone.socket.send(piece);
    }
    await waitFor(() => detector.held > 0, 5000);
    await setup.shows(setup.a.phone, setup.ids.y);
    // Another device moves Z first: "session 3" is now Y.
    setup.sessions.move(setup.ids.z, setup.ids.x, setup.sessions.order().revision);
    detector.gate = undefined;
    release();

    await waitFor(() => setup.microphones.transcriptions.length === 1, 5000);
    await setup.deliver();
    await setup.settled();
    assert.deepEqual(setup.selects(setup.a.phone), []);
  } finally {
    await setup.close();
  }
});

test('a selection report refused by the gateway before listening still ends the old target', async () => {
  const setup = await createWorld();
  try {
    // Browser C reports X, then a report the gateway refuses (it moved on),
    // and only then starts listening: its speech must not reach X.
    const { token } = await setup.fixture.pair('Browser C');
    const phone = await setup.fixture.phone(token, setup.fixture.origin, true);
    await phone.engine('state');
    await setup.shows(phone, setup.ids.x);
    const refused = await setup.request(phone, {
      action: 'panel-state',
      id: setup.ids.z.toUpperCase(),
      visible: true,
    });
    assert.equal(refused.type, 'error');
    const answer = await setup.request(phone, { action: 'audio-start' });
    assert.equal(answer.type, 'result', JSON.stringify(answer));

    await setup.say({ phone, streamId: answer.result.streamId }, 'follow-up');
    await setup.deliver();
    await setup.settled();
    assert.deepEqual(setup.followedUp(), []);
  } finally {
    await setup.close();
  }
});
