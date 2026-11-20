/**
 * Application state for the phone panel, derived from gateway events.
 *
 * It applies the same protocol rules as the desktop panel (see
 * src/desktop/README.md): snapshots carry complete conversations; incremental
 * `agent-session` events carry only changed messages, upserted by ID in arrival
 * order; `agent-order` is authoritative; Activity history is paged from the
 * current listener run and kept current by `activity-entry` events whose
 * revisions prevent stale pages from overwriting newer feedback.
 *
 * The store is framework-free. Components subscribe and re-render on change;
 * every change replaces the top-level state object so identity checks work.
 *
 * Unread marks: a conversation's marker is the listener's shared mark (its
 * `unread` field, src/desktop/README.md "Unread mark") whenever the latest
 * version of that conversation this page received carries the field, true
 * or false. A listener with the shared mark sends it with every conversation
 * in every snapshot and event. A conversation without it (an older
 * listener) is marked by this Store's own rule instead (`ownUnread`). The
 * Store tells the listener which conversation it shows and whether the
 * reader can see it (`panel-state` with `visible`, see `reportSelection`);
 * that is what clears the shared mark, on every device.
 */

import type {
  AgentMessage,
  AgentSession,
  ClaudeCodeModelCatalog,
  PreviousSession,
} from '../../../src/agents/types.ts';
import type {
  ActivityEntry,
  ActivityPage,
  EngineEvent,
  EngineState,
  ModelCatalog,
  RemoteAction,
  RemoteActionParameters,
  RemoteAgentActions,
} from '../../../src/remote/protocol.ts';
import { Connection, UncertainOutcome, type ConnectionState } from './connection.ts';
import { Navigation, type PhonePage } from './navigation.ts';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

export interface ActivityState {
  sessionId: string;
  /** Newest first after sorting by sequence. */
  entries: Map<string, ActivityEntry>;
  /** Deleted IDs, so late pages or events cannot resurrect them. */
  removed: Set<string>;
  /** Completion positions already read for this run. */
  read: number;
  syncing: boolean;
  error: string;
}

export interface AppState {
  connection: ConnectionState;
  engine?: Omit<EngineState, 'sessions' | 'previousSessions'>;
  sessions: Map<string, AgentSession>;
  order: string[];
  orderRevision: string;
  previous: PreviousSession[];
  actions?: RemoteAgentActions;
  activity: ActivityState;
  /**
   * Page shown, as in the desktop panel: a selected conversation, else the
   * Previous sessions library when `showingPrevious`, else Activity.
   */
  selected: string;
  showingPrevious: boolean;
  /**
   * Conversations marked unread: the listener's mark of each conversation
   * that carries one, else this Store's own rule (see the module comment).
   */
  unread: Set<string>;
  models?: ModelCatalog;
  modelsError: string;
  modelsLoading: boolean;
  claudeModels?: ClaudeCodeModelCatalog;
  claudeModelsError: string;
  claudeModelsLoading: boolean;
  sends: Map<string, { pending: boolean; error: string }>;
  toasts: Toast[];
}

function emptyActivity(sessionId = ''): ActivityState {
  return {
    sessionId,
    entries: new Map(),
    removed: new Set(),
    read: 0,
    syncing: false,
    error: '',
  };
}

const draftKey = 'companion.remote.drafts';

/**
 * How many times in a row a refused selection report is tried again, a
 * second apart (see `Store.reportRefused`).
 */
const reportRetryLimit = 5;

export interface StoreOptions {
  /**
   * Read Activity history pages (`activity-history`) for the current run.
   * On by default (the phone panel and the browser shell show Activity).
   * Off, the Store never requests them.
   */
  activity?: boolean;
  /**
   * After each reconnect, read the run's Activity history again from its
   * start instead of only what completed since. Entries deleted or labelled
   * elsewhere while this page was offline change only in those pages (their
   * events were missed). The position reached is kept after every page, so
   * a reading that fails part way (the gateway's rate limit on a long run)
   * continues there on Retry instead of starting over; a reading on its
   * way when a reconnect's snapshot arrives starts over. Off by default (the
   * phone panel reads only what is new, and keeps its position at the end
   * of a reading); the browser shell turns it on.
   */
  rereadActivityAfterReconnect?: boolean;
  /**
   * Whether the selected conversation is shown to the reader now, besides
   * the page being visible. Absent (the phone panel) it always is. The
   * browser shell's settings screen and, in a narrow window, its Activity
   * column cover the selected conversation. Meanwhile this page reports it
   * as not visible to the listener (so the listener's mark is neither
   * cleared nor kept from being set), a completed turn is announced as for a
   * conversation that is not selected, and the Store's own rule (an older
   * listener) marks it unread; selecting a conversation then (a started
   * one, underneath the settings screen) keeps its own mark until it is
   * shown. Call `selectionShownChanged` whenever the answer changes.
   */
  selectionShown?: () => boolean;
}

