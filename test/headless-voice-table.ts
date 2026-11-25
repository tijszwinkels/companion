// The voice rule of "Running without a desktop" (src/desktop/README.md) as
// one table of cases:
//
//   utterance (follow-up, plain dictation, insert, enter, new session, quick
//     question, go to session N, stop, label previous, close session)
//   × what the listening browser tab shows (a conversation; none; none, while
//     another tab of the same device shows one)
//   × intent model absent (the default) or present (`--intent-model`)
//   → the Activity entry (intent, outcome), where the words went, which tab
//     was asked to show what, and whether the model was asked.
//
// Paused × every utterance is one row of its own (`pausedRow`): while
// paused nothing is heard, because Pause ends the browser's stream and a new
// one is refused until Resume.
//
// Run by test/unit/headless-voice.test.ts (model absent) and
// test/unit/headless-voice-model.test.ts (model present) against the world
// of test/headless-voice-fixture.ts: the real listener and gateway, the real
// voice detector on real speech, the test recogniser, the synthetic agent.

import assert from 'node:assert/strict';

import { waitFor } from './desktop-fixture.ts';
import { remote, type HeadlessVoiceWorld } from './headless-voice-fixture.ts';

type Json = Record<string, any>;

export type TabShows = 'conversation' | 'none' | 'other tab';

/** What one case leads to; `X` and `Y` are the two open conversations. */
interface Expected {
  intent: string;
  outcome: string;
  /** The conversation the words reached as a message, if any. */
  delivered?: 'Y';
  /** What the listening tab was asked to show: conversation X, or the new one. */
  shown?: 'X' | 'new';
  /** Y was closed. */
  closed?: true;
  /** Y's running turn was stopped. */
  stopped?: true;
}

interface Row {
  utterance: string;
  /** The recogniser's words; `#` becomes the case number, to tell cases apart. */
  phrase: string;
  /** Y has a running turn when the words are spoken. */
  running?: boolean;
  expected: Record<TabShows, { absent: Expected; present: Expected }>;
}

/** The same result whatever the model and the tab. */
function always(expected: Expected): Row['expected'] {
  const both = { absent: expected, present: expected };
  return { conversation: both, none: both, 'other tab': both };
}

const delivered: Expected = {
  intent: 'CONTINUE_OPEN_AGENT_CONVERSATION',
  outcome: 'started',
  delivered: 'Y',
};
const notDelivered: Expected = { intent: 'NO_CONVERSATION_SHOWN', outcome: 'skipped' };
const ignoredByModel: Expected = { intent: 'IGNORE', outcome: 'ignored' };

/** Words that are not a command: by the rule, or as the model decides. */
const message: Row['expected'] = {
  conversation: { absent: delivered, present: delivered },
  none: { absent: notDelivered, present: ignoredByModel },
  'other tab': { absent: notDelivered, present: ignoredByModel },
};

const notTyped: Expected = { intent: 'TYPING_WITHOUT_DESKTOP', outcome: 'skipped' };

export const rows: Row[] = [
  { utterance: 'follow-up', phrase: 'please also add tests #', expected: message },
  {
    utterance: 'plain dictation',
    phrase: 'dear team the meeting moves to friday #',
    expected: message,
  },
  { utterance: 'insert …', phrase: 'insert hello world #', expected: always(notTyped) },
  { utterance: 'enter …', phrase: 'enter hello world #', expected: always(notTyped) },
  {
    utterance: 'new session …',
    phrase: 'new session write a poem #',
    expected: always({ intent: 'START_CODING_AGENT_SESSION', outcome: 'started', shown: 'new' }),
  },
  {
    utterance: 'quick question …',
    phrase: 'quick question what time is it #',
    expected: always({ intent: 'QUICK_QUESTION', outcome: 'started', shown: 'new' }),
  },
  {
    utterance: 'go to session 1',
    phrase: 'go to session 1',
    expected: always({ intent: 'GO_TO_SESSION', outcome: 'selected', shown: 'X' }),
  },
  {
    utterance: 'stop',
    phrase: 'stop',
    running: true,
    expected: {
      conversation: {
        absent: { intent: 'STOP_OPEN_AGENT', outcome: 'cancelled', stopped: true },
        present: { intent: 'STOP_OPEN_AGENT', outcome: 'cancelled', stopped: true },
      },
      // No conversation: "stop" names no run, so it is words like any others.
      none: { absent: notDelivered, present: ignoredByModel },
      'other tab': { absent: notDelivered, present: ignoredByModel },
    },
  },
  {
    // Never labels: there is no original screenshot, and the previous
    // labelable entry could be one of an earlier run with a desktop.
    utterance: 'label previous correct',
    phrase: 'label previous correct',
    expected: always({ intent: 'LABEL_PREVIOUS_CORRECT', outcome: 'skipped' }),
  },
  {
    utterance: 'close session',
    phrase: 'close session',
    expected: {
      conversation: {
        absent: { intent: 'CLOSE_AGENT_SESSION', outcome: 'closed', closed: true },
        present: { intent: 'CLOSE_AGENT_SESSION', outcome: 'closed', closed: true },
      },
      none: {
        absent: { intent: 'CLOSE_AGENT_SESSION', outcome: 'skipped' },
        present: { intent: 'CLOSE_AGENT_SESSION', outcome: 'skipped' },
      },
      'other tab': {
        absent: { intent: 'CLOSE_AGENT_SESSION', outcome: 'skipped' },
        present: { intent: 'CLOSE_AGENT_SESSION', outcome: 'skipped' },
      },
    },
  },
];

