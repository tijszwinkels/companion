/**
 * The trusted chat page's `NativeBridge`, implemented over the gateway.
 *
 * In the Qt host the chat page (integrations/session-apps/chat/) talks to
 * TrustedChatView.qml through QWebChannel; that view mirrors the SessionView
 * model into `rows` and `status` messages and turns the page's requests into
 * listener requests. In the browser shell this class plays that role:
 *
 * - Source of truth: the phone panel's Store (integrations/mobile/src/store.ts)
 *   and its Connection, which pair, authenticate, reconnect and never resend
 *   a request whose outcome is unknown. The conversation shown is the Store's
 *   `selected` conversation.
 * - Output: `rows` and `status` messages with the Qt host's shapes and
 *   sequence rules (see TrustedChatView.qml and ChatState.mjs). Every message
 *   carries the next sequence number; `ready()` resends everything in full.
 *   Rows are diffed with ChatState.diffRows and sent at most every 30 ms;
 *   status goes out at the end of the current task when it changed.
 * - Input: the page's requests, checked again here against the shown
 *   conversation exactly like the Qt bridge, then sent as the gateway's
 *   remote actions: `send-agent`, `choose-agent`, `stop-agent-run`,
 *   `stop-agent`, `close-agent` and `agent-history-page`. Nothing else
 *   leaves the page.
 *
 * Differences from the Qt host (deliberate, see integrations/shell/README.md):
 * - The draft is kept in this page per conversation, as the phone panel does
 *   (its Store saves it in this browser's storage). There is no
 *   listener-owned or agent-proposed draft, so `draftUnsaved` is always
 *   empty and Save/Discard have nothing to do.
 * - Recording, voice target, focus shortcut, session applications, the
 *   classic view, tool details and screenshots are not available. Recording
 *   and applications are hidden through `status`; the page's Classic view
 *   and tool-group buttons show a notice in `inputError` instead.
 * - Stricter admission: a send must be based on the current draft revision
 *   (no second send of text already sent), and nothing is admitted after a
 *   reconnect until the listener's new snapshot arrived.
 * - Newer history pages below a detached snapshot also load as the reader
 *   scrolls toward the end (`readerNearEnd`, reported by main.tsx), not only
 *   through the page's `history('newer')`.
 *
 * Replies and messages reach the page asynchronously and in call order, as
 * QWebChannel delivers them.
 */

import type { AgentSession } from '../../../src/agents/types.ts';
import type { HistoryPage } from '../../../src/agents/history-pages.ts';
import type { Store } from '../../mobile/src/store.ts';
import { diffRows, maximumMessageCharacters } from '../../session-apps/ChatState.mjs';
import type {
  ChatChoice,
  ChatStatus,
  HostMessage,
  NativeBridge,
} from '../../session-apps/chat/protocol.ts';
import { ResidentHistory, type PageRequest } from './history.ts';
import { pageRow } from './rows.ts';

/** Longest message the gateway accepts for `send-agent` (src/remote/protocol.ts). */
export const maximumMessageLength = 4000;

/** Longest text one Copy hands to the clipboard (as in the Qt host). */
const copyLimit = 1_048_576;

/** How long rows wait to be coalesced while text streams (as in the Qt host). */
const rowsIntervalMilliseconds = 30;

/** Shown when the page asks for something only the desktop offers. */
const classicUnavailable =
  'Tool details, widgets and the classic view are not available in the browser yet.';
const applicationUnavailable = 'Session applications are not available in the browser yet.';

/**
 * Where the transcript is on screen. The page draws one `.message` element
 * per row, in the order of the last rows message; these report positions in
 * that order. Supplied by main.tsx, which knows the page's DOM.
 */
export interface TranscriptView {
  /** Indexes of rows that are at least partly inside the transcript viewport. */
  visibleIndexes(): number[];
  /** Index of the row at the transcript's top edge, or -1. */
  topIndex(): number;
}

type Answer = Record<string, unknown>;

