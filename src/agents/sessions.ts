import { lstat } from 'node:fs/promises';
import { ConversationUnavailableError } from './resume-error.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WakeStore } from './wakes/store.ts';
import { WakeScheduler } from './wakes/scheduler.ts';
import { unstarted, type WakeRecord, type WakeSchedule, type WakeSummary } from './wakes/types.ts';
import { describeRecurrence } from './wakes/recurrence.ts';

import { WidgetService } from '../widgets/service.ts';
import { bundledLibraryDirectory } from '../widgets/library-path.ts';
import type { JsonObject, WidgetLease, WidgetRecord } from '../widgets/types.ts';
import {
  sessionApplicationLimits,
  type SessionApplicationDescriptor,
  type SessionApplicationEventMode,
} from '../session-apps/types.ts';
import { applicationChatSnapshot } from '../session-apps/chat.ts';
import type { ApplicationSendReceipt } from '../session-apps/sending.ts';
import type { UserSensorFrame, Log } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import {
  agentDirectory,
  loadAgentConfiguration,
  loadAgentSettings,
  loadClaudeCodeSettings,
} from './settings.ts';
import type { ToolPage, ToolPageRequest } from './tool-transcripts.ts';
import { MAX_OPEN_AGENT_SESSIONS, MAX_RUNNING_AGENT_SESSIONS } from './session-limit.ts';
import { MAX_DIRECT_USER_MESSAGE_LENGTH, MAX_RELAYED_MESSAGE_LENGTH } from './message-limits.ts';
import {
  codingDefaultsConflict,
  readCodingDefaults,
  saveCodingDefaults,
  type CodingDefaults,
  type CodingDefaultsChange,
} from './coding-defaults.ts';
import { SessionStore } from './session-store.ts';
import { historyPage, type HistoryPage, type HistoryPageRequest } from './history-pages.ts';
import { choiceText, parseChoices, type AgentChoice, type AgentChoiceSet } from './choices.ts';
import { parseSessionName } from './session-name.ts';
import { conversationContext, type AgentConversationContext } from './conversation-context.ts';
import { canonicalText, promptText } from './agent-origin.ts';
import { applicationMessageAncestry } from './application-message-origin.ts';
import type { SessionLiveState } from './harness-live-state.ts';
import { CaptureStoragePolicy, type CaptureAdmission } from '../capture-storage/policy.ts';
import { claudeCodeModelCatalog } from './claude/models.ts';
import {
  SessionToolError,
  SessionToolService,
  checkStartModel,
  type OpenSessionToolSummary,
  type SessionDirectory,
  type SessionToolSummary,
} from './session-tools-service.ts';
import type {
  AgentPresentationHost,
  AgentPresentOutcome,
  AgentPresentRequest,
} from './session-presentation.ts';
import {
  chatMessage,
  agentThinkingLevels,
  type AgentSettings,
  type AgentBackend,
  type AgentHarness,
  type AgentHarnessBackends,
  type AgentRunRequest,
  type ClaudeCodeConversationSettings,
  type ClaudeCodeModelCatalog,
  type ClaudeCodeSettings,
  type NativeTitleExport,
  type AgentBrowserHost,
  type AgentBrowserOpenOutcome,
  type AgentDraftHost,
  type AgentDraftOutcome,
  type AgentMessage,
  type AgentMessageOrigin,
  type AgentProfile,
  type AgentSession,
  type SessionEvent,
  type PreviousSession,
} from './types.ts';

/**
 * The desktop runtime's side of the shared unread mark: which conversations
 * a connected client shows on a visible page right now. The runtime decides
 * this from panel reports (see "Unread mark" in src/desktop/README.md).
 */
export interface ConversationViewers {
  /** True while at least one connection shows `id` on a visible page. */
  showsVisibly(id: string): boolean;
}

interface RunningSession {
  view: AgentSession;
  controller: AbortController;
  done: Promise<void>;
  changed: Map<string, AgentMessage>;
  historyRevision?: number;
  displayed?: Map<string, AgentMessage>;
  // Only the latest cumulative partial per active call, bounded below. Terminal
  // updates supersede it; flush/stop persist the last accepted partial.
  pendingTools: Map<string, AgentMessage>;
  toolError: string;
  timer?: ReturnType<typeof setTimeout>;
  // Closing blocks new turns until the archive write settles. Busy also covers
  // final persistence, when the displayed model status may already be terminal.
  closing: boolean;
  busy: boolean;
  pending: AgentMessage[];
  modelWrite?: Promise<void>;
  /**
   * Agent-to-agent hops behind the prompt of the current/last turn: 0 for a
   * human message, otherwise its origin's depth. Session tools extend it.
   */
  depth: number;
  currentOrigin?: AgentMessageOrigin;
  wake?: WakeRecord;
  /**
   * The conversation's own agent asked to close it (companion_session_close).
   * It closes only after the requesting turn completes with nothing queued.
   */
  closeAfterTurn: boolean;
  /**
   * Capture-storage admission of the first turn's screenshot: the sensor
   * frame's own, or decided when the conversation was created. The PNG copy
   * in the conversation directory is written only while it still allows it.
   */
  screenshotStorage?: CaptureAdmission;
  /**
   * A conversation started by speech whose harness is not yet recorded in the
   * view. Reading the configuration is asynchronous, but tab creation is not,
   * so the first turn resolves it before its first save or backend call:
   * `coding-default` reads `codingDefaultHarness`; `claude-code` only reads the
   * Claude model and effort. A configuration error then fails that turn in its
   * own tab. Cleared once resolved; never saved.
   *
   * If the first turn fails or stops before resolution (for example because
   * the configuration is broken), the saved archive has no harness. While the
   * tab stays open, the next turn tries to resolve again. Once it is closed
   * and reopened, or after a listener restart, it is an ordinary Pi
   * conversation, even if "new claude session" started it: a follow-up runs Pi
   * with `resume`, which fails visibly because Pi has no transcript for it.
   * This is deliberate. Do not turn it into a silent fallback.
   */
  pendingHarness?: 'coding-default' | 'claude-code';
  /**
   * A new coding conversation without its own Pi model choice. If it turns
   * out to be a Pi conversation, the first turn gives it the configured
   * `codingDefaultPiModel` (when set) as its saved `modelOverride`, so a later
   * change of that default never moves it to another model. Resolved,
   * cleared and refused for model choices exactly like `pendingHarness`.
   * Conversations created before this existed have no override and keep
   * following the configured Pi coding model.
   */
  pendingPiModel?: boolean;
  /** Live session application descriptor, from the widget service. */
  application?: SessionApplicationDescriptor;
  /** Immediate-mode debounce before queueing an application event turn. */
  applicationTimer?: ReturnType<typeof setTimeout>;
  /** An application-event placeholder message is waiting in `pending`. */
  applicationEventQueued?: boolean;
  /**
   * The current turn answers an application send that was withdrawn (its
   * permission revoked or renewed) before it reached the model. Such a turn
   * never ran and keeps the previous turn's duration. Reset for every turn.
   */
  currentSendWithdrawn?: boolean;
  /**
   * The current turn was admitted to the model: its harness `run` was called
   * (for an application send, right after the send gate admitted it). Reset
   * for every turn. See `endTurnNow`.
   */
  turnAdmitted?: boolean;
  /**
   * The current or last turn's measurement, in listener-clock milliseconds.
   * `startedAt` is set when the turn's message is admitted (published as
   * `turnStartedAt`); `endedAt` when the turn ends. Only `endTurnNow` ends
   * a turn, and the first end stands.
   */
  turnMeasurement?: { startedAt: number; endedAt?: number };
  /** The status and error that the latest `flush` published to clients. */
  publishedOutcome?: Pick<AgentSession, 'status' | 'error'>;
  /**
   * Set while a finished turn's final bookkeeping (save, application and
   * wake outcomes) is pending. The turn's end and duration are already
   * published, but clients keep seeing the status and error they saw while
   * the turn ran: the conversation is still busy and queues new messages,
   * so it must not look ready yet. See `run`.
   */
  heldOutcome?: Pick<AgentSession, 'status' | 'error'>;
}

/**
 * One turn's backend and settings, chosen from the conversation's harness.
 * `run` receives the harness-independent request fields and adds the settings.
 */
interface PreparedTurn {
  /** Displayed as the conversation's model while this turn runs. */
  model: string;
  run(
    request: Omit<AgentRunRequest, 'settings'>,
    signal: AbortSignal,
    emit: (message: AgentMessage) => void,
    replaceChoices: (options: readonly AgentChoice[]) => void,
    renameSession: (title: string) => void,
    exportTitle: (title: NativeTitleExport) => void,
  ): Promise<void>;
}

/**
 * How a turn ends, for `AgentSessions.endTurnNow`:
 * - `finished`: the harness returned (answered, failed or exited), or the
 *   listener itself found an error that fails the turn (tool storage).
 * - `cancelled`: Stop, listener shutdown, or the application service
 *   withdrawing the turn's own send.
 * - `ran-nothing`: nothing reached the model: a placeholder with nothing to
 *   deliver, a send refused at its gate, or a wake that could not enter.
 */
type TurnEnd = 'finished' | 'cancelled' | 'ran-nothing';

const maxPendingFollowUps = 8;
const runningCapacityReason = `${MAX_RUNNING_AGENT_SESSIONS} questions are already running; stop one or wait for an answer`;

/**
 * Owns independent question lifetimes. The sensor worker only hands off a frame;
 * it never waits for a long answer. Microphone pause therefore does not cancel
 * accepted questions. Stop, close-tab, and application shutdown do cancel them.
 * Closed tabs are saved for reopening. The conversation's harness (Pi or Claude
 * Code) owns the resumable model transcript; Companion owns its display
 * transcript and the original screenshot attachment. Each turn selects its
 * backend from the conversation's harness; absence means Pi.
 */
export class AgentSessions implements InspectableModule {
  readonly id = 'agent-sessions';
  readonly label = 'Question sessions';
  readonly dependencies: Readonly<Record<string, InspectableModule>>;
  private readonly sessions = new Map<string, RunningSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private closed = false;
  private readonly previous = new Map<string, PreviousSession>();
  private readonly restoring = new Set<string>();
  private readonly store: SessionStore;
  private readonly widgets: WidgetService;
  private orderRevision = randomUUID();
  private readonly modelChanges = new Set<string>();
  /** A change of the defaults for new conversations is being validated or saved. */
  private codingDefaultsSaving = false;
  readonly sessionTools: SessionToolService;
  readonly wakes: WakeScheduler;
  private wakeWarningText = '';
  /** When this listener raised its latest timer service warning (listener clock). */
  private wakeWarningAt?: number;
  private readonly wakePreparation = new Map<
    string,
    { configuration: string; session: RunningSession; controller: AbortController }
  >();
  // The desktop runtime owns UI connections and therefore unsent drafts.
  private draftHost?: AgentDraftHost;
  // The desktop runtime also owns the native panel's built-in browser.
  private browserHost?: AgentBrowserHost;
  // ... and the native panel's pop-out conversation windows.
  private presentationHost?: AgentPresentationHost;
  // ... and knows which conversations a connection shows on a visible page,
  // which decides whether a completed turn leaves the conversation unread.
  private viewers?: ConversationViewers;
  // Saves of a changed unread mark that may still be running. Shutdown waits
  // for them so a mark set or cleared just before it survives the restart.
  private readonly unreadWrites = new Set<Promise<void>>();
  // Refuses to close a conversation that is being recorded into (manual
  // recording, core/dictation). Returns the reason, or undefined to allow it.
  private closeGuard?: (id: string) => string | undefined;

