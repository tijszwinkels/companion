/**
 * One conversation, full screen: header with status and menu, messages that
 * follow the newest answer unless the reader scrolled up, the conversation's
 * choices, and a composer that queues follow-ups while an answer streams.
 *
 * Composer rules match the desktop panel: a draft is cleared only after its
 * send succeeds, and only if the user has not typed more since; failed sends
 * keep the text. Nothing is resent automatically.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { initial, statusLabels } from '../format.ts';
import { useAppState, useStore } from '../hooks.ts';
import { ArrowDownIcon, BackIcon, MoreIcon, SendIcon, StopIcon } from './icons.tsx';
import { Message } from './Messages.tsx';
import { Sheet } from './Sheet.tsx';

export function Conversation(props: { session: AgentSession }) {
  const { session } = props;
  const state = useAppState();
  const store = useStore();
  const online = state.connection.status === 'online';
  const [menu, setMenu] = useState(false);
  const [modelSheet, setModelSheet] = useState(false);

  // Only controls for this conversation (the listener scopes them per phone).
  const actions = state.actions?.sessionId === session.id ? state.actions : undefined;
  const effectiveModel = session.modelOverride || session.model;

  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon-button" onClick={() => store.close()} aria-label="Back to chats">
          <BackIcon />
        </button>
        <span class="avatar" aria-hidden="true" style={{ width: '34px', height: '34px' }}>
          {initial(session.title)}
        </span>
        <div class="title-block">
          <h1>{session.title || 'Untitled'}</h1>
          <div class="subtitle">
            {statusLabels[session.status] ?? session.status}
            {effectiveModel ? ` · ${effectiveModel}` : ''}
            {session.thinkingOverride ? ` · ${session.thinkingOverride}` : ''}
          </div>
        </div>
        <button
          class="icon-button"
          onClick={() => setMenu(true)}
          aria-label="Conversation options"
          aria-haspopup="dialog"
        >
          <MoreIcon />
        </button>
      </header>

      <MessageList session={session} />

      {session.error && (
        <div class="banner error" role="alert">
          {session.error}
        </div>
      )}

      <div class="dock">
        {actions && actions.choices.length > 0 && (
          <div class="choices" role="group" aria-label="Suggested replies">
            {actions.choices.map((choice) => (
              <button
                key={`${choice.revision}:${choice.index}`}
                class="choice"
                disabled={!online || !choice.available}
                title={choice.available ? choice.description : choice.voiceReason}
                onClick={() =>
                  void store
                    .request('choose-agent', {
                      id: session.id,
                      revision: choice.revision,
                      index: choice.index,
                    })
                    .catch(() => {})
                }
              >
                {choice.label}
                {choice.description && <small>{choice.description}</small>}
              </button>
            ))}
          </div>
        )}
        <Composer session={session} stopRunId={actions?.stopRunId ?? ''} online={online} />
      </div>

      {menu && (
        <ConversationMenu
          session={session}
          onClose={() => setMenu(false)}
          onModel={() => {
            setMenu(false);
            setModelSheet(true);
          }}
        />
      )}
      {modelSheet && <ModelSheet session={session} onClose={() => setModelSheet(false)} />}
    </div>
  );
}

function MessageList(props: { session: AgentSession }) {
  const { session } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);

  // Keep the newest message in view while following; respect manual scrolling.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && followRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  // Opening another conversation starts at its newest message.
  useEffect(() => {
    followRef.current = true;
    setFollowing(true);
  }, [session.id]);

  function scrolled() {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    followRef.current = atEnd;
    if (atEnd !== following) {
      setFollowing(atEnd);
    }
  }

  function jump() {
    const element = scroller.current;
    if (element) {
      followRef.current = true;
      setFollowing(true);
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    }
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <div
        class="scroll"
        ref={scroller}
        onScroll={scrolled}
        role="log"
        aria-live="polite"
        aria-label="Messages"
      >
        <div class="messages">
          {session.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              sessionId={session.id}
              toolEpoch={session.toolEpoch ?? ''}
            />
          ))}
          {(session.status === 'starting' || session.status === 'running') && (
            <div class="message notice">
              <span class="status running">
                <span class="dot" aria-hidden="true" />
                Working…
              </span>
            </div>
          )}
        </div>
      </div>
      {!following && (
        <button class="button small primary jump" onClick={jump}>
          <ArrowDownIcon size={16} /> Latest
        </button>
      )}
    </div>
  );
}

function Composer(props: { session: AgentSession; stopRunId: string; online: boolean }) {
  const store = useStore();
  const { session } = props;
  const [text, setText] = useState(() => store.draft(session.id));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const latestText = useRef(text);

  useEffect(() => {
    const draft = store.draft(session.id);
    setText(draft);
    latestText.current = draft;
    setError('');
  }, [session.id]);

  // Grow with the content up to the CSS max-height.
  useLayoutEffect(() => {
    const element = field.current;
    if (element) {
      // scrollHeight excludes borders; add them so no scrollbar appears
      // until the CSS max-height is reached.
      const borders = element.offsetHeight - element.clientHeight;
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight + borders}px`;
    }
  }, [text]);

  function edit(value: string) {
    setText(value);
    latestText.current = value;
    store.setDraft(session.id, value);
  }

  async function send() {
    const submitted = text;
    if (!submitted.trim() || sending) {
      return;
    }
    setSending(true);
    setError('');

    try {
      await store.request('send-agent', { id: session.id, text: submitted }, { quiet: true });
      // Clear only what was sent; newer typing survives an older reply.
      if (latestText.current === submitted) {
        edit('');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  }

  function keydown(event: KeyboardEvent) {
    // Hardware keyboards: Enter sends, Shift+Enter adds a line. The phone's
    // on-screen Return inserts a newline, as in most messaging apps.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && hasHardwareKeyboard()) {
      event.preventDefault();
      void send();
    }
  }

  const running = session.status === 'running' || session.status === 'starting';

  return (
    <>
      <div class="composer">
        <label class="visually-hidden" for="composer">
          Message to this conversation
        </label>
        <textarea
          id="composer"
          ref={field}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={running ? 'Queue a follow-up…' : 'Message'}
          onInput={(event) => edit(event.currentTarget.value)}
          onKeyDown={keydown}
          enterkeyhint="send"
        />
        {props.stopRunId && !text.trim() ? (
          <button
            class="send stop"
            aria-label="Stop the current answer"
            disabled={!props.online}
            onClick={() =>
              void store
                .request('stop-agent-run', { id: session.id, runId: props.stopRunId })
                .catch(() => {})
            }
          >
            <StopIcon />
          </button>
        ) : (
          <button
            class="send"
            aria-label={running ? 'Queue message' : 'Send message'}
            disabled={!props.online || sending || !text.trim()}
            onClick={() => void send()}
          >
            <SendIcon />
          </button>
        )}
      </div>
      {error && (
        <div class="composer-note error" role="alert">
          {error} Your message was kept.
        </div>
      )}
      {!error && running && text.trim() && (
        <div class="composer-note">Sends after the current answer (up to 8 queued).</div>
      )}
    </>
  );
}

function hasHardwareKeyboard(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function ConversationMenu(props: { session: AgentSession; onClose(): void; onModel(): void }) {
  const store = useStore();
  const state = useAppState();
  const { session } = props;
  const index = state.order.indexOf(session.id);
  const online = state.connection.status === 'online';
  const running = session.status === 'running' || session.status === 'starting';

  async function run(action: () => Promise<unknown>) {
    props.onClose();
    await action().catch(() => {});
  }

  function move(offset: -1 | 1) {
    // move-agent inserts before `beforeId`; empty appends at the end.
    const target = index + offset;
    const beforeId = offset < 0 ? state.order[target] : (state.order[target + 1] ?? '');
    return store.request('move-agent', {
      id: session.id,
      beforeId,
      revision: state.orderRevision,
    });
  }

  return (
    <Sheet title="Conversation" onClose={props.onClose}>
      <div class="menu-list">
        <button onClick={props.onModel} disabled={!online}>
          Model and effort
        </button>
        <button onClick={() => run(() => move(-1))} disabled={!online || index <= 0}>
          Move earlier in the list
        </button>
        <button
          onClick={() => run(() => move(1))}
          disabled={!online || index < 0 || index >= state.order.length - 1}
        >
          Move later in the list
        </button>
        <button
          onClick={() => run(() => store.request('stop-agent', { id: session.id }))}
          disabled={!online || !running}
        >
          Stop working
        </button>
        <button
          class="danger"
          onClick={() => run(() => store.request('close-agent', { id: session.id }))}
          disabled={!online}
        >
          Close conversation (saved in Previous)
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Per-conversation model and effort for the next turn, from the computer's
 * Pi catalogue. Pinned models first; "Show all" reveals the rest. Clearing
 * returns to the profile default. Nothing here changes global settings.
 */