export class GatewayChatBridge implements NativeBridge {
  readonly message: { connect(callback: (json: string) => void): void };

  private readonly listeners: ((json: string) => void)[] = [];
  // Ordered deliveries to the page (messages and replies), drained in a
  // microtask so the page never runs inside its own call into the bridge.
  private readonly deliveries: (() => void)[] = [];
  private draining = false;

  // Page mirroring, as in TrustedChatView.qml.
  private pageReady = false;
  private sequence = 0;
  private sentRows: Record<string, string> = {};
  private sentOrder: string[] = [];
  private lastStatus = '';
  private fullRows = true;
  private rowsDirty = true;
  private rowsTimer: ReturnType<typeof setTimeout> | undefined;
  private statusQueued = false;

  // The shown conversation and its resident rows.
  private shownSession: AgentSession | null = null;
  private readonly resident: ResidentHistory;

  // Connection state. `online` (what the page sees, and what admits
  // requests) is true only once the current connection's first complete
  // snapshot arrived: between authentication and that snapshot the shown
  // conversation may be stale (closed, or reopened under the same ID while
  // offline), so nothing may be sent for it yet. The Store ignores partial
  // engine states until its snapshot, so a new `engine` object after the
  // connection came up means the snapshot was applied.
  private connected = false;
  private engineAtConnect: unknown = undefined;
  private snapshotSeen = false;
  private online = false;

  // Drafts live in the Store; the bridge tracks their host revisions. A
  // revision advances only when the draft changes other than by this page's
  // own edit (a completed send clearing it, another page of this browser).
  private readonly draftRevisions = new Map<string, number>();
  private readonly knownDrafts = new Map<string, string>();
  private readonly cursors = new Map<string, number>();

  // Per conversation: the last refusal or failure to show (`inputError`).
  private readonly errors = new Map<string, string>();
  // Per conversation: the choice request awaiting its answer, kept until it
  // settles even when the page shows another conversation meanwhile.
  private readonly pendingChoices = new Map<string, object>();
  // Input only the page's editor holds (its length only), as in SessionView.
  private unresolved: { sessionId: string; length: number } | null = null;

  constructor(
    private readonly store: Store,
    private readonly view: TranscriptView,
  ) {
    this.message = {
      connect: (callback) => {
        this.listeners.push(callback);
      },
    };
    this.resident = new ResidentHistory({
      requestPage: (request) => this.requestPage(request),
      visibleKeys: () => this.visibleKeys(),
      topKey: () => this.topKey(),
      changed: () => {
        this.scheduleRows();
        this.scheduleStatus();
      },
    });
    store.subscribe(() => this.storeChanged());
    this.storeChanged();
  }

  // ---- Store → page -----------------------------------------------------------

  /** Called on every Store change: follow the shown conversation and status. */
  private storeChanged(): void {
    const state = this.store.state;
    if (state.connection.status === 'unpaired') {
      this.forgetPrivateState();
    }
    this.followConnection();

    let session: AgentSession | null = null;
    if (state.selected) {
      session = state.sessions.get(state.selected) ?? null;
    }
    let switched = false;
    if (session !== this.shownSession) {
      const previousId = this.shownSession ? this.shownSession.id : '';
      const id = session ? session.id : '';
      switched = id !== previousId;
      if (switched) {
        // Another conversation: the page replaces its rows.
        this.fullRows = true;
      }
      this.shownSession = session;
      this.resident.show(session);
      this.scheduleRows();
    }

    if (session) {
      this.noticeDraftChange(session.id);
    }
    if (switched && this.pageReady) {
      // The new conversation's rows and status go out together, so the page
      // never shows one conversation's title with another's transcript.
      this.cancelRowsTimer();
      this.publishRows();
      this.publishStatus();
      return;
    }
    this.scheduleStatus();
  }

