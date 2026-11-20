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
 *   `close-agent`, `agent-history-page` and `agent-tool-page`. Nothing else
 *   leaves the page; in particular never the unscoped `stop-agent` (see
 *   stop()). View screenshot is handed to the shell's viewer
 *   (`onScreenshot`), which fetches the image from the gateway.
 *
 * Differences from the Qt host (deliberate, see integrations/shell/README.md):
 * - The draft is kept in this page per conversation, as the phone panel does
 *   (its Store saves it in this browser's storage). There is no
 *   listener-owned or agent-proposed draft, so `draftUnsaved` is always
 *   empty and Save/Discard have nothing to do.
 * - Recording, voice target, focus shortcut, session applications, widgets
 *   and the classic view are not available. Recording and applications are
 *   hidden through `status`; the page's Classic view button and widget cards
 *   show a notice in `inputError` instead.
 * - Tool details open in place in the page (`ChatRow.tools`, an optional
 *   field the Qt host does not send), by the desktop classic view's rules
 *   (./tools/tool-details.ts).
 * - Stricter admission: a send must be based on the current draft revision
 *   (no second send of text already sent), and nothing is admitted after a
 *   reconnect until the listener's new snapshot arrived.
 *
 * Replies and messages reach the page asynchronously and in call order, as
 * QWebChannel delivers them.
 *
 * Message times (the one addition to the Qt host's rows): while the Display
 * setting Message timestamps is on, each row whose message has `createdAt`
 * carries `time`, its text for the reader (../times/message-time.ts). The
 * rows are sent again (only those whose text changed, by the usual diff)
 * when the switch changes, when the listener clock's offset changes and
 * when a new calendar day starts here ("14:02" becomes "Yesterday 14:02").
 * A publication made only for the times is not sent when no row's text
 * changed (the offset moves by milliseconds with every state message), so
 * the page is not drawn again for nothing. With the switch off, or without
 * `times`, rows carry no time.
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
  ToolDetailsAction,
} from '../../session-apps/chat/protocol.ts';
import { ResidentHistory, type PageRequest } from './history.ts';
import { pageRow, screenshotPath } from './rows.ts';
import type { ScreenshotRequest } from './screenshots/screenshot-viewer.ts';
import type { DisplaySettings } from './settings/display-settings.ts';
import type { ListenerClock } from './times/listener-clock.ts';
import { ToolDetails, type ToolPageAnswer, type ToolPageRequest } from './tools/tool-details.ts';
import {
  browserCalendar,
  messageTimeText,
  untilNextDay,
  type LocalCalendar,
} from './times/message-time.ts';

/** Longest message the gateway accepts for `send-agent` (src/remote/protocol.ts). */
export const maximumMessageLength = 4000;

/** Longest text one Copy hands to the clipboard (as in the Qt host). */
const copyLimit = 1_048_576;

/** How long rows wait to be coalesced while text streams (as in the Qt host). */
const rowsIntervalMilliseconds = 30;

/** Shown when the page asks for something only the desktop offers. */
const classicUnavailable = 'Widgets and the classic view are not available in the browser yet.';
const applicationUnavailable = 'Session applications are not available in the browser yet.';
/** Shown when the footer Stop is pressed: there is no run to name. */
const stopUnavailable =
  'Stop is not available for this turn: Companion has not named its run (it may already be ending).';

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

/**
 * What the bridge needs for message times: the Display settings (the
 * Message timestamps switch) and the listener's clock (its offset, and this
 * browser's now). `calendar` is this browser's time zone unless a test
 * gives another.
 */
export interface MessageTimes {
  settings: DisplaySettings;
  clock: ListenerClock;
  calendar?: LocalCalendar;
}

/**
 * The longest wait for the next calendar day, in milliseconds. The wait is
 * set for the next local midnight; checking at least every hour also
 * catches a clock or time zone that changed meanwhile.
 */
const longestDayWait = 60 * 60 * 1000;

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
  // Waits for the next calendar day while message times are shown.
  private dayTimer: ReturnType<typeof setTimeout> | undefined;
  // The rows waiting to be published were scheduled only because message
  // times may have changed (a new offset or day): an unchanged result is
  // then not sent.
  private onlyTimesChanged = false;
  // The reader's calendar date the published times were formatted on
  // ('' before the first), so any Store change noticed on another date
  // (a timeout that came late, a computer that slept) sends them again.
  private timesDate = '';

  // The shown conversation and its resident rows.
  private shownSession: AgentSession | null = null;
  private readonly resident: ResidentHistory;
  // The shown conversation's open tool groups (./tools/tool-details.ts).
  private readonly tools: ToolDetails;
  // Messages whose screenshot the gateway no longer has ("<lifetime> <message
  // ID>"), labelled unavailable from then on. Forgotten on sign-out.
  private readonly goneScreenshots = new Set<string>();
  // The shell's screenshot viewer, told when the page asks to view one.
  private readonly screenshotListeners = new Set<(request: ScreenshotRequest) => void>();

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

  // Per conversation: the last refusal or failure to show (`inputError`),
  // with the conversation lifetime (ID and tool epoch) it belongs to. A
  // conversation closed and reopened under the same ID is a new lifetime and
  // does not show the old one's notices. `turn` is set only for the footer
  // Stop's notice, which belongs to the turn it was pressed in (see stop()).
  private readonly errors = new Map<string, { lifetime: string; message: string; turn?: string }>();
  // Per conversation: the choice request awaiting its answer and the
  // lifetime it was made in, kept until it settles even when the page shows
  // another conversation meanwhile.
  private readonly pendingChoices = new Map<string, { lifetime: string }>();
  // Advances on sign-out or revocation. Answers to requests of an earlier
  // pairing are ignored, so they cannot bring back its notices.
  private pairing = 0;
  // Input only the page's editor holds (its length only), as in SessionView.
  private unresolved: { sessionId: string; length: number } | null = null;
  // The conversation list, told when `unresolved` names another conversation.
  private readonly heldInputListeners = new Set<() => void>();

  constructor(
    private readonly store: Store,
    private readonly view: TranscriptView,
    private readonly times?: MessageTimes,
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
      changed: (rowsChanged) => {
        if (rowsChanged) {
          // A page's rows were applied: they go out at once, before the
          // status that ends "loading" (the one exception to coalescing
          // rows). Otherwise the page could see the request settled while
          // it still shows the previous rows, and a scroll continuing
          // meanwhile (a key's smooth scrolling, a fling) would ask for the
          // page after the one it has not shown yet.
          this.cancelRowsTimer();
          this.onlyTimesChanged = false;
          this.publishRows();
        } else {
          this.scheduleRows();
        }
        this.scheduleStatus();
      },
    });
    this.tools = new ToolDetails({
      // The phone panel's own request for tool pages (its ToolGroup), quiet:
      // failures are shown in the group, not as toasts.
      requestPage: (request) => this.requestToolPage(request),
      changed: () => this.scheduleRows(),
    });
    store.subscribe(() => this.storeChanged());
    if (times) {
      // A switched setting or a new offset can change every row's time.
      // Only the Message timestamps switch changes the rows; the other two
      // Display switches change nothing here.
      let timestampsShown = times.settings.values.messageTimestamps;
      times.settings.subscribe(() => {
        const shown = times.settings.values.messageTimestamps;
        if (shown === timestampsShown) {
          return;
        }
        timestampsShown = shown;
        this.scheduleTimeRows();
        this.waitForNextDay();
      });
      // A new offset can mean this browser's clock was corrected: the times
      // and the moment the day changes are taken again.
      times.clock.subscribe(() => {
        if (times.settings.values.messageTimestamps) {
          this.scheduleTimeRows();
          this.waitForNextDay();
        }
      });
    }
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
    this.noticeNewDay();

    let session: AgentSession | null = null;
    if (state.selected) {
      session = state.sessions.get(state.selected) ?? null;
    }
    let switched = false;
    if (session !== this.shownSession) {
      // Another conversation, or the same ID in a new lifetime (closed and
      // reopened while this page was offline: a new tool epoch).
      switched = this.lifetime(session) !== this.lifetime(this.shownSession);
      if (switched) {
        // Another conversation: the page replaces its rows.
        this.fullRows = true;
      }
      this.shownSession = session;
      this.resident.show(session);
      this.tools.show(session);
      this.scheduleRows();
    }

    if (session) {
      this.noticeDraftChange(session.id);
    }
    this.expireStopNotices();
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

  /** A conversation's identity for the page: its ID and tool epoch. */
  private lifetime(session: AgentSession | null): string {
    if (!session) {
      return '';
    }
    return session.id + ' ' + (session.toolEpoch ?? '');
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
      this.tools.setOnline(online);
      // Open tool groups show the loss (or offer to load again).
      this.scheduleRows();
    }
  }

  /**
   * Signed out or revoked: nothing typed or refused for the previous pairing
   * may reach the next one. (The Store clears its drafts itself; the page's
   * own editor-only input is cleared by main.tsx.)
   */
  private forgetPrivateState(): void {
    this.pairing++;
    this.goneScreenshots.clear();
    this.knownDrafts.clear();
    this.cursors.clear();
    this.errors.clear();
    this.pendingChoices.clear();
    this.setUnresolved(null);
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

  /** Rows again because only message times may have changed. */
  private scheduleTimeRows(): void {
    if (!this.rowsDirty) {
      this.onlyTimesChanged = true;
    }
    this.scheduleRows(true);
  }

  private scheduleRows(onlyTimes = false): void {
    if (!onlyTimes) {
      this.onlyTimesChanged = false;
    }
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

  /**
   * While message times are shown, rows are sent again when a new calendar
   * day starts here. One timeout at a time; none while the switch is off.
   */
  private waitForNextDay(): void {
    if (this.dayTimer !== undefined) {
      clearTimeout(this.dayTimer);
      this.dayTimer = undefined;
    }
    const times = this.times;
    if (!times || !this.pageReady || !times.settings.values.messageTimestamps) {
      return;
    }
    const calendar = times.calendar ?? browserCalendar;
    const wait = Math.min(untilNextDay(times.clock.readerNow(), calendar), longestDayWait);
    this.dayTimer = setTimeout(() => {
      this.dayTimer = undefined;
      this.scheduleTimeRows();
      this.waitForNextDay();
    }, wait);
  }

  /** The reader's calendar date now, as a key ('' without message times). */
  private readerDate(): string {
    const times = this.times;
    if (!times) {
      return '';
    }
    const today = (times.calendar ?? browserCalendar)(times.clock.readerNow());
    return `${today.year}-${today.month}-${today.day}`;
  }

  /**
   * A Store change on another calendar date than the published times':
   * they are formatted again, and the wait for the next day taken again.
   */
  private noticeNewDay(): void {
    const times = this.times;
    if (!times || !this.pageReady || !times.settings.values.messageTimestamps) {
      return;
    }
    if (this.timesDate === '' || this.readerDate() === this.timesDate) {
      return;
    }
    this.scheduleTimeRows();
    this.waitForNextDay();
  }

  /** The time on a message's heading line, or '' for none (../times/message-time.ts). */
  private messageTime(createdAt: unknown): string {
    const times = this.times;
    if (!times || !times.settings.values.messageTimestamps) {
      return '';
    }
    return messageTimeText(
      createdAt,
      times.clock.offset,
      times.clock.readerNow(),
      times.calendar ?? browserCalendar,
    );
  }

  private publishRows(): void {
    if (!this.pageReady) {
      return;
    }
    this.timesDate = this.readerDate();
    const resident = this.resident.rows();
    // Open tool groups follow their rows (gone, or newer output).
    this.tools.sync(resident);
    const lifetime = this.lifetime(this.shownSession);
    const rows = resident.map((row) =>
      pageRow(row, {
        time: this.messageTime(row.message.createdAt),
        tools: this.tools.details(row),
        screenshotGone: this.goneScreenshots.has(lifetime + ' ' + row.message.id),
      }),
    );
    const diff = diffRows(this.sentRows, rows, this.fullRows);
    const onlyTimes = this.onlyTimesChanged;
    this.onlyTimesChanged = false;
    if (onlyTimes && !this.fullRows && diff.changed.length === 0) {
      // Only times could have changed, and none did (the order cannot
      // change without another reason to publish).
      this.rowsDirty = false;
      return;
    }
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
    // A failed or uncertain send comes first: it says whether the text in
    // the editor may already have been sent. Other notices follow it.
    const notices: string[] = [];
    if (send && send.error) {
      notices.push(send.error);
    }
    const notice = this.notice(id);
    if (notice) {
      notices.push(notice);
    }
    const inputError = notices.join(' ');
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
      canSend: this.online && !pendingSend && !this.choicePending(id),
      pendingSend: pendingSend,
      pendingChoice: this.choicePending(id),
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

  /**
   * The run a Stop for this conversation may name (`status.stopRunId`): the
   * run the conversation itself names while it runs, or '' when it names
   * none. The listener sets that ID when a turn starts and withdraws it as
   * soon as it starts ending the turn, and it stops a run only while that
   * run is current, so a Stop naming it can never reach another turn.
   */
  private stopRunId(sessionId: string): string {
    const session = this.store.state.sessions.get(sessionId);
    if (!session || !this.running(session)) {
      return '';
    }
    if (typeof session.runId !== 'string') {
      return '';
    }
    return session.runId;
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

  private requestToolPage(request: ToolPageRequest): Promise<ToolPageAnswer> {
    return this.store.request('agent-tool-page', request, {
      quiet: true,
    }) as Promise<ToolPageAnswer>;
  }

  /** The resident row of the shown conversation with `key`, or null. */
  private residentRow(key: unknown) {
    if (typeof key !== 'string') {
      return null;
    }
    for (const row of this.resident.rows()) {
      if (row.key === key) {
        return row;
      }
    }
    return null;
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

  /** The ID and tool epoch of an open conversation, or '' when it is not open. */
  private lifetimeOf(sessionId: string): string {
    return this.lifetime(this.store.state.sessions.get(sessionId) ?? null);
  }

  /** Show `message` as the conversation's notice, for its current lifetime. */
  private setNotice(sessionId: string, message: string): void {
    this.errors.set(sessionId, { lifetime: this.lifetimeOf(sessionId), message: message });
    this.scheduleStatus();
  }

  /**
   * The turn a footer Stop is pressed in: the conversation runs without
   * naming a run, after its latest completed turn. '' when it does not run
   * that way (no footer Stop is shown then).
   */
  private unnamedTurn(sessionId: string): string {
    const session = this.store.state.sessions.get(sessionId);
    if (!session || !this.running(session) || this.stopRunId(sessionId) !== '') {
      return '';
    }
    return 'after:' + (session.completedTurnId ?? '');
  }

  /**
   * The footer Stop's notice says Stop is not available for *this* turn. It
   * goes as soon as that turn is over: the conversation stops running, names
   * a run (a follow-up turn started) or completes the turn. Checked on every
   * Store change, so a short pause between two turns is not missed.
   */
  private expireStopNotices(): void {
    for (const [sessionId, entry] of this.errors) {
      if (entry.turn === undefined) {
        continue;
      }
      if (entry.turn !== this.unnamedTurn(sessionId)) {
        this.errors.delete(sessionId);
      }
    }
  }

  /** The conversation's notice, unless it belongs to an earlier lifetime. */
  private notice(sessionId: string): string {
    const entry = this.errors.get(sessionId);
    if (!entry || entry.lifetime !== this.lifetimeOf(sessionId)) {
      return '';
    }
    return entry.message;
  }

  /** Whether a choice of the conversation's current lifetime awaits its answer. */
  private choicePending(sessionId: string): boolean {
    const entry = this.pendingChoices.get(sessionId);
    return entry !== undefined && entry.lifetime === this.lifetimeOf(sessionId);
  }

  /** Remember a refusal or failure for the conversation's `inputError`. */
  private fail(sessionId: string, failure: unknown): void {
    let message = String(failure);
    if (failure instanceof Error) {
      message = failure.message;
    }
    this.setNotice(sessionId, message);
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
    const pairing = this.pairing;
    const lifetime = this.lifetimeOf(sessionId);
    work().then(
      () => {
        settled();
        this.scheduleStatus();
      },
      (failure: unknown) => {
        settled();
        // Signed out, or the conversation closed or reopened meanwhile: the
        // failure belongs to a pairing or lifetime that is no longer shown.
        if (pairing === this.pairing && lifetime === this.lifetimeOf(sessionId)) {
          this.fail(sessionId, failure);
        }
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
    this.waitForNextDay();
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
        this.setUnresolved({ sessionId: sessionId, length: text.length });
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
      !this.choicePending(sessionId);
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
      this.choicePending(sessionId) ||
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
    const pending = { lifetime: this.lifetimeOf(sessionId) };
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

  /**
   * The page's per-run Stop, rendered for `runId` (the `stopRunId` of the
   * status it showed). Sent as `stop-agent-run` naming that run, and only
   * while connected (after the new snapshot) and while that run is still the
   * conversation's run; otherwise nothing is sent (the page then shows the
   * Stop of the newer run, or none). See the Stop rule in the README.
   */
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

  /**
   * The page's footer Stop. The page offers it only while the conversation
   * runs without a run to name (`stopRunId` is empty), and the browser never
   * stops a conversation without naming the run (no `stop-agent`): an
   * unscoped Stop could reach a turn that started after the reader pressed
   * it. Nothing is sent; the notice says why Stop is unavailable.
   */
  stop(sessionId: string, callback?: (answer: string) => void): void {
    if (this.sameSession(sessionId)) {
      const turn = this.unnamedTurn(sessionId);
      // Only while the conversation runs without a run to name: otherwise
      // the page has shown a footer Stop for a turn that is already over.
      if (turn !== '') {
        this.errors.set(sessionId, {
          lifetime: this.lifetimeOf(sessionId),
          message: stopUnavailable,
          turn: turn,
        });
        this.scheduleStatus();
      }
    }
    this.answer(callback, { accepted: false });
  }

  /**
   * Requests are admitted now: connected, and this connection's snapshot
   * has arrived. The conversation list reads it for closing, reordering and
   * reopening, the same rule as the chat page's own actions.
   */
  get admitted(): boolean {
    return this.online;
  }

  /**
   * Whether the conversation list may close `sessionId` now: requests are
   * admitted and the chat editor holds no input of that conversation that
   * only it has (closing would leave that input without its conversation),
   * the same refusals as the chat page's Close session.
   */
  canClose(sessionId: string): boolean {
    const held = this.unresolved !== null && this.unresolved.sessionId === sessionId;
    return this.online && !held;
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
      this.setUnresolved({ sessionId: sessionId, length: length });
    } else if (this.unresolved && this.unresolved.sessionId === sessionId) {
      this.setUnresolved(null);
    }
  }

  /**
   * Record which conversation the editor holds input for, and tell the
   * conversation list: whether it may close that conversation depends on it
   * (`canClose`), and the phone Store does not change when it does.
   */
  private setUnresolved(unresolved: { sessionId: string; length: number } | null): void {
    const before = this.unresolved?.sessionId ?? null;
    this.unresolved = unresolved;
    if ((unresolved?.sessionId ?? null) === before) {
      return;
    }
    for (const listener of this.heldInputListeners) {
      listener();
    }
  }

  /**
   * Call `listener` whenever the conversation whose input only the editor
   * holds changes. Returns the function that stops it.
   */
  onHeldInputChange(listener: () => void): () => void {
    this.heldInputListeners.add(listener);
    return () => {
      this.heldInputListeners.delete(listener);
    };
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
      // Never after a failure, as for newer pages below.
      this.resident.continueOlder();
    } else if (request === 'newer') {
      // The page asks as the reader nears the end of a detached snapshot.
      // Never while a page is pending, and never after a failure: only the
      // reader's Retry repeats a failed request.
      this.resident.continueNewer();
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

  /**
   * The page's View screenshot: the shown conversation's row `key`, whose
   * screenshot the gateway kept (`screenshotPath`), opens in the shell's
   * viewer. The viewer reports a screenshot the gateway no longer has; the
   * row is then labelled unavailable, as one that was never kept.
   */
  openScreenshot(sessionId: string, key: string): void {
    if (!this.sameSession(sessionId)) {
      return;
    }
    const row = this.residentRow(key);
    if (!row) {
      return;
    }
    const lifetime = this.lifetime(this.shownSession);
    const gone = lifetime + ' ' + row.message.id;
    const path = screenshotPath(row.message);
    if (path === '' || this.goneScreenshots.has(gone)) {
      return;
    }
    // The gateway grants a connection its screenshots with the snapshot it
    // relays; a 404 is final only for a request made and answered while
    // requests are admitted (after that snapshot), in the same lifetime.
    const admittedWhenAsked = this.online;
    const pairing = this.pairing;
    const request: ScreenshotRequest = {
      path: path,
      title: this.shownSession?.title || 'Screenshot',
      gone: () => {
        if (!admittedWhenAsked || !this.online || this.pairing !== pairing) {
          return false;
        }
        if (this.lifetime(this.shownSession) === lifetime) {
          this.goneScreenshots.add(gone);
          this.scheduleRows();
        }
        return true;
      },
    };
    for (const listener of this.screenshotListeners) {
      listener(request);
    }
  }

  /**
   * Call `listener` when the page asks to view a screenshot. Returns the
   * function that stops it.
   */
  onScreenshot(listener: (request: ScreenshotRequest) => void): () => void {
    this.screenshotListeners.add(listener);
    return () => {
      this.screenshotListeners.delete(listener);
    };
  }

  /**
   * The reader's action on the in-place details of tool row `key` of the
   * shown conversation (open or close it, load a page). Closing works
   * offline too; loading needs requests to be admitted (ToolDetails).
   */
  toolDetails(sessionId: string, key: string, action: ToolDetailsAction): void {
    if (!this.sameSession(sessionId)) {
      return;
    }
    if (action !== 'toggle' && action !== 'reload' && action !== 'start' && action !== 'next') {
      return;
    }
    const row = this.residentRow(key);
    if (!row) {
      return;
    }
    // The group's revision and count as the rows have them now, not as
    // they were last sent to the page.
    this.tools.sync(this.resident.rows());
    if (this.tools.act(row, action)) {
      this.scheduleRows();
    }
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
      this.setNotice(this.shownSession.id, classicUnavailable);
    }
  }

  openApp(): void {
    if (this.shownSession) {
      this.setNotice(this.shownSession.id, applicationUnavailable);
    }
  }
}
