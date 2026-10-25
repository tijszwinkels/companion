/**
 * Companion's trusted HTML chat: transcript, choices, composer and controls
 * for the conversation its native view shows.
 *
 * Everything the person does goes through the native bridge, which applies
 * it to the same SessionView model as the classic QML view: the host-owned
 * draft, the pending send/choice, recording and history pages. This page
 * holds no conversation state of its own beyond what is on screen.
 */

import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown } from '../../mobile/src/markdown.ts';
import type { BridgeAnswer, ChatRow, ChatStatus, NativeBridge } from './protocol.ts';
import type { ChatStore } from './store.ts';

function useSnapshot(store: ChatStore) {
  const [snapshot, setSnapshot] = useState(store.current());

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setSnapshot(store.current()));
    // Messages can arrive between the first render and this effect.
    setSnapshot(store.current());
    return unsubscribe;
  }, [store]);

  return snapshot;
}

function decode(answer: string): BridgeAnswer {
  try {
    return JSON.parse(answer) as BridgeAnswer;
  } catch {
    return { accepted: false };
  }
}

export function Chat(props: { store: ChatStore }) {
  const { rows, status } = useSnapshot(props.store);
  const bridge = props.store.native;

  if (!bridge || !status.sessionId) {
    return <div class="empty">No conversation</div>;
  }

  const theme = status.theme;
  const style = theme
    ? {
        '--foreground': theme.foreground,
        '--background': theme.background,
        '--accent': theme.accent,
        '--muted': theme.muted,
        '--selection': theme.selection,
        '--font': theme.fontFamily,
        '--prose-font': theme.proseFontFamily,
        '--scale': String(theme.scale || 1),
      }
    : {};

  return (
    <div class="chat" style={style}>
      <Header status={status} bridge={bridge} />
      <Transcript rows={rows} status={status} bridge={bridge} />
      <Controls status={status} bridge={bridge} />
      <Composer status={status} bridge={bridge} />
    </div>
  );
}

function Header(props: { status: ChatStatus; bridge: NativeBridge }) {
  const { status, bridge } = props;

  return (
    <div class="header">
      <span class="title">{status.title}</span>
      {status.application && (
        <button
          class="link"
          onClick={() => bridge.openApp()}
          title="Show this conversation's application"
        >
          {status.application.name}
        </button>
      )}
      <button
        class="link"
        onClick={() => bridge.classicView()}
        title="Classic Companion view (tool details and widgets)"
      >
        Classic view
      </button>
    </div>
  );
}

// ---- Transcript -------------------------------------------------------------