  /** Track the connection and whether its first snapshot has arrived. */
  private followConnection(): void {
    const state = this.store.state;
    const connected = state.connection.status === 'online';
    if (connected && !this.connected) {
      // A new authenticated connection: its snapshot is still to come.
      this.engineAtConnect = state.engine;
      this.snapshotSeen = false;
    }
    this.connected = connected;
    if (connected && !this.snapshotSeen) {
      if (state.engine !== undefined && state.engine !== this.engineAtConnect) {
        this.snapshotSeen = true;
      }
    }
    const online = connected && this.snapshotSeen;
    if (online !== this.online) {
      this.online = online;
      this.resident.setOnline(online);
    }
  }

  /**
   * Signed out or revoked: nothing typed or refused for the previous pairing
   * may reach the next one. (The Store clears its drafts itself; the page's
   * own editor-only input is cleared by main.tsx.)
   */
  private forgetPrivateState(): void {
    this.knownDrafts.clear();
    this.cursors.clear();
    this.errors.clear();
    this.pendingChoices.clear();
    this.unresolved = null;
  }

  /** A draft that changed outside this page's edits advances its revision. */
  private noticeDraftChange(sessionId: string): void {
    const text = this.store.draft(sessionId);
    const known = this.knownDrafts.get(sessionId);
    if (known === undefined) {
      this.knownDrafts.set(sessionId, text);
      return;
    }
    if (known !== text) {
      this.knownDrafts.set(sessionId, text);
      this.draftRevisions.set(sessionId, this.draftRevision(sessionId) + 1);
      this.cursors.set(sessionId, text.length);
    }
  }

  private draftRevision(sessionId: string): number {
    return this.draftRevisions.get(sessionId) ?? 1;
  }

  /** The page's current text for a conversation becomes its draft. */
  private writeDraft(sessionId: string, text: string): void {
    // Known first: the Store notifies synchronously from setDraft.
    this.knownDrafts.set(sessionId, text);
    this.store.setDraft(sessionId, text);
  }

  private cancelRowsTimer(): void {
    if (this.rowsTimer !== undefined) {
      clearTimeout(this.rowsTimer);
      this.rowsTimer = undefined;
    }
  }

  private scheduleRows(): void {
    this.rowsDirty = true;
    if (this.rowsTimer !== undefined) {
      return;
    }
    this.rowsTimer = setTimeout(() => {
      this.rowsTimer = undefined;
      if (this.rowsDirty) {
        this.publishRows();
      }
      this.publishStatus();
    }, rowsIntervalMilliseconds);
  }

  private scheduleStatus(): void {
    if (this.statusQueued) {
      return;
    }
    this.statusQueued = true;
    setTimeout(() => {
      this.statusQueued = false;
      this.publishStatus();
    }, 0);
  }

  private publishRows(): void {
    if (!this.pageReady) {
      return;
    }
    const rows = this.resident.rows().map(pageRow);
    const diff = diffRows(this.sentRows, rows, this.fullRows);
    this.sentRows = diff.sent;
    this.sentOrder = diff.order;
    const sessionId = this.shownSession ? this.shownSession.id : '';
    this.post({
      type: 'rows',
      seq: 0,
      sessionId: sessionId,
      full: this.fullRows,
      order: diff.order,
      changed: diff.changed,
    });
    this.fullRows = false;
    this.rowsDirty = false;
  }

  private publishStatus(): void {
    if (!this.pageReady) {
      return;
    }
    const status = JSON.stringify(this.currentStatus());
    if (status === this.lastStatus) {
      return;
    }
    this.lastStatus = status;
    this.post({ type: 'status', seq: 0, status: JSON.parse(status) as ChatStatus });
  }

  /**
   * Number and send one message. An oversized one is dropped; its sequence
   * number is still used, so the page notices the gap and resynchronizes.
   */
  private post(message: HostMessage): void {
    this.sequence++;
    message.seq = this.sequence;
    const encoded = JSON.stringify(message);
    if (encoded.length > maximumMessageCharacters) {
      console.warn('Companion chat: dropped an oversized page update; the page resynchronizes');
      this.sentRows = {};
      this.fullRows = true;
      return;
    }
    this.deliver(() => {
      for (const listener of this.listeners) {
        listener(encoded);
      }
    });
  }

