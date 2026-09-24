/**
 * Open conversations (in the listener's authoritative order), a composer for
 * starting a new one, and Previous conversations that can be reopened.
 */

import { useState } from 'preact/hooks';

import type { AgentSession, PreviousSession } from '../../../../src/agents/types.ts';
import { initial, relativeTime, statusLabels } from '../format.ts';
import { useAppState, useStore } from '../hooks.ts';
import { lastText, plainPreview } from '../store.ts';
import { ChevronIcon, PlusIcon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';

export function StatusBadge(props: { status: AgentSession['status'] }) {
  return (
    <span class={`status ${props.status}`}>
      <span class="dot" aria-hidden="true" />
      {statusLabels[props.status] ?? props.status}
    </span>
  );
}

export function ChatList() {
  const state = useAppState();
  const store = useStore();
  const [composing, setComposing] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const online = state.connection.status === 'online';
  const controls = state.engine?.sessionControlsAvailable !== false;

  const sessions = state.order
    .map((id) => state.sessions.get(id))
    .filter((session): session is AgentSession => Boolean(session));

  return (
    <div class="screen">
      <header class="topbar">
        <h1>Chats</h1>
      </header>

      <div class="scroll">
        <section class="section" aria-label="Open conversations">
          {sessions.length === 0 && (
            <div class="empty">
              <div class="art" aria-hidden="true">
                💬
              </div>
              <h2>No open conversations</h2>
              <p>Start one here, or by voice on the computer.</p>
            </div>
          )}
          {sessions.map((session) => (
            <ConversationCard
              key={session.id}
              session={session}
              onOpen={() => store.open(session.id)}
            />
          ))}
        </section>

        <section class="section" aria-label="Previous conversations">
          <button
            class="button small"
            aria-expanded={showPrevious}
            onClick={() => setShowPrevious(!showPrevious)}
          >
            Previous ({state.previous.length})
          </button>
          {showPrevious && (
            <div class="card" style={{ marginTop: '10px' }}>
              {state.previous.length === 0 && (
                <div class="empty">Closed conversations are saved here.</div>
              )}
              {state.previous.map((session) => (
                <PreviousRow key={session.id} session={session} disabled={!online} />
              ))}
            </div>
          )}
        </section>
        <div style={{ height: '96px' }} />
      </div>

      <button
        class="fab"
        onClick={() => setComposing(true)}
        disabled={!online || !controls}
        aria-label="New conversation"
      >
        <PlusIcon /> New
      </button>

      {composing && <NewConversation onClose={() => setComposing(false)} />}
    </div>
  );
}

function ConversationCard(props: { session: AgentSession; onOpen(): void }) {
  const { session } = props;
  const preview = plainPreview(lastText(session));

  return (
    <button class="card conversation-card" onClick={props.onOpen}>
      <span class="avatar" aria-hidden="true">
        {initial(session.title)}
      </span>
      <span class="body">
        <span class="title-row">
          <span class="title">{session.title || 'Untitled'}</span>
          <span class="time">{relativeTime(session.updatedAt)}</span>
        </span>
        {preview && <span class="preview">{preview}</span>}
        <span class="meta-row">
          <StatusBadge status={session.status} />
          {session.model && <span class="model-tag">{session.model}</span>}
        </span>
      </span>
    </button>
  );
}

function PreviousRow(props: { session: PreviousSession; disabled: boolean }) {
  const store = useStore();
  const [busy, setBusy] = useState(false);

  async function reopen() {
    setBusy(true);
    try {
      await store.request('reopen-agent', { id: props.session.id });
      store.open(props.session.id);
    } catch {
      // The toast explains; the entry stays available for another try.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="previous-row">
      <span class="avatar" aria-hidden="true">
        {initial(props.session.title)}
      </span>
      <div class="body">
        <div class="title">{props.session.title || 'Untitled'}</div>
        <div class="time">{relativeTime(props.session.updatedAt)}</div>
      </div>
      <button
        class="button small"
        onClick={reopen}
        disabled={props.disabled || busy}
        aria-label={`Reopen ${props.session.title}`}
      >
        {busy ? 'Opening…' : 'Reopen'}
      </button>
    </div>
  );
}

/**
 * A typed question from the phone. It has no screenshot of the computer and
 * does not change what the desktop panel shows.
 */
function NewConversation(props: { onClose(): void }) {
  const store = useStore();
  const [text, setText] = useState(() => store.draft('new'));
  const [profile, setProfile] = useState<'coding' | 'quickQuestion'>('coding');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = (await store.request('start-agent', { text, profile }, { quiet: true })) as {
        id: string;
      };
      store.setDraft('new', '');
      props.onClose();
      store.open(result.id);
    } catch (failure) {
      // Keep the text; never resend automatically.
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="New conversation" onClose={props.onClose}>
      <div class="segmented" role="group" aria-label="Conversation type">
        <button aria-pressed={profile === 'coding'} onClick={() => setProfile('coding')}>
          Coding agent
        </button>
        <button
          aria-pressed={profile === 'quickQuestion'}
          onClick={() => setProfile('quickQuestion')}
        >
          Quick question
        </button>
      </div>
      <p class="hint">
        Uses the computer’s {profile === 'coding' ? 'coding' : 'quick question'} profile and model.
        No screenshot is attached.
      </p>
      <label class="field-label" for="new-text">
        Message
      </label>
      <textarea
        id="new-text"
        value={text}
        maxLength={4000}
        placeholder="What should Companion do?"
        onInput={(event) => {
          setText(event.currentTarget.value);
          store.setDraft('new', event.currentTarget.value);
        }}
      />
      {error && (
        <p class="composer-note error" role="alert">
          {error}
        </p>
      )}
      <div style={{ height: '14px' }} />
      <button class="button primary block" onClick={start} disabled={busy || !text.trim()}>
        {busy ? 'Starting…' : 'Start conversation'}
        {!busy && <ChevronIcon size={18} />}
      </button>
    </Sheet>
  );
}