function ModelSheet(props: { session: AgentSession; onClose(): void }) {
  const store = useStore();
  const state = useAppState();
  const { session } = props;
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalog = state.models;

  useEffect(() => {
    if (!catalog && !state.modelsLoading) {
      void store.loadModels();
    }
  }, []);

  const profileDefault =
    session.profile === 'quickQuestion' ? catalog?.quickQuestion : catalog?.coding;
  const profileThinking =
    session.profile === 'quickQuestion' ? catalog?.quickQuestionThinking : catalog?.codingThinking;
  const selected = session.modelOverride || '';
  const effectiveModel = selected || profileDefault || '';

  const visible = new Set<string>();
  if (catalog) {
    for (const model of showAll || !catalog.pinned ? catalog.models : catalog.pinned) {
      visible.add(model);
    }
    if (selected) {
      visible.add(selected);
    }
  }
  const levels = catalog?.thinkingLevels[effectiveModel] ?? [];

  async function choose(action: 'set-agent-model' | 'set-agent-thinking', value: string) {
    setBusy(true);
    try {
      if (action === 'set-agent-model') {
        await store.request('set-agent-model', { id: session.id, model: value });
      } else {
        await store.request('set-agent-thinking', { id: session.id, thinking: value });
      }
    } catch {
      // The toast explains; the current selection stays.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Model and effort" onClose={props.onClose}>
      <p class="hint">Applies to this conversation’s next turn. The current turn is unchanged.</p>

      {state.modelsLoading && !catalog && <p class="hint">Loading models from the computer…</p>}
      {state.modelsError && (
        <p class="composer-note error" role="alert">
          {state.modelsError}
        </p>
      )}
      {catalog?.warning && <p class="hint">{catalog.warning}</p>}

      {catalog && (
        <>
          <span class="field-label">Model</span>
          <div class="option-list" role="radiogroup" aria-label="Model">
            <button
              role="radio"
              aria-checked={!selected}
              disabled={busy}
              onClick={() => choose('set-agent-model', '')}
            >
              <span class="label">
                Profile default
                <span class="sub">{profileDefault || 'Not configured'}</span>
              </span>
              {!selected && <span class="check">✓</span>}
            </button>
            {[...visible].map((model) => {
              const unavailable = !catalog.models.includes(model);
              return (
                <button
                  key={model}
                  role="radio"
                  aria-checked={selected === model}
                  disabled={busy || unavailable}
                  onClick={() => choose('set-agent-model', model)}
                >
                  <span class="label">
                    {model}
                    {unavailable && <span class="sub">Unavailable</span>}
                  </span>
                  {selected === model && <span class="check">✓</span>}
                </button>
              );
            })}
          </div>
          {catalog.pinned && catalog.pinned.length < catalog.models.length && (
            <button
              class="button small"
              style={{ marginTop: '8px' }}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Show pinned models' : 'Show all models'}
            </button>
          )}

          <span class="field-label">Effort</span>
          {levels.length === 0 ? (
            <p class="hint">This model does not report effort levels.</p>
          ) : (
            <div class="choices" role="radiogroup" aria-label="Effort">
              <button
                class="chip"
                role="radio"
                aria-pressed={!session.thinkingOverride}
                aria-checked={!session.thinkingOverride}
                disabled={busy}
                onClick={() => choose('set-agent-thinking', '')}
              >
                Default{profileThinking ? ` (${profileThinking})` : ''}
              </button>
              {levels.map((level) => (
                <button
                  key={level}
                  class="chip"
                  role="radio"
                  aria-pressed={session.thinkingOverride === level}
                  aria-checked={session.thinkingOverride === level}
                  disabled={busy}
                  onClick={() => choose('set-agent-thinking', level)}
                >
                  {level}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <button
        class="button small"
        style={{ marginTop: '14px' }}
        onClick={() => void store.loadModels()}
        disabled={state.modelsLoading}
      >
        Refresh model list
      </button>
    </Sheet>
  );
}