/** Intents an intent model must never be offered without a desktop. */
const neverOffered = [
  'SEND_TEXT_TO_APPLICATION',
  'ENTER_TEXT_TO_APPLICATION',
  'TYPING_WITHOUT_DESKTOP',
  'NO_CONVERSATION_SHOWN',
];

/**
 * Put the world in the state a case starts from: X and Y open and idle,
 * conversations of earlier cases closed, the tabs showing what `tab` says,
 * and (for `running`) a turn of Y that keeps running.
 */
async function prepare(world: HeadlessVoiceWorld, tab: TabShows, running: boolean) {
  const { x, y } = world.ids;

  // A closed Y comes back from Previous sessions.
  if (!world.sessions.has(y)) {
    const reopened = await remote(world.otherTab, { action: 'reopen-agent', id: y });
    assert.equal(reopened.result, 'reopened', JSON.stringify(reopened));
    await waitFor(() => world.sessions.has(y), 10_000);
  }
  for (const id of [...world.sessions.keys()]) {
    if (id !== x && id !== y) {
      await remote(world.otherTab, { action: 'close-agent', id });
      await waitFor(() => !world.sessions.has(id), 10_000);
    }
  }
  await world.idle();

  if (tab === 'conversation') {
    await world.shows(world.listeningTab, y);
    await world.shows(world.otherTab, '');
  } else if (tab === 'none') {
    await world.shows(world.listeningTab, '');
    await world.shows(world.otherTab, '');
  } else {
    await world.shows(world.listeningTab, '');
    await world.shows(world.otherTab, y);
  }

  if (running) {
    const partials = world.messagesWith(y, 'Partial');
    const sent = await remote(world.otherTab, { action: 'send-agent', id: y, text: 'stall' });
    assert.equal(sent.type, 'result', JSON.stringify(sent));
    // Stop only once the agent streams (see headless-listener.test.ts).
    await waitFor(
      () =>
        world.sessions.get(y)?.status === 'running' && world.messagesWith(y, 'Partial') > partials,
      20_000,
    );
  }
}

/** End a turn of Y that the case left running. */
async function stopLeftOver(world: HeadlessVoiceWorld) {
  const y = world.sessions.get(world.ids.y);
  if (y?.status !== 'running' && y?.status !== 'starting') {
    return;
  }
  const stopped = await remote(world.otherTab, { action: 'stop-agent', id: y.id });
  assert.match(String(stopped.result), /^stopped/, JSON.stringify(stopped));
  await world.idle();
}

