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
import { ListenerDrafts } from './listener-drafts.ts';
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
  /** Conversations whose turn completed while they were not being viewed. */
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
   * browser shell's settings screen covers the selected conversation: a turn
   * completed meanwhile is then marked unread and announced, as for a
   * conversation that is not selected, and selecting a conversation then
   * (a started one, underneath the settings screen) keeps its mark until it
   * is shown.
   */
  selectionShown?: () => boolean;
  /**
   * Share conversation drafts with the listener (./listener-drafts.ts): ask
   * every connection for them, show the listener's draft in each
   * conversation's box, write edits with `draft-set`, and report
   * `pendingSend` while a send waits. A connection without drafts (an older
   * gateway or listener) keeps them in this browser exactly as without this
   * option. Off by default (the phone panel keeps its drafts on the phone);
   * the browser shell turns it on. The new-conversation box (`new`) always
   * stays local.
   */
  listenerDrafts?: boolean;
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
  /** Listener-owned drafts, only with the `listenerDrafts` option. */
  private readonly listenerDrafts: ListenerDrafts | undefined;
  /**
   * The conversation whose send waits for its answer, as `panel-state`
   * reports it (`pendingSend`, listener drafts only), or ''.
   */
  private pendingSendReport = '';

  constructor(options: StoreOptions = {}) {
    this.readsActivity = options.activity !== false;
    this.rereadsActivity = options.rereadActivityAfterReconnect === true;
    this.selectionShown = options.selectionShown ?? (() => true);
    this.connection = new Connection(
      (event) => this.apply(event),
      (connection) => this.connectionChanged(connection),
      () => this.online(),
      { drafts: options.listenerDrafts === true },
    );
    if (options.listenerDrafts === true) {
      this.listenerDrafts = new ListenerDrafts({
        shown: (id) => this.draft(id),
        shownIds: () => [...this.drafts.keys()].filter((id) => id !== 'new'),
        show: (id, text) => this.showListenerDraft(id, text),
        write: (id, text, editId) => this.connection.request('draft-set', { id, text, editId }),
        changed: () => {
          // What is not confirmed yet is kept in this browser (see saveDrafts).
          this.saveDrafts();
          this.update({});
        },
      });
    }
    this.navigation = new Navigation((page) => this.applyPage(page));
    this.state = { ...this.state, connection: this.connection.state };
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
    const unread = new Set(this.state.unread);
    // Selecting shows the conversation, which clears its mark; unless it is
    // selected where the reader does not see it (see `selectionShown`).
    if (this.selectionShown()) {
      unread.delete(id);
    }
    this.update({
      selected: id,
      showingPrevious: this.connection.paired && page.showingPrevious,
      actions: id === this.state.selected ? this.state.actions : undefined,
      unread,
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
   * Tell the listener which conversation this phone shows. It only scopes this
   * phone's choice/stop/tool-page controls; the desktop selection is untouched.
   */
  private reportSelection(): void {
    if (this.state.connection.status !== 'online') {
      return;
    }
    const id = this.state.sessions.has(this.state.selected) ? this.state.selected : '';
    const report: { id: string; pendingSend?: string } = { id };
    // Only a connection that shares drafts may name a waiting send; one
    // without drafts would refuse the field.
    if (this.listenerDrafts !== undefined && this.listenerDrafts.ready) {
      report.pendingSend = this.pendingSendReport;
    }
    void this.request('panel-state', report, { quiet: true }).then(
      () => this.selectionReportAccepted(),
      () => {},
    );
  }

  /**
   * The listener accepted a `panel-state` report. Without a draft snapshot
   * before the connection's first one, the connection does not share
   * drafts: they are this browser's again (see ./listener-drafts.ts).
   */
  private selectionReportAccepted(): void {
    if (this.listenerDrafts === undefined) {
      return;
    }
    const decidedLocal = this.listenerDrafts.reportAccepted();
    if (decidedLocal) {
      // The shown texts are now local drafts: kept, pruned and saved as
      // before (pruning waited until this connection decided, see pruneDrafts).
      this.pruneDrafts(new Set(this.state.sessions.keys()));
    }
  }

  private online(): void {
    // Wait for this connection's authoritative snapshot before reporting a
    // selection: the old conversation may have been closed while offline.
    this.receivedSnapshot = false;
    this.listenerDrafts?.connected();
  }

  private connectionChanged(connection: ConnectionState): void {
    if (connection.status === 'unpaired') {
      this.clearPrivateState();
    }
    if (connection.status !== 'online') {
      this.listenerDrafts?.disconnected();
    }
    this.update({ connection });
  }

  private clearPrivateState(): void {
    this.identityRevision += 1;
    this.drafts.clear();
    this.draftRevisions.clear();
    this.completedTurns.clear();
    this.seen.clear();
    this.receivedSnapshot = false;
    this.revealNextRestore = '';
    this.listenerDrafts?.forget();
    this.pendingSendReport = '';
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
    // A conversation's draft shared with the listener is written there.
    if (id !== 'new') {
      this.listenerDrafts?.edited(id, text);
    }
    this.update({});
  }

  /**
   * Show the listener's text in a conversation's box (listener drafts). Not
   * an edit: nothing is written. The revision advances, as for any change of
   * the draft that the person did not type here.
   */
  private showListenerDraft(id: string, text: string): void {
    this.draftRevisions.set(id, (this.draftRevisions.get(id) ?? 0) + 1);
    if (text) {
      this.drafts.set(id, text);
    } else {
      this.drafts.delete(id);
    }
  }

  /** Whether this page's conversation drafts are the listener's now (listener drafts only). */
  get draftsShared(): boolean {
    return this.listenerDrafts !== undefined && this.listenerDrafts.mode === 'listener';
  }

  /** Why a conversation's shown text is not saved in the listener, or ''. */
  draftUnsaved(id: string): string {
    return this.listenerDrafts?.unsaved(id) ?? '';
  }

  /** The agent that proposed a conversation's shown, unedited draft, or ''. */
  draftSource(id: string): string {
    return this.listenerDrafts?.source(id) ?? '';
  }

  /** Save: write a conversation's unsaved text. False when there is none. */
  saveUnsavedDraft(id: string): boolean {
    return this.listenerDrafts?.save(id) ?? false;
  }

  /** Discard: show the listener's draft instead of the unsaved text. */
  discardUnsavedDraft(id: string): boolean {
    return this.listenerDrafts?.discard(id) ?? false;
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
    this.reportPendingSend(id);
    try {
      // Listener drafts: the edit carrying this text reaches the listener
      // first, so a send never overtakes it (the listener clears only a
      // draft that equals the sent text).
      if (id !== 'new' && this.listenerDrafts !== undefined) {
        const unsavedBefore = this.draftUnsaved(id);
        await this.listenerDrafts.written(id);
        // Meanwhile signed out, or this send was dropped (the conversation
        // closed, maybe already reopened): it must not leave any more.
        if (identity !== this.identityRevision || this.state.sends.get(id) !== sending) {
          this.endPendingSend(id);
          this.listenerDrafts.sendSettled(id, null);
          return undefined;
        }
        // The edit carrying this text was refused: the listener does not
        // hold it, so after the send it could not clear it, and the box
        // would offer the same text again. Not sent; the text stays unsaved.
        if (unsavedBefore === '' && this.draftUnsaved(id) !== '') {
          throw Error('Your text could not be saved, so it was not sent.');
        }
      }
      const result =
        id === 'new'
          ? await this.request('start-agent', { text, profile }, { quiet: true })
          : await this.request('send-agent', { id, text }, { quiet: true });
      this.endPendingSend(id);
      if (identity !== this.identityRevision || this.state.sends.get(id) !== sending) {
        if (id !== 'new') {
          // Text typed while it was in progress is written now.
          this.listenerDrafts?.sendSettled(id, text);
        }
        return undefined;
      }
      const unchangedDraft = (this.draftRevisions.get(id) ?? 0) === revision;
      if (id !== 'new' && this.draftsShared) {
        // The listener clears its draft itself, only while it still equals
        // the sent text, and tells every editor; this page never writes an
        // empty draft for a send (newer text typed elsewhere would go).
        this.listenerDrafts?.sendSettled(id, text);
      } else if (unchangedDraft) {
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
      this.endPendingSend(id);
      if (id !== 'new') {
        // Text typed while it was in progress is written now.
        this.listenerDrafts?.sendSettled(id, null);
      }
      if (identity !== this.identityRevision || this.state.sends.get(id) !== sending) {
        return undefined;
      }
      const explanation = error instanceof Error ? error.message : String(error);
      let message =
        error instanceof UncertainOutcome
          ? `${explanation} The draft remains here; check the conversation before sending it again.`
          : `${explanation} The draft remains here.`;
      // A shared draft follows the listener: if the send arrived, the
      // listener cleared it, so the box need not hold the text any more.
      if (id !== 'new' && this.draftsShared && error instanceof UncertainOutcome) {
        message = `${explanation} Check the conversation before sending it again.`;
      }
      this.update({ sends: new Map(this.state.sends).set(id, { pending: false, error: message }) });
      return undefined;
    }
  }

  /**
   * With listener drafts, report the conversation whose send now waits
   * (`pendingSend`) before the send leaves, so agents cannot propose a draft
   * for it meanwhile (src/remote/README.md, "Drafts"). Nothing otherwise.
   */
  private reportPendingSend(id: string): void {
    if (id === 'new' || this.listenerDrafts === undefined || !this.listenerDrafts.ready) {
      return;
    }
    this.pendingSendReport = id;
    this.reportSelection();
  }

  /**
   * The send of `id` has its answer (or lost it): no longer reported as
   * waiting. Another conversation's send that still waits is reported
   * instead (the listener takes one conversation per connection).
   */
  private endPendingSend(id: string): void {
    if (this.pendingSendReport !== id) {
      return;
    }
    this.pendingSendReport = this.waitingSend(id);
    if (this.listenerDrafts !== undefined && this.listenerDrafts.ready) {
      this.reportSelection();
    }
  }

  /**
   * A conversation whose send still waits for its answer (the latest
   * started, other than `except`), or ''. The new-conversation box is not a
   * conversation the listener knows.
   */
  private waitingSend(except = ''): string {
    let found = '';
    for (const [id, send] of this.state.sends) {
      if (send.pending && id !== 'new' && id !== except) {
        found = id;
      }
    }
    return found;
  }

  /**
   * Only open conversations and the new-conversation composer retain drafts.
   * With the `listenerDrafts` option they are pruned only once the current
   * connection has shown that drafts are local: the listener keeps every conversation's
   * draft (also of closed ones, which may be reopened), and until the mode
   * is known a draft of a conversation closed elsewhere may be text the
   * listener never received, kept here so that it is offered, not lost.
   * Sends are always pruned.
   */
  private pruneDrafts(active: Set<string>): void {
    const local = this.listenerDrafts === undefined || this.listenerDrafts.localDecided;
    if (local) {
      for (const id of this.drafts.keys()) {
        if (id !== 'new' && !active.has(id)) {
          this.drafts.delete(id);
          this.draftRevisions.delete(id);
        }
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
    let kept = this.drafts;
    if (this.listenerDrafts !== undefined && this.draftsShared) {
      // Conversation drafts are the listener's. This browser keeps only the
      // new-conversation box and text the listener has not confirmed yet
      // (unsaved, or still being written), so a reload offers that text
      // again instead of losing it. Local copies from before are deleted
      // here once the listener's snapshot offered them.
      kept = new Map();
      const newConversation = this.drafts.get('new');
      if (newConversation !== undefined) {
        kept.set('new', newConversation);
      }
      for (const id of this.listenerDrafts.unconfirmedIds()) {
        const text = this.drafts.get(id);
        if (text !== undefined) {
          kept.set(id, text);
        }
      }
    }
    try {
      localStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(kept)));
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
      case 'draft-snapshot':
        // Only a connection that asked for drafts receives these.
        if (this.listenerDrafts !== undefined) {
          this.listenerDrafts.snapshot(event);
          // Local copies have been offered: deleted from this browser.
          this.saveDrafts();
          // A send that started before this connection became a draft host
          // is reported now, so agents cannot propose a draft for it.
          const waiting = this.waitingSend();
          if (waiting !== '') {
            this.pendingSendReport = waiting;
            this.reportSelection();
          }
        }
        return;
      case 'draft':
        this.listenerDrafts?.change(event);
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

    let selected = this.state.selected;
    if (selected && !map.has(selected)) {
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
    const unread = this.observeCompletions(sessions, selected);

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
      unread,
      actions: firstSnapshot ? undefined : this.state.actions,
    });

    this.pruneDrafts(new Set(map.keys()));
    if (firstSnapshot) {
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

    let unread = this.observeCompletions([session], reveal ? update.id : this.state.selected);
    if (newlySeen && !reveal && update.id !== this.state.selected) {
      unread = new Set(unread).add(update.id);
    }
    this.update({ sessions, order, unread });

    if (reveal) {
      this.open(update.id);
    }
  }

  /** Mark conversations unread when a new turn completed out of view. */
  private observeCompletions(sessions: AgentSession[], viewed: string): Set<string> {
    let unread = this.state.unread;
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
    const unread = new Set(this.state.unread);
    unread.delete(id);
    change.unread = unread;
    this.completedTurns.delete(id);
    if (this.state.selected === id) {
      change.selected = '';
      change.actions = undefined;
      this.toast(`“${removed?.title ?? 'Conversation'}” was closed. It is in Previous sessions.`);
    }
    this.update(change);
    this.pruneDrafts(new Set(sessions.keys()));
  }

  /** Whether the reader sees the selected conversation now: the page is visible and shows it. */
  private selectionVisible(): boolean {
    return document.visibilityState === 'visible' && this.selectionShown();
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