  /**
   * `directory` is the agents' working directory holding saved conversations
   * and widget state. `widgetLibrary` is the widget source directory used for
   * discovery and publication. The listener passes the configured user library
   * (see library-path.ts); the default is the checkout's bundled examples so
   * tests and harnesses stay hermetic and never read the user's real widgets.
   * `backends` holds one backend per harness. Claude Code is optional: a
   * Claude Code conversation's turns then fail with a visible error.
   */
  constructor(
    private readonly backends: AgentHarnessBackends,
    private readonly log: Log,
    private readonly directory = agentDirectory(),
    widgetLibrary = bundledLibraryDirectory,
    // Optional: reports busy Pi conversations to a local agent-harness.
    private readonly liveState?: SessionLiveState,
    // Gates the automatic conversation screenshot copy. Absent means a fixed
    // "off" policy: nothing is saved unless the listener passes its policy.
    private readonly captureStorage: CaptureStoragePolicy = new CaptureStoragePolicy(),
    // The listener's wall clock in milliseconds since the Unix epoch. It
    // schedules wakes and stamps turn and message times; tests inject it.
    private readonly clock: () => number = Date.now,
  ) {
    // Graph inspection shows each wired backend under its harness name.
    const dependencies: Record<string, InspectableModule> = { pi: backends.pi };
    const claudeCode = backends['claude-code'];
    if (claudeCode) {
      dependencies['claude-code'] = claudeCode;
    }
    this.dependencies = dependencies;

    this.store = new SessionStore(join(directory, '.companion-sessions'));
    this.widgets = new WidgetService(
      join(directory, '.companion-widgets'),
      async (record, reference) => {
        const session = this.sessions.get(record.owner);
        if (!session) {
          return;
        }
        this.message(session, {
          ...chatMessage('widget:' + record.id, 'assistant', record.text),
          widget: reference,
        });
        session.view.updatedAt = Date.now();
        this.flush(session);
        // User interactions continue between agent turns and must survive a close
        // immediately after a click, without waiting for another model response.
        await this.store.save(session.view);
      },
      widgetLibrary,
      undefined,
      (records) => this.validateWidgetChanges(records),
      {
        changed: (owner, descriptor) => this.applicationChanged(owner, descriptor),
        userEdit: (owner, eventMode) => this.applicationEdited(owner, eventMode),
        sendChat: (owner, text, origin) =>
          this.acceptFollowUp(owner, text, new AbortController().signal, origin),
        withdrawChat: (owner, receipts) => this.withdrawApplicationChat(owner, receipts),
        readChat: (owner, after) => {
          const session = this.sessions.get(owner);
          if (!session) {
            throw Error('Conversation is closed');
          }
          // The application service checked version, grant and read rate first.
          // Use canonical rows, never a possibly historical UI page or draft.
          return applicationChatSnapshot(session.view, after);
        },
      },
    );
    this.wakes = new WakeScheduler(
      new WakeStore(join(directory, '.companion-wakes'), (text) => this.wakeWarning(text)),
      {
        prepare: (record) => this.prepareWake(record),
        admit: (record, claim) => this.admitWake(record, claim),
        changed: (record) => this.wakeChanged(record),
        warning: (text) => this.wakeWarning(text),
      },
      clock,
    );
    this.sessionTools = new SessionToolService({
      wake: (owner, turnId, depth, method, command, signal) =>
        this.wakeTool(owner, turnId, depth, method, command, signal),
      title: (id) => this.sessions.get(id)?.view.title,
      sourceGroupId: (sender, turnId, toolCallId) => this.sourceGroupId(sender, turnId, toolCallId),
      directory: (sender, query, limit) => this.sessionDirectory(sender, query, limit),
      start: (request, signal) => this.startFromAgent(request, signal),
      reopen: (id, focus, signal) => this.reopenFromAgent(id, focus, signal),
      close: (id, sender, signal) => this.closeFromAgent(id, sender, signal),
      send: (id, text, origin, signal) => this.sendFromAgent(id, text, origin, signal),
      draft: (request, signal) => this.draftFromAgent(request, signal),
      browserOpen: (request, signal) => this.browserOpenFromAgent(request, signal),
      presentationAvailable: () => this.presentationHost?.available() === true,
      present: (request, signal) => this.presentFromAgent(request, signal),
    });
  }

  /** Install (or clear) the UI connection that can hold composer drafts. */
  setDraftHost(host: AgentDraftHost | undefined): void {
    this.draftHost = host;
  }

  /**
   * Install (or clear) a check that can refuse closing a conversation. It
   * applies to every close path: the panel, `close session`, agent tools,
   * the external API and an agent's deferred self-close.
   */
  setCloseGuard(guard: ((id: string) => string | undefined) | undefined): void {
    this.closeGuard = guard;
  }

  /** Install (or clear) the route to the native panel's built-in browser. */
  setBrowserHost(host: AgentBrowserHost | undefined): void {
    this.browserHost = host;
  }

  /** Install (or clear) the route to the native panel's pop-out windows. */
  setPresentationHost(host: AgentPresentationHost | undefined): void {
    this.presentationHost = host;
  }

  /**
   * Install (or clear) the check whether a connection shows a conversation
   * on a visible page. Without one, nobody shows anything: every successful
   * turn leaves its conversation unread.
   */
  setViewers(viewers: ConversationViewers | undefined): void {
    this.viewers = viewers;
  }

  /**
   * Clear the unread mark of an open conversation because a connection now
   * shows it on a visible page. Publishes the change at once and saves it in
   * the background (shutdown waits for that save). Does nothing for a
   * conversation that is not open or not unread, so callers may call it on
   * every report.
   */
  markRead(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.view.unread !== true) {
      return;
    }

