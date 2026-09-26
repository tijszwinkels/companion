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

import type { AgentMessage, AgentSession, PreviousSession } from '../../../src/agents/types.ts';
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

export class Store {
  private listeners = new Set<() => void>();
  private nextToast = 0;
  private drafts = new Map<string, string>();
  /** Latest completed turn per conversation, for unread marking. */
  private readonly completedTurns = new Map<string, string>();
  /** Conversations seen in any snapshot or event; newly seen ones are selected. */
  private readonly seen = new Set<string>();
  private receivedSnapshot = false;
  /** Set just before this phone asks to reopen a conversation. */
  revealNextRestore = '';
  readonly connection: Connection;

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
    toasts: [],
  };

  constructor() {
    this.loadDrafts();
    this.connection = new Connection(
      (event) => this.apply(event),
      (connection) => this.update({ connection }),
      () => this.online(),
    );
    this.state = { ...this.state, connection: this.connection.state };
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
   * Uncertain outcomes are always surfaced, never retried.
   */
  async request<Action extends RemoteAction>(
    action: Action,
    parameters: RemoteActionParameters[Action],
    options: { quiet?: boolean } = {},
  ): Promise<unknown> {
    try {
      return await this.connection.request(action, parameters);
    } catch (error) {
      if (!options.quiet || error instanceof UncertainOutcome) {
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
    const unread = new Set(this.state.unread);
    unread.delete(id);
    this.update({
      selected: id,
      showingPrevious: false,
      actions: id === this.state.selected ? this.state.actions : undefined,
      unread,
    });
    this.reportSelection();
    if (id && !this.state.models && !this.state.modelsLoading && !this.state.modelsError) {
      void this.loadModels();
    }
  }

  showActivity(): void {
    this.open('');
  }

  showPrevious(): void {
    this.update({ selected: '', showingPrevious: true, actions: undefined });
    this.reportSelection();
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
    void this.request('panel-state', { id }, { quiet: true }).catch(() => {});
  }

  private online(): void {
    // A new connection has no selection on the listener side yet.
    this.reportSelection();
  }

  // ---- Drafts (per conversation, kept on this phone only) ------------------

  draft(id: string): string {
    return this.drafts.get(id) ?? '';
  }

  setDraft(id: string, text: string): void {
    if (text) {
      this.drafts.set(id, text);
    } else {
      this.drafts.delete(id);
    }
    this.saveDrafts();
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
    this.update({ modelsLoading: true, modelsError: '' });
    try {
      const models = (await this.request('agent-models', {}, { quiet: true })) as ModelCatalog;
      this.update({ models, modelsLoading: false });
    } catch (error) {
      this.update({
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error),
      });
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
        this.revealNextRestore = '';
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
    const map = new Map<string, AgentSession>();
    for (const session of sessions) {
      map.set(session.id, session);
    }

    let selected = this.state.selected;
    if (selected && !map.has(selected)) {
      selected = '';
    }

    // Reconnect snapshots can reveal conversations started meanwhile; like the
    // desktop they are only added to the rail, never selected, on a snapshot.
    for (const session of sessions) {
      this.seen.add(session.id);
    }
    this.receivedSnapshot = true;
    const unread = this.observeCompletions(sessions, selected);

    // A new listener run starts a new Activity history.
    let activity = this.state.activity;
    if (activity.sessionId !== engine.activitySessionId) {
      activity = emptyActivity(engine.activitySessionId);
    }

    this.update({
      engine,
      sessions: map,
      order: sessions.map((session) => session.id),
      orderRevision: engine.sessionOrderRevision,
      previous: previousSessions,
      selected,
      activity,
      unread,
    });

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
      session = { ...update, messages };
    }

    sessions.set(update.id, session);
    const order = this.state.order.includes(update.id)
      ? this.state.order
      : [...this.state.order, update.id];

    // A newly seen conversation opens and is selected once, unless an agent
    // tool opened it in the background (desktop protocol rule). Reopening is
    // explicit: `agent-restored` with reveal selects it again.
    const newlySeen = !this.seen.has(update.id);
    this.seen.add(update.id);
    const reveal =
      this.receivedSnapshot &&
      ((newlySeen && !update.openInBackground) || (complete && revealRestored));

    const unread = this.observeCompletions([session], reveal ? update.id : this.state.selected);
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
      if (session.id !== viewed || document.visibilityState !== 'visible') {
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
  }

  private turnCompleted(id: string): void {
    if (id === this.state.selected && document.visibilityState === 'visible') {
      return;
    }
    const title = this.state.sessions.get(id)?.title ?? 'A conversation';
    this.toast(`${title} — answer ready`, 'success');
  }

  // ---- Activity history -----------------------------------------------------

  /** Read new completion positions for the current run, 50 per page. */
  private async syncActivity(): Promise<void> {
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
    const through = engine.activityHistoryCount;
    this.setActivity({ syncing: true, error: '' });

    try {
      let after: number | null = activity.read;
      while (after !== null) {
        const page = (await this.request(
          'activity-history',
          { sessionId, after, through },
          { quiet: true },
        )) as ActivityPage;

        if (this.state.activity.sessionId !== sessionId) {
          return;
        }
        this.applyActivityPage(page);
        after = page.next;
      }
      this.setActivity({ read: through, syncing: false });
    } catch (error) {
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