export class Store {
  private listeners = new Set<() => void>();
  private nextToast = 0;
  private drafts = new Map<string, string>();
  private readonly draftRevisions = new Map<string, number>();
  /** Invalidates async completions when the paired identity is forgotten. */
  private identityRevision = 0;
  /** Changes on phone navigation, including Back/Forward and modal dismissal. */
  private pageRevision = 0;
  /** Latest completed turn per conversation, for unread marking. */
  private readonly completedTurns = new Map<string, string>();
  /** Conversations seen in any snapshot or event; new arrivals are marked unread. */
  private readonly seen = new Set<string>();
  /**
   * The Store's own unread rule, used only for conversations that carry no
   * listener mark (an older listener): conversations whose turn completed
   * while they were not being viewed. See the module comment.
   */
  private ownUnread = new Set<string>();
  /**
   * The selection report this connection last sent (`panel-state`), or
   * undefined when none was sent on it yet or the listener dropped it.
   * A report equal to it is not sent again.
   */
  private lastReport?: { id: string; visible: boolean };
  /** A deferred check for a selection that became visible (see `visibilityChanged`). */
  private visibleCheck?: ReturnType<typeof setTimeout>;
  /** A cover lifted since the last deferred check (see `selectionShownChanged`). */
  private coverLifted = false;
  /** A later attempt after a report the gateway refused (see `reportSelection`). */
  private reportRetry?: ReturnType<typeof setTimeout>;
  /** Refused reports in a row; the Store tries again at most `reportRetryLimit` times. */
  private refusedReports = 0;
  /**
   * The gateway of this connection refused `visible` as an unknown field (a
   * gateway from before the shared unread mark): reports carry the
   * selection only, as before, until the next connection.
   */
  private legacyReports = false;
  private receivedSnapshot = false;
  /** Set just before this phone asks to reopen a conversation. */
  revealNextRestore = '';
  readonly connection: Connection;
  readonly navigation: Navigation;

  state: AppState = {
    connection: { status: 'unpaired', message: '', retryAt: 0, deviceName: '' },
    sessions: new Map(),
    order: [],
    orderRevision: '',
    previous: [],
    activity: emptyActivity(),
    selected: '',
    showingPrevious: false,
    unread: new Set(),
    modelsError: '',
    modelsLoading: false,
    claudeModelsError: '',
    claudeModelsLoading: false,
    sends: new Map(),
    toasts: [],
  };

  /** Whether this store reads Activity history (see StoreOptions). */
  private readonly readsActivity: boolean;
  /** Whether a reconnect reads the run's history again from its start (see StoreOptions). */
  private readonly rereadsActivity: boolean;
  /** Whether the selected conversation is shown besides page visibility (see StoreOptions). */
  private readonly selectionShown: () => boolean;
  /**
   * Changes when a reconnect asks for the run's history to be read again
   * from the start; a reading begun before that is abandoned (only with
   * `rereadActivityAfterReconnect`).
   */
  private activityReadGeneration = 0;

