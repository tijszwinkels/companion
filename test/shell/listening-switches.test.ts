import assert from 'node:assert/strict';
import test from 'node:test';

import type { EngineState } from '../../src/remote/protocol.ts';
import {
  listeningView,
  noEngineNote,
  notConnectedNote,
  olderListenerNote,
  previewNote,
} from '../../integrations/shell/src/settings/listening-switches.ts';

/**
 * The settings screen's Listening section (the listener's own Sound
 * feedback, intent and shortcut switches), checked in Node with the cases
 * of the README's "Listening switches" table
 * (integrations/shell/README.md), derived from its rule. The browser suite
 * (settings.test.ts) changes them through the real gateway and listener.
 */

type Engine = Omit<EngineState, 'sessions' | 'previousSessions'>;
type Intent = Engine['intents'][number];

function intent(name: string, overrides: Partial<Intent> = {}): Intent {
  return {
    name,
    label: name[0].toUpperCase() + name.slice(1),
    enabled: true,
    supportsInference: true,
    inferenceEnabled: true,
    shortcutEnabled: true,
    toggleable: true,
    inferenceAvailable: true,
    prefixes: [name],
    prefixAvailable: true,
    ...overrides,
  };
}

function engine(overrides: Partial<Engine> = {}): Engine {
  return {
    protocol: 1,
    ready: true,
    paused: false,
    pauseReason: '',
    soundsEnabled: true,
    processing: 0,
    preview: false,
    history: [],
    activitySessionId: 'run',
    activityHistoryCount: 0,
    sessionControlsAvailable: true,
    intents: [
      intent('note'),
      intent('question', { prefixes: [] }),
      intent('dictate', { supportsInference: false, acceptsEmptyPrefix: true }),
    ],
    ...overrides,
  };
}

const nothingPending = () => false;

/** Each switch as `name: checked/available`, and the notes. */
function summary(view: ReturnType<typeof listeningView>) {
  return {
    switches: view.switches.map(
      (entry) =>
        `${entry.name}: ${entry.checked ? 'on' : 'off'}, ${entry.available ? 'available' : 'unavailable'}`,
    ),
    notes: view.notes,
  };
}

test('listening switches: each row of the README table', () => {
  // Connected, after the snapshot: every switch available, in the phone's
  // order (an intent's intent switch, then its shortcut switch).
  assert.deepEqual(summary(listeningView(engine(), true, nothingPending)), {
    switches: [
      'Sound feedback: on, available',
      'Note intent: on, available',
      'Note shortcut: on, available',
      'Question intent: on, available',
      'Dictate shortcut: on, available',
    ],
    notes: [],
  });

  // Before the first snapshot of the pairing: nothing to show yet.
  assert.deepEqual(summary(listeningView(undefined, false, nothingPending)), {
    switches: [],
    notes: [noEngineNote],
  });

  // Offline, or reconnected before the new snapshot: last known, unavailable.
  const offline = summary(listeningView(engine({ soundsEnabled: false }), false, nothingPending));
  assert.deepEqual(offline.notes, [notConnectedNote]);
  assert.deepEqual(offline.switches, [
    'Sound feedback: off, unavailable',
    'Note intent: on, unavailable',
    'Note shortcut: on, unavailable',
    'Question intent: on, unavailable',
    'Dictate shortcut: on, unavailable',
  ]);

  // Preview mode: sound feedback cannot be changed; intents can.
  const preview = summary(listeningView(engine({ preview: true }), true, nothingPending));
  assert.deepEqual(preview.notes, [previewNote]);
  assert.equal(preview.switches[0], 'Sound feedback: on, unavailable');
  assert.equal(preview.switches[1], 'Note intent: on, available');

  // An older listener without independent switches: intents read-only.
  const older = engine({
    intents: [intent('note', { inferenceEnabled: undefined as unknown as boolean })],
  });
  const olderView = summary(listeningView(older, true, nothingPending));
  assert.deepEqual(olderView.notes, [olderListenerNote]);
  assert.deepEqual(olderView.switches, [
    'Sound feedback: on, available',
    'Note intent: off, unavailable',
    'Note shortcut: on, unavailable',
  ]);

  // An intent that is not toggleable: that one unavailable, "Always on".
  const fixed = listeningView(
    engine({ intents: [intent('note', { toggleable: false })] }),
    true,
    nothingPending,
  );
  assert.deepEqual(summary(fixed).switches, [
    'Sound feedback: on, available',
    'Note intent: on, unavailable',
    'Note shortcut: on, unavailable',
  ]);
  assert.equal(fixed.switches[1].description, 'Intent · Always on');

  // A request of one switch awaits its answer: only that one unavailable.
  const pending = summary(
    listeningView(engine(), true, (key) => key === 'intent:note:shortcut' || key === 'sounds'),
  );
  assert.deepEqual(pending.switches, [
    'Sound feedback: on, unavailable',
    'Note intent: on, available',
    'Note shortcut: on, unavailable',
    'Question intent: on, available',
    'Dictate shortcut: on, available',
  ]);

  // Changed on the computer: the next state message is shown as it is.
  const changed = engine({
    soundsEnabled: false,
    intents: [intent('note', { inferenceEnabled: false })],
  });
  assert.deepEqual(summary(listeningView(changed, true, nothingPending)).switches, [
    'Sound feedback: off, available',
    'Note intent: off, available',
    'Note shortcut: on, available',
  ]);
});

test('listening switches: the phone’s state words and shortcut prefixes', () => {
  const view = listeningView(
    engine({
      intents: [
        intent('note', { inferenceAvailable: false, prefixes: ['note', 'remember'] }),
        intent('dictate', { supportsInference: false, acceptsEmptyPrefix: true }),
        intent('off', { inferenceEnabled: false, shortcutEnabled: false }),
      ],
    }),
    true,
    nothingPending,
  );
  const descriptions = view.switches.map((entry) => entry.description);
  assert.deepEqual(descriptions, [
    'Cues play on the computer.',
    'Intent · Needs conversation context',
    'Shortcut · On · note …, remember …',
    'Shortcut · On · dictate',
    'Intent · Off',
    'Shortcut · Off · off …',
  ]);
  assert.deepEqual(
    view.switches.map((entry) => entry.key),
    [
      'sounds',
      'intent:note:inference',
      'intent:note:shortcut',
      'intent:dictate:shortcut',
      'intent:off:inference',
      'intent:off:shortcut',
    ],
  );
});
