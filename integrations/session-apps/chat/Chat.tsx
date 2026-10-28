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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { ArrowDownIcon, ToolIcon } from '../../chat-ui/icons.tsx';
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
    // Page-held text stays reachable while no conversation is shown.
    return (
      <div class="chat">
        <HeldNotices store={props.store} status={status} />
        <div class="empty">No conversation</div>
      </div>
    );
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
      {/* One Composer instance per conversation: switching conversations
          creates fresh editor state from that conversation's own host draft
          in the same render, instead of reusing the previous conversation's
          state until a later effect resets it (an input in between could
          otherwise be erased and the draft then overwritten). */}
      <Composer key={status.sessionId} status={status} bridge={bridge} store={props.store} />
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
    <div class="transcript messages" ref={scroller} onScroll={scrolled} onClick={clicked}>
      <HistoryNotice status={status} bridge={bridge} />
      {rows.map((row) => (
        <Row key={row.key} row={row} sessionId={status.sessionId} bridge={bridge} />
      ))}
      {history && !history.atLatest && (
        <button
          class="action small latest"
          onClick={() => {
            following.current = true;
            bridge.history(status.sessionId, 'latest');
          }}
        >
          <ArrowDownIcon size={14} /> Jump to latest
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

  // Collapsed like the phone's tool row; the whole row opens the classic
  // view, which has the tool details.
  if (row.kind === 'tool') {
    return (
      <div class="message tool tool-group">
        <button onClick={() => bridge.classicView()} title="Tool details are in the classic view">
          <ToolIcon size={16} />
          <span>
            {row.toolCount > 1 ? `${row.toolCount} tool calls` : row.toolName || 'Tool call'}
            {row.toolUnavailable ? ' · details unavailable' : ''}
          </span>
          <span class="details">Details</span>
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
    } else if (row.origin?.kind === 'application-event') {
      from = "Your edits in this conversation's app";
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
          <button onClick={() => bridge.copyText(row.text)}>Copy</button>
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
          class="action small"
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
            {choice.description && <small>{choice.description}</small>}
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
 * an older revision (or one that cannot be applied, e.g. too long) is
 * refused natively. The host keeps the refused text for that conversation
 * (`draft.refused`) until the person uses, copies or dismisses it, so
 * nothing typed is lost on navigation or handover.
 *
 * Send names the exact text it means; the host refuses it unless that is the
 * host draft. The cursor position follows the page's selection, so a
 * handover or Classic view resumes where the person left off.
 *
 * Bounds never drop text silently. A paste or drop that would make the text
 * longer than the host accepts is rejected before it changes anything. Text
 * that still cannot be applied and that the host could not keep (too long
 * to store, or no free recovery slot) stays on screen as `unkept`, with
 * Copy, Use my text and Discard; it is never replaced by the host draft.
 */
/**
 * Splits `text` into consecutive parts of at most `limit` UTF-16 units each,
 * never between the two halves of a surrogate pair (a character outside the
 * Basic Multilingual Plane, such as most emoji). Concatenated, the parts are
 * exactly `text`, and each is well-formed wherever `text` is, so the native
 * plain-text clipboard export keeps every character. Returns null when the
 * limit cannot hold one character (a pair needs two units): nothing is
 * copied then, and the caller says so.
 */
export function copyParts(text: string, limit: number): string[] | null {
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    const splitsPair =
      end < text.length &&
      isHighSurrogate(text.charCodeAt(end - 1)) &&
      isLowSurrogate(text.charCodeAt(end));
    if (splitsPair) {
      end -= 1;
    }
    if (end <= start) {
      return null;
    }
    parts.push(text.slice(start, end));
    start = end;
  }

  return parts.length > 0 ? parts : [''];
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Copy for retained text. One Copy hands at most `copyLimit` characters to
 * the host's clipboard; longer text is offered as numbered parts in order,
 * each within the limit, so nothing is cut off and the text stays here until
 * it is discarded. The host's answer is shown: copied (with the length) or
 * refused (with its reason), never a silent no-op.
 */
function CopyActions(props: { text: string; bridge: NativeBridge; copyLimit: number }) {
  const { text, bridge } = props;
  const limit = Math.max(1, Math.floor(props.copyLimit));
  // Feedback belongs to the text and limit it was given for; a different
  // text or limit shows none. (Not reset in an effect: that runs after the
  // next paint and could erase the answer to a click made just before.)
  const [feedbackFor, setFeedbackFor] = useState<{ text: string; limit: number; message: string }>({
    text: '',
    limit: 0,
    message: '',
  });
  const feedback =
    feedbackFor.text === text && feedbackFor.limit === limit ? feedbackFor.message : '';
  function setFeedback(message: string) {
    setFeedbackFor({ text: text, limit: limit, message: message });
  }
  // Part boundaries, counts and labels all come from the actual parts.
  const chunks = useMemo(() => copyParts(text, limit), [text, limit]);
  const parts = chunks ? chunks.length : 0;

  function copy(index: number) {
    if (!chunks) {
      return;
    }
    const part = chunks[index];
    const label = parts === 1 ? 'Copied' : `Copied part ${index + 1} of ${parts}`;
    setFeedback('Copying…');
    bridge.copyText(part, (json) => {
      const answer = decode(json) as BridgeAnswer & { length?: number };
      if (answer.accepted) {
        setFeedback(`${label} (${answer.length ?? part.length} characters).`);
      } else {
        setFeedback(
          `Copy refused: ${answer.reason || 'the text was not copied.'} Your text is still kept here.`,
        );
      }
    });
  }

  if (!chunks) {
    // Only a misconfigured limit gets here; the text stays kept.
    return (
      <span class="copy-feedback">
        Copy is not possible: the copy limit ({limit}) is smaller than one character. Your text is
        still kept here.
      </span>
    );
  }

  return (
    <>
      {Array.from({ length: parts }, (_, index) => (
        <button class="link" key={index} onClick={() => copy(index)}>
          {parts === 1 ? 'Copy my text' : `Copy part ${index + 1} of ${parts}`}
        </button>
      ))}
      {feedback && <span class="copy-feedback">{feedback}</span>}
    </>
  );
}

/**
 * Text the host could not keep for conversations other than the shown one
 * (or while none is shown): Copy or Discard. The shown conversation's held
 * text is in its editor, with the composer's own controls.
 */
function HeldNotices(props: { store: ChatStore; status: ChatStatus }) {
  const held = props.store.held();
  const bridge = props.store.native;
  const others = Object.entries(held).filter(([owner]) => owner !== props.status.sessionId);
  if (!bridge || others.length === 0) {
    return null;
  }

  return (
    <>
      {others.map(([owner, text]) => (
        <div class="conflict unkept" key={owner}>
          Text typed for another conversation ({text.length} characters) could not be added to its
          draft and is only kept here.
          <CopyActions text={text} bridge={bridge} copyLimit={props.status.copyLimit || 1048576} />
          <button class="link" onClick={() => props.store.hold(owner, '')}>
            Discard
          </button>
        </div>
      ))}
    </>
  );
}

// Keyboard focus moving from a replaced editor to its successor (see the
// layout effect in Composer).
const editorFocus = { transfer: false };

function Composer(props: { status: ChatStatus; bridge: NativeBridge; store: ChatStore }) {
  const { status, bridge, store } = props;
  const draft = status.draft || { text: '', cursor: -1, revision: 0, source: '', notice: '' };
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(store.held()[status.sessionId] ?? draft.text);
  const base = useRef(draft.revision);
  const sessionId = useRef(status.sessionId);
  const inFlight = useRef(0);
  // Rendered copy of inFlight, so Send waits for the latest edit's answer.
  const [editsInFlight, setEditsInFlight] = useState(0);
  const lastCursor = useRef(draft.cursor);
  // Text the host refused and could not keep (only when its bounded
  // recovery is exhausted), per conversation, held by the store so it
  // outlives this component. The host is told, so moving that conversation
  // to another view waits until it is resolved.
  const unkeptBySession = store.held();
  const unkept = unkeptBySession[status.sessionId] ?? null;
  const unkeptHere = unkept !== null;
  function setUnkept(sessionOfText: string, value: string) {
    store.hold(sessionOfText, value);
  }
  const [inputNotice, setInputNotice] = useState('');
  // The newest known host draft, kept by the store in message order (see
  // ChatStore.hostDraft), not from render state that may lag behind.
  const hostDraft = {
    get current() {
      return store.hostDraft();
    },
  };

  const maximum = status.maximumMessageLength || 8000;
  const editLimit = status.editLimit || 2 * maximum;
  const refused = draft.refused || '';
  const sendable =
    status.canSend === true &&
    editsInFlight === 0 &&
    refused === '' &&
    unkept === null &&
    text.trim() !== '' &&
    text.length <= maximum;
  // Like the classic composer, a draft can still be written while offline;
  // only words being recorded into it make it read-only.
  const readOnly = status.recording?.busy === true;

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

  // Whether this instance still shows its conversation. Answers to its edits
  // can arrive after a switch replaced it; they must not touch the editor
  // that now shows another (or a newer instance of the same) conversation.
  const alive = useRef(true);

  // A new editor (page load, pop-out window, conversation switch) starts at
  // the host cursor, and keeps keyboard focus if the previous editor had it.
  useLayoutEffect(() => {
    const element = area.current;
    if (element && draft.cursor >= 0) {
      const cursor = Math.min(draft.cursor, element.value.length);
      element.setSelectionRange(cursor, cursor);
    }
    if (element && editorFocus.transfer) {
      editorFocus.transfer = false;
      element.focus();
    }
    return () => {
      alive.current = false;
      // Only a successor created in this same render takes focus over (a
      // conversation switch); none is waiting after Activity is shown.
      editorFocus.transfer = element !== null && document.activeElement === element;
      setTimeout(() => {
        editorFocus.transfer = false;
      });
    };
  }, []);

  useEffect(() => {
    const otherSession = status.sessionId !== sessionId.current;
    if (otherSession) {
      // Unkept text of the previous conversation stays in its notice.
      sessionId.current = status.sessionId;
      inFlight.current = 0;
      setEditsInFlight(0);
      lastCursor.current = -1;
      setInputNotice('');
    } else if (unkeptHere) {
      // Never replace text only this page holds with the host draft.
      return;
    }
    if (otherSession && unkeptHere) {
      // The newly shown conversation has text only this page holds: show
      // that, not the host draft, so it is never replaced.
      base.current = draft.revision;
      setText(unkept);
      return;
    }
    if (otherSession || (draft.revision !== base.current && inFlight.current === 0)) {
      adoptHostDraft();
    }
  }, [status.sessionId, draft.revision]);

  // Over-limit text that still arrives (an input that cannot be cancelled,
  // e.g. an input method) is sent anyway: the host refuses it and keeps it
  // as this conversation's refused text, which handover and navigation
  // preserve.
  function edited(value: string, cursor: number) {
    setInputNotice('');
    setText(value);
    inFlight.current++;
    setEditsInFlight(inFlight.current);
    lastCursor.current = cursor;
    const editedSession = status.sessionId;
    bridge.editDraft(editedSession, base.current, value, cursor, (json) => {
      if (!alive.current) {
        // A replaced instance only makes sure nothing is lost: text the host
        // could not keep goes to its own conversation's page-held recovery.
        if (decode(json).kept === false) {
          setUnkept(editedSession, value);
        }
        return;
      }
      if (editedSession !== sessionId.current) {
        // The view moved on. The host normally kept this refused edit for
        // that conversation; if it could not, the notice keeps it here.
        if (decode(json).kept === false) {
          setUnkept(editedSession, value);
        }
        return;
      }
      inFlight.current = Math.max(0, inFlight.current - 1);
      setEditsInFlight(inFlight.current);
      const answer = decode(json);
      if (!answer.accepted && answer.draft) {
        if (answer.kept === false) {
          // The host could not keep it: it stays here, on screen.
          setUnkept(editedSession, value);
          setText(value);
          return;
        }
        // Refused: the host kept this text as the conversation's refused
        // text (shown below); show what the host draft holds now.
        base.current = answer.draft.revision;
        setText(answer.draft.text);
        return;
      }
      if (answer.accepted) {
        store.acceptedEdit(editedSession, value, cursor);
      }
      // The host changed while this edit travelled; its status update was
      // held back for the answer, so apply it now.
      if (inFlight.current === 0 && hostDraft.current.revision !== base.current) {
        adoptHostDraft();
      }
    });
  }

  // Reads the editor itself, not render state: an input and Enter can be
  // handled before the page re-renders, and the text sent must be exactly
  // what is on screen (the host checks it is the draft).
  function send() {
    const shown = area.current ? area.current.value : text;
    if (
      !sendable ||
      inFlight.current > 0 ||
      shown !== text ||
      shown.trim() === '' ||
      shown.length > maximum
    ) {
      return;
    }
    bridge.send(status.sessionId, base.current, shown);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  }

  // A paste or drop that would exceed what the host accepts changes nothing.
  function insertionTooLong(inserted: string): boolean {
    const element = area.current;
    if (!element) {
      return false;
    }
    const selected = element.selectionEnd - element.selectionStart;
    const resulting = element.value.length - selected + inserted.length;
    if (resulting <= editLimit) {
      return false;
    }
    setInputNotice(
      `That would make the message ${resulting} characters; at most ${editLimit} can be edited here ` +
        `and ${maximum} sent. Nothing was changed.`,
    );
    return true;
  }

  // Cursor-only movement (arrow keys, clicks, selection) is reported too.
  function cursorMoved() {
    const element = area.current;
    if (!element || document.activeElement !== element || inFlight.current > 0) {
      return;
    }
    const cursor = element.selectionStart;
    if (cursor === lastCursor.current || element.value !== text) {
      return;
    }
    lastCursor.current = cursor;
    bridge.moveCursor(status.sessionId, base.current, cursor);
  }

  useEffect(() => {
    document.addEventListener('selectionchange', cursorMoved);
    return () => document.removeEventListener('selectionchange', cursorMoved);
  });

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
      {inputNotice && <div class="conflict">{inputNotice}</div>}
      <HeldNotices store={store} status={status} />
      {unkept !== null && (
        <div class="conflict unkept">
          This text ({unkept.length} characters) could not be added to the draft and is only kept
          here.
          <CopyActions text={unkept} bridge={bridge} copyLimit={status.copyLimit || 1048576} />
          {unkept.length <= editLimit && (
            <button
              class="link"
              onClick={() => {
                const value = unkept;
                setUnkept(status.sessionId, '');
                base.current = hostDraft.current.revision;
                edited(value, value.length);
              }}
            >
              Use my text
            </button>
          )}
          <button
            class="link"
            onClick={() => {
              setUnkept(status.sessionId, '');
              adoptHostDraft();
            }}
          >
            Discard
          </button>
        </div>
      )}
      {refused && (
        <div class="conflict refused">
          Some of your text could not be added to the draft (it changed elsewhere, was too long or
          words were being recorded). Your text is kept.
          <button class="link" onClick={() => bridge.resolveRefused(status.sessionId, 'use')}>
            Use my text
          </button>
          <button class="link" onClick={() => bridge.resolveRefused(status.sessionId, 'copy')}>
            Copy my text
          </button>
          <button class="link" onClick={() => bridge.resolveRefused(status.sessionId, 'dismiss')}>
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
          if (unkeptHere) {
            // Shortening or editing text only this page holds.
            setText(element.value);
            setUnkept(status.sessionId, element.value);
            return;
          }
          edited(element.value, element.selectionStart);
        }}
        onBeforeInput={(event) => {
          // Typing, line breaks, replacement and drops that would go past
          // the limit change nothing (input methods cannot be cancelled).
          const input = event as unknown as InputEvent;
          const inserted = input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
          const inserting = input.inputType.startsWith('insert');
          const addition = input.inputType === 'insertLineBreak' ? '\n' : inserted;
          if (inserting && input.cancelable && insertionTooLong(addition)) {
            event.preventDefault();
          }
        }}
        onPaste={(event) => {
          if (insertionTooLong(event.clipboardData?.getData('text/plain') ?? '')) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (insertionTooLong(event.dataTransfer?.getData('text/plain') ?? '')) {
            event.preventDefault();
          }
        }}
        onKeyDown={keyDown}
        onKeyUp={cursorMoved}
        onMouseUp={cursorMoved}
        onSelect={cursorMoved}
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
      {/* The phone's footer hierarchy: primary Send/Queue, then secondary
          actions, and the conversation state at the end. */}
      <div class="actions controls-row">
        <button class="action primary" disabled={!sendable} onClick={send}>
          {status.running ? 'Queue' : 'Send'}
        </button>
        {recording?.available && (
          <button
            class={recording.here ? 'action recording' : 'action'}
            disabled={recording.here ? !recording.canStop : !recording.canRecord}
            onClick={() => bridge.toggleRecording(status.sessionId)}
          >
            {recordLabel}
          </button>
        )}
        {status.running && !status.stopRunId && (
          <button
            class="action"
            disabled={!status.online}
            onClick={() => bridge.stop(status.sessionId)}
          >
            Stop
          </button>
        )}
        <button
          class="action"
          disabled={!status.online || recording?.busy === true}
          onClick={() => bridge.closeSession(status.sessionId)}
        >
          Close session
        </button>
        <span class="state status-text">{stateLabel}</span>
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
