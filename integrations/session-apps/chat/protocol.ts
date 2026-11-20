/**
 * Messages between the trusted chat page and its native view
 * (TrustedChatView.qml). Shapes mirror ChatState.mjs and the view's
 * currentStatus(); the native side validates every request again.
 */

/** One resident transcript row (ChatState.chatRow). */
export interface ChatRow {
  key: string;
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | string;
  text: string;
  state: string;
  toolName: string;
  toolCount: number;
  toolUnavailable: boolean;
  screenshot: boolean;
  screenshotAvailable: boolean;
  screenshotNotSaved: boolean;
  fragmentLabel: string;
  origin: {
    kind: 'agent' | 'external' | 'scheduled-wake' | 'application-event' | 'application-message';
    receiptId?: string;
    title: string;
    sessionId: string;
    groupId: string;
  } | null;
  widget: { name: string } | null;
  /**
   * When the message was written, as the host formats it for the reader
   * (`14:02`, `Yesterday 16:48`), shown at the right of its heading line.
   * Optional: absent, the heading is exactly as without it. The Qt host
   * never sets it; the browser shell does while its Message timestamps
   * switch is on and the message has a time.
   */
  time?: string;
  /**
   * In-place details of a tool group (`kind` 'tool'), from a host that shows
   * them in the page. Optional: absent, the row is drawn exactly as without
   * it (its heading opens the classic view). The Qt host never sets it; the
   * browser shell does for every tool row.
   */
  tools?: ChatToolDetails;
}

/**
 * A tool group's details as the host shows them in place: open or closed,
 * one line about the page or request, the page's text and which actions are
 * offered. The host owns all of it; the page only draws it and reports the
 * reader's actions with `NativeBridge.toolDetails`.
 */
export interface ChatToolDetails {
  open: boolean;
  /** Loading, a failure, or which call and characters the page shows; may hold '\n'. */
  status: string;
  /** Whether `status` reports a failure. */
  failed: boolean;
  /** The page's text (a call's name, input and output), plain. */
  text: string;
  /** Whether `text` is a loaded page (it can be copied). */
  loaded: boolean;
  /** The label of the action that loads the page again ('' for none). */
  reload: string;
  /** Whether a next page exists. */
  next: boolean;
  /** Whether From start is offered (the page is not the first). */
  restart: boolean;
  /** Whether the actions that ask the host are unavailable now. */
  busy: boolean;
}

/** The reader's actions on a tool group's in-place details. */
export type ToolDetailsAction = 'toggle' | 'reload' | 'start' | 'next';

export interface ChatChoice {
  sessionId: string;
  revision: string;
  index: number;
  label: string;
  description: string;
  available: boolean;
  voiceAvailable: boolean;
  voiceReason: string;
}

/** The composer and controls state, sent whole on every change. */
export interface ChatStatus {
  sessionId: string;
  title?: string;
  sessionStatus?: string;
  /** The conversation's failure message, shown below the transcript. */
  sessionError?: string;
  /** Why the shown text is not saved in the listener, or '' (it is). */
  draftUnsaved?: string;
  running?: boolean;
  online?: boolean;
  paused?: boolean;
  draft?: {
    text: string;
    cursor: number;
    revision: number;
    source: string;
    notice: string;
  };
  maximumMessageLength?: number;
  /** Longest draft text the host accepts from the page. */
  editLimit?: number;
  canSend?: boolean;
  pendingSend?: boolean;
  pendingChoice?: boolean;
  inputError?: string;
  recording?: {
    available: boolean;
    here: boolean;
    state: string;
    canRecord: boolean;
    busy: boolean;
    stopPending: boolean;
    canStop: boolean;
  };
  choices?: ChatChoice[];
  stopRunId?: string;
  voiceTarget?: boolean;
  voiceStatus?: string;
  history?: {
    hasOlder: boolean;
    pending: boolean;
    error: string;
    canRetry: boolean;
    changed: boolean;
    detached: boolean;
    atLatest: boolean;
  };
  focusShortcut?: string;
  application?: { name: string; version: number } | null;
  theme?: {
    foreground: string;
    background: string;
    accent: string;
    muted: string;
    selection: string;
    fontFamily: string;
    proseFontFamily: string;
    /** Message and composer text scale (the classic view's textScale). */
    scale: number;
    /** Theme unit for chrome sizes (the classic view's unit). */
    unit?: number;
  };
}

export type HostMessage =
  | {
      type: 'rows';
      seq: number;
      sessionId: string;
      full: boolean;
      order: string[];
      changed: ChatRow[];
    }
  | { type: 'status'; seq: number; status: ChatStatus };

/** Result of a bridge request; methods answer with a JSON string. */
export interface BridgeAnswer {
  accepted: boolean;
  reason?: string;
}

/**
 * The native `companion` QWebChannel object. Calls are asynchronous and
 * delivered in order; each optional callback receives the method's result.
 */
export interface NativeBridge {
  message: { connect(callback: (json: string) => void): void };
  /** `documentId` is constant for one loaded page; a new id means a reload. */
  ready(documentId: string, callback?: () => void): void;
  editDraft(
    sessionId: string,
    base: number,
    text: string,
    cursor: number,
    callback?: (answer: string) => void,
  ): void;
  /** `text` is what the page shows; the host sends only if it is the draft. */
  send(sessionId: string, base: number, text: string, callback?: (answer: string) => void): void;
  moveCursor(sessionId: string, base: number, cursor: number): void;
  choose(
    sessionId: string,
    revision: string,
    index: number,
    callback?: (answer: string) => void,
  ): void;
  stopRun(sessionId: string, runId: string, callback?: (answer: string) => void): void;
  stop(sessionId: string, callback?: (answer: string) => void): void;
  closeSession(sessionId: string, callback?: (answer: string) => void): void;
  /**
   * The page keeps (`length` > 0) or no longer keeps (0) input the host does
   * not have, typed in `sessionId`. Only its length crosses the bridge.
   */
  inputUnresolved(sessionId: string, length: number): void;
  saveDraft(sessionId: string, callback?: (answer: string) => void): void;
  discardUnsavedDraft(sessionId: string, callback?: (answer: string) => void): void;
  toggleRecording(sessionId: string, callback?: (answer: string) => void): void;
  history(sessionId: string, request: 'older' | 'newer' | 'latest' | 'retry' | 'refresh'): void;
  following(sessionId: string, atEnd: boolean): void;
  composerFocus(focused: boolean): void;
  /** Answers `{accepted, length, reason}` as JSON. */
  copyText(text: string, callback?: (answer: string) => void): void;
  openLink(url: string): void;
  openScreenshot(sessionId: string, key: string): void;
  /**
   * The reader's action on the in-place details of tool row `key`. Optional:
   * only a host that sends `ChatRow.tools` implements it.
   */
  toolDetails?(sessionId: string, key: string, action: ToolDetailsAction): void;
  openOrigin(sessionId: string, key: string): void;
  classicView(): void;
  openApp(): void;
}