  constructor(options: StoreOptions = {}) {
    this.readsActivity = options.activity !== false;
    this.rereadsActivity = options.rereadActivityAfterReconnect === true;
    this.selectionShown = options.selectionShown ?? (() => true);
    this.connection = new Connection(
      (event) => this.apply(event),
      (connection) => this.connectionChanged(connection),
      () => this.online(),
    );
    this.navigation = new Navigation(
      (page) => this.applyPage(page),
      // A modal over the page (phone sheets, menus, the screenshot viewer)
      // covers the selected conversation.
      () => this.visibilityChanged(),
    );
    this.state = { ...this.state, connection: this.connection.state };
    // The page's visibility is half of what this page reports as visible.
    document.addEventListener('visibilitychange', () => this.visibilityChanged());
    if (this.connection.paired) {
      this.loadDrafts();
    } else {
      this.clearPrivateState();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(change: Partial<AppState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }

  start(): void {
    this.connection.start();
  }

  // ---- Requests -------------------------------------------------------------

  /**
   * Send a request; show failures as a toast unless the caller handles them.
   * Quiet callers own their error display. No request is automatically retried.
   */
  async request<Action extends RemoteAction>(
    action: Action,
    parameters: RemoteActionParameters[Action],
    options: { quiet?: boolean } = {},
  ): Promise<unknown> {
    const identity = this.identityRevision;
    try {
      return await this.connection.request(action, parameters);
    } catch (error) {
      if (!options.quiet && identity === this.identityRevision) {
        this.toast(error instanceof Error ? error.message : String(error), 'error');
      }
      throw error;
    }
  }

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    const id = ++this.nextToast;
    this.update({ toasts: [...this.state.toasts.slice(-2), { id, text, tone }] });
    setTimeout(() => this.dismissToast(id), tone === 'error' ? 6000 : 3500);
  }

  dismissToast(id: number): void {
    this.update({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  }

  // ---- Navigation -----------------------------------------------------------

  /** Show a conversation (or Activity for an empty ID); marks it read. */
  open(id: string): void {
    this.navigation.navigate({ selected: id, showingPrevious: false });
  }

  private applyPage(page: PhonePage): void {
    this.pageRevision += 1;
    const id = this.state.sessions.has(page.selected) ? page.selected : '';
    const ownUnread = new Set(this.ownUnread);
    // Selecting shows the conversation, which clears its own mark; unless it
    // is selected where the reader does not see it (see `selectionShown`).
    // The listener's mark is cleared by the listener when this page reports
    // the selection as visible.
    if (this.selectionShown()) {
      ownUnread.delete(id);
    }
    this.ownUnread = ownUnread;
    this.update({
      selected: id,
      showingPrevious: this.connection.paired && page.showingPrevious,
      actions: id === this.state.selected ? this.state.actions : undefined,
      unread: this.unreadMarks(this.state.sessions),
    });
    this.reportSelection();
  }

  showActivity(): void {
    this.open('');
  }

  showPrevious(): void {
    this.navigation.navigate({ selected: '', showingPrevious: true });
  }

  /**
   * Tell the listener which conversation this page shows, and whether the
   * reader can see it (`visible`). The selection scopes this page's
   * choice/stop/tool-page controls (the desktop selection is untouched);
   * `visible` decides the shared unread mark: while it is true the
   * conversation counts as read on every device.
   *
   * `visible` is true only while the page is visible
   * (`document.visibilityState`), a conversation is selected and it is shown
   * to the reader (`selectionShown`: not covered in the browser shell). The
   * report is sent after this connection's first snapshot and then whenever
   * the selection or `visible` changes, never twice the same on one
   * connection.
   */
  private reportSelection(): void {
    if (this.state.connection.status !== 'online' || !this.receivedSnapshot) {
      return;
    }

    const id = this.state.sessions.has(this.state.selected) ? this.state.selected : '';
    const visible = id !== '' && this.selectionVisible();
    const last = this.lastReport;
    if (last && last.id === id && (last.visible === visible || this.legacyReports)) {
      return;
    }

    const report = { id, visible };
    this.lastReport = report;
    let parameters: { id: string; visible?: boolean } = report;
    if (this.legacyReports) {
      parameters = { id };
    }
    void this.request('panel-state', parameters, { quiet: true }).then(
      () => {
        this.refusedReports = 0;
      },
      (error: unknown) => {
        if (this.lastReport !== report) {
          // A newer report was sent meanwhile; it says what is true now.
          return;
        }
        this.lastReport = undefined;
        this.reportRefused(error);
      },
    );
  }

  /**
   * A report was not delivered. Over a lost connection nothing more is
   * needed: the listener withdraws the connection's visibility itself, and
   * the next connection reports after its snapshot. Refused by a gateway
   * that does not know `visible` (older than the shared unread mark), the
   * selection is reported again without it, as before. Any other refusal
   * (the gateway's request rate, or a conversation closed meanwhile) is
   * tried again a second later with what is true then, so a page that has
   * become hidden is never left counted as visible; one attempt waits at a
   * time. After `reportRetryLimit` refusals in a row it stops trying again
   * by itself until a report is accepted or the page reconnects; changes
   * are still reported. (A report the gateway always refuses must not be
   * sent every second for as long as the page is open.)
   */
  private reportRefused(error: unknown): void {
    if (this.state.connection.status !== 'online') {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unknown field: visible' && !this.legacyReports) {
      this.legacyReports = true;
      this.reportSelection();
      return;
    }
    if (this.reportRetry !== undefined) {
      return;
    }
    this.refusedReports += 1;
    if (this.refusedReports > reportRetryLimit) {
      return;
    }
    this.reportRetry = setTimeout(() => {
      this.reportRetry = undefined;
      this.reportSelection();
    }, 1000);
  }

  /**
   * The page's visibility or `selectionShown` may have changed; report the
   * selection again if what the reader sees changed.
   *
   * Becoming hidden is reported at once, so a turn that completes right
   * after is not counted as seen. Becoming visible is checked once the
   * current event has finished (a zero-delay timer): a change that hides a
   * cover often arrives together with a change of selection (browser Back
   * from the browser shell's settings screen goes to another conversation),
   * and the conversation that was only underneath the cover must not be
   * reported as seen in between. Several changes in a row are checked once.
   */
  private visibilityChanged(): void {
    const id = this.state.sessions.has(this.state.selected) ? this.state.selected : '';
    const visible = id !== '' && this.selectionVisible();
    if (!visible) {
      this.reportSelection();
      return;
    }
    if (this.visibleCheck !== undefined) {
      return;
    }
    this.visibleCheck = setTimeout(() => {
      this.visibleCheck = undefined;
      this.reportSelection();
      if (this.coverLifted) {
        this.coverLifted = false;
        this.clearOwnMarkOfShown();
      }
    }, 0);
  }

  /**
   * The answer of `selectionShown` may have changed (the browser shell's
   * settings screen or narrow Activity column came or went). Reports the
   * selection again when needed; calling it without a change sends nothing.
   * A cover that lifts shows the selected conversation, which then counts
   * as chosen for the Store's own rule too (an older listener): its own mark
   * is cleared, after the current event, as the report is sent.
   */
  selectionShownChanged(): void {
    if (this.selectionVisible()) {
      this.coverLifted = true;
    }
    this.visibilityChanged();
  }

  /**
   * The Store's own rule (an older listener): the selected conversation is
   * shown to the reader now, so its own mark goes, as when it is selected.
   */
  private clearOwnMarkOfShown(): void {
    const id = this.state.selected;
    if (!id || !this.ownUnread.has(id) || !this.selectionVisible()) {
      return;
    }
    const ownUnread = new Set(this.ownUnread);
    ownUnread.delete(id);
    this.ownUnread = ownUnread;
    this.update({ unread: this.unreadMarks(this.state.sessions) });
  }

  private online(): void {
    // Wait for this connection's authoritative snapshot before reporting a
    // selection: the old conversation may have been closed while offline.
    // Nothing was reported on this connection yet.
    this.receivedSnapshot = false;
    this.lastReport = undefined;
    this.legacyReports = false;
    this.refusedReports = 0;
  }

  private connectionChanged(connection: ConnectionState): void {
    if (connection.status === 'unpaired') {
      this.clearPrivateState();
    }
    if (connection.status === 'limited') {
      // The limit page lies over everything and takes the input: no sheet
      // or menu (none holds typed text) may stay open under it.
      this.navigation.closeModals();
    }
    this.update({ connection });
  }

  private clearPrivateState(): void {
    this.identityRevision += 1;
    this.drafts.clear();
    this.draftRevisions.clear();
    this.completedTurns.clear();
    this.seen.clear();
    this.ownUnread = new Set();
    this.lastReport = undefined;
    this.legacyReports = false;
    this.refusedReports = 0;
    this.receivedSnapshot = false;
    this.revealNextRestore = '';
    this.navigation.reset();
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // In-memory content is still cleared when browser storage is unavailable.
    }
    this.update({
      engine: undefined,
      sessions: new Map(),
      order: [],
      orderRevision: '',
      previous: [],
      actions: undefined,
      activity: emptyActivity(),
      selected: '',
      showingPrevious: false,
      unread: new Set(),
      models: undefined,
      modelsError: '',
      modelsLoading: false,
      claudeModels: undefined,
      claudeModelsError: '',
      claudeModelsLoading: false,
      sends: new Map(),
      toasts: [],
    });
  }

  // ---- Drafts (per conversation, kept on this phone only) ------------------

  draft(id: string): string {
    return this.drafts.get(id) ?? '';
  }

  setDraft(id: string, text: string): void {
    this.draftRevisions.set(id, (this.draftRevisions.get(id) ?? 0) + 1);
    if (text) {
      this.drafts.set(id, text);
    } else {
      this.drafts.delete(id);
    }
    this.saveDrafts();
    this.update({});
  }

  /**
   * One admitted send per draft, even when its component unmounts/remounts.
   * For the new-conversation draft (`new`) it resolves to the started
   * conversation's ID when the listener names one, otherwise to undefined.
   *
   * The phone shows a conversation started from its Activity page itself
   * (`openStarted`, on by default). The browser shell turns that off and
   * selects the result by its own rule.
   */
  async sendDraft(
    id: string,
    profile: 'coding' | 'quickQuestion' = 'coding',
    options: { openStarted?: boolean } = {},
  ): Promise<string | undefined> {
    const text = this.draft(id);
    if (!text.trim() || this.state.sends.get(id)?.pending) {
      return undefined;
    }
    const revision = this.draftRevisions.get(id) ?? 0;
    const pageRevision = this.pageRevision;
    const identity = this.identityRevision;
    const sending = { pending: true, error: '' };
    this.update({ sends: new Map(this.state.sends).set(id, sending) });
    try {
      const result =
        id === 'new'
          ? await this.request('start-agent', { text, profile }, { quiet: true })
          : await this.request('send-agent', { id, text }, { quiet: true });
      if (identity !== this.identityRevision || this.state.sends.get(id) !== sending) {
        return undefined;
      }
      const unchangedDraft = (this.draftRevisions.get(id) ?? 0) === revision;
      if (unchangedDraft) {
        this.setDraft(id, '');
      }
      const sends = new Map(this.state.sends);
      sends.delete(id);
      this.update({ sends });
      // A delayed result must not take the user away from another page or
      // dismiss the keyboard while they compose a newer question.
      if (
        id === 'new' &&
        options.openStarted !== false &&
        unchangedDraft &&
        pageRevision === this.pageRevision &&
        !this.state.selected &&
        !this.state.showingPrevious
      ) {
        this.open((result as { id: string }).id);
      }
      if (id !== 'new') {
        return undefined;
      }
      return startedId(result);
    } catch (error) {
      if (identity !== this.identityRevision || this.state.sends.get(id) !== sending) {
        return undefined;
      }
      const explanation = error instanceof Error ? error.message : String(error);
      const message =
        error instanceof UncertainOutcome
          ? `${explanation} The draft remains here; check the conversation before sending it again.`
          : `${explanation} The draft remains here.`;
      this.update({ sends: new Map(this.state.sends).set(id, { pending: false, error: message }) });
      return undefined;
    }
  }

  /** Only open conversations and the new-conversation composer retain drafts. */
  private pruneDrafts(active: Set<string>): void {
    for (const id of this.drafts.keys()) {
      if (id !== 'new' && !active.has(id)) {
        this.drafts.delete(id);
        this.draftRevisions.delete(id);
      }
    }
    this.saveDrafts();
    this.update({
      sends: new Map([...this.state.sends].filter(([id]) => id === 'new' || active.has(id))),
    });
  }

  private loadDrafts(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || '{}') as Record<string, string>;
      for (const [id, text] of Object.entries(saved)) {
        if (typeof text === 'string') {
          this.drafts.set(id, text);
        }
      }
    } catch {
      // Drafts are a convenience; start empty if storage is unavailable.
    }
  }

