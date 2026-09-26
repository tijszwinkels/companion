/**
 * A conversation page, laid out like the desktop panel's SessionView and
 * ModelPicker: a collapsible Activity strip, the transcript, choices, the
 * composer, a row of Send/Queue · Stop · Close session with a status line,
 * and "This session · next turn model" with Effort at the bottom.
 *
 * Composer rules match the desktop panel: a draft is cleared only after its
 * send succeeds, and only if nothing more was typed since; failed sends keep
 * the text. Nothing is resent automatically.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import type { RemoteAgentActions } from '../../../../src/remote/protocol.ts';
import { useAppState, useStore } from '../hooks.ts';
import { listeningStatus } from './Activity.tsx';
import { ArrowDownIcon } from './icons.tsx';
import { Message } from './Messages.tsx';

export function ConversationPage(props: { session: AgentSession }) {
  const { session } = props;
  const state = useAppState();
  const online = state.connection.status === 'online';

  // Controls for this conversation only (the listener scopes them per phone).
  const actions = state.actions?.sessionId === session.id ? state.actions : undefined;

  return (
    <div class="page conversation-page">
      <ActivityStrip />
      <MessageList session={session} />
      {session.error && (
        <div class="input-error" role="alert">
          {session.error}
        </div>
      )}
      <InputSection
        session={session}
        online={online}
        stopRunId={actions?.stopRunId ?? ''}
        choices={actions?.choices ?? []}
      />
      {session.harness === 'claude-code' ? (
        <ClaudeModelPicker session={session} />
      ) : (
        <ModelPicker session={session} />
      )}
    </div>
  );
}

/** "● Activity · Listening", expandable for details, as on the desktop. */
function ActivityStrip() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const status = listeningStatus(state);

  return (
    <div class="activity-strip">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`indicator ${status.tone}`} aria-hidden="true" />
        <span class="label">Activity · {status.title}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div class="details">
          {status.description || 'Speak to Companion on the computer.'}
          {state.engine && state.engine.processing > 0
            ? ` Processing ${state.engine.processing}…`
            : ''}
        </div>
      )}
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
    <div class="message-area">
      <div class="scroll" ref={scroller} onScroll={scrolled} role="region" aria-label="Messages">
        <div class="messages">
          {session.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              sessionId={session.id}
              toolEpoch={session.toolEpoch ?? ''}
            />
          ))}
        </div>
      </div>
      {!following && (
        <button class="action small jump" onClick={jump}>
          <ArrowDownIcon size={14} /> Latest
        </button>
      )}
    </div>
  );
}