  private deliver(delivery: () => void): void {
    this.deliveries.push(delivery);
    if (this.draining) {
      return;
    }
    this.draining = true;
    queueMicrotask(() => {
      // Deliveries queued while draining run in this same pass, in order.
      while (this.deliveries.length > 0) {
        const next = this.deliveries.shift()!;
        next();
      }
      this.draining = false;
    });
  }

  private answer(callback: ((answer: string) => void) | undefined, value: Answer): void {
    if (!callback) {
      return;
    }
    const encoded = JSON.stringify(value);
    this.deliver(() => callback(encoded));
  }

  /** The page's status for the shown conversation (TrustedChatView.currentStatus). */
  private currentStatus(): ChatStatus {
    const session = this.shownSession;
    if (!session) {
      return { sessionId: '' };
    }
    const state = this.store.state;
    const id = session.id;
    const send = state.sends.get(id);
    const pendingSend = send !== undefined && send.pending;
    const draftText = this.store.draft(id);
    let cursor = this.cursors.get(id);
    if (cursor === undefined || cursor > draftText.length) {
      cursor = draftText.length;
    }
    let inputError = this.errors.get(id) ?? '';
    if (!inputError && send) {
      inputError = send.error;
    }
    let paused = false;
    if (state.engine) {
      paused = state.engine.paused;
    }

    return {
      sessionId: id,
      title: session.title || '',
      sessionStatus: session.status || '',
      sessionError: typeof session.error === 'string' ? session.error.slice(0, 2000) : '',
      // The draft is this page's own; nothing is ever "not saved" elsewhere.
      draftUnsaved: '',
      running: this.running(session),
      online: this.online,
      paused: paused,
      draft: {
        text: draftText,
        cursor: cursor,
        revision: this.draftRevision(id),
        source: '',
        notice: '',
      },
      maximumMessageLength: maximumMessageLength,
      editLimit: 2 * maximumMessageLength,
      // The same admission as send(): connected, nothing awaiting an answer.
      canSend: this.online && !pendingSend && !this.pendingChoices.has(id),
      pendingSend: pendingSend,
      pendingChoice: this.pendingChoices.has(id),
      inputError: inputError,
      // Recording into the text box is a desktop feature.
      recording: {
        available: false,
        here: false,
        state: '',
        canRecord: false,
        busy: false,
        stopPending: false,
        canStop: false,
      },
      choices: this.displayedChoices(id),
      stopRunId: this.stopRunId(id),
      // Speech never goes to a browser conversation.
      voiceTarget: false,
      voiceStatus: '',
      history: this.resident.status(),
      focusShortcut: '',
      application: null,
    };
  }

  private running(session: AgentSession): boolean {
    return session.status === 'starting' || session.status === 'running';
  }

  /** This conversation's choices, as the listener scoped them to this device. */
  private displayedChoices(sessionId: string): ChatChoice[] {
    const actions = this.store.state.actions;
    if (!actions || actions.sessionId !== sessionId) {
      return [];
    }
    const choices: ChatChoice[] = [];
    for (const choice of actions.choices) {
      choices.push({
        sessionId: choice.sessionId,
        revision: choice.revision,
        index: choice.index,
        label: choice.label || '',
        description: choice.description || '',
        available: choice.available === true,
        // Voice is the desktop's; a choice here is only ever clicked.
        voiceAvailable: false,
        voiceReason: choice.voiceReason || '',
      });
    }
    return choices;
  }

  private stopRunId(sessionId: string): string {
    const actions = this.store.state.actions;
    if (!actions || actions.sessionId !== sessionId) {
      return '';
    }
    return actions.stopRunId || '';
  }

  // ---- Transcript position (for history trimming) -------------------------------

