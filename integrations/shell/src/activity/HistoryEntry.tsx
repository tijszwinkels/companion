/**
 * One entry of the Activity history: what Companion heard, what it decided
 * (the intent and its outcome), the application that was in front, and the
 * entry's actions. Drawn as a tinted rounded panel like an agent's message
 * in the chat (chat/styles.css `.panel`, `.heading`).
 *
 * Which actions are offered and enabled is decided by `entryActions`
 * (entry-actions.ts); this component draws them and sends the requests.
 * Every request is checked again at the click with the same rule, applied to
 * the Store's current entry and listener state (the entry still in the run
 * it was drawn for, requests admitted, the action still allowed), and goes
 * through `ActivityRequests`, so an entry never has two requests on their
 * way. A refused request shows the
 * Store's error toast; the entry keeps showing what the listener reports
 * (labels are never shown as set before the listener says so).
 */

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { ActivityEntry, IntentState } from '../../../../src/remote/protocol.ts';
import { outcomeLabels } from '../../../mobile/src/components/Activity.tsx';
import { clockTime, copyText, intentLabel } from '../../../mobile/src/format.ts';
import { useStore } from '../../../mobile/src/hooks.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import {
  actualIntentChoices,
  entryActions,
  entryContext,
  entryFacts,
  incorrectSendsLabel,
  type EntryActions,
} from './entry-actions.ts';
import type { ActivityRequests } from './requests.ts';

/** How long "Copied" (or the refusal) stays next to Copy. */
const copyFeedbackMilliseconds = 1500;

