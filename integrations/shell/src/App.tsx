/**
 * The browser shell around the trusted chat page: pairing, a plain list of
 * open conversations, the connection banner and toasts. The conversation
 * itself is the desktop chat page (`Chat` from integrations/session-apps/
 * chat/Chat.tsx), rendered unchanged with the gateway bridge (bridge.ts).
 *
 * State comes from the phone panel's Store: pairing and reconnection,
 * conversations and their order, the selected conversation (with browser
 * Back/Forward through its Navigation), unread marks and toasts.
 */

import { useEffect, useState } from 'preact/hooks';

import { Chat } from '../../session-apps/chat/Chat.tsx';
import type { ChatStore } from '../../session-apps/chat/store.ts';
import { useAppState, useStore } from '../../mobile/src/hooks.ts';
import { lastText, plainPreview, type AppState } from '../../mobile/src/store.ts';
import type { AgentSession } from '../../../src/agents/types.ts';

export function App(props: { chat: ChatStore }) {
  const state = useAppState();

  if (state.connection.status === 'unpaired') {
    return (
      <div class="shell">
        <Pairing />
      </div>
    );
  }

  const selected = state.selected ? state.sessions.get(state.selected) : undefined;

  return (
    <div class="shell">
      <Header selected={selected} />
      <ConnectionBanner />
      <main class="shell-main">
        {selected ? (
          <div class="chat-host">
            {/* A new chat view for each conversation lifetime: the same ID
                reopened elsewhere (a new tool epoch) starts at its live end
                with a fresh editor, like a different conversation. */}
            <Chat key={selected.id + ' ' + (selected.toolEpoch ?? '')} store={props.chat} />
          </div>
        ) : (
          <>
            <HeldInput chat={props.chat} />
            <ConversationList />
          </>
        )}
      </main>
      <Toasts />
    </div>
  );
}

/** Title bar: Back to the list while a conversation is shown, and sign-out. */
function Header(props: { selected: AgentSession | undefined }) {
  const store = useStore();
  const state = useAppState();
  const { selected } = props;

  let title = 'Conversations';
  if (selected) {
    title = selected.title || 'Untitled';
  }

  return (
    <header class="shell-header">
      {selected && (
        <button
          class="shell-button back"
          aria-label="All conversations"
          onClick={() => store.showActivity()}
        >
          ‹ All
        </button>
      )}
      <h1 class="shell-title">{title}</h1>
      <span class={`connection-state ${state.connection.status}`}>{connectionLabel(state)}</span>
      {!selected && (
        <button class="shell-button" onClick={() => store.connection.forget()}>
          Sign out
        </button>
      )}
    </header>
  );
}

/**
 * Text only the chat editor holds (an input the bridge could not take, see
 * ChatStore.unresolved), shown on the list so it stays reachable when its
 * conversation is not shown, for example after it was closed elsewhere: its
 * length, Copy and Discard, as the chat page's own "No conversation" view
 * offers. The text itself is never shown or sent anywhere.
 */
function HeldInput(props: { chat: ChatStore }) {
  const { chat } = props;
  const [held, setHeld] = useState(chat.unresolved());
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const unsubscribe = chat.subscribe(() => setHeld(chat.unresolved()));
    // It can change between the first render and this effect.
    setHeld(chat.unresolved());
    return unsubscribe;
  }, [chat]);

  if (!held) {
    return null;
  }

  function copy() {
    const bridge = chat.native;
    if (!bridge || !held) {
      return;
    }
    setFeedback('Copying…');
    bridge.copyText(held.text, (json) => {
      let accepted = false;
      try {
        accepted = (JSON.parse(json) as { accepted: boolean }).accepted === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        setFeedback('Copied.');
      } else {
        setFeedback('The browser did not allow copying.');
      }
    });
  }

  return (
    <div class="held-input" role="status">
      <span>
        Text ({held.text.length} characters) typed in a conversation is only in this page. Copy it
        or discard it.
      </span>
      <button class="shell-button" onClick={copy}>
        Copy
      </button>
      <button class="shell-button" onClick={() => chat.setUnresolved(null)}>
        Discard
      </button>
      {feedback && <span class="held-feedback">{feedback}</span>}
    </div>
  );
}

