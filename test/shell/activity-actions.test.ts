import assert from 'node:assert/strict';
import test from 'node:test';

import {
  entryActions,
  type EntryContext,
} from '../../integrations/shell/src/activity/entry-actions.ts';
import type { ActivityEntry } from '../../src/remote/protocol.ts';

/**
 * Which actions an Activity history entry offers and enables, checked with
 * the rows of the README's actions table (integrations/shell/README.md,
 * "Listening, starting a conversation and history entries"), derived from
 * its rule: a request needs requests admitted, no other request of the same
 * entry awaiting its answer, and an entry that allows it; Copy is local.
 *
 * The rows about a refused request and about state changing between drawing
 * and the click are about the page's behaviour around this rule; the
 * browser suite (activity.test.ts) plays them through the real gateway.
 */

/** A saved, routed entry with a decision. */
function entry(change: Partial<Record<string, unknown>> = {}): ActivityEntry {
  return {
    id: 'entry-1',
    observedAt: 0,
    utterance: 'Synthetic utterance',
    application: 'org.example.Editor',
    intent: 'IGNORE',
    outcome: 'ignored',
    correct: null,
    actualIntent: null,
    transcriptSource: null,
    captureStorage: 'on',
    screenshotSaved: true,
    audioSaved: true,
    labelingUnavailable: null,
    screenshotUnavailable: false,
    sequence: 1,
    revision: 1,
    ...change,
  } as unknown as ActivityEntry;
}

const admitted: EntryContext = {
  admitted: true,
  pending: false,
  deletionAdvertised: true,
  captureStorage: { enabled: true } as EntryContext['captureStorage'],
};

/** The table's columns: Copy, New coding session, label, delete ('—' not shown). */
function row(item: ActivityEntry, context: EntryContext) {
  const actions = entryActions(item, context);
  let deletion = '—';
  if (actions.deleteOffered) {
    deletion = actions.deleteEnabled ? 'on' : 'off';
  }
  return {
    copy: actions.copy ? 'on' : 'off',
    session: actions.startSession ? 'on' : 'off',
    label: actions.label ? 'on' : 'off',
    reason: actions.labelReason,
    delete: deletion,
  };
}

test('entry actions: each row of the README table', () => {
  const cases: {
    name: string;
    entry: ActivityEntry;
    context: EntryContext;
    expected: ReturnType<typeof row>;
  }[] = [
    {
      name: 'saved entry with a decision; admitted; deletion offered',
      entry: entry(),
      context: admitted,
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'on' },
    },
    {
      name: 'offline, or reconnected before the new snapshot (not admitted)',
      entry: entry(),
      context: { ...admitted, admitted: false },
      expected: { copy: 'on', session: 'off', label: 'off', reason: '', delete: 'off' },
    },
    {
      name: 'deletion not advertised by the listener',
      entry: entry(),
      context: { ...admitted, deletionAdvertised: false },
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: '—' },
    },
    {
      name: 'already labelled correct (both labels stay available)',
      entry: entry({ correct: true }),
      context: admitted,
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'on' },
    },
    {
      name: 'labelled incorrect with an actual intent',
      entry: entry({ correct: false, actualIntent: 'QUICK_QUESTION' }),
      context: admitted,
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'on' },
    },
    {
      name: 'a request of this entry awaits its answer',
      entry: entry(),
      context: { ...admitted, pending: true },
      expected: { copy: 'on', session: 'off', label: 'off', reason: '', delete: 'off' },
    },
    {
      name: 'no decision (no intent)',
      entry: entry({ intent: null }),
      context: admitted,
      expected: { copy: 'on', session: 'on', label: 'off', reason: '', delete: 'on' },
    },
    {
      name: 'audio only (no text)',
      entry: entry({ utterance: '', transcriptSource: 'audio-only', intent: null }),
      context: admitted,
      expected: { copy: 'off', session: 'off', label: 'off', reason: '', delete: 'on' },
    },
    {
      name: 'not saved (capture storage was off)',
      entry: entry({
        captureStorage: 'off',
        screenshotSaved: false,
        audioSaved: false,
        screenshotUnavailable: true,
      }),
      context: admitted,
      expected: {
        copy: 'on',
        session: 'off',
        label: 'off',
        reason: "Labeling requires this entry's saved capture.",
        delete: 'on',
      },
    },
    {
      name: 'capture storage off at the listener now',
      entry: entry(),
      context: {
        ...admitted,
        captureStorage: { enabled: false } as EntryContext['captureStorage'],
      },
      expected: {
        copy: 'on',
        session: 'on',
        label: 'off',
        reason: 'Labeling requires capture storage.',
        delete: 'on',
      },
    },
    {
      name: 'capture storage being turned off',
      entry: entry(),
      context: {
        ...admitted,
        captureStorage: { enabled: true, pending: 'disabling' } as EntryContext['captureStorage'],
      },
      expected: {
        copy: 'on',
        session: 'on',
        label: 'off',
        reason: 'Labeling requires capture storage.',
        delete: 'on',
      },
    },
    {
      name: 'an older listener without capture storage state (its own rules apply)',
      entry: entry(),
      context: { ...admitted, captureStorage: undefined },
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'on' },
    },
    {
      name: 'screenshot not kept',
      entry: entry({ screenshotSaved: false }),
      context: admitted,
      expected: { copy: 'on', session: 'off', label: 'on', reason: '', delete: 'on' },
    },
    {
      name: 'the listener names why the capture is incomplete',
      entry: entry({
        labelingUnavailable: 'The original screenshot for this entry was not saved',
        screenshotUnavailable: true,
      }),
      context: admitted,
      expected: {
        copy: 'on',
        session: 'off',
        label: 'off',
        reason: "Labeling requires this entry's complete saved capture.",
        delete: 'on',
      },
    },
    {
      name: 'still processing',
      entry: entry({ outcome: 'processing' }),
      context: admitted,
      expected: { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'off' },
    },
  ];
  for (const testCase of cases) {
    assert.deepEqual(row(testCase.entry, testCase.context), testCase.expected, testCase.name);
  }
});

test('entry actions: a request of another entry does not disable this one', () => {
  // The pending state is per entry; the page passes only this entry's.
  const other = row(entry(), { ...admitted, pending: false });
  assert.deepEqual(other, { copy: 'on', session: 'on', label: 'on', reason: '', delete: 'on' });
});