export function HistoryEntry(props: {
  entry: ActivityEntry;
  /** The listener run the entry was drawn for (checked again at each click). */
  runId: string;
  intents: IntentState[];
  labels: Map<string, string>;
  bridge: GatewayChatBridge;
  requests: ActivityRequests;
}) {
  const store = useStore();
  const { entry } = props;
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  // Whether closing the confirmation should give focus back to ×.
  const restoreFocus = useRef(false);

  const facts = entryFacts(entry);
  const actions = entryActions(
    entry,
    entryContext(store.state.engine, props.bridge.admitted, props.requests.isPending(entry.id)),
  );

  // The confirmation takes keyboard focus when it opens, and gives it back
  // to × when it is cancelled (in the same frame, see Workspace.tsx).
  useLayoutEffect(() => {
    if (confirming) {
      cancelButton.current?.focus();
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      deleteButton.current?.focus();
    }
  }, [confirming]);

  /**
   * The entry as the Store has it now and the actions the rule allows for it
   * (not the ones this button was drawn for), or null when the entry is no
   * longer in the run it was drawn for.
   */
  function now(): { entry: ActivityEntry; actions: EntryActions } | null {
    const activity = store.state.activity;
    const current = activity.entries.get(entry.id);
    if (activity.sessionId !== props.runId || !current) {
      return null;
    }
    // Another request of this entry is refused by `requests.run` itself.
    const context = entryContext(store.state.engine, props.bridge.admitted, false);
    return { entry: current, actions: entryActions(current, context) };
  }

  /**
   * Send one request for this entry if `allowed` accepts the entry and the
   * actions as they are now; otherwise send nothing.
   */
  function send(
    allowed: (actions: EntryActions, current: ActivityEntry) => boolean,
    work: () => Promise<unknown>,
  ): Promise<unknown> {
    const current = now();
    if (!current || !allowed(current.actions, current.entry)) {
      return Promise.resolve(undefined);
    }
    return props.requests.run(entry.id, work);
  }

  async function copy() {
    const copied = await copyText(entry.utterance);
    if (copied) {
      setCopyFeedback('Copied');
    } else {
      setCopyFeedback('The browser did not allow copying');
    }
    setTimeout(() => setCopyFeedback(''), copyFeedbackMilliseconds);
  }

  function startSession() {
    void send(
      (actions) => actions.startSession,
      async () => {
        const answer = await store.request('start-history-agent', { id: entry.id });
        // Anything but "started" (a listener in preview mode) started nothing.
        if (answer !== 'started') {
          return;
        }
        // The answer does not name the conversation; it arrives in the list.
        store.toast(
          'Coding session started on the computer. It is in the conversation list.',
          'success',
        );
      },
    );
  }

  function labelCorrect() {
    setChoosing(false);
    void send(
      (actions) => actions.label,
      () => store.request('label-history', { id: entry.id, correct: true }),
    );
  }

  function labelIncorrect() {
    setChoosing(!choosing);
    // Already labelled incorrect (as the Store has it now, also by another
    // client): only the choice of the actual intent opens.
    void send(
      (actions, current) => actions.label && incorrectSendsLabel(current),
      () => store.request('label-history', { id: entry.id, correct: false }),
    );
  }

  function labelActual(intent: IntentState) {
    setChoosing(false);
    void send(
      (actions, current) => actions.label && intent.name !== current.intent,
      () =>
        store.request('label-history', {
          id: entry.id,
          correct: false,
          actualIntent: intent.name,
        }),
    );
  }

  function cancelDelete() {
    restoreFocus.current = true;
    setConfirming(false);
  }

  function confirmDelete() {
    void send(
      (actions) => actions.deleteEnabled,
      async () => {
        await store.request('delete-history', { id: entry.id });
        // The entry leaves the column when the listener reports it deleted.
        setConfirming(false);
      },
    );
  }

  const time = clockTime(entry.observedAt);
  const decision = intentLabel(entry.intent, props.labels);
  const outcome = outcomeLabels[entry.outcome] ?? entry.outcome;

  let label = '';
  if (entry.correct === true) {
    label = 'Labelled correct';
  } else if (entry.correct === false) {
    label = 'Labelled incorrect';
    if (entry.actualIntent) {
      label = `${label} → ${intentLabel(entry.actualIntent, props.labels)}`;
    }
  }

  const classes = ['activity-entry'];
  if (entry.correct === true) {
    classes.push('correct');
  } else if (entry.correct === false) {
    classes.push('incorrect');
  }

  return (
    <li class={classes.join(' ')} data-id={entry.id}>
      <article class="activity-panel" aria-label={`Heard at ${time}`}>
        <div class="activity-heading">
          <span class="activity-heading-text">
            <span>
              {time} · {decision} · {outcome}
            </span>
            {entry.application && <span class="activity-pill">{entry.application}</span>}
          </span>
          {actions.deleteOffered && (
            <button
              ref={deleteButton}
              class="activity-delete"
              disabled={!actions.deleteEnabled || confirming}
              aria-label="Delete utterance, screenshot and audio"
              title="Delete utterance, screenshot and audio"
              onClick={() => setConfirming(true)}
            >
              ×
            </button>
          )}
        </div>

        <p class="activity-utterance">{entry.utterance}</p>

        {facts.audioOnly && (
          <p class="activity-hint">Audio only: no speech was recognized, so nothing was sent.</p>
        )}
        {facts.earlierAttempt && (
          <p class="activity-hint">
            Text from an earlier part of this utterance; the full recording was not transcribed.
          </p>
        )}
        {facts.notSaved && (
          <p class="activity-hint">Not saved · audio and screenshot were not kept.</p>
        )}
        {facts.originalUnavailable && <p class="activity-hint">{entry.labelingUnavailable}.</p>}
        {label && <p class="activity-label">{label}</p>}

        <div class="activity-actions">
          <button class="bar-button" disabled={!actions.copy} onClick={() => void copy()}>
            Copy
          </button>
          <button class="bar-button" disabled={!actions.startSession} onClick={startSession}>
            New coding session
          </button>
          <button
            class="bar-button"
            aria-pressed={entry.correct === true}
            disabled={!actions.label}
            onClick={labelCorrect}
          >
            Correct
          </button>
          <button
            class="bar-button"
            aria-pressed={entry.correct === false}
            aria-expanded={choosing}
            disabled={!actions.label}
            onClick={labelIncorrect}
          >
            Incorrect
          </button>
          {copyFeedback && (
            <span class="activity-feedback" role="status">
              {copyFeedback}
            </span>
          )}
        </div>
        {actions.labelReason && <p class="activity-hint">{actions.labelReason}</p>}

        {choosing && actions.labelReason === '' && (
          <div class="activity-choice" role="group" aria-label="What should it have been?">
            <p class="activity-hint">What should it have been?</p>
            <div class="activity-actions">
              {actualIntentChoices(entry, props.intents).map((intent) => (
                <button
                  key={intent.name}
                  class="bar-button"
                  aria-pressed={entry.actualIntent === intent.name}
                  aria-label={`Correct intent to ${intent.label}`}
                  disabled={!actions.label}
                  onClick={() => labelActual(intent)}
                >
                  {intent.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {confirming && (
          <div class="activity-confirm" role="group" aria-label="Delete this entry?">
            <p>
              Delete this utterance, its screenshot and audio permanently? This cannot be undone.
            </p>
            <div class="activity-actions">
              <button ref={cancelButton} class="bar-button" onClick={cancelDelete}>
                Cancel
              </button>
              <button
                class="bar-button danger"
                disabled={!actions.deleteEnabled}
                onClick={confirmDelete}
              >
                Delete permanently
              </button>
            </div>
          </div>
        )}
      </article>
    </li>
  );
}