function InputSection(props: {
  session: AgentSession;
  online: boolean;
  stopRunId: string;
  choices: RemoteAgentActions['choices'];
}) {
  const store = useStore();
  const { session } = props;
  const state = useAppState();
  const text = store.draft(session.id);
  const sending = state.sends.get(session.id)?.pending ?? false;
  const error = state.sends.get(session.id)?.error ?? '';
  const field = useRef<HTMLTextAreaElement>(null);
  // Grow with the content up to the CSS max-height; borders included so no
  // scrollbar appears before that.
  useLayoutEffect(() => {
    const element = field.current;
    if (element) {
      const borders = element.offsetHeight - element.clientHeight;
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight + borders}px`;
    }
  }, [text]);

  function edit(value: string) {
    store.setDraft(session.id, value);
  }

  async function send() {
    await store.sendDraft(session.id);
  }

  function keydown(event: KeyboardEvent) {
    // Hardware keyboards: Enter sends, Shift+Enter adds a line (desktop
    // behavior). The on-screen Return key inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && hasHardwareKeyboard()) {
      event.preventDefault();
      void send();
    }
  }

  const running = session.status === 'running' || session.status === 'starting';
  const statusText = !props.online
    ? 'Disconnected'
    : running
      ? 'Answering…'
      : session.status === 'error'
        ? 'Failed'
        : session.status === 'cancelled'
          ? 'Stopped'
          : 'Ready';

  return (
    <div class="input-section">
      {props.choices.length > 0 && (
        <div class="choices" role="group" aria-label="Suggested replies">
          {props.choices.map((choice) => (
            <button
              key={`${choice.revision}:${choice.index}`}
              class="choice"
              disabled={!props.online || !choice.available}
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

      <label class="visually-hidden" for="composer">
        Message to the selected agent session
      </label>
      <textarea
        id="composer"
        class="composer"
        ref={field}
        rows={1}
        value={text}
        maxLength={4000}
        placeholder={running ? 'Queue a follow-up…' : 'Message this session…'}
        onInput={(event) => edit(event.currentTarget.value)}
        onKeyDown={keydown}
        enterkeyhint="send"
      />
      {error && (
        <div class="input-error" role="alert">
          {error}
        </div>
      )}

      <div class="controls-row">
        <button
          class="action primary send"
          disabled={!props.online || sending || !text.trim()}
          onClick={() => void send()}
        >
          {running ? 'Queue' : 'Send'}
        </button>
        {running && (
          <button
            class="action stop"
            disabled={!props.online}
            onClick={() =>
              void (
                props.stopRunId
                  ? store.request('stop-agent-run', { id: session.id, runId: props.stopRunId })
                  : store.request('stop-agent', { id: session.id })
              ).catch(() => {})
            }
          >
            Stop
          </button>
        )}
        <button
          class="action close-session"
          disabled={!props.online}
          onClick={() => void store.request('close-agent', { id: session.id }).catch(() => {})}
        >
          Close session
        </button>
        <span class="status-text" aria-live="polite">
          {statusText}
        </span>
      </div>
    </div>
  );
}

function hasHardwareKeyboard(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/**
 * "This session · next turn model" with Effort, like the desktop ModelPicker.
 * Native selects give the phone's own picker UI. Pinned models are listed
 * first; "Show all models" reveals the rest. Nothing here changes global
 * settings.
 */
function ModelPicker(props: { session: AgentSession }) {
  const store = useStore();
  const state = useAppState();
  const { session } = props;
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalog = state.models;
  const online = state.connection.status === 'online';

  useEffect(() => {
    if (online && !catalog && !state.modelsLoading && !state.modelsError) {
      void store.loadModels();
    }
  }, [online]);

  const quick = session.profile === 'quickQuestion';
  const profileDefault = quick ? catalog?.quickQuestion : catalog?.coding;
  const profileThinking = quick ? catalog?.quickQuestionThinking : catalog?.codingThinking;
  const selected = session.modelOverride || '';
  const effectiveModel = selected || profileDefault || '';

  const listed = catalog ? (showAll || !catalog.pinned ? catalog.models : catalog.pinned) : [];
  const models = listed.filter((model) => model !== selected);
  const overrideUnavailable = Boolean(selected && catalog && !catalog.models.includes(selected));
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
      // The toast explains; the select re-renders from the engine's state.
    } finally {
      setBusy(false);
    }
  }

  const statusText = state.modelsLoading
    ? 'Loading models…'
    : state.modelsError || catalog?.warning || '';

  return (
    <div class="model-picker">
      <div class="caption">
        This session · next turn model
        {session.model ? ` · last: ${session.model}` : ''}
      </div>
      <div class="selects">
        <select
          class="model"
          aria-label="Model for this conversation's next turn"
          value={selected}
          disabled={!catalog || busy || !online}
          onChange={(event) => void choose('set-agent-model', event.currentTarget.value)}
        >
          <option value="">
            Use {quick ? 'quick-question' : 'coding'} default · {profileDefault || '…'}
          </option>
          {selected && (
            <option value={selected}>
              {selected}
              {overrideUnavailable ? ' (unavailable)' : ''}
            </option>
          )}
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <span class="effort-label">Effort</span>
        <select
          aria-label="Effort for this conversation's next turn"
          value={session.thinkingOverride || ''}
          disabled={!catalog || busy || !online || levels.length === 0}
          onChange={(event) => void choose('set-agent-thinking', event.currentTarget.value)}
        >
          <option value="">Default{profileThinking ? ` · ${profileThinking}` : ''}</option>
          {session.thinkingOverride && !levels.includes(session.thinkingOverride) && (
            <option value={session.thinkingOverride}>{session.thinkingOverride}</option>
          )}
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <div class="controls-row">
        {catalog?.pinned && catalog.pinned.length < catalog.models.length && (
          <button class="action small" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Pinned models only' : 'Show all models'}
          </button>
        )}
        <button
          class="action small"
          aria-label="Refresh available Pi models"
          disabled={state.modelsLoading || !online}
          onClick={() => void store.loadModels()}
        >
          ↻
        </button>
        <span class="status-text">{statusText}</span>
      </div>
    </div>
  );
}

/** Claude keeps its creation-time effort and has its own exact model catalogue. */
function ClaudeModelPicker(props: { session: AgentSession }) {
  const store = useStore();
  const state = useAppState();
  const { session } = props;
  const [busy, setBusy] = useState(false);
  const online = state.connection.status === 'online';
  const catalog = state.claudeModels;
  const selected = session.claudeCode?.model || session.model;
  const models = [...new Set([selected, ...(catalog?.models ?? [])])].filter(Boolean);

  useEffect(() => {
    if (online && !catalog && !state.claudeModelsLoading && !state.claudeModelsError) {
      void store.loadClaudeModels();
    }
  }, [online]);

  async function choose(model: string) {
    setBusy(true);
    try {
      await store.request('set-agent-model', { id: session.id, model });
    } catch {
      // The store reports the failure and the engine remains authoritative.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="model-picker">
      <div class="caption">Claude Code · next turn model</div>
      <div class="selects">
        <select
          class="model"
          aria-label="Model for this conversation's next turn"
          value={selected}
          disabled={!catalog || !online || busy}
          onChange={(event) => void choose(event.currentTarget.value)}
        >
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
      <div class="hint">
        Effort · {session.claudeCode?.effort ?? 'unknown'} · fixed for this conversation
      </div>
      <div class="controls-row">
        <button
          class="action small"
          aria-label="Refresh available Claude models"
          disabled={!online || state.claudeModelsLoading}
          onClick={() => void store.loadClaudeModels()}
        >
          ↻
        </button>
        <span class="status-text">
          {state.claudeModelsLoading ? 'Loading models…' : state.claudeModelsError}
        </span>
      </div>
    </div>
  );
}
