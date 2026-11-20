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
 * way. A refused request shows the Store's error toast; the entry keeps
 * showing what the listener reports (labels are never shown as set before
 * the listener says so). Unavailable actions stay focusable
 * (ActionButton.tsx), and focus that would go away with a closing choice or
 * with the entry itself is moved to a neighbour.
 */

import type { RefObject } from 'preact';
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
import { useFocusHandOff } from '../workspace/focus-hand-off.ts';
import { ActionButton } from './ActionButton.tsx';
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
  /** Keyboard focus was inside this entry when it went away (deleted, a new run). */
  onFocusLost: () => void;
}) {
  const store = useStore();
  const { entry } = props;
  const [choosing, setChoosing] = useState(false);
  // The delete confirmation is open; also when the column is shown again
  // while this entry's deletion awaits its answer.
  const [confirming, setConfirming] = useState(
    () => props.requests.pendingKind(entry.id) === 'delete',
  );
  const [copyFeedback, setCopyFeedback] = useState('');
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const incorrectButton = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLLIElement>(null);

  // Focus inside the entry when it goes away is handed to the history list,
  // which moves it to the entry that takes its place.
  useFocusHandOff(item, props.onFocusLost);

  const facts = entryFacts(entry);
  const actions = entryActions(
    entry,
    entryContext(store.state.engine, props.bridge.admitted, props.requests.isPending(entry.id)),
  );

  // Pressed Delete permanently; its answer is awaited.
  const deleting = props.requests.pendingKind(entry.id) === 'delete';

  // The confirmation takes keyboard focus when it opens (in the same frame,
  // see Workspace.tsx). When it closes with focus inside it, focus goes back
  // to × (DeleteConfirmation).
  useLayoutEffect(() => {
    if (confirming && !deleting) {
      cancelButton.current?.focus();
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
    kind = '',
  ): Promise<unknown> {
    const current = now();
    if (!current || !allowed(current.actions, current.entry)) {
      return Promise.resolve(undefined);
    }
    return props.requests.run(entry.id, work, kind);
  }

  async function copy() {
    if (!actions.copy) {
      return;
    }
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
    // The choice goes away; keyboard focus returns to Incorrect.
    incorrectButton.current?.focus();
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
    // A deletion on its way cannot be cancelled: the listener deletes anyway.
    if (props.requests.pendingKind(entry.id) === 'delete') {
      return;
    }
    setConfirming(false);
  }

  function confirmDelete() {
    void send(
      (actions) => actions.deleteEnabled,
      async () => {
        await store.request('delete-history', { id: entry.id });
        // The entry leaves the column when the listener reports it deleted
        // (usually before this answer). A refusal throws above and keeps
        // the confirmation open.
        setConfirming(false);
      },
      'delete',
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

  function askDelete() {
    if (!actions.deleteEnabled || confirming) {
      return;
    }
    setConfirming(true);
  }

  const classes = ['activity-entry'];
  if (entry.correct === true) {
    classes.push('correct');
  } else if (entry.correct === false) {
    classes.push('incorrect');
  }

  return (
    <li ref={item} class={classes.join(' ')} data-id={entry.id}>
      <article class="activity-panel" aria-label={`Heard at ${time}`}>
        <div class="activity-heading">
          <span class="activity-heading-text">
            <span>
              {time} · {decision} · {outcome}
            </span>
            {entry.application && <span class="activity-pill">{entry.application}</span>}
          </span>
          {actions.deleteOffered && (
            <ActionButton
              buttonRef={deleteButton}
              class="activity-delete"
              available={actions.deleteEnabled && !confirming}
              label="Delete utterance, screenshot and audio"
              title="Delete utterance, screenshot and audio"
              onPress={askDelete}
            >
              ×
            </ActionButton>
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
          <ActionButton class="bar-button" available={actions.copy} onPress={() => void copy()}>
            Copy
          </ActionButton>
          <ActionButton class="bar-button" available={actions.startSession} onPress={startSession}>
            New coding session
          </ActionButton>
          <ActionButton
            class="bar-button"
            pressed={entry.correct === true}
            available={actions.label}
            onPress={labelCorrect}
          >
            Correct
          </ActionButton>
          <ActionButton
            buttonRef={incorrectButton}
            class="bar-button"
            pressed={entry.correct === false}
            expanded={choosing}
            available={actions.label}
            onPress={labelIncorrect}
          >
            Incorrect
          </ActionButton>
          {copyFeedback && (
            <span class="activity-feedback" role="status">
              {copyFeedback}
            </span>
          )}
        </div>
        {actions.labelReason && <p class="activity-hint">{actions.labelReason}</p>}

        {choosing && actions.labelReason === '' && (
          <IntentChoice
            intents={actualIntentChoices(entry, props.intents)}
            actualIntent={entry.actualIntent}
            available={actions.label}
            onChoose={labelActual}
            onFocusLost={() => incorrectButton.current?.focus()}
          />
        )}

        {confirming && (
          <DeleteConfirmation
            deleting={deleting}
            deleteAvailable={actions.deleteEnabled}
            cancelButton={cancelButton}
            onCancel={cancelDelete}
            onDelete={confirmDelete}
            onFocusLost={() => deleteButton.current?.focus()}
          />
        )}
      </article>
    </li>
  );
}

/**
 * "What should it have been?": the intents to choose as the actual intent.
 * If it goes away while one of them has focus (labeling no longer
 * possible), focus goes back to Incorrect (`onFocusLost`).
 */
function IntentChoice(props: {
  intents: IntentState[];
  actualIntent: string | null;
  available: boolean;
  onChoose: (intent: IntentState) => void;
  onFocusLost: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useFocusHandOff(element, props.onFocusLost);

  return (
    <div ref={element} class="activity-choice" role="group" aria-label="What should it have been?">
      <p class="activity-hint">What should it have been?</p>
      <div class="activity-actions">
        {props.intents.map((intent) => (
          <ActionButton
            key={intent.name}
            class="bar-button"
            pressed={props.actualIntent === intent.name}
            label={`Correct intent to ${intent.label}`}
            available={props.available}
            onPress={() => props.onChoose(intent)}
          >
            {intent.label}
          </ActionButton>
        ))}
      </div>
    </div>
  );
}

/**
 * The delete confirmation inside an entry. While the deletion awaits the
 * listener's answer it says "Deleting…" and neither button can be pressed
 * (Cancel could not stop it). If it closes with focus inside it, focus goes
 * back to × (`onFocusLost`).
 */
function DeleteConfirmation(props: {
  deleting: boolean;
  deleteAvailable: boolean;
  cancelButton: RefObject<HTMLButtonElement>;
  onCancel: () => void;
  onDelete: () => void;
  onFocusLost: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useFocusHandOff(element, props.onFocusLost);

  return (
    <div ref={element} class="activity-confirm" role="group" aria-label="Delete this entry?">
      <p>
        {props.deleting
          ? 'Deleting…'
          : 'Delete this utterance, its screenshot and audio permanently? This cannot be undone.'}
      </p>
      <div class="activity-actions">
        <ActionButton
          buttonRef={props.cancelButton}
          class="bar-button"
          available={!props.deleting}
          onPress={props.onCancel}
        >
          Cancel
        </ActionButton>
        <ActionButton
          class="bar-button danger"
          available={props.deleteAvailable && !props.deleting}
          onPress={props.onDelete}
        >
          {props.deleting ? 'Deleting…' : 'Delete permanently'}
        </ActionButton>
      </div>
    </div>
  );
}