    session.view.unread = false;
    this.flush(session);
    void this.saveUnread(session);
  }

  /**
   * Save a conversation after its unread mark changed. Store writes are
   * serialized per conversation in call order, so this never overwrites a
   * newer save. A failed write is logged: the live mark stays as published,
   * and the conversation's next save (every later turn saves) stores it.
   */
  private async saveUnread(session: RunningSession): Promise<void> {
    const write = this.store.save(session.view).catch((error: unknown) => {
      this.log('agent-history', `Could not save the unread mark: ${String(error)}`);
    });
    this.unreadWrites.add(write);
    try {
      await write;
    } finally {
      this.unreadWrites.delete(write);
    }
  }

  /**
   * The listener's current time, in milliseconds since the Unix epoch, from
   * the same clock that stamps `turnStartedAt` and message `createdAt`. The
   * desktop runtime sends it to clients as `listenerTime` so that a client
   * whose own clock differs can still show correct durations and times.
   */
  now(): number {
    return this.clock();
  }

  // ---- Session applications (src/session-apps/README.md) -------------------

  /** Trusted desktop route only; never exposed through agent or application tools. */
  setApplicationChatRead(id: string, command: JsonObject, validateDesktop?: () => void) {
    return this.widgets.applications.setChatRead(id, command, validateDesktop);
  }

  setApplicationChatSend(id: string, command: JsonObject, validateDesktop?: () => void) {
    return this.widgets.applications.setChatSend(id, command, validateDesktop);
  }

  private withdrawApplicationChat(owner: string, receipts: ApplicationSendReceipt[]): void {
    const session = this.sessions.get(owner);
    if (!session || !receipts.length) return;
    const ids = new Set(receipts.map((receipt) => receipt.receiptId));
    const withdrawn = (message: AgentMessage) =>
      message.origin?.kind === 'application-message' && ids.has(message.origin.receiptId);
    session.pending = session.pending.filter((message) => !withdrawn(message));
    for (const message of session.view.messages.filter(withdrawn)) {
      this.message(session, { ...message, state: 'error' });
    }
    // Only never-started sends are withdrawn. When that is the current
    // turn's own send, the model will never see it: stop showing a running
    // time now, although the turn stays busy until its startup settles.
    const current = session.currentOrigin;
    if (
      current?.kind === 'application-message' &&
      ids.has(current.receiptId) &&
      !session.turnAdmitted
    ) {
      session.currentSendWithdrawn = true;
      // Published by the flush below.
      this.endTurnNow(session, 'cancelled', false);
    }
    // A current pre-model wait is deliberately not aborted: its late gate will
    // skip it, then continue unrelated human input already in the FIFO.
    this.flush(session);
  }

  /**
   * Debounce for immediate-mode application events, in milliseconds. Edits
   * within this window share one turn. Tests may shorten it.
   */
  applicationEventDelayMilliseconds: number =
    sessionApplicationLimits.immediateDebounceMilliseconds;

  private applicationChanged(
    owner: string,
    descriptor: SessionApplicationDescriptor | undefined,
  ): void {
    const session = this.sessions.get(owner);
    if (!session) {
      return;
    }
    session.application = descriptor;
    this.flush(session);
  }

  /**
   * A user edit in the application view was committed together with its
   * event. Immediate mode schedules an event turn after a short quiet period;
   * next-input mode waits for the person's next message. Agent-origin
   * changes never reach this method, so they cannot trigger turns.
   */
  private applicationEdited(owner: string, eventMode: SessionApplicationEventMode): void {
    const session = this.sessions.get(owner);
    if (!session || session.closing || this.closed || eventMode !== 'immediate') {
      return;
    }
    clearTimeout(session.applicationTimer);
    session.applicationTimer = setTimeout(() => {
      session.applicationTimer = undefined;
      this.queueApplicationEvents(session);
    }, this.applicationEventDelayMilliseconds);
  }

  /**
   * Put one placeholder turn for the pending application edits into the
   * ordinary follow-up FIFO. Its prompt is built when the turn starts, so it
   * keeps absorbing edits while it waits behind other turns. A refused
   * admission leaves the edits pending with a note; nothing retries on a timer.
   */
  private queueApplicationEvents(session: RunningSession): void {
    const id = session.view.id;
    if (this.sessions.get(id) !== session || session.closing || this.closed) {
      return;
    }
    if (session.applicationEventQueued || !this.widgets.applications.hasPendingEdits(id)) {
      return;
    }
    const application = session.application;
    if (!application?.id) {
      return;
    }
    try {
      this.acceptFollowUp(
        id,
        'Application edits are waiting to be delivered.',
        new AbortController().signal,
        { kind: 'application-event', applicationId: application.id, depth: 0 },
      );
    } catch (error) {
      const reason = `No turn could be queued for these edits: ${error instanceof Error ? error.message : String(error)}`;
      void this.widgets.applications.noteAdmissionFailure(id, reason).catch((failure) => {
        this.log(
          'agent-application',
          `Could not record event admission failure: ${String(failure)}`,
        );
      });
    }
  }

  /**
   * Called as a turn starts. An application-event placeholder takes the
   * pending batch as its whole prompt; a person's own message takes it as an
   * attachment (both event modes). Other turns (agent messages, wakes) carry
   * no application events. `skip` means the placeholder has nothing to deliver.
   */
  private async startApplicationDelivery(
    session: RunningSession,
    messageId: string | undefined,
    prompt: Parameters<AgentBackend['run']>[0]['prompt'],
  ): Promise<
    | { skip: true }
    | { skip: false; prompt: Parameters<AgentBackend['run']>[0]['prompt']; batchId?: string }
  > {
    const message = session.view.messages.find((entry) => entry.id === messageId);
    const eventOnly = message?.origin?.kind === 'application-event';
    if (eventOnly) {
      session.applicationEventQueued = false;
      this.widgets.applications.setQueued(session.view.id, false);
    } else if (!message || message.origin || !session.application?.id) {
      return { skip: false, prompt };
    } else {
      // The person's message takes the pending edits now, so an older
      // immediate-mode debounce must not offer them again later, whether
      // this attachment succeeds or fails. Edits made after this point arm
      // a new debounce themselves.
      clearTimeout(session.applicationTimer);
      session.applicationTimer = undefined;
    }

    const id = session.view.id;
    let delivery: Awaited<ReturnType<typeof this.widgets.applications.beginDelivery>>;
    let preparationFailed = false;
    try {
      delivery = await this.widgets.applications.beginDelivery(id);
    } catch (error) {
      // Without a durable `delivering` record the edits must not reach the
      // model: they stay pending for the next edit or message.
      this.log('agent-application', `Could not record event delivery: ${String(error)}`);
      delivery = undefined;
      preparationFailed = true;
    }
    if (!eventOnly) {
      if (!delivery) {
        return { skip: false, prompt };
      }
      return {
        skip: false,
        prompt: { ...prompt, text: prompt.text + '\n\n' + delivery.text },
        batchId: delivery.batchId,
      };
    }

    if (!delivery) {
      // Usually another turn (the person's own message) already carried them.
      const text = preparationFailed
        ? 'Application edits could not be prepared for delivery; they are kept for the next edit or message.'
        : 'Application edits were delivered with an earlier message.';
      this.message(session, { ...message, text, state: preparationFailed ? 'error' : 'done' });
      return { skip: true };
    }
    this.message(session, { ...message, text: delivery.summary, state: 'done' });
    return { skip: false, prompt: { text: delivery.text }, batchId: delivery.batchId };
  }

  private async finishApplicationDelivery(
    session: RunningSession,
    batchId: string | undefined,
  ): Promise<void> {
    if (!batchId) {
      return;
    }
    const delivered = session.view.status === 'completed' && !session.controller.signal.aborted;
    let reason = 'The turn carrying these edits was stopped.';
    if (session.view.status === 'error') {
      reason = `The turn carrying these edits failed: ${session.view.error}`;
    }
    try {
      await this.widgets.applications.finishDelivery(
        session.view.id,
        batchId,
        delivered ? { delivered: true } : { delivered: false, reason },
      );
    } catch (error) {
      // The batch stays `delivering`; the next restart marks it failed.
      this.log('agent-application', `Could not record event delivery outcome: ${String(error)}`);
    }
  }

  private validateWidgetChanges(records: WidgetRecord[]): () => void {
    const session = this.sessions.get(records[0].owner);
    if (!session || session.closing || this.closed) {
      throw Error('Widget conversation is closing');
    }
    // The service retains its transaction/release contract, but canonical
    // widgets no longer compete with historical rows for display admission.
    return () => {};
  }

  /** Restore history as data; only explicit durable timers may later admit a new turn. */
  async loadPrevious(): Promise<void> {
    for (const entry of await this.store.previous(this.log)) {
      if (!this.sessions.has(entry.id)) {
        this.previous.set(entry.id, entry);
      }
    }
    this.wakes.open();
    for (const owner of new Set(this.wakes.store.all().map((record) => record.owner))) {
      if (!this.previous.has(owner) && !this.sessions.has(owner)) {
        const deleted = await lstat(
          join(this.directory, '.companion-sessions', `${owner}.json`),
        ).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
        );
        if (deleted) {
          this.wakes.deleteOwner(owner);
        } else {
          this.wakes.blockUnavailableOwner(owner, 'Saved owner is malformed or unavailable');
        }
      }
    }
    this.wakes.start();
  }

  private wakeTool(
    owner: string,
    turnId: string,
    depth: number,
    method: string,
    command: Record<string, unknown>,
    signal: AbortSignal,
  ): Record<string, unknown> {
    signal.throwIfAborted();
    const session = this.sessions.get(owner);
    if (
      this.closed ||
      !session ||
      session.closing ||
      session.closeAfterTurn ||
      session.controller.signal.aborted
    ) {
      throw new SessionToolError('expired', 'Conversation stopped or closing');
    }
    if (method === 'wake-list') {
      const recent = command.recent ?? 0;
      if (typeof recent !== 'number' || !Number.isInteger(recent) || recent < 0 || recent > 50) {
        throw new SessionToolError('invalid', 'recent must be 0–50');
      }
      return { timers: this.wakes.list(owner, recent) };
    }
    if (method === 'wake-cancel') {
      if (typeof command.timerId !== 'string') {
        throw new SessionToolError('invalid', 'timerId is required');
      }
      return this.wakes.cancel(owner, command.timerId);
    }
    // Application-event turns stand for the person's own edits (depth 0), so
    // like human turns they give a timer no agent ancestry.
    const ancestry =
      session.currentOrigin?.kind === 'scheduled-wake'
        ? session.currentOrigin.ancestry
        : session.currentOrigin?.kind === 'application-event'
          ? undefined
          : session.currentOrigin?.kind === 'application-message'
            ? applicationMessageAncestry(session.currentOrigin)
            : session.currentOrigin;
    return this.wakes.schedule(
      {
        owner,
        turnId,
        callId: String(command.requestId),
        depth,
        ancestry,
        harness: session.view.harness ?? 'pi',
        signal,
      },
      command as unknown as WakeSchedule,
    );
  }

  private wakeWarning(text: string): void {
    this.wakeWarningText = text.slice(0, 600);
    this.wakeWarningAt = this.clock();
    this.log('agent-wake', this.wakeWarningText);
    for (const session of this.sessions.values()) {
      try {
        // A tab without the warning yet gets it with this occurrence's time,
        // the same time a reopen gives it (see reopen); a tab that already
        // shows a warning keeps its row's first time.
        this.message(
          session,
          chatMessage('wake-service-warning', 'notice', this.wakeWarningText),
          false,
          this.wakeWarningAt,
        );
        this.flush(session);
      } catch {
        // Storage/size failures must not recursively report through the timer service.
      }
    }
  }

  private wakeConfiguration(view: AgentSession): string {
    return JSON.stringify([
      view.harness,
      view.modelOverride,
      view.thinkingOverride,
      view.claudeCode,
    ]);
  }

  private wakeNotice(record: WakeSummary): AgentMessage {
    // A repeating occurrence also shows its interval, occurrence and series.
    // Each occurrence has its own notice, so the newest one shows the next due time.
    const recurrence = record.recurrence ? ` · ${describeRecurrence(record.recurrence)}` : '';
    return chatMessage(
      `wake:${record.id}`,
      'notice',
      `Timer ${record.label} · ${record.state} · ${new Date(record.dueAt).toISOString()} · ${record.id}${recurrence} · scheduled in ${record.schedulingTurn}${record.turnId ? ` · turn ${record.turnId}` : ''}${record.reason ? ` · ${record.reason}` : ''}`,
    );
  }

  private wakeChanged(record: WakeRecord): void {
    this.wakePreparation.delete(record.id);
    const session = this.sessions.get(record.owner);
    if (!session) {
      return;
    }
    session.view.wakes = this.wakes.list(record.owner, 20);
    // A single occurrence's notice is updated in place; successive transitions
    // do not consume a transcript bubble each. Instruction text stays private.
    try {
      // A new notice takes its timer's creation time, the same time a reopen
      // gives it when the archive lacks it, so it never changes on restart.
      this.message(session, this.wakeNotice(record), false, record.createdAt);
      this.flush(session);
    } catch (error) {
      this.log('agent-wake', `Timer saved, transcript notice unavailable: ${String(error)}`);
    }
  }

  private async prepareWake(record: WakeRecord): Promise<string> {
    if (this.closed) {
      return 'waiting';
    }
    let session = this.sessions.get(record.owner);
    // A repeating timer runs only in an open tab. It never restores a closed
    // or archived conversation, so nothing runs in the background unseen;
    // this occurrence is skipped and its series moves on to the next slot.
    if (!session && record.recurrence) {
      return 'not-open';
    }
    if (!session) {
      if (!this.previous.has(record.owner)) {
        return 'Owner conversation is deleted or its archive is missing';
      }
      if (
        this.sessions.size + this.restoring.size >= MAX_OPEN_AGENT_SESSIONS ||
        this.restoring.has(record.owner) ||
        this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS
      ) {
        return 'waiting';
      }
      try {
        await this.reopen(record.owner, false);
      } catch {
        return 'Owner archive could not be restored';
      }
      session = this.sessions.get(record.owner);
    }
    if (
      !session ||
      session.closing ||
      session.busy ||
      session.pending.length ||
      this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS ||
      session.modelWrite ||
      this.modelChanges.has(record.owner)
    ) {
      return 'waiting';
    }
    if (session.view.status === 'error' || session.controller.signal.aborted) {
      return 'Preceding conversation turn failed or stopped';
    }
    if ((session.view.harness ?? 'pi') !== record.harness) {
      return 'Owner harness changed';
    }
    const view = session.view;
    const configuration = this.wakeConfiguration(view);
    const controller = session.controller;
    let readiness = 'ready';
    try {
      const prepared = await this.prepareTurn(view, true, {
        modelOverride: view.modelOverride,
        thinkingOverride: view.thinkingOverride,
        claudeCode: view.claudeCode,
      });
      if (view.harness === 'claude-code') {
        await this.checkClaudeModel(view, prepared.model);
      } else if (this.backends.pi.models) {
        const settings = await loadAgentSettings(this.directory, view.profile);
        const models = await this.backends.pi.models(
          settings,
          this.directory,
          AbortSignal.timeout(15_000),
        );
        if (!models.models.includes(prepared.model)) {
          readiness = 'Configured wake model is unavailable; no fallback';
        }
      }
    } catch (error) {
      readiness = `Wake configuration unavailable: ${String(error).slice(0, 450)}`;
    }
    // Negative discovery results grant no more authority than positive ones.
    // Revalidate every asynchronous outcome before admitting OR blocking work.
    const current = this.wakes.store.get(record.id);
    const liveSession = this.sessions.get(record.owner);
    if (
      !current ||
      current.revision !== record.revision ||
      !unstarted(current) ||
      this.closed ||
      liveSession !== session ||
      session.controller !== controller ||
      controller.signal.aborted ||
      session.closing ||
      session.closeAfterTurn ||
      session.busy ||
      session.pending.length ||
      liveSession.view.status === 'error' ||
      session.modelWrite ||
      this.modelChanges.has(record.owner) ||
      this.wakeConfiguration(session.view) !== configuration
    ) {
      return 'waiting';
    }
    if (readiness === 'ready') {
      this.wakePreparation.set(record.id, { configuration, session, controller });
    }
    return readiness;
  }

  private admitWake(record: WakeRecord, claim: () => WakeRecord | undefined): boolean {
    const session = this.sessions.get(record.owner);
    const preparation = this.wakePreparation.get(record.id);
    if (
      this.closed ||
      !session ||
      session.closing ||
      session.busy ||
      session.pending.length ||
      session.closeAfterTurn ||
      session.modelWrite ||
      this.modelChanges.has(record.owner) ||
      this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS ||
      (session.view.harness ?? 'pi') !== record.harness ||
      session.controller.signal.aborted ||
      session.view.status === 'error' ||
      preparation?.session !== session ||
      preparation.controller !== session.controller ||
      preparation.configuration !== this.wakeConfiguration(session.view)
    ) {
      return false;
    }
    // No await between durable claim and busy reservation. Cancel, Stop and
    // ordinary follow-ups are ordered on this same event loop.
    this.wakePreparation.delete(record.id);
    const claimed = claim();
    if (!claimed) {
      return false;
    }
    const recorded =
      record.ancestry?.kind === 'scheduled-wake' ? record.ancestry.ancestry : record.ancestry;
    const ancestry =
      recorded?.kind === 'agent' || recorded?.kind === 'external' ? recorded : undefined;
    const origin: AgentMessageOrigin = {
      kind: 'scheduled-wake',
      timerId: record.id,
      dueAt: record.dueAt,
      schedulingTurn: record.schedulingTurn,
      title: record.label,
      depth: record.depth,
      ...(record.recurrence
        ? {
            series: {
              id: record.recurrence.seriesId,
              everySeconds: record.recurrence.everySeconds,
              occurrence: record.recurrence.occurrence,
            },
          }
        : {}),
      ...(ancestry ? { ancestry } : {}),
    };
    const message = { ...chatMessage(`wake-turn:${record.id}`, 'user', record.message), origin };
    try {
      session.wake = claimed;
      this.prepareFollowUp(session, message);
      this.wakeChanged(claimed);
      session.done = this.drain(session, { text: promptText(record.message, origin) }, true);
      return true;
    } catch (error) {
      session.wake = undefined;
      session.busy = false;
      this.endTurnNow(session, 'ran-nothing', false);
      session.view.status = 'error';
      session.view.error = 'Scheduled wake could not enter the conversation';
      this.wakes.transitionAttempt(claimed, 'failed', String(error));
      this.flush(session);
      return false;
    }
  }

  /** Native user cancellation is scoped to the selected conversation by ID. */
  cancelWake(owner: string, timerId: string): Record<string, unknown> {
    return this.wakes.cancel(owner, timerId);
  }

  previousSnapshot(): PreviousSession[] {
    return [...this.previous.values()].sort((first, second) => second.updatedAt - first.updatedAt);
  }

  /**
   * Locate the sender's stored tool group for one outbound session-tool call,
   * using the turn-prefixed Pi tool message ID written by `runTurn` and
   * `pi-transcript`. The anchor is optional navigation metadata: a storage
   * read failure omits it instead of refusing an otherwise valid delivery.
   */
  private sourceGroupId(sender: string, turnId: string, toolCallId: string): string | undefined {
    try {
      return this.store.tools.groupFor(sender, `${turnId}:tool-${toolCallId}`);
    } catch (error) {
      this.log('agent-session-tools', `Source tool group unavailable: ${String(error)}`);
      return undefined;
    }
  }

  private publishHistory(): void {
    for (const listener of this.listeners) {
      listener({ type: 'agent-history', sessions: this.previousSnapshot() });
    }
  }

  snapshot(): AgentSession[] {
    return [...this.sessions.values()].map((session) => this.display(session));
  }

  /** The Map order is also the visible tab order. Moves retain every run object. */
  order(): { ids: string[]; revision: string } {
    return { ids: [...this.sessions.keys()], revision: this.orderRevision };
  }

  private publishOrder(): void {
    this.orderRevision = randomUUID();
    for (const listener of this.listeners) {
      listener({ type: 'agent-order', ...this.order() });
    }
  }

  move(id: string, beforeId: string, revision: string): void {
    if (
      this.closed ||
      revision !== this.orderRevision ||
      !this.sessions.has(id) ||
      (beforeId !== '' && !this.sessions.has(beforeId)) ||
      id === beforeId
    ) {
      throw Error('Session order changed; try moving the tab again');
    }
    const entries = [...this.sessions.entries()];
    const moved = entries.find(([entryId]) => entryId === id)!;
    const remaining = entries.filter(([entryId]) => entryId !== id);
    const position = beforeId
      ? remaining.findIndex(([entryId]) => entryId === beforeId)
      : remaining.length;
    remaining.splice(position, 0, moved);
    this.sessions.clear();
    for (const [entryId, session] of remaining) {
      this.sessions.set(entryId, session);
    }
    this.publishOrder();
  }

  async models(signal: AbortSignal) {
    const coding = await loadAgentSettings(this.directory, 'coding', false);
    const quickQuestion = await loadAgentSettings(this.directory, 'quickQuestion', false);
    // Pi's catalogue only. The Claude picker has its own catalogue below, so a
    // Pi discovery failure cannot stop a Claude Code conversation's choice.
    if (!this.backends.pi.models) {
      throw Error('This agent backend does not support model selection');
    }
    const catalog = await this.backends.pi.models(coding, this.directory, signal);
    if (catalog.warning) {
      this.log('agent-models', catalog.warning);
    }
    return {
      ...catalog,
      coding: coding.model,
      quickQuestion: quickQuestion.model,
      codingThinking: coding.thinking,
      quickQuestionThinking: quickQuestion.thinking,
    };
  }

  /**
   * The Claude picker's catalogue: the fixed allowlist plus the configured
   * default model. It only reads the configuration file; it starts neither
   * Claude Code nor Pi, so it works even when Pi discovery fails.
   */
  async claudeModels(): Promise<ClaudeCodeModelCatalog> {
    const { model } = await loadClaudeCodeSettings(this.directory, false);
    return { models: claudeCodeModelCatalog(model), model };
  }

  /** The harness and models that the next new coding conversation will use. */
  async codingDefaults(): Promise<CodingDefaults> {
    return readCodingDefaults(this.directory);
  }

  /**
   * Change the defaults for new coding conversations only (see
   * `coding-defaults.ts`). A model must be one the matching picker offers:
   * Pi's discovered catalogue, or the Claude allowlist plus the configured
   * Claude default. There is no fallback to another model. One change runs
   * at a time; a second request is refused rather than queued, because it
   * was made against defaults that are about to change.
   */
  async setCodingDefaults(
    change: CodingDefaultsChange,
    signal: AbortSignal,
  ): Promise<CodingDefaults> {
    if (this.codingDefaultsSaving) {
      throw Error('The defaults for new sessions are already being saved');
    }

    this.codingDefaultsSaving = true;
    try {
      // Fail before a slow Pi discovery when the panel's view is already
      // stale. Saving compares the revision again.
      const current = await readCodingDefaults(this.directory);
      if (current.revision !== change.revision) {
        throw codingDefaultsConflict();
      }

      if (change.model !== undefined && change.harness === 'pi') {
        const catalog = await this.models(signal);
        if (!catalog.models.includes(change.model)) {
          throw Error(`${change.model} is not an available Pi model`);
        }
      } else if (change.model !== undefined) {
        const catalog = claudeCodeModelCatalog(current.claudeModel);
        if (!catalog.includes(change.model)) {
          throw Error(
            `${change.model} is not an available Claude model. Choose one of: ${catalog.join(', ')}`,
          );
        }
      }

      signal.throwIfAborted();
      return await saveCodingDefaults(this.directory, change);
    } finally {
      this.codingDefaultsSaving = false;
    }
  }

  /**
   * Choices affect only later turns of this conversation, including reopening.
   * A Pi conversation stores a Pi model override (empty clears it). A Claude
   * Code conversation replaces its own Claude model; it never becomes a Pi
   * conversation and a Pi model ID is not reinterpreted as a Claude one.
   */
  async setModel(id: string, model: string, signal: AbortSignal): Promise<void> {
    const session = this.sessions.get(id);
    if (session?.view.harness === 'claude-code' && session.view.claudeCode) {
      await this.setPreferences(
        id,
        { claudeCode: { model, effort: session.view.claudeCode.effort } },
        signal,
      );
      return;
    }
    await this.setPreferences(id, { modelOverride: model || undefined }, signal);
  }

  async setThinking(id: string, thinking: string, signal: AbortSignal): Promise<void> {
    if (thinking !== '' && !agentThinkingLevels.includes(thinking as AgentSettings['thinking'])) {
      throw Error('Choose a supported effort level');
    }
    await this.setPreferences(
      id,
      {
        thinkingOverride: thinking ? (thinking as AgentSettings['thinking']) : undefined,
      },
      signal,
    );
  }

  /**
   * A Claude model choice must be one exact ID from the allowlist (or the
   * configured default), or the conversation's current model. There is no
   * trimming, alias resolution or fallback; anything else is refused visibly.
   */
  private async checkClaudeModel(view: AgentSession, model: string): Promise<void> {
    if (model === view.claudeCode?.model) {
      return;
    }
    if (model === '') {
      throw Error('Choose a Claude model for this Claude Code conversation');
    }

    const { model: configuredModel } = await loadClaudeCodeSettings(this.directory, false);
    const catalog = claudeCodeModelCatalog(configuredModel);
    if (!catalog.includes(model)) {
      throw Error(
        `${model} is not an available Claude model. Choose one of: ${catalog.join(', ')}`,
      );
    }
  }

  /**
   * Validate and durably save one model/effort choice for the next turn.
   * `changes` holds either Pi overrides or, for a Claude Code conversation,
   * its replacement `claudeCode` settings (same effort, another model).
   */
  private async setPreferences(
    id: string,
    changes: Pick<AgentSession, 'modelOverride' | 'thinkingOverride' | 'claudeCode'>,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (this.closed || !session || session.closing || this.modelChanges.has(id)) {
      throw Error('Conversation is unavailable or its model/effort is already being changed');
    }
    const claudeConversation = session.view.harness === 'claude-code';
    if (claudeConversation && 'thinkingOverride' in changes) {
      throw Error('This Claude Code conversation keeps the effort chosen when it started');
    }
    const claudeChoice = 'claudeCode' in changes;
    if (claudeConversation !== claudeChoice) {
      // A choice prepared for the other harness, for example a Pi override
      // for a conversation that has since become Claude Code. Never convert.
      throw Error('That model choice does not belong to this conversation’s harness');
    }
    // Until the first turn has read the configuration, this conversation might
    // still become a Claude Code conversation, whose picker lists Claude models.
    if (session.pendingHarness || session.pendingPiModel) {
      throw Error('This conversation is still starting; choose its model/effort in a moment');
    }
    this.modelChanges.add(id);
    try {
      if (changes.claudeCode) {
        await this.checkClaudeModel(session.view, changes.claudeCode.model);
      } else if (changes.modelOverride !== undefined || changes.thinkingOverride !== undefined) {
        const catalog = await this.models(signal);
        if (
          changes.modelOverride !== undefined &&
          !catalog.models.includes(changes.modelOverride)
        ) {
          throw Error('Choose an available configured Pi model');
        }
        if (changes.thinkingOverride !== undefined) {
          const model = session.view.modelOverride ?? catalog[session.view.profile ?? 'coding'];
          if (!catalog.thinkingLevels[model]?.includes(changes.thinkingOverride)) {
            throw Error('Choose an effort level supported by this model');
          }
        }
      }
      signal.throwIfAborted();
      if (this.closed || this.sessions.get(id) !== session || session.closing) {
        throw Error('Conversation closed while choosing its model/effort');
      }
      // `claudeCode` is replaced as a whole object, never edited in place, so
      // a turn that already captured the previous object keeps its settings.
      let previous: Pick<AgentSession, 'modelOverride' | 'thinkingOverride' | 'claudeCode'> = {
        modelOverride: session.view.modelOverride,
        thinkingOverride: session.view.thinkingOverride,
      };
      if (claudeConversation) {
        previous = { claudeCode: session.view.claudeCode };
      }
      // Save both preferences through the same ordered write gate. A running
      // turn already holds a settings copy; a queued successor waits for this
      // save (or rollback). Changing models retains the requested effort: Pi
      // clamps it to that model, so switching back restores the user's choice.
      Object.assign(session.view, changes);
      this.flush(session);
      session.modelWrite = this.store.save(session.view).catch(async (error) => {
        Object.assign(session.view, previous);
        this.flush(session);
        // A turn may have queued another snapshot while this write was pending.
        // Repair after those ordered writes too, so a rejected preference cannot
        // survive on disk while the live view correctly shows the old setting.
        try {
          await this.store.save(session.view);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Could not save or restore conversation model/effort',
          );
        }
        throw error;
      });
      await session.modelWrite;
    } finally {
      session.modelWrite = undefined;
      this.modelChanges.delete(id);
    }
  }

  /** Project only a recent bounded window. Authoritative history stays in view
   * for persistence, context, canonical widgets and source-anchor lookup. */
  private display(session: RunningSession): AgentSession {
    const page = historyPage(session.view, session.historyRevision ?? 0);
    const pinned = session.view.messages.find(
      (message) => message.widget?.presentation.placement === 'pinned',
    );
    return {
      ...session.view,
      ...session.heldOutcome,
      messages: page.messages,
      history: page.history,
      pinnedMessage: pinned ? { ...pinned, text: '', input: '' } : null,
      ...(session.application ? { application: session.application } : {}),
    };
  }

  historyPage(request: HistoryPageRequest): HistoryPage {
    const session = this.sessions.get(request.id);
    if (this.closed || !session || session.closing || request.epoch !== session.view.toolEpoch) {
      throw Error('History is unavailable in this conversation');
    }
    let index = request.index;
    let offset = request.offset;
    if (request.anchor !== undefined) {
      index = session.view.messages.findIndex((message) => message.id === request.anchor);
      if (index < 0) {
        throw Error('History anchor is unavailable');
      }
      offset = 0;
    }
    return historyPage(
      session.view,
      session.historyRevision ?? 0,
      request.anchor ? 'after' : request.direction,
      { index, offset },
    );
  }

  toolPage(request: ToolPageRequest): ToolPage {
    const session = this.sessions.get(request.id);
    const group = session?.view.messages.find(
      (message) => message.id === request.groupId && message.toolGroup,
    );
    if (
      this.closed ||
      !session ||
      session.closing ||
      !group ||
      request.epoch !== session.view.toolEpoch
    ) {
      throw Error('Tool group is unavailable in this conversation');
    }
    return group.toolGroup?.legacy
      ? this.store.legacyPage(request)
      : this.store.tools.page(request);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Whether a close of this conversation has been admitted and is still
   * saving. It stays in `has` until then, but must not gain new owners, such
   * as a recording into its draft. Synchronous, so a caller can check and
   * claim in the same tick (the close guard covers the reverse order).
   */
  isClosing(id: string): boolean {
    return this.sessions.get(id)?.closing === true;
  }

  /** Only the capture path needs transcript excerpts; UI updates stay small. */
  conversationContext(id: string): AgentConversationContext | undefined {
    const session = this.sessions.get(id);
    return session ? conversationContext(session.view) : undefined;
  }

  /**
   * Immutable choices/run identity for speech capture and UI state. Availability
   * here gates choice selection; freeform follow-ups can also queue while busy.
   */
  interaction(id: string): {
    agentChoices?: AgentChoiceSet;
    agentRunId?: string;
    agentAcceptsFollowUp: boolean;
    agentFollowUpUnavailableReason: string;
  } {
    const session = this.sessions.get(id);
    let unavailableReason = '';
    if (!session || this.closed || session.closing) {
      unavailableReason = 'Question session is unavailable';
    } else if (session.busy) {
      unavailableReason = 'Available when the agent finishes';
    } else if (this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS) {
      unavailableReason = runningCapacityReason;
    }
    return {
      agentChoices: session?.view.choices,
      agentRunId:
        session && !session.closing && !session.controller.signal.aborted && session.busy
          ? session.view.runId
          : undefined,
      agentAcceptsFollowUp: !unavailableReason,
      agentFollowUpUnavailableReason: unavailableReason,
    };
  }

  private activeRuns(): number {
    // Keep the slot reserved through persistence and between queued turns.
    return [...this.sessions.values()].filter((session) => session.busy).length;
  }

  /** A click/voice selection carries identity, never a caller-supplied payload. */
  selectChoice(id: string, revision: string, index: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    const choices = this.sessions.get(id)?.view.choices;
    if (
      !choices ||
      choices.revision !== revision ||
      !Number.isInteger(index) ||
      !choices.options[index]
    ) {
      throw Error('These choices have expired; use the current choices or write a follow-up');
    }
    // Freeform input may queue; choices retain their existing end-of-turn gate.
    const interaction = this.interaction(id);
    if (!interaction.agentAcceptsFollowUp) {
      throw Error(interaction.agentFollowUpUnavailableReason);
    }
    this.followUp(id, choiceText(choices.options[index]), signal);
  }

  /** A delayed "stop" cannot cancel the next turn in the same conversation. */
  async stopRun(id: string, runId: string): Promise<boolean> {
    if (!runId || this.interaction(id).agentRunId !== runId) {
      return false;
    }
    await this.stop(id);
    return true;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * `harness` is the explicitly requested harness; omitting it uses the
   * configured `codingDefaultHarness`. Quick questions always use Pi.
   * Remote history starts preserve the saved frame but suppress desktop reveal.
   */
  start(
    frame: UserSensorFrame,
    signal: AbortSignal,
    profile: AgentProfile = 'coding',
    harness?: AgentHarness,
    openInBackground = false,
  ): string {
    return this.create(
      {
        text: frame.utterance,
        screenshot: frame.screenshot,
        storage: frame.storage,
        frameId: frame.id,
        profile,
        harness,
        openInBackground,
      },
      signal,
    );
  }

  /**
   * A typed question from a remote panel (for example the phone app). It has
   * no screenshot: the phone cannot capture the desktop, and substituting a
   * current desktop capture would attach a screen the user did not choose.
   * The tab opens in the background so a desktop panel keeps its selection;
   * the remote client selects the returned ID itself.
   */
  startRemote(text: string, profile: AgentProfile, signal: AbortSignal): string {
    if (!text.trim() || text.length > MAX_RELAYED_MESSAGE_LENGTH) {
      throw new SessionToolError(
        'rejected',
        `Enter between 1 and ${MAX_RELAYED_MESSAGE_LENGTH} characters`,
      );
    }

    return this.create({ text, profile, openInBackground: true }, signal);
  }

  /**
   * Speech, history recovery and agent tools share one creation path, so tab
   * and concurrency limits apply equally. Only a sensor frame has a screenshot.
   *
   * An absent `harness` means the configured coding default. A Claude Code
   * request without `claudeCode` reads the configured Claude model and effort.
   * Both are resolved when the first turn starts (see `pendingHarness`); the
   * session tools resolve them before calling this and pass both explicitly.
   */
  private create(
    request: {
      text: string;
      screenshot?: UserSensorFrame['screenshot'];
      /** The frame's admission; absent (history recovery) is decided now. */
      storage?: CaptureAdmission;
      frameId?: number;
      profile: AgentProfile;
      harness?: AgentHarness;
      claudeCode?: ClaudeCodeConversationSettings;
      modelOverride?: string;
      origin?: AgentMessageOrigin;
      openInBackground?: boolean;
    },
    signal: AbortSignal,
  ): string {
    signal.throwIfAborted();
    if (this.closed) {
      throw new SessionToolError('rejected', 'Agent sessions are shutting down');
    }
    if (this.sessions.size + this.restoring.size >= MAX_OPEN_AGENT_SESSIONS) {
      throw new SessionToolError(
        'rejected',
        `Close a question tab before starting another (${MAX_OPEN_AGENT_SESSIONS} tabs maximum)`,
      );
    }
    if (this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS) {
      throw new SessionToolError('rejected', runningCapacityReason);
    }

    // Quick questions use Pi's local model profile; only coding conversations
    // can run in Claude Code.
    let harness = request.harness;
    if (request.profile === 'quickQuestion') {
      harness = 'pi';
    }

    const id = randomUUID();
    const question = chatMessage('user', 'user', canonicalText(request.text, request.origin));
    question.screenshot = request.screenshot !== undefined;
    if (request.origin) {
      question.origin = request.origin;
    }

    // The first message and the first turn start together: the question is
    // admitted and its turn begins now (later turns: prepareFollowUp).
    const startedAt = this.clock();
    question.createdAt = startedAt;

    const session: RunningSession = {
      view: {
        id,
        title: request.text.slice(0, 80),
        status: 'starting',
        toolEpoch: randomUUID(),
        model: '',
        profile: request.profile,
        ...(request.modelOverride ? { modelOverride: request.modelOverride } : {}),
        error: '',
        messages: [question],
        updatedAt: Date.now(),
        turnStartedAt: startedAt,
        runId: randomUUID(),
        acceptsFollowUp: false,
        // A new conversation has nothing to read yet; its first successful
        // turn decides (see run()).
        unread: false,
        ...(request.openInBackground ? { openInBackground: true } : {}),
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      turnMeasurement: { startedAt },
      changed: new Map([[question.id, question]]),
      pendingTools: new Map(),
      toolError: '',
      closing: false,
      busy: true,
      pending: [],
      depth: request.origin?.depth ?? 0,
      currentOrigin: request.origin,
      closeAfterTurn: false,
      screenshotStorage: request.screenshot
        ? (request.storage ?? this.captureStorage.admit())
        : undefined,
    };

    // Record the harness now when it is fully known; otherwise the first turn
    // resolves it from the configuration. A Pi conversation records nothing.
    if (harness === 'claude-code' && request.claudeCode) {
      adoptClaudeCode(session.view, request.claudeCode);
    } else if (harness === 'claude-code') {
      session.pendingHarness = 'claude-code';
    } else if (harness === undefined) {
      session.pendingHarness = 'coding-default';
    }
    if (
      request.profile === 'coding' &&
      harness !== 'claude-code' &&
      request.modelOverride === undefined
    ) {
      session.pendingPiModel = true;
    }

    this.sessions.set(id, session);
    this.flush(session);
    this.publishOrder();
    session.done = this.drain(
      session,
      { text: promptText(request.text, request.origin), screenshot: request.screenshot },
      false,
      request.frameId,
    );
    return id;
  }

  /**
   * Spoken and typed follow-ups share one FIFO, owned by their captured tab.
   * Agent messages join the same FIFO with their origin; they never interrupt
   * a running turn or overtake earlier queued messages.
   *
   * A message without `origin` comes from the person at this desktop and may
   * be longer. Agent, external and wake messages always carry an origin and
   * keep the relayed bound. Remote panels share this method without an
   * origin, so the desktop runtime applies their bound before calling it.
   */
  followUp(
    id: string,
    text: string,
    signal: AbortSignal,
    origin?: AgentMessageOrigin,
  ): { outcome: 'started' | 'queued'; queuePosition: number } {
    const { outcome, queuePosition } = this.acceptFollowUp(id, text, signal, origin);
    return { outcome, queuePosition };
  }

  /** followUp, also returning the accepted message's ID for internal callers. */
  private acceptFollowUp(
    id: string,
    text: string,
    signal: AbortSignal,
    origin?: AgentMessageOrigin,
  ): { outcome: 'started' | 'queued'; queuePosition: number; messageId: string } {
    signal.throwIfAborted();
    const session = this.sessions.get(id);
    if (this.closed || !session || session.closing) {
      throw new SessionToolError('rejected', 'Question session is unavailable');
    }
    if (session.busy && session.controller.signal.aborted) {
      throw new SessionToolError(
        'rejected',
        'Wait for this question to stop before sending a follow-up',
      );
    }
    let maximumLength = MAX_DIRECT_USER_MESSAGE_LENGTH;
    if (origin) {
      maximumLength = MAX_RELAYED_MESSAGE_LENGTH;
    }
    if (!text.trim() || text.length > maximumLength) {
      throw new SessionToolError('rejected', `A follow-up requires 1–${maximumLength} characters`);
    }
    if (session.pending.length >= maxPendingFollowUps) {
      throw new SessionToolError(
        'rejected',
        `This conversation already has ${maxPendingFollowUps} queued messages`,
      );
    }
    if (!session.busy && this.activeRuns() >= MAX_RUNNING_AGENT_SESSIONS) {
      throw new SessionToolError('rejected', runningCapacityReason);
    }

    const message = chatMessage(`user-${randomUUID()}`, 'user', canonicalText(text, origin));
    message.state = session.busy ? 'queued' : 'done';
    if (origin) {
      message.origin = origin;
    }
    this.message(session, message);
    delete session.view.choices;
    if (origin?.kind === 'application-event') {
      session.applicationEventQueued = true;
    }
    if (session.busy) {
      session.pending.push(message);
      if (origin?.kind === 'application-event') {
        this.widgets.applications.setQueued(id, true);
      }
      this.flush(session);
      return { outcome: 'queued', queuePosition: session.pending.length, messageId: message.id };
    }

    this.prepareFollowUp(session, message);
    session.done = this.drain(
      session,
      { text: promptText(text, origin) },
      true,
      undefined,
      message.id,
    );
    return { outcome: 'started', queuePosition: 0, messageId: message.id };
  }

  private prepareFollowUp(session: RunningSession, message: AgentMessage): void {
    this.message(session, { ...message, state: 'done' });
    session.depth = message.origin?.depth ?? 0;
    session.currentOrigin = message.origin;
    session.currentSendWithdrawn = false;
    session.turnAdmitted = false;
    session.controller = new AbortController();
    session.busy = true;
    // Every admitted message starts its own turn and its own measurement,
    // including a queued follow-up that waited behind the previous turn.
    const startedAt = this.clock();
    session.view.turnStartedAt = startedAt;
    session.turnMeasurement = { startedAt };
    session.view.status = 'starting';
    session.view.error = '';
    session.toolError = '';
    delete session.view.choices;
    session.view.runId = randomUUID();
    session.view.acceptsFollowUp = false;
    this.flush(session);
  }

  private cancelPending(session: RunningSession): void {
    for (const message of session.pending.splice(0)) {
      this.message(session, { ...message, state: 'error' });
      if (message.origin?.kind === 'application-message') {
        this.widgets.applications.cancelChatSend(session.view.id, message.origin.receiptId);
      }
      if (message.origin?.kind === 'application-event') {
        // Never admitted to a model turn: the edits stay pending and are
        // carried by the next edit's turn or the person's next message.
        session.applicationEventQueued = false;
        this.widgets.applications.setQueued(session.view.id, false);
      }
    }
  }

  /**
   * One promise owns the entire sequence, so idle/stop/close include queued
   * work. Await both the backend and its final save before resuming the agent.
   * Once accepted, a message is independent of microphone pause and UI tab
   * changes.
   */
  private async drain(
    session: RunningSession,
    prompt: Parameters<AgentBackend['run']>[0]['prompt'],
    resume: boolean,
    frameId?: number,
    // The user-kind message this turn answers, when known. Used to attach
    // pending session-application edits; see startApplicationDelivery.
    messageId?: string,
  ): Promise<void> {
    try {
      while (true) {
        const delivery = await this.startApplicationDelivery(session, messageId, prompt);
        if (delivery.skip) {
          // An application-event placeholder with nothing left to deliver:
          // no model turn runs. Restore the completed state it replaced.
          // Nothing ran, so the previous turn's duration stays the last one.
          session.view.status = 'completed';
          delete session.view.runId;
          this.endTurnNow(session, 'ran-nothing', false);
        } else {
          await this.run(session, delivery.prompt, resume, frameId, messageId);
          await this.finishApplicationDelivery(session, delivery.batchId);
        }
        if (
          this.closed ||
          session.closing ||
          session.controller.signal.aborted ||
          session.view.status !== 'completed' ||
          session.view.error
        ) {
          // A failed or stopped turn keeps its tab so the user can see why.
          session.closeAfterTurn = false;
          this.cancelPending(session);
          delete session.view.choices;
          return;
        }

        const next = session.pending.shift();
        if (!next) {
          return;
        }
        // Someone continued the conversation; closing would hide that work.
        session.closeAfterTurn = false;
        this.prepareFollowUp(session, next);
        prompt = { text: promptText(next.text, next.origin) };
        resume = true;
        frameId = undefined;
        messageId = next.id;
      }
    } finally {
      session.busy = false;
      // `run` ends every turn it ran. This also covers a turn that ended
      // before `run` could (an exception in between), so that no running
      // time is ever published for a conversation that is no longer busy.
      this.endTurnNow(session, 'finished', false);
      session.heldOutcome = undefined;
      session.view.acceptsFollowUp = !session.closing && !this.closed;
      this.flush(session);
      if (session.closeAfterTurn) {
        session.closeAfterTurn = false;
        this.closeWhenSettled(session);
      }
    }
  }

  /**
   * A self-close runs after this drain has settled: `remove` awaits the
   * session's `done`, which is still this drain while the finally block runs.
   * A follow-up accepted in between keeps the conversation open.
   */
  private closeWhenSettled(session: RunningSession): void {
    const id = session.view.id;
    // The finished turn's controller identifies this request. Stop aborts it
    // and a new follow-up replaces it; either cancels the pending close.
    const requestingTurn = session.controller;
    setImmediate(() => {
      if (
        this.closed ||
        this.sessions.get(id) !== session ||
        session.controller !== requestingTurn ||
        requestingTurn.signal.aborted ||
        session.busy ||
        session.closing ||
        session.pending.length > 0
      ) {
        return;
      }
      void this.remove(id).catch((error) => {
        this.log('agent', `Could not close conversation ${id}: ${String(error)}`);
      });
    });
  }

  private async run(
    session: RunningSession,
    prompt: Parameters<AgentBackend['run']>[0]['prompt'],
    resume: boolean,
    frameId?: number,
    messageId?: string,
  ): Promise<void> {
    const appSend =
      session.currentOrigin?.kind === 'application-message'
        ? this.widgets.applications.chatSendTurn(session.view.id, session.currentOrigin.receiptId)
        : undefined;
    let appSendSkipped = false;
    const wake = session.wake;
    session.wake = undefined;
    const turnId = wake?.turnId ?? randomUUID();
    // The measurement was started when this turn's message was admitted
    // (create or prepareFollowUp). Retries and several executable attempts
    // inside the backend's `run` belong to this one turn and measurement.
    // Stop may already have ended it before this point.
    session.turnMeasurement ??= { startedAt: this.clock() };
    // Callbacks belong to this invocation, even if a faulty backend retains one.
    let acceptingUpdates = true;
    let resumeBlocked = false;
    let widgetLease: WidgetLease | undefined;
    let sessionToolLease: Awaited<ReturnType<SessionToolService['lease']>> | undefined;
    try {
      // A queued successor waits for an accepted model change to be durable.
      // A failed choice rolls back first, then this turn uses the old setting.
      if (session.modelWrite) {
        await session.modelWrite.catch(() => {});
      }
      let modelOverride = session.view.modelOverride;
      const thinkingOverride = session.view.thinkingOverride;
      // A Claude model choice is replaced as a whole object, so this keeps the
      // settings accepted before this turn began, like the Pi overrides above.
      let claudeCode = session.view.claudeCode;
      if (prompt.screenshot) {
        // The live screenshot always reaches the agent (below). Only the copy
        // kept with the conversation depends on capture storage.
        const question = session.view.messages[0];
        const png = prompt.screenshot.png;
        const url = await this.captureStorage.publish(session.screenshotStorage, (current) =>
          this.store.screenshot(session.view.id, png, current),
        );
        if (url) {
          question.screenshotUrl = url;
        } else {
          delete question.screenshotUrl;
          question.screenshotSaved = false;
        }
        session.changed.set(question.id, question);
      }
      // A new conversation records its harness before the first save, so the
      // saved question already reopens with the harness that will answer it.
      await this.resolveHarness(session);
      // A conversation still resolving its harness refuses model choices, so
      // the freshly resolved settings are the ones this turn must use.
      claudeCode ??= session.view.claudeCode;
      modelOverride ??= session.view.modelOverride;
      // Save the question before launching the agent. An interrupted turn can
      // still be found in history after a restart and is shown as stopped.
      session.view.updatedAt = Date.now();
      await this.store.save(session.view);
      session.controller.signal.throwIfAborted();
      const turn = await this.prepareTurn(session.view, resume, {
        modelOverride,
        thinkingOverride,
        claudeCode,
      });
      session.controller.signal.throwIfAborted();
      session.view.model = turn.model;
      session.view.status = 'running';
      this.flush(session);
      try {
        widgetLease = await this.widgets.lease(session.view.id, session.controller.signal);
      } catch (error) {
        session.controller.signal.throwIfAborted();
        // A damaged visual cache must not block an ordinary answer/follow-up.
        this.log('agent-widget', `Widget tools unavailable: ${String(error)}`, frameId);
      }
      try {
        // Authority lasts exactly this turn and names this conversation as
        // the sender; queued successors receive a fresh lease and depth.
        sessionToolLease = await this.sessionTools.lease(
          session.view.id,
          turnId,
          session.depth,
          session.controller.signal,
        );
      } catch (error) {
        session.controller.signal.throwIfAborted();
        this.log('agent-session-tools', `Session tools unavailable: ${String(error)}`, frameId);
      }
      session.controller.signal.throwIfAborted();
      if (appSend) {
        if (!appSend.begin()) {
          appSendSkipped = true;
          const message = session.view.messages.find((row) => row.id === messageId);
          if (message) this.message(session, { ...message, state: 'error' });
          session.view.status = 'completed';
          return;
        }
      }
      if (wake) {
        this.wakes.transitionAttempt(wake, 'started');
      }
      // Admitted to the model now: nothing is awaited between the send gate
      // above and the harness call below. Before this point, Stop, shutdown or
      // a withdrawal means that no model turn ran (see endTurnNow).
      session.turnAdmitted = true;
      await turn.run(
        {
          id: session.view.id,
          directory: this.directory,
          prompt,
          resume,
          widgets: widgetLease,
          sessionTools: sessionToolLease
            ? {
                endpoint: sessionToolLease.endpoint,
                token: sessionToolLease.token,
                capabilities: sessionToolLease.capabilities,
              }
            : undefined,
        },
        session.controller.signal,
        (message) => {
          if (
            acceptingUpdates &&
            !session.closing &&
            !session.controller.signal.aborted &&
            !this.closed
          ) {
            try {
              this.message(session, { ...message, id: `${turnId}:${message.id}` });
            } catch (error) {
              // Storing a tool call's details failed. The listener fails the
              // turn now, exactly as for a coalesced update (flushTools), so
              // the harness's cleanup is not counted. The harness still
              // receives the error, as before.
              if (message.kind === 'tool') {
                this.failTurnForToolStorage(session, error);
                this.flush(session);
              }
              throw error;
            }
          }
        },
        (options) => {
          if (
            !acceptingUpdates ||
            session.controller.signal.aborted ||
            session.closing ||
            session.pending.length > 0 ||
            this.closed
          ) {
            return;
          }
          const parsed = parseChoices(options);
          if (parsed.length) {
            session.view.choices = Object.freeze({ revision: randomUUID(), options: parsed });
          } else {
            delete session.view.choices;
          }
          this.flush(session);
        },
        (title) => {
          if (
            !acceptingUpdates ||
            session.controller.signal.aborted ||
            session.closing ||
            this.closed
          ) {
            return;
          }
          const name = parseSessionName(title);
          if (name === session.view.title) {
            return;
          }
          session.view.title = name;
          session.view.updatedAt = Date.now();
          // Publish immediately; the normal end-of-turn save retains the name
          // alongside the transcript, including when this turn is stopped.
          this.flush(session);
        },
        (title) => {
          // Claude Code's answer describes its own session, so it is kept even
          // when this turn was stopped meanwhile; the end-of-turn save keeps it.
          // A new pending name after Stop was rejected as a title above.
          if (
            !acceptingUpdates ||
            this.closed ||
            (title.state === 'pending' && session.controller.signal.aborted)
          ) {
            return;
          }
          session.view.nativeTitle = { title: title.title, state: title.state };
          this.flush(session);
        },
      );
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      resumeBlocked = error instanceof ConversationUnavailableError;
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'error';
      if (session.view.status === 'error') {
        session.view.error = error instanceof Error ? error.message : String(error);
        this.log('agent-error', session.view.error, frameId);
      }
    } finally {
      // The harness has returned (answered, stopped, failed or exited): the
      // turn's work ends here, unless Stop, shutdown, a withdrawal or a
      // listener error already ended it, which then stands. Persistence
      // below is bookkeeping, not turn time.
      let turnEnd: TurnEnd = 'finished';
      if (appSendSkipped) {
        turnEnd = 'ran-nothing';
      } else if (session.controller.signal.aborted || session.currentSendWithdrawn === true) {
        turnEnd = 'cancelled';
      }
      this.endTurnNow(session, turnEnd, false);
      acceptingUpdates = false;
      this.flushTools(session);
      if (session.toolError) {
        session.view.status = 'error';
        session.view.error = session.toolError;
      }
      widgetLease?.release();
      sessionToolLease?.release();
      if (session.view.status !== 'completed') {
        delete session.view.choices;
      }
      delete session.view.runId;
      if (session.view.status !== 'completed' || session.controller.signal.aborted) {
        this.cancelPending(session);
      }
      // Ordinary answers and archived terminal groups do not depend on a tool
      // database write. Only interrupted live calls need their state finalized.
      if (
        session.view.messages.some((message) => message.toolGroup && message.state === 'running')
      ) {
        try {
          this.store.tools.stop(session.view.id);
        } catch (error) {
          session.view.status = 'error';
          session.view.error = `Could not finalize tool details: ${String(error)}`;
          this.log('agent-history', session.view.error, frameId);
        }
      }
      // A stopped partial answer/tool must not retain a running spinner.
      for (const message of session.view.messages) {
        if (message.state === 'running') {
          let finished = { ...message, state: 'error' as const } as AgentMessage;
          if (message.toolGroup) {
            try {
              // A stored summary does not carry the row's creation time.
              const summary = this.store.tools.summary(session.view.id, message.id);
              finished = withCreationTime({ ...summary, state: 'error' }, message.createdAt);
            } catch {
              /* Keep the visible error if storage failed. */
            }
          }
          const index = session.view.messages.indexOf(message);
          session.view.messages[index] = finished;
          session.changed.set(finished.id, finished);
        }
      }

      // Publish the end of the turn before awaiting the final save, so that
      // no client keeps counting while persistence is slow. The status and
      // error stay as clients last saw them until the bookkeeping below is
      // done, and the completion event still waits for a successful save.
      session.heldOutcome = session.publishedOutcome;
      this.flush(session);

      session.view.updatedAt = Date.now();
      try {
        await this.store.save(session.view);
      } catch (error) {
        session.view.status = 'error';
        session.view.error = `Could not save session history: ${String(error)}`;
        this.log('agent-history', session.view.error, frameId);
      }
      const completed =
        session.view.status === 'completed' &&
        !session.controller.signal.aborted &&
        !appSendSkipped;
      if (appSend) {
        try {
          await appSend.finish(
            completed ? 'completed' : session.controller.signal.aborted ? 'cancelled' : 'failed',
          );
        } catch (error) {
          this.log(
            'agent-application',
            `Could not publish sending outcome: ${String(error)}`,
            frameId,
          );
        }
      }
      if (wake) {
        try {
          this.wakes.transitionAttempt(
            wake,
            completed ? 'completed' : resumeBlocked ? 'blocked' : 'failed',
            session.view.error || (completed ? '' : 'Wake turn stopped'),
          );
        } catch (error) {
          this.wakeWarning(
            'Wake outcome could not be saved. Its external effects may have occurred; restart will mark delivery uncertain.',
          );
        }
      }
      if (!completed && !appSendSkipped && !this.closed) {
        try {
          this.wakes.blockOwner(session.view.id, 'Preceding turn failed or stopped');
        } catch {
          this.wakeWarning(
            'Could not save blocked timer state after a failed turn. Wake dispatch is halted in this listener. Failed writes are not durable; inspect and cancel pending timers before restarting.',
          );
        }
      }
      // The shared unread mark is decided at the same moment as the
      // completion signal below: a successful turn that no connection shows
      // on a visible page leaves the conversation unread. Errors and stops
      // leave the mark as it was (see "Unread mark" in the desktop README).
      let markedUnread = false;
      if (completed) {
        // Keep the latest success in live snapshots, including while a queued
        // successor runs. A reconnect can then recover a missed completion.
        // This is UI state, not part of a saved/restored conversation.
        session.view.completedTurnId = turnId;

        const shown = this.viewers?.showsVisibly(session.view.id) === true;
        if (!shown && session.view.unread !== true) {
          session.view.unread = true;
          markedUnread = true;
        }
      }
      session.heldOutcome = undefined;
      // One update carries the completed status together with the mark.
      this.flush(session);
      this.log('agent', `${session.view.status}: ${session.view.id}`, frameId);
      // One event per successful turn, after persistence. Repeated snapshots,
      // reconnects, cancellations and failed saves are not completion signals.
      if (completed) {
        for (const listener of this.listeners) {
          listener({ type: 'agent-turn-completed', id: session.view.id, turnId });
        }
      }
      // The turn's own save above ran before the mark existed. Save once
      // more so a reload or restart finds it; a queued successor waits for
      // this like for the rest of the turn's bookkeeping.
      if (markedUnread) {
        await this.saveUnread(session);
      }
    }
  }

  /**
   * Record a new conversation's harness and default model from the
   * configuration, once (see `pendingHarness` and `pendingPiModel`). The
   * configuration is read with initialization, as every turn does. A failure
   * leaves both pending and fails this turn in its tab.
   */
  private async resolveHarness(session: RunningSession): Promise<void> {
    const pending = session.pendingHarness;
    if (!pending && !session.pendingPiModel) {
      return;
    }

    const configuration = await loadAgentConfiguration(this.directory);
    session.controller.signal.throwIfAborted();

    let harness: AgentHarness = session.view.harness ?? 'pi';
    if (pending === 'coding-default') {
      harness = configuration.codingDefaultHarness;
    } else if (pending === 'claude-code') {
      harness = 'claude-code';
    }
    if (pending && harness === 'claude-code') {
      adoptClaudeCode(session.view, {
        model: configuration.claudeCode.model,
        effort: configuration.claudeCode.effort,
      });
    }

    // Pin the Pi default now. Without that setting the conversation keeps the
    // older behavior of following the configured Pi coding model.
    if (
      session.pendingPiModel &&
      harness === 'pi' &&
      session.view.modelOverride === undefined &&
      configuration.codingDefaultPiModel !== undefined
    ) {
      session.view.modelOverride = configuration.codingDefaultPiModel;
    }

    session.pendingHarness = undefined;
    session.pendingPiModel = undefined;
    this.flush(session);
  }

  /**
   * Select this turn's backend from the conversation's harness and load its
   * settings afresh, so configuration edits need no restart.
   *
   * `choices` are the conversation's model/effort choices captured when this
   * turn began. Pi reads its profile settings and applies its overrides.
   * Claude Code uses the conversation's own model and effort and only reads
   * the executable, so configuration edits never change the model; only the
   * picker does. Without a Claude Code backend, the turn fails instead of
   * falling back to Pi: Pi cannot resume a Claude Code transcript.
   */
  private async prepareTurn(
    view: AgentSession,
    resume: boolean,
    choices: {
      modelOverride: string | undefined;
      thinkingOverride: AgentSettings['thinking'] | undefined;
      claudeCode: ClaudeCodeConversationSettings | undefined;
    },
  ): Promise<PreparedTurn> {
    if (view.harness === 'claude-code') {
      const backend = this.backends['claude-code'];
      if (!backend) {
        throw Error(
          'Claude Code is not available in this Companion listener, so this Claude Code conversation cannot continue',
        );
      }
      // The store only accepts a Claude Code conversation with its settings.
      const claudeCode = choices.claudeCode;
      if (!claudeCode) {
        throw Error('This Claude Code conversation has no saved model and effort');
      }

      const { executable } = await loadClaudeCodeSettings(this.directory);
      const settings: ClaudeCodeSettings = {
        executable,
        model: claudeCode.model,
        effort: claudeCode.effort,
      };

      // `view.model` still names the previous turn's model here; the caller
      // replaces it with this turn's model afterwards. A first turn has no
      // previous model to switch from.
      let previousModel: string | undefined;
      if (resume && view.model !== '' && view.model !== settings.model) {
        previousModel = view.model;
      }
      const nativeTitle = view.nativeTitle;
      return {
        model: settings.model,
        run: (request, signal, emit, replaceChoices, renameSession, exportTitle) =>
          backend.run(
            {
              ...request,
              settings,
              ...(previousModel ? { previousModel } : {}),
              ...(nativeTitle ? { nativeTitle: { ...nativeTitle } } : {}),
            },
            signal,
            emit,
            replaceChoices,
            renameSession,
            exportTitle,
          ),
      };
    }

    const settings = await loadAgentSettings(this.directory, view.profile);
    if (choices.modelOverride) {
      settings.model = choices.modelOverride;
    }
    if (choices.thinkingOverride !== undefined) {
      settings.thinking = choices.thinkingOverride;
    }
    const backend = this.backends.pi;
    return {
      model: settings.model,
      run: (request, signal, emit, replaceChoices, renameSession) =>
        backend.run({ ...request, settings }, signal, emit, replaceChoices, renameSession),
    };
  }

  /**
   * Add or update one row of the conversation and schedule its publication.
   * `createdAt` is the creation time for a new row: absent means now; a
   * number is a time listener code knows better (a timer notice); `null`
   * means unknown, for a repaired row created at an unrecorded time. It is
   * ignored for an update, which keeps the existing row's time.
   */
  private message(
    session: RunningSession,
    message: AgentMessage,
    persistTool = false,
    createdAt?: number | null,
  ): void {
    if (message.kind === 'tool' && !message.toolGroup) {
      const existingGroup = this.store.tools.groupFor(session.view.id, message.id);
      if (!persistTool && existingGroup && message.state === 'running') {
        // The RPC adapter emits cumulative partials. Do not rewrite a growing
        // blob hundreds of times in one event-loop turn. The queue holds at
        // most 16 MiB / 128 latest active partials, never completed tool history.
        const pendingBytes = [...session.pendingTools.values()]
          .filter((entry) => entry.id !== message.id)
          .concat(message)
          .reduce(
            (size, entry) =>
              size + 2 * (entry.text.length + entry.input.length + entry.toolName.length + 4),
            0,
          );
        if (pendingBytes <= 16 * 1024 * 1024 && session.pendingTools.size < 128) {
          session.pendingTools.set(message.id, message);
          session.timer ??= setTimeout(() => this.flush(session), 40);
          return;
        }
      }
      const last = session.view.messages.at(-1);
      const groupId =
        existingGroup ??
        (last?.toolGroup && !last.toolGroup.legacy && !last.toolGroup.unavailable
          ? last.id
          : randomUUID());
      const toolId = message.id;
      message = this.store.tools.put(session.view.id, message, groupId);
      session.pendingTools.delete(toolId);
    }

    // Creation time belongs to the row, not to this update: a new row is
    // stamped now (or per `createdAt`); an update keeps the existing row's
    // time, or its absence for a row saved before times were recorded. A
    // time inside `message` (for example from a backend) is never trusted.
    const index = session.view.messages.findIndex((entry) => entry.id === message.id);
    if (index < 0) {
      let newRowCreatedAt: number | undefined;
      if (createdAt === undefined) {
        newRowCreatedAt = this.clock();
      } else if (createdAt !== null) {
        newRowCreatedAt = createdAt;
      }
      message = withCreationTime(message, newRowCreatedAt);
      session.view.messages.push(message);
    } else {
      message = withCreationTime(message, session.view.messages[index].createdAt);
      session.view.messages[index] = message;
    }
    session.changed.set(message.id, message);
    session.historyRevision = (session.historyRevision ?? 0) + 1;
    if (message.kind === 'assistant' && message.state === 'done') {
      this.log('answer', message.text);
    }

    // Coalesce token bursts into at most 25 UI updates/second. Each update sends
    // only changed bubbles, not every previous tool result and completed answer.
    if (!persistTool) {
      session.timer ??= setTimeout(() => this.flush(session), 40);
    }
  }

  private flushTools(session: RunningSession): void {
    const pending = [...session.pendingTools.values()];
    session.pendingTools.clear();
    try {
      for (const message of pending) {
        this.message(session, message, true);
      }
    } catch (error) {
      // A timer cannot throw back into Pi's emit callback. Every caller of
      // flushTools publishes right after it returns.
      this.failTurnForToolStorage(session, error);
    }
  }

  /**
   * Tool details could not be stored: the listener fails the turn now. It
   * ends the turn (its duration ends here, not when the harness finishes
   * cancelling), aborts the harness and keeps the explicit storage failure
   * through the cancellation cleanup (`toolError`). The caller publishes.
   */
  private failTurnForToolStorage(session: RunningSession, error: unknown): void {
    session.toolError = `Could not save tool details: ${String(error)}`;
    session.view.status = 'error';
    session.view.error = session.toolError;
    this.endTurnNow(session, 'finished', false);
    session.controller.abort();
    this.log('agent-history', session.toolError);
  }

  private flush(session: RunningSession): void {
    clearTimeout(session.timer);
    session.timer = undefined;
    this.flushTools(session);
    // Every busy transition passes through here (turn start, follow-up,
    // drain end), so this is the single place that informs the reporter.
    // It only schedules work and can never block the conversation.
    this.liveState?.update(session.view.id, session.busy, harnessSessionId(session));
    if (session.changed.size > 0) {
      // Includes terminal tool-state recovery performed outside message().
      session.historyRevision = (session.historyRevision ?? 0) + 1;
    }
    const display = this.display(session);
    const previous = session.displayed;
    // Newly entering rows must be sent even if they were not changed in this
    // flush. Window IDs tell clients what to evict and retain in exact order.
    const messages = display.messages.filter(
      (message) => previous?.get(message.id) !== message || session.changed.has(message.id),
    );
    session.displayed = new Map(display.messages.map((message) => [message.id, message]));
    session.publishedOutcome = { status: display.status, error: display.error };
    const event: SessionEvent = {
      type: 'agent-session',
      session: { ...display, messages },
    };
    session.changed.clear();
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async stop(id: string): Promise<number> {
    const session = this.sessions.get(id);
    if (!session) {
      throw Error('Question session not found');
    }
    // First of all: the turn ends at Stop, before any timer cancellation or
    // storage work below can publish or take time.
    this.endTurnNow(session, 'cancelled', true);
    this.widgets.applications.revokeChatSend(id);
    session.controller.abort();
    session.closeAfterTurn = false;
    // Stop also withdraws a not-yet-queued application event turn. The edits
    // stay pending for the next edit or the person's next message.
    clearTimeout(session.applicationTimer);
    session.applicationTimer = undefined;
    let cancelledTimers = 0;
    try {
      cancelledTimers = this.wakes.cancelOwner(id, 'Human Stop or explicit close');
    } finally {
      delete session.view.choices;
      delete session.view.runId;
      this.cancelPending(session);
      this.flush(session);
    }
    await session.done;
    return cancelledTimers;
  }

  /**
   * The single place where a turn ends. It records the end and, unless
   * nothing reached the model, the duration (`lastTurnDurationMs`), removes
   * the published running time (`turnStartedAt`) and, with `publish`,
   * publishes both together. Callers that publish right afterwards pass
   * `publish: false`.
   *
   * Called as soon as the turn is known to be over: first thing in Stop and
   * listener shutdown, when the application service withdraws the turn's
   * own send, when the listener fails the turn (tool storage), and in
   * `run`'s finally when the harness returns. The first end stands; later
   * calls for the same turn change nothing. So a slow save, the harness's
   * cancellation cleanup or the final save are never turn time.
   *
   * Keeps the previous turn's duration (nothing reached the model) for
   * `ran-nothing`, and for `cancelled` when the turn is an application's
   * (a send or an edit event) that had not been admitted to the model yet.
   * `endedAt` defaults to now; shutdown passes one time for all turns.
   */
  private endTurnNow(
    session: RunningSession,
    how: TurnEnd,
    publish: boolean,
    endedAt: number = this.clock(),
  ): void {
    const measurement = session.turnMeasurement;
    if (!measurement || measurement.endedAt !== undefined) {
      return;
    }

    measurement.endedAt = endedAt;
    delete session.view.turnStartedAt;

    // An application's turn (its send, or the person's edits delivered as
    // an event) that is cancelled before it reached the model never ran.
    const applicationTurn =
      session.currentOrigin?.kind === 'application-message' ||
      session.currentOrigin?.kind === 'application-event';
    let measured = how !== 'ran-nothing';
    if (how === 'cancelled' && applicationTurn && session.turnAdmitted !== true) {
      measured = false;
    }
    if (measured) {
      // A clock that was set back during the turn gives 0, not a negative value.
      session.view.lastTurnDurationMs = Math.max(0, endedAt - measurement.startedAt);
    }

    if (publish) {
      this.flush(session);
    }
  }

  async remove(id: string): Promise<number> {
    const session = this.sessions.get(id);
    if (!session) {
      throw Error('Question session not found');
    }
    if (session.closing) {
      throw Error('Question session is already closing');
    }
    const refusal = this.closeGuard?.(id);
    if (refusal) {
      throw Error(refusal);
    }
    session.closing = true;
    try {
      const cancelledTimers = await this.stop(id);
      await this.widgets.deactivate(id);
      // Do not discard the visible tab if saving fails. Closing can be retried.
      await this.store.save(session.view);
      const { messages: _messages, ...summary } = session.view;
      this.previous.set(id, summary);
      this.sessions.delete(id);
      this.liveState?.forget(id);
      for (const listener of this.listeners) {
        listener({ type: 'agent-removed', id });
      }
      this.publishHistory();
      this.publishOrder();
      return cancelledTimers;
    } finally {
      session.closing = false;
      if (this.sessions.has(id)) {
        try {
          session.application = await this.widgets.applications.descriptor(id);
          for (const { record, reference } of await this.widgets.restored(id)) {
            // Like reopen's repair: a widget row missing from the transcript
            // was committed at an unrecorded time and gets none.
            const widgetRow = {
              ...chatMessage('widget:' + record.id, 'assistant', record.text),
              widget: reference,
            };
            this.message(session, widgetRow, false, null);
          }
        } catch (error) {
          this.log(
            'agent-widget',
            `Could not restore visuals after failed close: ${String(error)}`,
          );
        }
        session.view.acceptsFollowUp = !session.busy && !this.closed;
        this.flush(session);
      }
    }
  }

  /**
   * `reveal: false` adds the tab without selecting it or showing the panel.
   * An agent tool passes its turn signal: if that turn ends while the archive
   * is being read, nothing is reopened.
   */
  async reopen(id: string, reveal = true, signal?: AbortSignal): Promise<void> {
    if (this.closed || !this.previous.has(id) || this.restoring.has(id)) {
      throw new SessionToolError('rejected', 'Previous session is unavailable');
    }
    if (this.sessions.size + this.restoring.size >= MAX_OPEN_AGENT_SESSIONS) {
      throw new SessionToolError(
        'rejected',
        `Close a question tab before reopening another (${MAX_OPEN_AGENT_SESSIONS} tabs maximum)`,
      );
    }
    this.restoring.add(id);
    try {
      const view = await this.store.read(id);
      if (this.closed) {
        throw new SessionToolError('rejected', 'Agent sessions are shutting down');
      }
      // Canonical widget state repairs a display snapshot interrupted after a
      // widget commit. Missing bundles leave the saved text readable instead.
      try {
        for (const { record, reference } of await this.widgets.restored(id)) {
          const message = {
            ...chatMessage('widget:' + record.id, 'assistant', record.text),
            widget: reference,
          };
          // A widget row missing from the saved transcript was committed
          // earlier, at a time nobody recorded: it is repaired without one.
          replaceOrAppend(view.messages, message, undefined);
        }
      } catch (error) {
        this.log('agent-widget', `Could not restore visuals: ${String(error)}`);
      }
      // The session application is restored as data and view capability only;
      // reopening never starts a turn, even with pending edits.
      let application: SessionApplicationDescriptor | undefined;
      try {
        application = await this.widgets.applications.descriptor(id);
      } catch (error) {
        this.log('agent-application', `Could not restore the application: ${String(error)}`);
      }
      if (this.closed || signal?.aborted) {
        await this.widgets.deactivate(id);
        throw this.closed
          ? Error('Agent sessions are shutting down')
          : new SessionToolError(
              'expired',
              'This agent turn has ended; the conversation was not reopened',
              403,
            );
      }
      const wakes = this.wakes.list(id, 20);
      // The list puts active timers first. Missing notices are appended oldest
      // first instead, so a series' newest occurrence (its next due time) ends
      // up last, as it would have while the tab was open.
      const chronological = [...wakes].sort((first, second) => first.createdAt - second.createdAt);

      // A notice missing from the transcript takes the time its timer was
      // created (when it would have appeared while the tab was open), and a
      // missing warning row the time of the current warning occurrence; an
      // existing row keeps its own time. Reopening does not save, so a time
      // taken from the clock here would change on every reopen.
      const notices: { notice: AgentMessage; createdAt: number | undefined }[] = [];
      for (const wake of chronological) {
        notices.push({ notice: this.wakeNotice(wake), createdAt: wake.createdAt });
      }
      if (this.wakeWarningText) {
        notices.push({
          notice: chatMessage('wake-service-warning', 'notice', this.wakeWarningText),
          createdAt: this.wakeWarningAt,
        });
      }
      if (wakes.length) {
        view.wakes = wakes;
      }
      // This is authoritative history, not a bounded display page. Reconcile
      // stable notice IDs without dropping old rows or duplicating a saved warning.
      for (const { notice, createdAt } of notices) {
        replaceOrAppend(view.messages, notice, createdAt);
      }
      view.acceptsFollowUp = true;
      view.toolEpoch = randomUUID();
      // Snapshots must also keep a quiet reopen out of focus: a client can
      // miss the agent-restored event and first see this tab on reconnect.
      if (!reveal) {
        view.openInBackground = true;
      }
      this.sessions.set(id, {
        view,
        controller: new AbortController(),
        done: Promise.resolve(),
        changed: new Map(),
        pendingTools: new Map(),
        toolError: '',
        closing: false,
        busy: false,
        pending: [],
        depth: 0,
        closeAfterTurn: false,
        application,
      });
      this.previous.delete(id);
      for (const listener of this.listeners) {
        listener({
          type: 'agent-restored',
          session: this.display(this.sessions.get(id)!),
          ...(reveal ? {} : { reveal: false }),
        });
      }
      this.publishHistory();
      this.publishOrder();
    } finally {
      this.restoring.delete(id);
    }
  }

  private summary(view: PreviousSession): SessionToolSummary {
    return {
      id: view.id,
      title: view.title,
      status: view.status,
      profile: view.profile ?? 'coding',
      harness: view.harness ?? 'pi',
      // The model the next turn uses when known: a Claude conversation's own
      // model or a Pi override, otherwise the current/last turn's model.
      model: view.claudeCode?.model ?? view.modelOverride ?? view.model,
      ...(view.modelOverride ? { modelOverride: view.modelOverride } : {}),
      updatedAt: view.updatedAt,
    };
  }

  /**
   * Discoverable targets for session tools: every open tab in visible order,
   * and bounded saved summaries. Transcripts and drafts are never included.
   */
  private sessionDirectory(
    sender: string | undefined,
    query: string,
    limit: number,
  ): SessionDirectory {
    const open: OpenSessionToolSummary[] = [];
    for (const session of this.sessions.values()) {
      open.push({
        ...this.summary(session.view),
        busy: session.busy,
        queuedMessages: session.pending.length,
        self: session.view.id === sender,
      });
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = this.previousSnapshot().filter(
      (entry) => !normalizedQuery || entry.title.toLocaleLowerCase().includes(normalizedQuery),
    );
    return {
      open,
      previous: matches.slice(0, limit).map((entry) => this.summary(entry)),
      previousMatches: matches.length,
    };
  }

  /** Explain a target that is not an open tab, without revealing anything else. */
  private notOpen(id: string): SessionToolError {
    if (this.previous.has(id) || this.restoring.has(id)) {
      return new SessionToolError(
        'not-open',
        'That conversation is saved but not open. Reopen it with companion_session_reopen first.',
      );
    }
    return new SessionToolError(
      'unknown-session',
      'No Companion conversation has that id. Use an id returned by companion_sessions.',
      404,
    );
  }

  /**
   * Everything is resolved and validated before the tab exists, so a refused
   * request never leaves a tab behind. There is deliberately no fallback to
   * another model or harness.
   */
  private async startFromAgent(
    request: {
      text: string;
      profile: AgentProfile;
      /** Absent: the configured coding default (Pi for quick questions). */
      harness?: AgentHarness;
      model: string;
      focus: boolean;
      origin: AgentMessageOrigin;
    },
    signal: AbortSignal,
  ): Promise<SessionToolSummary> {
    // Quick questions always use Pi (the service refuses an explicit Claude
    // Code quick question). Only the coding default and Claude Code's model
    // and effort need the configuration file.
    let harness: AgentHarness = 'pi';
    let claudeCode: ClaudeCodeConversationSettings | undefined;
    if (request.profile === 'coding' && request.harness !== 'pi') {
      const configuration = await loadAgentConfiguration(this.directory);
      signal.throwIfAborted();
      harness = request.harness ?? configuration.codingDefaultHarness;
      if (harness === 'claude-code') {
        claudeCode = {
          model: request.model || configuration.claudeCode.model,
          effort: configuration.claudeCode.effort,
        };
      }
    }

    // Both harnesses check the model's form. Claude Code models are then
    // checked exactly by the backend when the turn starts, which fails the
    // turn visibly if Claude Code reports a different model.
    checkStartModel(harness, request.model);

    // Validate a Pi model against a fresh catalog, as the model picker does.
    if (
      harness === 'pi' &&
      request.model &&
      !(await this.models(signal)).models.includes(request.model)
    ) {
      throw new SessionToolError(
        'unavailable-model',
        `Model ${request.model} is not available in Pi. Omit model to use the ${request.profile} default.`,
      );
    }

    const id = this.create(
      {
        text: request.text,
        profile: request.profile,
        harness,
        claudeCode,
        modelOverride: harness === 'pi' && request.model ? request.model : undefined,
        origin: request.origin,
        openInBackground: !request.focus,
      },
      signal,
    );
    return this.summary(this.sessions.get(id)!.view);
  }

  private async reopenFromAgent(
    id: string,
    focus: boolean,
    signal: AbortSignal,
  ): Promise<{
    outcome: 'reopened' | 'already-open';
    session: SessionToolSummary;
    messages: number;
  }> {
    const open = this.sessions.get(id);
    if (open) {
      return {
        outcome: 'already-open',
        session: this.summary(open.view),
        messages: open.view.messages.length,
      };
    }
    if (!this.previous.has(id)) {
      throw this.notOpen(id);
    }
    await this.reopen(id, focus, signal);
    const view = this.sessions.get(id)!.view;
    return { outcome: 'reopened', session: this.summary(view), messages: view.messages.length };
  }

  private async closeFromAgent(
    id: string,
    sender: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    outcome: 'closed' | 'closing-after-turn' | 'already-closed';
    session: SessionToolSummary;
    cancelledTimers?: number;
  }> {
    const session = this.sessions.get(id);
    if (!session) {
      const saved = this.previous.get(id);
      if (saved) {
        return { outcome: 'already-closed', session: this.summary(saved) };
      }
      throw this.notOpen(id);
    }

    // Closing now would stop the calling turn from inside its own tool call.
    if (id === sender) {
      session.closeAfterTurn = true;
      const cancelledTimers = this.wakes.cancelOwner(id, 'Agent requested explicit close');
      return {
        outcome: 'closing-after-turn',
        session: this.summary(session.view),
        cancelledTimers,
      };
    }

    // Closing stops a running turn and cancels queued messages. An agent must
    // not discard another conversation's work; the user can still do so.
    if (session.busy || session.pending.length > 0 || session.closing) {
      throw new SessionToolError(
        'busy',
        'That conversation is running, closing or has queued messages, so it was left open.',
      );
    }
    if (this.closeGuard?.(id)) {
      throw new SessionToolError(
        'busy',
        'The user is recording into that conversation, so it was left open.',
      );
    }
    signal.throwIfAborted();
    const cancelledTimers = await this.remove(id);
    return { cancelledTimers, outcome: 'closed', session: this.summary(session.view) };
  }

  private sendFromAgent(
    id: string,
    text: string,
    origin: AgentMessageOrigin,
    signal: AbortSignal,
  ): { outcome: 'started' | 'queued'; queuePosition: number; session: SessionToolSummary } {
    const session = this.sessions.get(id);
    if (!session) {
      throw this.notOpen(id);
    }
    const result = this.followUp(id, text, signal, origin);
    return { ...result, session: this.summary(session.view) };
  }

  private async draftFromAgent(
    request: {
      id: string;
      text: string;
      ifDraftExists: 'reject' | 'append';
      focus: boolean;
      origin: AgentMessageOrigin;
    },
    signal: AbortSignal,
  ): Promise<AgentDraftOutcome> {
    const session = this.sessions.get(request.id);
    if (!session) {
      throw this.notOpen(request.id);
    }
    if (session.closing || this.closed) {
      return { outcome: 'unavailable', reason: 'The conversation is closing.' };
    }
    signal.throwIfAborted();
    if (!this.draftHost) {
      return { outcome: 'offline', reason: '' };
    }
    return this.draftHost(
      {
        sessionId: request.id,
        text: request.text,
        ifDraftExists: request.ifDraftExists,
        focus: request.focus,
        source:
          request.origin.kind === 'external'
            ? { kind: 'external', title: request.origin.title }
            : {
                sessionId: request.origin.kind === 'agent' ? request.origin.sessionId : request.id,
                // Session tools never build an application-event origin.
                title: request.origin.kind === 'application-event' ? '' : request.origin.title,
              },
      },
      signal,
    );
  }

  /**
   * Forward a conversation's own request to show a web page. The service has
   * already validated the address and the caller's live turn; the UI decides
   * whether this conversation is the one the user is looking at.
   */
  private async browserOpenFromAgent(
    request: { sessionId: string; url: string },
    signal: AbortSignal,
  ): Promise<AgentBrowserOpenOutcome> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw this.notOpen(request.sessionId);
    }
    if (session.closing || this.closed) {
      return { outcome: 'not-selected', reason: 'The conversation is closing.' };
    }
    signal.throwIfAborted();
    if (!this.browserHost) {
      return { outcome: 'offline', reason: '' };
    }
    return this.browserHost(request, signal);
  }

  /**
   * Forward a conversation's own request to show it in its own window or
   * return it to the sidebar. The service has already validated the request
   * and the caller's live turn. This only changes where the conversation is
   * displayed; its identity, history and queue stay exactly as they are.
   */
  private async presentFromAgent(
    request: AgentPresentRequest,
    signal: AbortSignal,
  ): Promise<AgentPresentOutcome> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw this.notOpen(request.sessionId);
    }
    if (session.closing || this.closed) {
      return { outcome: 'unavailable', reason: 'The conversation is closing.' };
    }
    signal.throwIfAborted();
    if (!this.presentationHost) {
      return { outcome: 'offline', reason: '' };
    }
    return this.presentationHost.present(request, signal);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.done));
  }

  async close(): Promise<void> {
    this.closed = true;
    // First of all, as in `stop`: every running turn ends at the same moment
    // of shutdown, before any conversation's publication (which can write
    // pending tool output) takes time. Then connected clients learn of it
    // at once instead of counting while shutdown waits.
    const shutdownAt = this.clock();
    for (const session of this.sessions.values()) {
      this.endTurnNow(session, 'cancelled', false, shutdownAt);
    }
    for (const session of this.sessions.values()) {
      this.flush(session);
      this.widgets.applications.revokeChatSend(session.view.id, 'closed');
      session.controller.abort();
      clearTimeout(session.applicationTimer);
      session.applicationTimer = undefined;
      delete session.view.choices;
      delete session.view.runId;
      session.view.acceptsFollowUp = false;
      this.cancelPending(session);
    }
    await this.idle();
    // Unread marks changed by the last reports and turns are saved before
    // the store closes, so the restarted listener restores them.
    await Promise.all([...this.unreadWrites]);
    // After idle(): every drain has ended, so the final `idle` reports are sent.
    await this.liveState?.close();
    await this.sessionTools.close();
    await this.widgets.close();
    this.listeners.clear();
    this.store.tools.close();
    await this.wakes.close();
  }
}