  private saveDrafts(): void {
    try {
      localStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(this.drafts)));
    } catch {
      // Ignore: the draft stays in memory for this page.
    }
  }

  // ---- Models ---------------------------------------------------------------

  async loadModels(): Promise<void> {
    const identity = this.identityRevision;
    this.update({ modelsLoading: true, modelsError: '' });
    try {
      const models = (await this.request('agent-models', {}, { quiet: true })) as ModelCatalog;
      if (identity !== this.identityRevision) {
        return;
      }
      this.update({ models, modelsLoading: false });
    } catch (error) {
      if (identity !== this.identityRevision) {
        return;
      }
      this.update({
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async loadClaudeModels(): Promise<void> {
    const identity = this.identityRevision;
    this.update({ claudeModelsLoading: true, claudeModelsError: '' });
    try {
      const claudeModels = (await this.request(
        'claude-models',
        {},
        { quiet: true },
      )) as ClaudeCodeModelCatalog;
      if (identity === this.identityRevision) {
        this.update({ claudeModels, claudeModelsLoading: false });
      }
    } catch (error) {
      if (identity === this.identityRevision) {
        this.update({
          claudeModelsLoading: false,
          claudeModelsError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ---- Engine events --------------------------------------------------------

  private apply(event: EngineEvent): void {
    switch (event.type) {
      case 'state':
        this.applyState(event);
        return;
      case 'agent-session':
        this.upsertSession(event.session, false);
        return;
      case 'agent-restored':
        // Only reopen requests from this phone reveal the tab here; the
        // desktop's reveal flag describes the desktop panel.
        this.upsertSession(event.session, true, this.revealNextRestore === event.session.id);
        if (this.revealNextRestore === event.session.id) {
          this.revealNextRestore = '';
        }
        return;
      case 'agent-removed':
        this.removeSession(event.id);
        return;
      case 'agent-order':
        this.update({ order: event.ids, orderRevision: event.revision });
        return;
      case 'agent-history':
        this.update({ previous: event.sessions });
        return;
      case 'agent-turn-completed':
        this.turnCompleted(event.id);
        return;
      case 'remote-agent-actions':
        this.update({ actions: event.actions });
        return;
      case 'activity-entry':
        this.activityEntry(event.sessionId, event.entry);
        return;
      case 'history-deleted':
        this.historyDeleted(event.id, event.sessionId);
        return;
    }
  }

  private applyState(event: EngineState & { type: 'state' }): void {
    const { type: _type, sessions, previousSessions, ...engine } = event;

    // After hydration the gateway can send only engine metadata. Conversations,
    // order and Previous then belong to the ordered agent events. Absence means
    // unchanged, not an empty library; never prune drafts on a partial state.
    if (sessions === undefined) {
      if (!this.receivedSnapshot) {
        return;
      }
      const activity =
        this.state.activity.sessionId === engine.activitySessionId
          ? this.state.activity
          : emptyActivity(engine.activitySessionId);
      this.update({ engine: { ...this.state.engine, ...engine }, activity });
      void this.syncActivity();
      return;
    }

    const map = new Map<string, AgentSession>();
    for (const session of sessions) {
      map.set(session.id, session);
    }

    // A reported conversation that is no longer open was dropped by the
    // listener with its close: shown again after a reopen, it is reported
    // again (as in removeSession).
    if (this.lastReport && this.lastReport.id !== '' && !map.has(this.lastReport.id)) {
      this.lastReport = undefined;
    }

    let selected = this.state.selected;
    let selectionDropped = false;
    if (selected && !map.has(selected)) {
      selectionDropped = true;
      this.toast(
        'The selected conversation was closed while disconnected. It is in Previous sessions.',
      );
      selected = '';
    }

    // Reconnect snapshots can reveal conversations started meanwhile; like the
    // desktop they are only added to the rail, never selected, on a snapshot.
    for (const session of sessions) {
      this.seen.add(session.id);
    }
    const firstSnapshot = !this.receivedSnapshot;
    this.receivedSnapshot = true;
    this.ownUnread = this.observeCompletions(sessions, selected);

    // A new listener run starts a new Activity history.
    let activity = this.state.activity;
    if (activity.sessionId !== engine.activitySessionId) {
      activity = emptyActivity(engine.activitySessionId);
    } else if (firstSnapshot && this.rereadsActivity) {
      // This connection's first snapshot of the same run: read every page
      // again, so deletions (removal markers) and newer revisions made while
      // offline replace what is shown. Entries stay shown meanwhile. A
      // reading still on its way (a Retry pressed before this snapshot) is
      // abandoned and starts over (see syncActivity).
      this.activityReadGeneration += 1;
      activity = { ...activity, read: 0 };
    }

    this.update({
      engine,
      sessions: map,
      order: sessions.map((session) => session.id),
      orderRevision: engine.sessionOrderRevision ?? '',
      previous: previousSessions ?? [],
      selected,
      activity,
      unread: this.unreadMarks(map),
      actions: firstSnapshot ? undefined : this.state.actions,
    });

    this.pruneDrafts(new Set(map.keys()));
    // The first snapshot of a connection reports the selection; a later one
    // that closed the selected conversation reports that nothing is shown.
    if (firstSnapshot || selectionDropped) {
      this.reportSelection();
    }

    void this.syncActivity();
  }

  private upsertSession(update: AgentSession, complete: boolean, revealRestored = false): void {
    const sessions = new Map(this.state.sessions);
    const existing = sessions.get(update.id);

    let session: AgentSession;
    if (!existing || complete) {
      session = update;
    } else {
      // Incremental: only changed messages are included. Upsert by ID in
      // arrival order; never replace the whole conversation.
      const messages = existing.messages.slice();
      const positions = new Map(messages.map((message, index) => [message.id, index]));
      for (const message of update.messages) {
        const index = positions.get(message.id);
        if (index === undefined) {
          positions.set(message.id, messages.length);
          messages.push(message);
        } else {
          messages[index] = message;
        }
      }
      const retained = update.history
        ? update.history.ids.flatMap((id) => {
            const index = positions.get(id);
            return index === undefined ? [] : [messages[index]];
          })
        : messages;
      session = { ...update, messages: retained };
    }

    sessions.set(update.id, session);
    const order = this.state.order.includes(update.id)
      ? this.state.order
      : [...this.state.order, update.id];

    // Desktop arrivals never navigate this phone. Only a restore requested
    // here may reveal a session; phone-start replies are handled by sendDraft.
    const newlySeen = !this.seen.has(update.id);
    this.seen.add(update.id);
    const reveal = this.receivedSnapshot && complete && revealRestored;

    let ownUnread = this.observeCompletions([session], reveal ? update.id : this.state.selected);
    if (newlySeen && !reveal && update.id !== this.state.selected) {
      ownUnread = new Set(ownUnread).add(update.id);
    }
    this.ownUnread = ownUnread;
    this.update({ sessions, order, unread: this.unreadMarks(sessions) });

    if (reveal) {
      this.open(update.id);
    }
  }

  /**
   * The Store's own rule (`ownUnread`): mark conversations unread when a new
   * turn completed out of view. Returns the new set; the caller stores it.
   */
  private observeCompletions(sessions: AgentSession[], viewed: string): Set<string> {
    let unread = this.ownUnread;
    for (const session of sessions) {
      const turn = session.completedTurnId;
      if (!turn || this.completedTurns.get(session.id) === turn) {
        continue;
      }
      this.completedTurns.set(session.id, turn);
      if (session.id !== viewed || !this.selectionVisible()) {
        unread = new Set(unread);
        unread.add(session.id);
      }
    }
    return unread;
  }

  private removeSession(id: string): void {
    const sessions = new Map(this.state.sessions);
    const removed = sessions.get(id);
    sessions.delete(id);

    const change: Partial<AppState> = {
      sessions,
      order: this.state.order.filter((candidate) => candidate !== id),
    };
    const ownUnread = new Set(this.ownUnread);
    ownUnread.delete(id);
    this.ownUnread = ownUnread;
    change.unread = this.unreadMarks(sessions);
    this.completedTurns.delete(id);
    // Closing drops every report of the conversation at the listener: shown
    // again after a reopen, it has to be reported again.
    if (this.lastReport?.id === id) {
      this.lastReport = undefined;
    }
    if (this.state.selected === id) {
      change.selected = '';
      change.actions = undefined;
      this.toast(`“${removed?.title ?? 'Conversation'}” was closed. It is in Previous sessions.`);
    }
    this.update(change);
    this.pruneDrafts(new Set(sessions.keys()));
    // The selection went with it: the listener learns that this page shows
    // nothing now. (It dropped its reports of the closed conversation, but
    // an earlier report of another conversation, whose replacement it may
    // have refused, would otherwise stay counted as shown.)
    if (change.selected === '') {
      this.reportSelection();
    }
  }

  /**
   * The unread markers of the open conversations: the listener's mark of
   * each conversation that carries one (`unread`, true or false), else the
   * Store's own rule (`ownUnread`). See the module comment.
   */
  private unreadMarks(sessions: Map<string, AgentSession>): Set<string> {
    const marks = new Set<string>();
    for (const [id, session] of sessions) {
      let marked = this.ownUnread.has(id);
      if (typeof session.unread === 'boolean') {
        marked = session.unread;
      }
      if (marked) {
        marks.add(id);
      }
    }

    // Unchanged marks keep the current set, so whoever compares it by
    // identity sees no change (as before the listener's mark).
    const current = this.state.unread;
    if (marks.size === current.size && [...marks].every((id) => current.has(id))) {
      return current;
    }
    return marks;
  }

  /**
   * Whether the reader sees the selected conversation now: the page is
   * visible, shows it (`selectionShown`) and no modal (a phone sheet, menu
   * or the screenshot viewer) lies over it.
   */
  private selectionVisible(): boolean {
    if (document.visibilityState !== 'visible') {
      return false;
    }
    if (this.navigation.modalOpen) {
      return false;
    }
    return this.selectionShown();
  }

  private turnCompleted(id: string): void {
    if (id === this.state.selected && this.selectionVisible()) {
      return;
    }
    const title = this.state.sessions.get(id)?.title ?? 'A conversation';
    this.toast(`${title} — answer ready`, 'success');
  }

  // ---- Activity history -----------------------------------------------------

  /** Read new completion positions for the current run, 50 per page. */
  private async syncActivity(): Promise<void> {
    if (!this.readsActivity) {
      return;
    }
    const engine = this.state.engine;
    const activity = this.state.activity;
    if (
      !engine ||
      activity.syncing ||
      this.state.connection.status !== 'online' ||
      activity.read >= engine.activityHistoryCount
    ) {
      return;
    }

    const sessionId = activity.sessionId;
    const identity = this.identityRevision;
    const generation = this.activityReadGeneration;
    const through = engine.activityHistoryCount;
    this.setActivity({ syncing: true, error: '' });

    /**
     * A reconnect asked for the run to be read again while this reading was
     * on its way: its pages and position may predate what changed offline,
     * so it is dropped and a new reading starts from the reset position.
     */
    const restartIfReset = (): boolean => {
      if (generation === this.activityReadGeneration) {
        return false;
      }
      this.setActivity({ syncing: false });
      void this.syncActivity();
      return true;
    };

    try {
      let after: number | null = activity.read;
      while (after !== null) {
        const page = (await this.request(
          'activity-history',
          { sessionId, after, through },
          { quiet: true },
        )) as ActivityPage;

        if (identity !== this.identityRevision || this.state.activity.sessionId !== sessionId) {
          return;
        }
        if (restartIfReset()) {
          return;
        }
        this.applyActivityPage(page);
        after = page.next;
        if (this.rereadsActivity && after !== null) {
          // Keep the position reached, so a failure later in this reading
          // continues from here (see StoreOptions).
          this.setActivity({ read: after });
        }
      }
      this.setActivity({ read: through, syncing: false });
    } catch (error) {
      if (identity !== this.identityRevision || this.state.activity.sessionId !== sessionId) {
        return;
      }
      if (restartIfReset()) {
        return;
      }
      this.setActivity({
        syncing: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // More may have finished while this sync ran.
    if ((this.state.engine?.activityHistoryCount ?? 0) > this.state.activity.read) {
      void this.syncActivity();
    }
  }

  retryActivity(): void {
    void this.syncActivity();
  }

  private applyActivityPage(page: ActivityPage): void {
    const entries = new Map(this.state.activity.entries);
    const removed = new Set(this.state.activity.removed);

    for (const marker of page.removed) {
      removed.add(marker.id);
      entries.delete(marker.id);
    }
    for (const entry of page.entries) {
      const current = entries.get(entry.id);
      if (!removed.has(entry.id) && (!current || current.revision <= entry.revision)) {
        entries.set(entry.id, entry);
      }
    }
    this.setActivity({ entries, removed });
  }

  private activityEntry(sessionId: string, entry: ActivityEntry): void {
    const activity = this.state.activity;
    if (sessionId !== activity.sessionId || activity.removed.has(entry.id)) {
      return;
    }
    const current = activity.entries.get(entry.id);
    if (current && current.revision > entry.revision) {
      return;
    }
    const entries = new Map(activity.entries);
    entries.set(entry.id, entry);
    this.setActivity({ entries });
  }

  private historyDeleted(id: string, sessionId: string): void {
    if (sessionId !== this.state.activity.sessionId) {
      return;
    }
    const entries = new Map(this.state.activity.entries);
    const removed = new Set(this.state.activity.removed);
    entries.delete(id);
    removed.add(id);
    this.setActivity({ entries, removed });
  }

  private setActivity(change: Partial<ActivityState>): void {
    this.update({ activity: { ...this.state.activity, ...change } });
  }
}

/** The conversation ID a `start-agent` answer names (a preview answer names none). */
function startedId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const id = (result as { id?: unknown }).id;
  if (typeof id === 'string' && id) {
    return id;
  }
  return undefined;
}

/**
 * Markdown reduced to readable plain text for one-line previews: code fences,
 * heading/list/quote markers, emphasis and link syntax are removed.
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Latest user or assistant text, for list previews. */
export function lastText(session: AgentSession | PreviousSession): string {
  if (!('messages' in session)) {
    return '';
  }
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message: AgentMessage = session.messages[index];
    if ((message.kind === 'assistant' || message.kind === 'user') && message.text.trim()) {
      return message.text;
    }
  }
  return '';
}