/** Run every row for every tab with the model `absent` or `present`. */
export async function runVoiceTable(world: HeadlessVoiceWorld, model: 'absent' | 'present') {
  if (!world.microphone.listening) {
    const started = await world.microphone.start();
    assert.equal(started.type, 'result', JSON.stringify(started));
  }

  let number = 0;
  for (const row of rows) {
    for (const tab of ['conversation', 'none', 'other tab'] as const) {
      number++;
      const name = `${row.utterance} × ${tab} × model ${model}`;
      const expected = row.expected[tab][model];
      const phrase = row.phrase.replace('#', String(number));

      await prepare(world, tab, row.running === true);
      const sessionsBefore = new Set(world.sessions.keys());
      const listeningFrom = world.listeningTab.messages.length;
      const otherFrom = world.otherTab.messages.length;
      const requestsBefore = world.model?.requests.length ?? 0;

      const entry = await world.say(phrase);
      await world.settled();

      // The Activity entry: what was decided, and nothing about a screen.
      assert.equal(entry.intent, expected.intent, name);
      assert.equal(entry.outcome, expected.outcome, name);
      assert.equal(entry.application, null, name);
      assert.equal(entry.microphone, 'Browser A', name);

      // Where the words went: only to Y, and only when expected.
      const words = phrase.replace(/^(insert|enter) /, '');
      const reached = world.receivedBy(words);
      assert.deepEqual(reached, expected.delivered ? [world.ids.y] : [], `${name}: delivered`);

      // What the listening tab was asked to show; the other tab never is.
      const shown = world.selects(world.listeningTab, listeningFrom);
      if (expected.shown === 'X') {
        assert.deepEqual(
          shown.map((select) => select.id),
          [world.ids.x],
          `${name}: listening tab selects X`,
        );
      } else if (expected.shown === 'new') {
        const started = [...world.sessions.keys()].filter((id) => !sessionsBefore.has(id));
        assert.equal(started.length, 1, `${name}: one conversation started`);
        assert.deepEqual(
          shown.map((select) => [select.id, select.started]),
          [[started[0], true]],
          `${name}: listening tab shows the new conversation`,
        );
      } else {
        assert.deepEqual(shown, [], `${name}: listening tab not asked to show anything`);
      }
      assert.deepEqual(world.selects(world.otherTab, otherFrom), [], `${name}: other tab`);

      // Close and stop.
      assert.equal(world.sessions.has(world.ids.y), expected.closed !== true, `${name}: Y open`);
      if (row.running) {
        if (expected.stopped) {
          await waitFor(() => world.sessions.get(world.ids.y)?.status === 'cancelled', 10_000);
        } else {
          assert.equal(world.sessions.get(world.ids.y)?.status, 'running', `${name}: Y runs`);
        }
      }
      await stopLeftOver(world);

      // The model: asked only for words that are not a command, never shown
      // a screen, never offered typing.
      if (world.model) {
        const asked = world.model.requests.slice(requestsBefore);
        const command = !['IGNORE', 'CONTINUE_OPEN_AGENT_CONVERSATION'].includes(entry.intent);
        assert.equal(asked.length, command ? 0 : 1, `${name}: model requests`);
        for (const request of asked) {
          checkScreenlessRequest(request, name);
        }
      }
    }
  }
}

/** An intent request without a desktop: no image, no application, no typing. */
function checkScreenlessRequest(request: Json, name: string) {
  const [system, user] = request.messages as Json[];
  const systemText = JSON.stringify(system.content);
  assert.match(systemText, /runs without a desktop: no screenshot/, name);
  for (const intent of neverOffered) {
    assert.ok(!systemText.includes(`Name: ${intent}`), `${name}: ${intent} not offered`);
  }

  const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: user.content }];
  assert.ok(
    parts.every((part: Json) => part.type === 'text'),
    `${name}: only text in the request`,
  );
  const text = JSON.parse(parts[0].text);
  assert.equal('application' in text, false, `${name}: no application`);
}

/**
 * Paused × every utterance: Pause ends the listening tab's stream (the
 * gateway tells it `paused`), a new stream is refused while paused, and
 * after Resume the tab listens again and is heard.
 */
export async function pausedRow(world: HeadlessVoiceWorld) {
  await prepare(world, 'conversation', false);
  if (!world.microphone.listening) {
    assert.equal((await world.microphone.start()).type, 'result');
  }
  const streamId = world.microphone.streamId;

  const paused = await remote(world.otherTab, { action: 'toggle-pause' });
  assert.equal(paused.result, 'paused');
  await waitFor(() =>
    world.listeningTab.messages.some(
      (message: Json) =>
        message.type === 'audio-ended' &&
        message.streamId === streamId &&
        message.reason === 'paused',
    ),
  );
  assert.equal(world.microphone.listening, false);

  const refused = await world.microphone.start();
  assert.equal(refused.type, 'error');
  assert.match(String(refused.message), /Listening is paused/);

  const resumed = await remote(world.otherTab, { action: 'toggle-pause' });
  assert.equal(resumed.result, 'listening');
  assert.equal((await world.microphone.start()).type, 'result');

  const entry = await world.say('after resume please continue');
  assert.equal(entry.intent, 'CONTINUE_OPEN_AGENT_CONVERSATION');
  assert.deepEqual(world.receivedBy('after resume please continue'), [world.ids.y]);
}