/**
 * Make `view` a Claude Code conversation with its own model and effort. The
 * displayed model is the Claude model from the start, before any turn runs.
 */
function adoptClaudeCode(view: AgentSession, settings: ClaudeCodeConversationSettings): void {
  view.harness = 'claude-code';
  view.claudeCode = { model: settings.model, effort: settings.effort };
  view.model = settings.model;
}

/**
 * A copy of `message` whose creation time is `createdAt`, or without one
 * when `createdAt` is undefined (a row saved before times were recorded).
 */
function withCreationTime(message: AgentMessage, createdAt: number | undefined): AgentMessage {
  const { createdAt: _ignored, ...rest } = message;
  if (createdAt === undefined) {
    return rest;
  }
  return { ...rest, createdAt };
}

/**
 * Put `message` into `messages` in place of the row with the same ID, which
 * keeps that row's creation time, or append it as a new row created at
 * `createdAt` (undefined: unknown, no time). Used where reopening repairs a
 * saved transcript directly instead of going through `message()`.
 */
function replaceOrAppend(
  messages: AgentMessage[],
  message: AgentMessage,
  createdAt: number | undefined,
): void {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index >= 0) {
    messages[index] = withCreationTime(message, messages[index].createdAt);
  } else {
    messages.push(withCreationTime(message, createdAt));
  }
}

/**
 * The agent-harness id of a Pi conversation, or undefined while the
 * conversation's harness is unresolved or it runs on Claude Code. Pi persists
 * the conversation under `--session-id <conversation id>`, and agent-harness
 * names that transcript `ses_<conversation id without dashes>`.
 */
function harnessSessionId(session: RunningSession): string | undefined {
  if (session.pendingHarness !== undefined) {
    return undefined;
  }
  if (session.view.harness === 'claude-code') {
    return undefined;
  }
  return 'ses_' + session.view.id.replaceAll('-', '').toLowerCase();
}
