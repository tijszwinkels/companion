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
        '--unit': String(theme.unit || 1),
      }
    : {};

  return (
    <div class="chat" style={style}>
      <Header status={status} />
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

/**
 * The conversation's title for assistive technology. It is not drawn: the
 * native header above the page already shows it, as in the classic view.
 * The application and Classic view actions are in the composer's footer.
 */
function Header(props: { status: ChatStatus }) {
  return (
    <h1 class="header visually-hidden">
      <span class="title">{props.status.title}</span>
    </h1>
  );
}

// ---- Transcript -------------------------------------------------------------

function Transcript(props: { rows: ChatRow[]; status: ChatStatus; bridge: NativeBridge }) {
  const { rows, status, bridge } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const firstKey = useRef('');
  const heightBefore = useRef(0);
  // When the reader last scrolled the transcript themselves (wheel, keys or a
  // pointer, such as dragging the scroll bar), in performance.now() time.
  const readerScrolledAt = useRef(-Infinity);

  function readerInput() {
    readerScrolledAt.current = performance.now();
  }
  const history = status.history;

  // While the reader is away from the live end: the message at the
  // transcript's top edge and its distance from that edge, so a resize or
  // reflow can put it back where it was (the classic view's reader anchor).
  const readerAnchor = useRef<{ row: Element; offset: number } | null>(null);

  function follow(value: boolean) {
    following.current = value;
    if (value) {
      readerAnchor.current = null;
    }
  }

  function rememberReaderRow() {
    const element = scroller.current;
    const inner = content.current;
    readerAnchor.current = null;
    if (!element || !inner) {
      return;
    }
    const edge = element.getBoundingClientRect().top;
    for (const row of inner.querySelectorAll('.message')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > edge + 1) {
        readerAnchor.current = { row: row, offset: box.top - edge };
        return;
      }
    }
  }

  function restoreReaderRow() {
    const element = scroller.current;
    const anchor = readerAnchor.current;
    if (!element || !anchor || !anchor.row.isConnected) {
      return;
    }
    const edge = element.getBoundingClientRect().top;
    const offset = anchor.row.getBoundingClientRect().top - edge;
    element.scrollTop += offset - anchor.offset;
  }

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
      rememberReaderRow();
    }
    firstKey.current = first;
    heightBefore.current = element.scrollHeight;
  }, [rows]);

  // A different conversation starts at its live end. Scrolling done in the
  // previous one does not carry over.
  useEffect(() => {
    follow(true);
    readerScrolledAt.current = -Infinity;
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [status.sessionId]);

  // Like the classic view, a reader who follows the live end stays there when
  // the transcript or its content changes size without new rows: the window
  // is resized, the text scale changes, or a streamed answer reflows. A
  // reader who scrolled up keeps the message at the top edge where it was.
  // (The browser's own scroll anchoring is off for the transcript, see the
  // stylesheet, so it never moves the view as well.) The observer belongs to
  // this component and is disconnected when it unmounts.
  useEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (!element || !inner) {
      return;
    }
    // Also on the window's own resize event: the native view resizes the
    // page (and animates its height) without waiting for a rendered frame,
    // which the observer's callbacks need.
    const observer = new ResizeObserver(keepPlace);
    observer.observe(element);
    observer.observe(inner);
    window.addEventListener('resize', keepPlace);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', keepPlace);
    };
  }, []);

  // A new text scale or theme unit changes every row's height in this render.
  useLayoutEffect(keepPlace, [status.theme?.scale, status.theme?.unit]);

  // After a size change: at the live end while following, otherwise the
  // reader's row back where it was.
  function keepPlace() {
    const element = scroller.current;
    if (!element) {
      return;
    }
    if (following.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      restoreReaderRow();
      rememberReaderRow();
    }
    heightBefore.current = element.scrollHeight;
  }

  // Back to the live end: follow it again here and ask the host for the
  // latest page (it may hold an older one).
  function jumpToLatest() {
    follow(true);
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    bridge.history(status.sessionId, 'latest');
  }

  function scrolled() {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;

    // Like the classic view, only the reader leaves the live end: a scroll
    // within a second of their own input (each scroll while they drag or
    // keep scrolling extends that). Other scroll events while following come
    // from layout changes, e.g. the native view animating its height after a
    // text scale change; they never stop following, the view stays at the end.
    const byReader = performance.now() - readerScrolledAt.current < 1000;
    if (byReader) {
      readerInput();
    }
    if (following.current && !atEnd && !byReader) {
      element.scrollTop = element.scrollHeight;
      heightBefore.current = element.scrollHeight;
      return;
    }
    if (atEnd !== following.current) {
      follow(atEnd);
      bridge.following(status.sessionId, atEnd);
    }
    if (!following.current) {
      rememberReaderRow();
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

  // The Jump button floats over the transcript's bottom-right corner, like
  // the classic view's arrow, instead of taking a row in the transcript.
  return (
    <div class="transcript-area">
      <div
        class="transcript"
        ref={scroller}
        onScroll={scrolled}
        onClick={clicked}
        onWheel={readerInput}
        onKeyDown={readerInput}
        onPointerDown={readerInput}
      >
        <div class="rows" ref={content}>
          <HistoryNotice status={status} bridge={bridge} />
          {rows.map((row) => (
            <Row key={row.key} row={row} sessionId={status.sessionId} bridge={bridge} />
          ))}
          {status.sessionError && <div class="session-error">{status.sessionError}</div>}
        </div>
      </div>
      {history && !history.atLatest && (
        <button
          class="latest"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={jumpToLatest}
        >
          ↓
        </button>
      )}
    </div>
  );
}

/**
 * Loading, failure and out-of-date notices for the history pages, drawn
 * like the classic view's pill at the top of the transcript: a short muted
 * message and, when there is something to do, one action.
 */
function HistoryNotice(props: { status: ChatStatus; bridge: NativeBridge }) {
  const { status, bridge } = props;
  const history = status.history;
  if (!history) {
    return null;
  }

  let message = '';
  let action = '';
  let request: 'older' | 'retry' | 'refresh' | null = null;
  if (history.pending) {
    message = 'Loading messages…';
  } else if (history.error) {
    message = history.error;
    if (history.canRetry) {
      action = 'Retry';
      request = 'retry';
    }
  } else if (history.changed) {
    message = 'Messages may have changed since they loaded';
    action = 'Refresh';
    request = 'refresh';
  } else if (history.hasOlder) {
    message = 'Earlier messages';
    action = 'Load';
    request = 'older';
  } else {
    return null;
  }

  return (
    <div class={`history-notice ${history.error ? 'error' : ''}`}>
      <span class="history-text">{message}</span>
      {request && (
        <button
          class="panel-action small"
          aria-label={request === 'older' ? 'Load earlier messages' : `${action} history`}
          onClick={() => bridge.history(status.sessionId, request)}
        >
          {action}
        </button>
      )}
    </div>
  );
}

/**
 * The small line at the top of each message, as in the classic view: who
 * wrote it ("You", "Pi", the agent or application that sent it), whether it
 * is queued or failed, and fragment and screenshot notes. Provenance stays in
 * its own `.from` element; a linked agent origin opens its conversation.
 */
function UserHeading(props: { row: ChatRow; sessionId: string; bridge: NativeBridge }) {
  const { row, sessionId, bridge } = props;
  const origin = row.origin;

  let from = '';
  if (origin?.kind === 'agent') {
    from = `Agent · ${origin.title || 'another conversation'}`;
  } else if (origin?.kind === 'external') {
    from = `External agent (unverified) · ${origin.title}`;
  } else if (origin?.kind === 'application-message') {
    from =
      `Application · ${origin.title || 'unverified application origin'}` +
      (origin.receiptId ? ` · receipt ${origin.receiptId.slice(0, 8)}` : '');
  } else if (origin?.kind === 'application-event') {
    from = "Your edits in this conversation's app";
  } else if (origin?.kind === 'scheduled-wake') {
    from = origin.title ? `Scheduled wake · ${origin.title}` : 'Scheduled wake';
  }

  let suffix = '';
  if (row.state === 'queued') {
    suffix += ' · queued';
  } else if (row.state === 'error') {
    suffix += ' · not sent';
  }
  if (row.screenshotNotSaved) {
    suffix += ' · screenshot not saved';
  } else if (row.screenshot) {
    suffix += row.screenshotAvailable ? ' · screenshot attached' : ' · screenshot unavailable';
  }
  suffix += row.fragmentLabel;

  let who = <span>You</span>;
  if (from && origin?.kind === 'agent' && origin.sessionId) {
    who = (
      <button
        class="from link"
        title="Opens the source conversation"
        onClick={() => bridge.openOrigin(sessionId, row.key)}
      >
        {from}
      </button>
    );
  } else if (from) {
    who = <span class="from">{from}</span>;
  }

  return (
    <div class={`heading ${row.state === 'error' ? 'error' : ''}`}>
      {who}
      {suffix}
    </div>
  );
}

/** Copy, shown on hover or keyboard focus in the message's top-right corner. */
function CopyMessage(props: { text: string; bridge: NativeBridge }) {
  return (
    <button
      class="copy"
      aria-label="Copy message"
      onClick={() => props.bridge.copyText(props.text)}
    >
      Copy
    </button>
  );
}

const Row = memo(function Row(props: { row: ChatRow; sessionId: string; bridge: NativeBridge }) {
  const { row, sessionId, bridge } = props;

  // A tool group is a collapsed panel like the classic view's; its details
  // are in the classic view, which the heading opens.
  if (row.kind === 'tool') {
    let state = '';
    if (row.toolUnavailable) {
      state = ' · details unavailable';
    } else if (row.state === 'running') {
      state = ' · running';
    } else if (row.state === 'error') {
      state = ' · failed or stopped';
    }
    const count =
      row.toolCount > 0
        ? `${row.toolCount} tool call${row.toolCount === 1 ? '' : 's'}`
        : row.toolName || 'Tool call';
    return (
      <div class="message tool">
        <div class="panel">
          <button
            class="heading tool-heading"
            onClick={() => bridge.classicView()}
            title="Tool details are in the classic view"
          >
            ▸ {count}
            {state}
          </button>
        </div>
      </div>
    );
  }

  if (row.kind === 'user') {
    return (
      <div class={`message user ${row.state === 'queued' ? 'queued' : ''}`}>
        <div class="panel">
          <UserHeading row={row} sessionId={sessionId} bridge={bridge} />
          {row.screenshot && row.screenshotAvailable && !row.screenshotNotSaved && (
            <button
              class="panel-action small"
              onClick={() => bridge.openScreenshot(sessionId, row.key)}
            >
              View screenshot
            </button>
          )}
          {row.text && <div class="bubble">{row.text}</div>}
          {row.text && <CopyMessage text={row.text} bridge={bridge} />}
        </div>
      </div>
    );
  }

  const heading = (
    <div class={`heading ${row.state === 'error' ? 'error' : ''}`}>Pi{row.fragmentLabel}</div>
  );

  if (row.kind === 'notice') {
    return (
      <div class={`message assistant notice ${row.state === 'error' ? 'error' : ''}`}>
        <div class="panel">
          {heading}
          <div class="bubble">{row.text}</div>
        </div>
      </div>
    );
  }

  if (row.widget) {
    return (
      <div class="message assistant">
        <div class="panel">
          {heading}
          <div class="widget-card">
            <strong>{row.widget.name}</strong> widget — shown in the classic view.
            <button class="link" onClick={() => bridge.classicView()}>
              Open
            </button>
            {row.text && <div>{row.text}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class={`message assistant ${row.state === 'error' ? 'error' : ''}`}>
      <div class="panel">
        {heading}
        <div
          class="bubble markdown"
          // renderMarkdown escapes every HTML tag in agent text and only keeps
          // explicit http(s) links; the page CSP also forbids inline scripts.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text || '…') }}
        />
        {row.text && row.state !== 'running' && <CopyMessage text={row.text} bridge={bridge} />}
      </div>
    </div>
  );
});

// ---- Choices, Stop and voice status -----------------------------------------

/**
 * Voice status, the run's Stop and the offered choices, laid out like the
 * classic view: one full-width row per choice with its "[label]" and the
 * description beside it. A choice the voice target can say right now has an
 * accent label and border; the others are muted, so the brackets never claim
 * more than the voice annotation does.
 */
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
          class={`panel-action stop ${status.voiceTarget && listening ? 'active' : ''}`}
          disabled={!status.online}
          onClick={() => bridge.stopRun(status.sessionId, status.stopRunId || '')}
        >
          {status.voiceTarget ? '[stop]' : 'Stop'}
        </button>
      )}
      {choices.length > 0 && (
        <div class="choices" role="group" aria-label="Choices">
          {choices.map((choice) => {
            const speakable = status.voiceTarget && listening && !pending && choice.voiceAvailable;
            let hint = choice.voiceReason;
            if (!status.online) {
              hint = 'Disconnected';
            } else if (!hint) {
              if (status.paused) {
                hint = 'Click to select; voice listening is paused';
              } else if (!status.voiceTarget) {
                hint = 'Click to select; voice goes elsewhere';
              } else if (!choice.voiceAvailable) {
                hint = 'Click to select';
              } else {
                hint = `Say “${choice.label}” to select`;
              }
            }
            return (
              <button
                key={`${choice.revision}:${choice.index}`}
                class={`choice ${speakable ? 'speakable' : ''}`}
                disabled={!status.online || pending || !choice.available}
                title={choice.description ? `${hint}\n${choice.description}` : hint}
                aria-label={
                  choice.description ? `${choice.label}: ${choice.description}` : choice.label
                }
                onClick={() => bridge.choose(choice.sessionId, choice.revision, choice.index)}
              >
                <span class="label">[{choice.label}]</span>
                {choice.description && <span class="description">{choice.description}</span>}
              </button>
            );
          })}
        </div>
      )}
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
// layout effect in Composer). `requested`: a native focus request (focus
// shortcut) that arrived before the conversation's editor was rendered; the
// editor takes focus when it appears, instead of the request being lost.
const editorFocus = { transfer: false, requested: false };

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
  // Whether this editor has keyboard focus (only for the placeholder).
  const [focused, setFocused] = useState(false);
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
    if (element && (editorFocus.transfer || editorFocus.requested)) {
      editorFocus.transfer = false;
      editorFocus.requested = false;
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

  // The classic view's wording: the focus shortcut while the editor is not
  // focused, otherwise what typing here does.
  let placeholder = status.running ? 'Write a follow-up while Pi answers…' : 'Ask a follow-up…';
  if (status.focusShortcut && !focused) {
    placeholder = `${status.focusShortcut} to focus`;
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
        onFocus={() => {
          setFocused(true);
          bridge.composerFocus(true);
        }}
        onBlur={() => {
          setFocused(false);
          bridge.composerFocus(false);
        }}
      />
      {/* Notices and recovery come below the editor, as in the classic
          view, so the editor never moves when one appears. */}
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
      {status.draftUnsaved && (
        <div class="conflict unsaved">
          {status.draftUnsaved}
          <button class="link" onClick={() => bridge.saveDraft(status.sessionId)}>
            Save
          </button>
          <button class="link" onClick={() => bridge.discardUnsavedDraft(status.sessionId)}>
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
      {/* The classic view's action row: Send/Queue, Record, Stop, the
          application and Classic view escapes, Close session, then the
          conversation's state right after the buttons. */}
      <div class="actions">
        <button class="panel-action" disabled={!sendable} onClick={send}>
          {status.running ? 'Queue' : 'Send'}
        </button>
        {recording?.available && (
          <button
            class={recording.here ? 'panel-action recording' : 'panel-action'}
            disabled={recording.here ? !recording.canStop : !recording.canRecord}
            onClick={() => bridge.toggleRecording(status.sessionId)}
          >
            {recordLabel}
          </button>
        )}
        {status.running && !status.stopRunId && (
          <button
            class="panel-action"
            disabled={!status.online}
            onClick={() => bridge.stop(status.sessionId)}
          >
            Stop
          </button>
        )}
        {status.application && (
          <button
            class="panel-action"
            onClick={() => bridge.openApp()}
            title="Show this conversation's application"
          >
            {status.application.name}
          </button>
        )}
        <button
          class="panel-action"
          onClick={() => bridge.classicView()}
          title="Classic Companion view (tool details and widgets)"
        >
          Classic view
        </button>
        <button
          class="panel-action"
          disabled={!status.online || recording?.busy === true || Boolean(status.draftUnsaved)}
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
  if (area) {
    area.focus();
  } else {
    // No editor yet (the page is still rendering the conversation).
    editorFocus.requested = true;
  }
}

export function blurComposer() {
  editorFocus.requested = false;
  const area = document.querySelector('textarea');
  area?.blur();
}