function connectionLabel(state: AppState): string {
  const status = state.connection.status;
  if (status === 'online') {
    return 'Connected';
  }
  if (status === 'connecting') {
    return 'Connecting…';
  }
  if (status === 'offline') {
    return 'Offline';
  }
  if (status === 'engine-unavailable') {
    return 'Companion not running';
  }
  return 'Reconnecting…';
}

/**
 * Shown while the connection is not online. It says what happened and when
 * the next attempt is; "Retry now" connects at once. Nothing that was sent is
 * resent: the Store reports requests without an answer as uncertain.
 */
function ConnectionBanner() {
  const store = useStore();
  const state = useAppState();
  const connection = state.connection;
  if (connection.status === 'online' || connection.status === 'unpaired') {
    return null;
  }
  let message = connection.message;
  if (!message) {
    message = connectionLabel(state);
  }
  return (
    <div class="connection-banner" role="status">
      <span>{message}</span>
      <button class="shell-button" onClick={() => store.connection.connectNow()}>
        Retry now
      </button>
    </div>
  );
}

/** The open conversations in the listener's order; one click shows one. */
function ConversationList() {
  const store = useStore();
  const state = useAppState();
  const sessions: AgentSession[] = [];
  for (const id of state.order) {
    const session = state.sessions.get(id);
    if (session) {
      sessions.push(session);
    }
  }

  if (sessions.length === 0) {
    let message = 'No open conversations. Start one on the computer.';
    if (state.connection.status !== 'online' && !state.engine) {
      message = 'Waiting for Companion…';
    }
    return <p class="list-empty">{message}</p>;
  }

  return (
    <ul class="conversation-list" aria-label="Open conversations">
      {sessions.map((session) => {
        const unread = state.unread.has(session.id);
        return (
          <li key={session.id}>
            <button class="conversation" onClick={() => store.open(session.id)}>
              <span class="conversation-title">
                {unread && <span class="unread" aria-hidden="true" />}
                {unread && <span class="visually-hidden">Unread: </span>}
                {session.title || 'Untitled'}
              </span>
              <span class="conversation-state">{sessionState(session)}</span>
              <span class="conversation-preview">{plainPreview(lastText(session))}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function sessionState(session: AgentSession): string {
  if (session.status === 'starting' || session.status === 'running') {
    return 'Answering…';
  }
  if (session.status === 'error') {
    return 'Failed';
  }
  if (session.status === 'cancelled') {
    return 'Stopped';
  }
  return 'Done';
}

function Toasts() {
  const store = useStore();
  const state = useAppState();
  if (state.toasts.length === 0) {
    return null;
  }
  return (
    <div class="toasts" role="status">
      {state.toasts.map((toast) => (
        <div key={toast.id} class={`toast ${toast.tone}`}>
          <span>{toast.text}</span>
          <button
            class="shell-button"
            aria-label="Dismiss"
            onClick={() => store.dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Exchange a one-time code from `companion-remote pair` for this browser's
 * device credential (the phone panel's pairing, with browser wording).
 */
function Pairing() {
  const store = useStore();
  const state = useAppState();
  const [code, setCode] = useState('');
  const [name, setName] = useState('Browser');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await store.connection.pair(code, name, '');
      setCode('');
    } catch (failure) {
      if (failure instanceof Error) {
        setError(failure.message);
      } else {
        setError(String(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="pairing">
      <h1>Pair this browser</h1>
      <p>
        Companion runs on your computer. This browser connects to it only after you approve it with
        a one-time code.
      </p>
      {state.connection.message && <p class="error">{state.connection.message}</p>}
      <ol>
        <li>
          On the computer, run <code>companion-remote pair</code>.
        </li>
        <li>Enter the code it shows. It works once, for 10 minutes.</li>
      </ol>
      <form onSubmit={submit}>
        <label for="code">Pairing code</label>
        <input
          id="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder="XXXXX-XXXXX"
          maxLength={16}
          value={code}
          onInput={(event) => setCode(event.currentTarget.value)}
          required
        />
        <label for="device-name">Name for this browser</label>
        <input
          id="device-name"
          maxLength={60}
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button class="shell-button primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Pairing…' : 'Pair browser'}
        </button>
      </form>
    </main>
  );
}