  private visibleKeys(): Record<string, boolean> {
    const keys: Record<string, boolean> = {};
    for (const index of this.view.visibleIndexes()) {
      const key = this.sentOrder[index];
      if (key !== undefined) {
        keys[key] = true;
      }
    }
    return keys;
  }

  private topKey(): string {
    const index = this.view.topIndex();
    if (index < 0) {
      return '';
    }
    return this.sentOrder[index] ?? '';
  }

  private requestPage(request: PageRequest): Promise<HistoryPage> {
    return this.store.connection.request('agent-history-page', request) as Promise<HistoryPage>;
  }

  // ---- Page → gateway (NativeBridge) --------------------------------------------

  /** Whether `sessionId` is the conversation the page shows. */
  private sameSession(sessionId: unknown): boolean {
    return (
      this.shownSession !== null &&
      typeof sessionId === 'string' &&
      sessionId === this.shownSession.id
    );
  }

  private pendingSend(sessionId: string): boolean {
    const send = this.store.state.sends.get(sessionId);
    return send !== undefined && send.pending;
  }

  /** Remember a refusal or failure for the conversation's `inputError`. */
  private fail(sessionId: string, failure: unknown): void {
    let message = String(failure);
    if (failure instanceof Error) {
      message = failure.message;
    }
    this.errors.set(sessionId, message);
    this.scheduleStatus();
  }

  /**
   * Send one remote action for the shown conversation. A failure (including
   * an unknown outcome after a lost connection) is shown, never retried.
   */
  private act(
    sessionId: string,
    work: () => Promise<unknown>,
    settled: () => void = () => {},
  ): void {
    this.errors.delete(sessionId);
    this.scheduleStatus();
    work().then(
      () => {
        settled();
        this.scheduleStatus();
      },
      (failure: unknown) => {
        settled();
        this.fail(sessionId, failure);
      },
    );
  }

  ready(_documentId: string, callback?: () => void): void {
    // The page and this bridge share one document, so a resynchronization
    // never loses page-only input: the page asks again after a sequence gap.
    this.pageReady = true;
    this.sentRows = {};
    this.lastStatus = '';
    this.fullRows = true;
    this.rowsDirty = true;
    this.cancelRowsTimer();
    this.publishRows();
    this.publishStatus();
    if (callback) {
      this.deliver(callback);
    }
  }

