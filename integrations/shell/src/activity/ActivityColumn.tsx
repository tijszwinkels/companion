/**
 * The Activity column on the right of the chat (the README's "Activity"):
 *
 *   header   Activity · short listening state · ☰ (hides the column)
 *   body     listening state with Pause/Resume
 *            start a conversation (coding or quick question)
 *            this listener run's history, newest first
 *
 * State comes from the phone Store, which reads the run's history in pages
 * and keeps it current from events (integrations/mobile/src/store.ts). The
 * requests are those of the phone Activity page, through the gateway's
 * remote role: `toggle-pause`, `start-agent` (via the Store's draft send),
 * and per entry `start-history-agent`, `label-history`, `delete-history`
 * (HistoryEntry.tsx).
 *
 * In a wide window the column sits beside the chat at the width Workspace
 * gives it; in a narrow one it lies over the chat (`overlay`), from the
 * list's right edge (`left`) to the window's right edge.
 */

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { AppState } from '../../../mobile/src/store.ts';
import { MicIcon, MicOffIcon } from '../../../chat-ui/icons.tsx';
import type { GatewayChatBridge } from '../bridge.ts';
import type { ListenHere } from '../listen/listen-here.ts';
import { ListenMark, MicrophoneRows } from '../listen/ListenControls.tsx';
import { useFocusHandOff } from '../workspace/focus-hand-off.ts';
import { ActionButton } from './ActionButton.tsx';
import { HistoryEntry } from './HistoryEntry.tsx';
import { listeningView } from './listening.ts';
import type { ActivityRequests } from './requests.ts';
import { StartedSelection } from './select-started.ts';

/** The column's id, named by the ☰ buttons, the list's Activity entry and the divider. */
export const activityColumnId = 'activity-column';

/** The longest text the gateway accepts for a new conversation. */
const maximumStartLength = 4000;

/** The kind of conversation Start asks for. */
export type StartProfile = 'coding' | 'quickQuestion';

export function ActivityColumn(props: {
  /** Lies over the chat (narrow window) instead of beside it. */
  overlay: boolean;
  /** Width beside the chat in CSS pixels (wide window). */
  width: number;
  /** Left edge over the chat in CSS pixels (narrow window). */
  left: number;
  bridge: GatewayChatBridge;
  requests: ActivityRequests;
  onHide: () => void;
  /** The ☰ that hides the column, for moving keyboard focus to it. */
  hideButton: RefObject<HTMLButtonElement>;
  /** Keyboard focus was inside the column when it went away. */
  onFocusLost: () => void;
  /**
   * The chosen kind of conversation for Start, kept by the workspace (like
   * the text, kept by the Store), so hiding the column keeps the choice.
   */
  startProfile: StartProfile;
  onStartProfile: (profile: StartProfile) => void;
  listenHere: ListenHere;
}) {
  const state = useAppState();
  const listening = listeningView(state);

  // A request's start or end re-renders the workspace, and with it this
  // column (Workspace.tsx follows `requests` for as long as the pairing).

  // Focus anywhere in the column when it goes away without its ☰ being
  // pressed (another tab hid it): it moves to the bar's ☰.
  const columnElement = useRef<HTMLElement>(null);
  useFocusHandOff(columnElement, props.onFocusLost);

  const classes = ['activity-column'];
  let style: Record<string, string> = { width: `${props.width}px` };
  if (props.overlay) {
    classes.push('overlay');
    style = { left: `${props.left}px` };
  }

  return (
    <aside
      ref={columnElement}
      id={activityColumnId}
      class={classes.join(' ')}
      style={style}
      aria-label="Activity"
    >
      <header class="activity-header">
        <h2>Activity</h2>
        <span class="activity-pill">{listening.short}</span>
        {/* Listen here's mark, where Activity lies over the chat and so
            covers the bar's (beside the chat the bar's stays visible). */}
        {props.overlay && <ListenMark listenHere={props.listenHere} />}
        <button
          ref={props.hideButton}
          class="bar-button activity-toggle"
          aria-label="Hide Activity"
          aria-expanded={true}
          aria-controls={activityColumnId}
          title="Hide Activity"
          onClick={props.onHide}
        >
          ☰
        </button>
      </header>
      <div class="activity-scroll">
        <Listening bridge={props.bridge} requests={props.requests} listenHere={props.listenHere} />
        <StartConversation
          bridge={props.bridge}
          profile={props.startProfile}
          onProfile={props.onStartProfile}
        />
        <History bridge={props.bridge} requests={props.requests} />
      </div>
    </aside>
  );
}

