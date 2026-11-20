/**
 * Which actions a history entry offers, and which of them are enabled, for
 * the entry and the page's state (the README's "Listening, starting a
 * conversation and history entries" lists the rule with its table).
 *
 * The entry facts (audio only, not saved, incomplete capture, screenshot
 * missing, labeling needs capture storage) are the phone Activity page's
 * (integrations/mobile/src/components/Activity.tsx), with the same reason
 * texts. The shell differs in one respect: an action that asks the listener
 * for something needs requests to be admitted (connected, after this
 * connection's snapshot), the conversation list's rule, rather than only a
 * connection.
 *
 * Pure: no DOM, no Store. test/shell/activity-actions.test.ts checks it with
 * the README's table.
 */

import type { ActivityEntry, EngineState } from '../../../../src/remote/protocol.ts';

/** What the page knows besides the entry itself. */
export interface EntryContext {
  /** Requests are admitted: connected, after this connection's snapshot. */
  admitted: boolean;
  /** A request of this entry awaits its answer. */
  pending: boolean;
  /** The listener advertises deletion (`historyDeletionAvailable`). */
  deletionAdvertised: boolean;
  /** The listener's capture storage, as it reports it (absent from older listeners). */
  captureStorage: EngineState['captureStorage'];
}

export interface EntryActions {
  /** Copy the recognised text: local, so only text is needed. */
  copy: boolean;
  /** New coding session from the entry's saved screenshot and text. */
  startSession: boolean;
  /** Correct, Incorrect and the actual-intent choice. */
  label: boolean;
  /** Why labeling is not possible for this entry, or empty. */
  labelReason: string;
  /** Whether the delete button is drawn at all. */
  deleteOffered: boolean;
  /** Whether it is enabled. */
  deleteEnabled: boolean;
}

/** Facts about an entry's text and saved capture, shown as hints in the entry. */
export interface EntryFacts {
  /** No speech was recognised: there is no text. */
  audioOnly: boolean;
  /** The text is from an earlier part of the utterance. */
  earlierAttempt: boolean;
  /** Capture storage was off: audio and screenshot were deliberately not kept. */
  notSaved: boolean;
  /** Saved, but the listener names why a required original is incomplete. */
  originalUnavailable: boolean;
  /** The original screenshot is known not to exist. */
  screenshotMissing: boolean;
}

export function entryFacts(entry: ActivityEntry): EntryFacts {
  const notSaved = entry.captureStorage === 'off';
  const screenshotMissing =
    notSaved || entry.screenshotUnavailable === true || entry.screenshotSaved === false;
  return {
    audioOnly: entry.transcriptSource === 'audio-only',
    earlierAttempt: entry.transcriptSource === 'earlier-attempt',
    notSaved,
    originalUnavailable: !notSaved && Boolean(entry.labelingUnavailable),
    screenshotMissing,
  };
}

/**
 * Labeling needs capture storage on the computer. An older listener does
 * not report the setting; its own rules apply there. Either way the
 * listener, not this page, enforces the rule.
 */
export function labelingAvailable(storage: EngineState['captureStorage']): boolean {
  if (!storage) {
    return true;
  }
  return storage.enabled && storage.pending !== 'disabling';
}

export function entryActions(entry: ActivityEntry, context: EntryContext): EntryActions {
  const facts = entryFacts(entry);
  const requestsAllowed = context.admitted && !context.pending;

  // Labeling: a decision to label, capture storage on, and this entry's
  // complete saved capture. The reason is shown only for an entry with a
  // decision, as on the phone.
  const storageOn = labelingAvailable(context.captureStorage);
  const labelable = storageOn && !facts.notSaved && !facts.originalUnavailable;
  let labelReason = '';
  if (entry.intent !== null) {
    if (!storageOn) {
      labelReason = 'Labeling requires capture storage.';
    } else if (facts.notSaved) {
      labelReason = "Labeling requires this entry's saved capture.";
    } else if (facts.originalUnavailable) {
      labelReason = "Labeling requires this entry's complete saved capture.";
    }
  }

  return {
    copy: !facts.audioOnly,
    // It starts from the saved screenshot; never substitute another one.
    startSession: requestsAllowed && !facts.audioOnly && !facts.screenshotMissing,
    label: requestsAllowed && entry.intent !== null && labelable,
    labelReason,
    deleteOffered: context.deletionAdvertised,
    deleteEnabled: context.deletionAdvertised && requestsAllowed && entry.outcome !== 'processing',
  };
}
