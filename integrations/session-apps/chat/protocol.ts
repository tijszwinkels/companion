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
}

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
  openOrigin(sessionId: string, key: string): void;
  classicView(): void;
  openApp(): void;
}