  editDraft(
    sessionId: string,
    _base: number,
    text: string,
    cursor: number,
    callback?: (answer: string) => void,
  ): void {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      this.answer(callback, { accepted: false, reason: 'invalid' });
      return;
    }
    // The page cancels ordinary edits past twice the editing bound; only
    // text an input method still inserted gets here. It stays in the page's
    // editor, which keeps the conversation from closing meanwhile.
    if (text.length > 4 * maximumMessageLength) {
      if (!this.unresolved || this.unresolved.sessionId === sessionId) {
        this.unresolved = { sessionId: sessionId, length: text.length };
      }
      this.answer(callback, { accepted: false, reason: 'too-long', unresolved: true });
      return;
    }
    // An edit typed before a switch names its own conversation and goes there.
    if (!this.store.state.sessions.has(sessionId)) {
      this.answer(callback, { accepted: false });
      return;
    }
    this.writeDraft(sessionId, text);
    if (this.sameSession(sessionId)) {
      let position = text.length;
      if (typeof cursor === 'number' && Number.isInteger(cursor)) {
        position = Math.max(0, Math.min(cursor, text.length));
      }
      this.cursors.set(sessionId, position);
    }
    this.answer(callback, { accepted: true });
  }

  /**
   * `base` is the draft revision the page's text is based on. A send based on
   * an older revision is refused: the draft changed since, most likely
   * because this text was already sent and cleared (a second Enter before
   * the editor caught up), and sending it would send it twice.
   */
  send(sessionId: string, base: number, text: string, callback?: (answer: string) => void): void {
    const admitted =
      this.online &&
      this.sameSession(sessionId) &&
      !this.pendingSend(sessionId) &&
      !this.pendingChoices.has(sessionId);
    if (
      !admitted ||
      base !== this.draftRevision(sessionId) ||
      typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > maximumMessageLength
    ) {
      this.answer(callback, { accepted: false });
      return;
    }
    // Send exactly what the page shows: it becomes the draft, then is sent.
    if (text !== this.store.draft(sessionId)) {
      this.writeDraft(sessionId, text);
    }
    this.errors.delete(sessionId);
    // The Store admits one send per draft, marks it pending synchronously,
    // clears the draft only if it was not edited meanwhile, and keeps it with
    // an explanation when the outcome is unknown. It never resends.
    void this.store.sendDraft(sessionId);
    this.answer(callback, { accepted: this.pendingSend(sessionId) });
  }

  moveCursor(sessionId: string, base: number, cursor: number): void {
    if (!this.sameSession(sessionId) || base !== this.draftRevision(sessionId)) {
      return;
    }
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
      return;
    }
    if (cursor > this.store.draft(sessionId).length) {
      return;
    }
    this.cursors.set(sessionId, cursor);
  }

  choose(
    sessionId: string,
    revision: string,
    index: number,
    callback?: (answer: string) => void,
  ): void {
    if (
      !this.sameSession(sessionId) ||
      !this.online ||
      this.pendingChoices.has(sessionId) ||
      this.pendingSend(sessionId)
    ) {
      this.answer(callback, { accepted: false });
      return;
    }
    let offered = false;
    for (const choice of this.displayedChoices(sessionId)) {
      if (choice.revision === revision && choice.index === index && choice.available) {
        offered = true;
        break;
      }
    }
    if (!offered) {
      this.answer(callback, { accepted: false });
      return;
    }
    const pending = {};
    this.pendingChoices.set(sessionId, pending);
    this.act(
      sessionId,
      () =>
        this.store.request(
          'choose-agent',
          { id: sessionId, revision: revision, index: index },
          { quiet: true },
        ),
      () => {
        if (this.pendingChoices.get(sessionId) === pending) {
          this.pendingChoices.delete(sessionId);
        }
      },
    );
    this.answer(callback, { accepted: true });
  }

  stopRun(sessionId: string, runId: string, callback?: (answer: string) => void): void {
    if (
      !this.sameSession(sessionId) ||
      !this.online ||
      typeof runId !== 'string' ||
      runId === '' ||
      runId !== this.stopRunId(sessionId)
    ) {
      this.answer(callback, { accepted: false });
      return;
    }
    this.act(sessionId, () =>
      this.store.request('stop-agent-run', { id: sessionId, runId: runId }, { quiet: true }),
    );
    this.answer(callback, { accepted: true });
  }

  stop(sessionId: string, callback?: (answer: string) => void): void {
    const session = this.shownSession;
    if (
      !session ||
      !this.sameSession(sessionId) ||
      !this.online ||
      !this.running(session) ||
      this.stopRunId(sessionId) !== ''
    ) {
      this.answer(callback, { accepted: false });
      return;
    }
    this.act(sessionId, () => this.store.request('stop-agent', { id: sessionId }, { quiet: true }));
    this.answer(callback, { accepted: true });
  }

  closeSession(sessionId: string, callback?: (answer: string) => void): void {
    const held = this.unresolved !== null && this.unresolved.sessionId === sessionId;
    if (!this.sameSession(sessionId) || !this.online || held) {
      this.answer(callback, { accepted: false });
      return;
    }
    // The conversation leaves the list when the listener reports it closed.
    this.act(sessionId, () =>
      this.store.request('close-agent', { id: sessionId }, { quiet: true }),
    );
    this.answer(callback, { accepted: true });
  }

  inputUnresolved(sessionId: string, length: number): void {
    if (typeof sessionId !== 'string' || typeof length !== 'number') {
      return;
    }
    if (length > 0) {
      this.unresolved = { sessionId: sessionId, length: length };
    } else if (this.unresolved && this.unresolved.sessionId === sessionId) {
      this.unresolved = null;
    }
  }

  saveDraft(_sessionId: string, callback?: (answer: string) => void): void {
    // Never offered: `draftUnsaved` is always empty in the browser.
    this.answer(callback, { accepted: false });
  }

  discardUnsavedDraft(_sessionId: string, callback?: (answer: string) => void): void {
    this.answer(callback, { accepted: false });
  }

  toggleRecording(_sessionId: string, callback?: (answer: string) => void): void {
    // Never offered: `recording.available` is false.
    this.answer(callback, { accepted: false });
  }

  history(sessionId: string, request: 'older' | 'newer' | 'latest' | 'retry' | 'refresh'): void {
    if (!this.sameSession(sessionId)) {
      return;
    }
    if (request === 'latest') {
      // Local only: drop the resident pages and follow the live end.
      this.resident.latest();
    } else if (!this.online) {
      return;
    } else if (request === 'older') {
      this.resident.loadOlder();
    } else if (request === 'newer') {
      this.resident.loadNewer();
    } else if (request === 'retry') {
      this.resident.retry();
    } else if (request === 'refresh') {
      this.resident.refresh();
    } else {
      return;
    }
    this.scheduleRows();
    this.scheduleStatus();
  }

  following(sessionId: string, atEnd: boolean): void {
    if (!this.sameSession(sessionId)) {
      return;
    }
    this.resident.setFollowing(atEnd === true);
    this.scheduleRows();
    this.scheduleStatus();
  }

  /**
   * The reader scrolled the transcript themselves to within one viewport of
   * its end (reported by main.tsx, like SessionView's readerScrolled). Below
   * a detached snapshot the next newer page then loads before the reader
   * reaches the end, so the page keeps their place and the new rows simply
   * continue below. Not after a failure: only Retry repeats a request.
   */
  readerNearEnd(): void {
    if (!this.shownSession || !this.online) {
      return;
    }
    this.resident.continueNewer();
    this.scheduleRows();
    this.scheduleStatus();
  }

  composerFocus(_focused: boolean): void {
    // Only the desktop routes speech by composer focus.
  }

  copyText(text: string, callback?: (answer: string) => void): void {
    if (typeof text !== 'string' || text === '') {
      this.answer(callback, { accepted: false, length: 0, reason: 'Nothing to copy.' });
      return;
    }
    if (text.length > copyLimit) {
      this.answer(callback, {
        accepted: false,
        length: text.length,
        reason: 'At most ' + copyLimit + ' characters can be copied at once.',
      });
      return;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      this.answer(callback, {
        accepted: false,
        length: text.length,
        reason: 'This browser does not allow copying here.',
      });
      return;
    }
    clipboard.writeText(text).then(
      () => this.answer(callback, { accepted: true, length: text.length, reason: '' }),
      () =>
        this.answer(callback, {
          accepted: false,
          length: text.length,
          reason: 'The browser did not allow copying.',
        }),
    );
  }

  openLink(url: string): void {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 8192) {
      return;
    }
    // A new tab without opener or referrer; the page itself never navigates.
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  openScreenshot(_sessionId: string, _key: string): void {
    // Never offered: rows from the gateway carry no screenshot URL.
  }

  /** An agent heading opens its sender conversation when it is still open. */
  openOrigin(sessionId: string, key: string): void {
    if (!this.sameSession(sessionId)) {
      return;
    }
    for (const row of this.resident.rows()) {
      if (row.key !== key) {
        continue;
      }
      const origin = row.message.origin;
      if (origin && origin.kind === 'agent' && this.store.state.sessions.has(origin.sessionId)) {
        this.store.open(origin.sessionId);
      }
      return;
    }
  }

  classicView(): void {
    if (this.shownSession) {
      this.errors.set(this.shownSession.id, classicUnavailable);
      this.scheduleStatus();
    }
  }

  openApp(): void {
    if (this.shownSession) {
      this.errors.set(this.shownSession.id, applicationUnavailable);
      this.scheduleStatus();
    }
  }
}