/** The listening state with Pause and Resume (`toggle-pause`). */
function Listening(props: {
  bridge: GatewayChatBridge;
  requests: ActivityRequests;
  listenHere: ListenHere;
}) {
  const store = useStore();
  const state = useAppState();
  const listening = listeningView(state);
  const pending = props.requests.isPending('pause');

  let label = 'Pause listening';
  if (listening.paused) {
    label = 'Resume listening';
  }

  function toggle() {
    // Checked again at the click: the state may have changed since drawing.
    if (!props.bridge.admitted || !listeningView(store.state).running) {
      return;
    }
    void props.requests.run('pause', () => store.request('toggle-pause', {}));
  }

  const classes = ['activity-listening'];
  if (listening.paused || !listening.running) {
    classes.push('paused');
  }
  if (listening.speaking) {
    classes.push('speaking');
  }

  // The state with Pause and Resume, then the microphones (the computer's
  // switch, Listen here, other listening browsers), as one block.
  return (
    <div class="listening-block">
      <section class={classes.join(' ')} aria-label="Listening">
        <ActionButton
          class="activity-mic"
          available={props.bridge.admitted && listening.running && !pending}
          label={label}
          title={label}
          onPress={toggle}
        >
          {listening.paused ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
        </ActionButton>
        <div class="activity-listening-text" aria-live="polite">
          <div class="activity-listening-title">{listening.title}</div>
          <div class="activity-hint">{listening.detail}</div>
        </div>
      </section>
      <MicrophoneRows
        listenHere={props.listenHere}
        bridge={props.bridge}
        requests={props.requests}
      />
    </div>
  );
}

/**
 * Start a conversation from a typed text: coding or a quick question. The
 * text is the phone Store's `new` draft, sent with its rules (one send per
 * draft; a failure keeps the text with the explanation). The conversation
 * opens in the background on the desktop; here it is selected once it is
 * in the list, unless what is shown changed meanwhile (select-started.ts).
 * Not offered while the listener is in preview mode.
 */
function StartConversation(props: {
  bridge: GatewayChatBridge;
  profile: StartProfile;
  onProfile: (profile: StartProfile) => void;
}) {
  const store = useStore();
  const state = useAppState();
  const profile = props.profile;
  const text = store.draft('new');
  const send = state.sends.get('new');
  const pending = send?.pending ?? false;
  const error = send?.error ?? '';
  const canStart = props.bridge.admitted && startAvailable(state) && !pending && text.trim() !== '';

  async function start(event: Event) {
    event.preventDefault();
    if (!canStart) {
      return;
    }
    // Checked again at the press: the state may have changed since drawing.
    // (The Store itself refuses an empty draft and a second send.)
    if (!props.bridge.admitted || !startAvailable(store.state)) {
      return;
    }
    // Watch what is shown from now on, so a selection made while the start
    // is on its way is never overridden (select-started.ts).
    const selection = new StartedSelection(store);
    // The shell selects the result by its own rule, not the phone's.
    const id = await store.sendDraft('new', profile, { openStarted: false });
    if (id) {
      selection.started(id);
    } else {
      selection.cancel();
    }
  }

  let hint = 'Opens in the background on the computer. No screenshot is attached.';
  if (!props.bridge.admitted) {
    hint = 'Disconnected · the text is kept';
  } else if (state.engine?.preview) {
    hint = 'Preview mode: Companion starts no conversations.';
  }

  return (
    <form class="activity-start" onSubmit={start}>
      <h3>Start a conversation</h3>
      <label class="visually-hidden" for="activity-start-text">
        Message for a new conversation
      </label>
      <textarea
        id="activity-start-text"
        value={text}
        maxLength={maximumStartLength}
        placeholder="Ask Companion…"
        onInput={(event) => store.setDraft('new', event.currentTarget.value)}
      />
      <div class="activity-actions">
        <div class="activity-choice-group" role="group" aria-label="Conversation type">
          <button
            type="button"
            class="bar-button"
            aria-pressed={profile === 'coding'}
            onClick={() => props.onProfile('coding')}
          >
            Coding
          </button>
          <button
            type="button"
            class="bar-button"
            aria-pressed={profile === 'quickQuestion'}
            onClick={() => props.onProfile('quickQuestion')}
          >
            Quick question
          </button>
        </div>
        <ActionButton
          submit={true}
          class="bar-button activity-start-button"
          available={canStart}
          onPress={() => {}}
        >
          {pending ? 'Starting…' : 'Start'}
        </ActionButton>
      </div>
      {error ? (
        <p class="activity-error" role="alert">
          {error}
        </p>
      ) : (
        <p class="activity-hint">{hint}</p>
      )}
    </form>
  );
}

/**
 * Whether the listener can start a conversation now: it offers conversation
 * controls and is not in preview mode (where it would answer without
 * starting anything, and the Store would clear the text).
 */
function startAvailable(state: AppState): boolean {
  const engine = state.engine;
  return engine?.sessionControlsAvailable !== false && engine?.preview !== true;
}

/**
 * This run's history, newest first, with the Store's reading error and
 * Retry.
 *
 * Keyboard focus inside an entry that goes away (deleted here or
 * elsewhere, or gone with its run) moves to the entry that takes its place,
 * else the one above it, else the History heading; focus on Retry, which
 * goes away once the reading works again, moves to the heading too.
 */
function History(props: { bridge: GatewayChatBridge; requests: ActivityRequests }) {
  const store = useStore();
  const state = useAppState();
  const engine = state.engine;
  const intents = engine?.intents ?? [];
  const labels = new Map(intents.map((intent) => [intent.name, intent.label]));
  const entries = [...state.activity.entries.values()].sort(
    (left, right) => right.sequence - left.sequence,
  );

  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Where focus was lost in this render: an entry's position, or -1 for the
  // heading; null when nothing was lost.
  const focusLostAt = useRef<number | null>(null);

  useLayoutEffect(() => {
    const position = focusLostAt.current;
    if (position === null) {
      return;
    }
    focusLostAt.current = null;
    const items = list.current?.querySelectorAll<HTMLElement>('.activity-entry') ?? [];
    if (position < 0 || items.length === 0) {
      heading.current?.focus();
      return;
    }
    const replacement = items[Math.min(position, items.length - 1)];
    replacement.querySelector<HTMLElement>('button')?.focus();
  });

  return (
    <section class="activity-history" aria-label="History">
      <h3 ref={heading} tabIndex={-1}>
        History <span class="activity-count">{entries.length}</span>
      </h3>
      {state.activity.error && (
        <ReadingError
          message={state.activity.error}
          available={props.bridge.admitted}
          onRetry={() => {
            // Only after this connection's snapshot: a reading started before
            // it could miss what changed while offline (README, marker rule 2).
            if (props.bridge.admitted) {
              store.retryActivity();
            }
          }}
          onFocusLost={() => {
            focusLostAt.current = -1;
          }}
        />
      )}
      {entries.length === 0 && !state.activity.syncing && (
        <p class="activity-hint">What you say to Companion on the computer appears here.</p>
      )}
      <ul ref={list} class="activity-entries">
        {entries.map((entry, position) => (
          <HistoryEntry
            key={entry.id}
            entry={entry}
            runId={state.activity.sessionId}
            intents={intents}
            labels={labels}
            bridge={props.bridge}
            requests={props.requests}
            onFocusLost={() => {
              focusLostAt.current = position;
            }}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The Store's reading error with Retry, offered only while requests are
 * admitted; focus on Retry is handed on when it goes away.
 */
function ReadingError(props: {
  message: string;
  /** Retry may be pressed now: requests are admitted. */
  available: boolean;
  onRetry: () => void;
  onFocusLost: () => void;
}) {
  const element = useRef<HTMLParagraphElement>(null);
  useFocusHandOff(element, props.onFocusLost);
  return (
    <p ref={element} class="activity-error" role="alert">
      {props.message}{' '}
      <ActionButton class="bar-button" available={props.available} onPress={props.onRetry}>
        Retry
      </ActionButton>
    </p>
  );
}