function Transcript(props: { rows: ChatRow[]; status: ChatStatus; bridge: NativeBridge }) {
  const { rows, status, bridge } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const firstKey = useRef('');
  const heightBefore = useRef(0);
  const history = status.history;

  // Keep the reader's position when older rows arrive above, and follow the
  // live end otherwise.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const first = rows.length > 0 ? rows[0].key : '';
    if (following.current) {
      element.scrollTop = element.scrollHeight;
    } else if (first !== firstKey.current && heightBefore.current > 0) {
      element.scrollTop += element.scrollHeight - heightBefore.current;
    }
    firstKey.current = first;
    heightBefore.current = element.scrollHeight;
  }, [rows]);

  // A different conversation starts at its live end.
  useEffect(() => {
    following.current = true;
  }, [status.sessionId]);

  function scrolled() {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
    if (atEnd !== following.current) {
      following.current = atEnd;
      bridge.following(status.sessionId, atEnd);
    }
    heightBefore.current = element.scrollHeight;

    // Near the top: load the previous page once (the native model refuses
    // repeats while one is pending or after an empty answer).
    if (
      element.scrollTop < element.clientHeight &&
      history?.hasOlder &&
      !history.pending &&
      !history.error
    ) {
      bridge.history(status.sessionId, 'older');
    }
  }

  // Links inside rendered Markdown open outside Companion via the host.
  function clicked(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target.closest('a') : null;
    if (target) {
      event.preventDefault();
      bridge.openLink(target.getAttribute('href') || '');
    }
  }

  return (
    <div class="transcript" ref={scroller} onScroll={scrolled} onClick={clicked}>
      <HistoryNotice status={status} bridge={bridge} />
      {rows.map((row) => (
        <Row key={row.key} row={row} sessionId={status.sessionId} bridge={bridge} />
      ))}
      {history && !history.atLatest && (
        <button
          class="latest"
          onClick={() => {
            following.current = true;
            bridge.history(status.sessionId, 'latest');
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

function HistoryNotice(props: { status: ChatStatus; bridge: NativeBridge }) {
  const { status, bridge } = props;
  const history = status.history;
  if (!history) {
    return null;
  }

  if (history.pending) {
    return <div class="history-notice">Loading messages…</div>;
  }
  if (history.error) {
    return (
      <div class="history-notice">
        {history.error}
        {history.canRetry && (
          <button class="link" onClick={() => bridge.history(status.sessionId, 'retry')}>
            Retry
          </button>
        )}
      </div>
    );
  }
  if (history.changed) {
    return (
      <div class="history-notice">
        Messages may have changed since they loaded
        <button class="link" onClick={() => bridge.history(status.sessionId, 'refresh')}>
          Refresh
        </button>
      </div>
    );
  }
  if (history.hasOlder) {
    return (
      <div class="history-notice">
        <button class="link" onClick={() => bridge.history(status.sessionId, 'older')}>
          Earlier messages
        </button>
      </div>
    );
  }
  return null;
}

const Row = memo(function Row(props: { row: ChatRow; sessionId: string; bridge: NativeBridge }) {
  const { row, sessionId, bridge } = props;

  if (row.kind === 'notice') {
    return <div class={`message notice ${row.state === 'error' ? 'error' : ''}`}>{row.text}</div>;
  }

  if (row.kind === 'tool') {
    return (
      <div class="message tool">
        <span>
          {row.toolCount > 1 ? `${row.toolCount} tool calls` : row.toolName || 'Tool call'}
          {row.toolUnavailable ? ' · details unavailable' : ''}
        </span>
        <button
          class="link"
          onClick={() => bridge.classicView()}
          title="Tool details are in the classic view"
        >
          Details
        </button>
      </div>
    );
  }

  if (row.kind === 'user') {
    let from = '';
    if (row.origin?.kind === 'agent') {
      from = `From ${row.origin.title}`;
    } else if (row.origin?.kind === 'external') {
      from = `${row.origin.title} · external (unverified)`;
    } else if (row.origin?.kind === 'scheduled-wake') {
      from = row.origin.title || 'Scheduled wake';
    }

    return (
      <div class={`message user ${row.state === 'queued' ? 'queued' : ''}`}>
        {from &&
          (row.origin?.kind === 'agent' && row.origin.sessionId ? (
            <button class="from link" onClick={() => bridge.openOrigin(sessionId, row.key)}>
              {from}
            </button>
          ) : (
            <div class="from">{from}</div>
          ))}
        {row.screenshotNotSaved && <div class="state-note">Screenshot not saved</div>}
        {row.screenshot && !row.screenshotNotSaved && (
          <button
            class="link"
            disabled={!row.screenshotAvailable}
            onClick={() => bridge.openScreenshot(sessionId, row.key)}
          >
            {row.screenshotAvailable ? 'View screenshot' : 'Screenshot unavailable'}
          </button>
        )}
        {row.text && <div class="bubble">{row.text}</div>}
        {row.fragmentLabel && <div class="state-note">{row.fragmentLabel.replace(/^ · /, '')}</div>}
        {row.state === 'queued' && <div class="state-note">Queued · sends after this answer</div>}
        {row.state === 'error' && <div class="state-note">Not delivered</div>}
      </div>
    );
  }

  if (row.widget) {
    return (
      <div class="message assistant">
        <div class="widget-card">
          <strong>{row.widget.name}</strong> widget — shown in the classic view.
          <button class="link" onClick={() => bridge.classicView()}>
            Open
          </button>
          {row.text && <div>{row.text}</div>}
        </div>
      </div>
    );
  }

  return (
    <div class={`message assistant ${row.state === 'error' ? 'error' : ''}`}>
      <div
        class="bubble markdown"
        // renderMarkdown escapes every HTML tag in agent text and only keeps
        // explicit http(s) links; the page CSP also forbids inline scripts.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text || '…') }}
      />
      {row.text && row.state !== 'running' && (
        <div class="message-actions">
          <button class="link" onClick={() => bridge.copyText(row.text)}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
});

// ---- Choices, Stop and voice status -----------------------------------------

function Controls(props: { status: ChatStatus; bridge: NativeBridge }) {
  const { status, bridge } = props;
  const choices = status.choices || [];
  const pending = status.pendingChoice || status.pendingSend;
  const listening = !status.paused && status.online;

  if (choices.length === 0 && !status.stopRunId && !status.voiceStatus) {
    return null;
  }

  return (
    <div class="controls">
      {status.voiceStatus && (
        <div class={`voice ${status.voiceTarget && listening ? 'active' : ''}`}>
          {status.voiceStatus}
        </div>
      )}
      {status.stopRunId && (
        <button
          class="choice"
          disabled={!status.online}
          onClick={() => bridge.stopRun(status.sessionId, status.stopRunId || '')}
        >
          {status.voiceTarget ? '[stop]' : 'Stop'}
        </button>
      )}
      {choices.map((choice) => {
        const speakable = status.voiceTarget && listening && !pending && choice.voiceAvailable;
        return (
          <button
            key={`${choice.revision}:${choice.index}`}
            class={`choice ${speakable ? 'speakable' : ''}`}
            disabled={!status.online || pending || !choice.available}
            title={choice.description || choice.voiceReason}
            onClick={() => bridge.choose(choice.sessionId, choice.revision, choice.index)}
          >
            {speakable ? `[${choice.label}]` : choice.label}
            {choice.description && <span class="description">{choice.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- Composer -----------------------------------------------------------------

/**
 * The composer edits the host-owned draft. Each input is sent with the host
 * draft revision it is based on. A host-side change (agent draft, recorded
 * words, completed send, handover) advances the revision; an edit based on
 * an older revision is refused natively and the page shows the conflict with
 * the refused text, so nothing typed is silently lost.
 */
function Composer(props: { status: ChatStatus; bridge: NativeBridge }) {
  const { status, bridge } = props;
  const draft = status.draft || { text: '', cursor: -1, revision: 0, source: '', notice: '' };
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(draft.text);
  const base = useRef(draft.revision);
  const sessionId = useRef(status.sessionId);
  const inFlight = useRef(0);
  const [conflict, setConflict] = useState('');
  // The newest host draft, for answers that arrive after a status update.
  const hostDraft = useRef(draft);
  hostDraft.current = draft;

  const maximum = status.maximumMessageLength || 8000;
  const readOnly = !status.online || status.recording?.busy === true;

  // Adopt the host draft when it changed on the host side (or the view now
  // shows another conversation). Never while the page's own edits are still
  // in flight: their answers decide first.
  function adoptHostDraft() {
    const latest = hostDraft.current;
    base.current = latest.revision;
    setText(latest.text);
    const element = area.current;
    if (element && latest.cursor >= 0) {
      requestAnimationFrame(() => element.setSelectionRange(latest.cursor, latest.cursor));
    }
  }

  useEffect(() => {
    const otherSession = status.sessionId !== sessionId.current;
    if (otherSession) {
      sessionId.current = status.sessionId;
      inFlight.current = 0;
      setConflict('');
    }
    if (otherSession || (draft.revision !== base.current && inFlight.current === 0)) {
      adoptHostDraft();
    }
  }, [status.sessionId, draft.revision]);

  function edited(value: string, cursor: number) {
    setText(value);
    inFlight.current++;
    const editedSession = status.sessionId;
    bridge.editDraft(editedSession, base.current, value, cursor, (json) => {
      inFlight.current = Math.max(0, inFlight.current - 1);
      if (editedSession !== sessionId.current) {
        return;
      }
      const answer = decode(json);
      if (!answer.accepted && answer.draft) {
        // Refused: show what the host holds now and keep the refused text.
        setConflict(value);
        base.current = answer.draft.revision;
        setText(answer.draft.text);
        return;
      }
      // The host changed while this edit travelled; its status update was
      // held back for the answer, so apply it now.
      if (inFlight.current === 0 && hostDraft.current.revision !== base.current) {
        adoptHostDraft();
      }
    });
  }

  function send() {
    bridge.send(status.sessionId, base.current);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const recording = status.recording;
  let recordLabel = 'Record';
  if (recording?.state === 'finishing') {
    recordLabel = 'Finishing transcription…';
  } else if (recording?.here) {
    recordLabel = 'Stop recording';
  }

  let placeholder = status.running
    ? 'Write a follow-up while the agent answers…'
    : 'Ask a follow-up…';
  if (status.focusShortcut) {
    placeholder += ` (${status.focusShortcut} to focus)`;
  }

  let stateLabel = 'Done';
  if (!status.online) {
    stateLabel = 'Disconnected';
  } else if (status.running) {
    stateLabel = 'Answering…';
  } else if (status.sessionStatus === 'cancelled') {
    stateLabel = 'Stopped';
  } else if (status.sessionStatus === 'error') {
    stateLabel = 'Failed';
  }

  return (
    <div class="composer">
      {conflict && (
        <div class="conflict">
          Your text changed elsewhere (an agent draft, recording or another view) while you typed.
          <button
            class="link"
            onClick={() => {
              edited(conflict, conflict.length);
              setConflict('');
            }}
          >
            Use my text
          </button>
          <button class="link" onClick={() => bridge.copyText(conflict)}>
            Copy my text
          </button>
          <button class="link" onClick={() => setConflict('')}>
            Dismiss
          </button>
        </div>
      )}
      <textarea
        ref={area}
        aria-label="Message to this agent session"
        value={text}
        readOnly={readOnly}
        placeholder={placeholder}
        onInput={(event) => {
          const element = event.currentTarget;
          edited(element.value, element.selectionStart);
        }}
        onKeyDown={keyDown}
        onFocus={() => bridge.composerFocus(true)}
        onBlur={() => bridge.composerFocus(false)}
      />
      {draft.source && (
        <div class="note">Drafted by agent · {draft.source} — review before sending</div>
      )}
      {draft.notice && <div class="note">{draft.notice}</div>}
      {text.length > maximum - 1000 && (
        <div class={`note ${text.length > maximum ? 'error' : ''}`}>
          {text.length} / {maximum} characters
        </div>
      )}
      {(text.length > maximum || status.inputError) && (
        <div class="note error">
          {text.length > maximum
            ? `Keep messages within ${maximum} characters.`
            : status.inputError}
        </div>
      )}
      <div class="actions">
        <button disabled={!status.canSend} onClick={send}>
          {status.running ? 'Queue' : 'Send'}
        </button>
        {recording?.available && (
          <button
            class={recording.here ? 'recording' : ''}
            disabled={recording.here ? !recording.canStop : !recording.canRecord}
            onClick={() => bridge.toggleRecording(status.sessionId)}
          >
            {recordLabel}
          </button>
        )}
        {status.running && !status.stopRunId && (
          <button disabled={!status.online} onClick={() => bridge.stop(status.sessionId)}>
            Stop
          </button>
        )}
        <button
          disabled={!status.online || recording?.busy === true}
          onClick={() => bridge.closeSession(status.sessionId)}
        >
          Close session
        </button>
        <span class="state">{stateLabel}</span>
      </div>
    </div>
  );
}

/** Native focus requests (focus shortcut) reach the composer through this. */
export function focusComposer() {
  const area = document.querySelector('textarea');
  area?.focus();
}

export function blurComposer() {
  const area = document.querySelector('textarea');
  area?.blur();
}
