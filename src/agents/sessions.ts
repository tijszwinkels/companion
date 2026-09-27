import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { WidgetService } from '../widgets/service.ts';
import { bundledLibraryDirectory } from '../widgets/library-path.ts';
import type { WidgetLease, WidgetRecord } from '../widgets/types.ts';
import type { UserSensorFrame, Log } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import {
  agentDirectory,
  loadAgentConfiguration,
  loadAgentSettings,
  loadClaudeCodeSettings,
} from './settings.ts';
import type { ToolPage, ToolPageRequest } from './tool-transcripts.ts';
import { MAX_OPEN_AGENT_SESSIONS } from './session-limit.ts';
import { SessionStore } from './session-store.ts';
import { panelMessageLimit, panelTextLimit } from './transcript-limits.ts';
import { choiceText, parseChoices, type AgentChoice, type AgentChoiceSet } from './choices.ts';
import { parseSessionName } from './session-name.ts';
import { conversationContext, type AgentConversationContext } from './conversation-context.ts';
import { promptText } from './agent-origin.ts';
import { claudeCodeModelCatalog } from './claude/models.ts';
import {
  SessionToolError,
  SessionToolService,
  checkStartModel,
  type OpenSessionToolSummary,
  type SessionDirectory,
  type SessionToolSummary,
} from './session-tools-service.ts';
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
  type AgentDraftHost,
  type AgentDraftOutcome,
  type AgentMessage,
  type AgentMessageOrigin,
  type AgentProfile,
  type AgentSession,
  type SessionEvent,
  type PreviousSession,
} from './types.ts';

interface RunningSession {
  view: AgentSession;
  controller: AbortController;
  done: Promise<void>;
  changed: Map<string, AgentMessage>;
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
  widgetReservations: Map<string, AgentMessage>;
  modelWrite?: Promise<void>;
  /**
   * Agent-to-agent hops behind the prompt of the current/last turn: 0 for a
   * human message, otherwise its origin's depth. Session tools extend it.
   */
  depth: number;
  /**
   * The conversation's own agent asked to close it (companion_session_close).
   * It closes only after the requesting turn completes with nothing queued.
   */
  closeAfterTurn: boolean;
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
  ): Promise<void>;
}

const maxPendingFollowUps = 8;

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
  readonly sessionTools: SessionToolService;
  // The desktop runtime owns UI connections and therefore unsent drafts.
  private draftHost?: AgentDraftHost;

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
    );
    this.sessionTools = new SessionToolService({
      title: (id) => this.sessions.get(id)?.view.title,
      sourceGroupId: (sender, turnId, toolCallId) => this.sourceGroupId(sender, turnId, toolCallId),
      directory: (sender, query, limit) => this.sessionDirectory(sender, query, limit),
      start: (request, signal) => this.startFromAgent(request, signal),
      reopen: (id, focus, signal) => this.reopenFromAgent(id, focus, signal),
      close: (id, sender, signal) => this.closeFromAgent(id, sender, signal),
      send: (id, text, origin, signal) => this.sendFromAgent(id, text, origin, signal),
      draft: (request, signal) => this.draftFromAgent(request, signal),
    });
  }

  /** Install (or clear) the UI connection that can hold composer drafts. */
  setDraftHost(host: AgentDraftHost | undefined): void {
    this.draftHost = host;
  }

  private validateWidgetChanges(records: WidgetRecord[]): () => void {
    const session = this.sessions.get(records[0].owner);
    if (!session || session.closing || this.closed) {
      throw Error('Widget conversation is closing');
    }
    const messages = new Map(session.view.messages.map((message) => [message.id, message]));
    for (const record of records) {
      messages.set(
        'widget:' + record.id,
        chatMessage('widget:' + record.id, 'assistant', record.text),
      );
    }
    const size = [...messages.values()].reduce(
      (total, message) => total + message.text.length + message.input.length,
      0,
    );
    if (messages.size > panelMessageLimit || size > panelTextLimit) {
      throw Error('The panel transcript limit was reached');
    }
    // Reserve space across the atomic widget write. Concurrent streamed text
    // cannot consume it before the committed visual reaches the transcript.
    for (const record of records) {
      const id = 'widget:' + record.id;
      session.widgetReservations.set(id, messages.get(id)!);
    }
    return () => {
      for (const record of records) {
        session.widgetReservations.delete('widget:' + record.id);
      }
    };
  }

  /** Read-only startup: old conversations appear in history, without launching agents. */
  async loadPrevious(): Promise<void> {
    for (const entry of await this.store.previous(this.log)) {
      if (!this.sessions.has(entry.id)) {
        this.previous.set(entry.id, entry);
      }
    }
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
    return [...this.sessions.values()].map(({ view }) => ({
      ...view,
      messages: [...view.messages],
    }));
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
    if (session.pendingHarness) {
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
    } else if (this.activeRuns() >= 4) {
      unavailableReason = 'Four questions are already running; stop one or wait for an answer';
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
   */
  start(
    frame: UserSensorFrame,
    signal: AbortSignal,
    profile: AgentProfile = 'coding',
    harness?: AgentHarness,
  ): string {
    return this.create(
      { text: frame.utterance, screenshot: frame.screenshot, frameId: frame.id, profile, harness },
      signal,
    );
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
    if (this.activeRuns() >= 4) {
      throw new SessionToolError(
        'rejected',
        'Four questions are already running; stop one or wait for an answer',
      );
    }

    // Quick questions use Pi's local model profile; only coding conversations
    // can run in Claude Code.
    let harness = request.harness;
    if (request.profile === 'quickQuestion') {
      harness = 'pi';
    }

    const id = randomUUID();
    const question = chatMessage('user', 'user', request.text);
    question.screenshot = request.screenshot !== undefined;
    if (request.origin) {
      question.origin = request.origin;
    }
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
        runId: randomUUID(),
        acceptsFollowUp: false,
        ...(request.openInBackground ? { openInBackground: true } : {}),
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      changed: new Map([[question.id, question]]),
      pendingTools: new Map(),
      toolError: '',
      closing: false,
      busy: true,
      pending: [],
      widgetReservations: new Map(),
      depth: request.origin?.depth ?? 0,
      closeAfterTurn: false,
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
   */
  followUp(
    id: string,
    text: string,
    signal: AbortSignal,
    origin?: AgentMessageOrigin,
  ): { outcome: 'started' | 'queued'; queuePosition: number } {
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
    if (!text.trim() || text.length > 4000) {
      throw new SessionToolError('rejected', 'A follow-up requires 1–4000 characters');
    }
    if (session.pending.length >= maxPendingFollowUps) {
      throw new SessionToolError(
        'rejected',
        `This conversation already has ${maxPendingFollowUps} queued messages`,
      );
    }
    if (!session.busy && this.activeRuns() >= 4) {
      throw new SessionToolError(
        'rejected',
        'Four questions are already running; stop one or wait for an answer',
      );
    }

    const message = chatMessage(`user-${randomUUID()}`, 'user', text);
    message.state = session.busy ? 'queued' : 'done';
    if (origin) {
      message.origin = origin;
    }
    this.message(session, message);
    delete session.view.choices;
    if (session.busy) {
      session.pending.push(message);
      this.flush(session);
      return { outcome: 'queued', queuePosition: session.pending.length };
    }

    this.prepareFollowUp(session, message);
    session.done = this.drain(session, { text: promptText(text, origin) }, true);
    return { outcome: 'started', queuePosition: 0 };
  }

  private prepareFollowUp(session: RunningSession, message: AgentMessage): void {
    this.message(session, { ...message, state: 'done' });
    session.depth = message.origin?.depth ?? 0;
    session.controller = new AbortController();
    session.busy = true;
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
  ): Promise<void> {
    try {
      while (true) {
        await this.run(session, prompt, resume, frameId);
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
      }
    } finally {
      session.busy = false;
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
  ): Promise<void> {
    const turnId = randomUUID();
    // Callbacks belong to this invocation, even if a faulty backend retains one.
    let acceptingUpdates = true;
    let widgetLease: WidgetLease | undefined;
    let sessionToolLease: { endpoint: string; token: string; release(): void } | undefined;
    try {
      // A queued successor waits for an accepted model change to be durable.
      // A failed choice rolls back first, then this turn uses the old setting.
      if (session.modelWrite) {
        await session.modelWrite.catch(() => {});
      }
      const modelOverride = session.view.modelOverride;
      const thinkingOverride = session.view.thinkingOverride;
      // A Claude model choice is replaced as a whole object, so this keeps the
      // settings accepted before this turn began, like the Pi overrides above.
      let claudeCode = session.view.claudeCode;
      if (prompt.screenshot) {
        const question = session.view.messages[0];
        question.screenshotUrl = await this.store.screenshot(
          session.view.id,
          prompt.screenshot.png,
        );
        session.changed.set(question.id, question);
      }
      // A new conversation records its harness before the first save, so the
      // saved question already reopens with the harness that will answer it.
      await this.resolveHarness(session);
      // A conversation still resolving its harness refuses model choices, so
      // the freshly resolved settings are the ones this turn must use.
      claudeCode ??= session.view.claudeCode;
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
      await turn.run(
        {
          id: session.view.id,
          directory: this.directory,
          prompt,
          resume,
          widgets: widgetLease,
          sessionTools: sessionToolLease
            ? { endpoint: sessionToolLease.endpoint, token: sessionToolLease.token }
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
            this.message(session, { ...message, id: `${turnId}:${message.id}` });
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
      );
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'error';
      if (session.view.status === 'error') {
        session.view.error = error instanceof Error ? error.message : String(error);
        this.log('agent-error', session.view.error, frameId);
      }
    } finally {
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
              finished = {
                ...this.store.tools.summary(session.view.id, message.id),
                state: 'error',
              };
            } catch {
              /* Keep the visible error if storage failed. */
            }
          }
          const index = session.view.messages.indexOf(message);
          session.view.messages[index] = finished;
          session.changed.set(finished.id, finished);
        }
      }
      session.view.updatedAt = Date.now();
      try {
        await this.store.save(session.view);
      } catch (error) {
        session.view.status = 'error';
        session.view.error = `Could not save session history: ${String(error)}`;
        this.log('agent-history', session.view.error, frameId);
      }
      const completed = session.view.status === 'completed' && !session.controller.signal.aborted;
      if (completed) {
        // Keep the latest success in live snapshots, including while a queued
        // successor runs. A reconnect can then recover a missed completion.
        // This is UI state, not part of a saved/restored conversation.
        session.view.completedTurnId = turnId;
      }
      this.flush(session);
      this.log('agent', `${session.view.status}: ${session.view.id}`, frameId);
      // One event per successful turn, after persistence. Repeated snapshots,
      // reconnects, cancellations and failed saves are not completion signals.
      if (completed) {
        for (const listener of this.listeners) {
          listener({ type: 'agent-turn-completed', id: session.view.id, turnId });
        }
      }
    }
  }

  /**
   * Record a speech-started conversation's harness from the configuration,
   * once. The configuration is read with initialization, as every turn does.
   * A failure leaves the harness pending and fails this turn in its tab.
   */
  private async resolveHarness(session: RunningSession): Promise<void> {
    const pending = session.pendingHarness;
    if (!pending) {
      return;
    }

    const configuration = await loadAgentConfiguration(this.directory);
    session.controller.signal.throwIfAborted();

    let harness: AgentHarness = 'claude-code';
    if (pending === 'coding-default') {
      harness = configuration.codingDefaultHarness;
    }
    if (harness === 'claude-code') {
      adoptClaudeCode(session.view, {
        model: configuration.claudeCode.model,
        effort: configuration.claudeCode.effort,
      });
    }
    session.pendingHarness = undefined;
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
      return {
        model: settings.model,
        run: (request, signal, emit, replaceChoices, renameSession) =>
          backend.run(
            { ...request, settings, ...(previousModel ? { previousModel } : {}) },
            signal,
            emit,
            replaceChoices,
            renameSession,
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

  private message(session: RunningSession, message: AgentMessage, persistTool = false): void {
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
      if (
        new Set([
          ...session.view.messages.map((entry) => entry.id),
          ...session.widgetReservations.keys(),
          groupId,
        ]).size > panelMessageLimit
      ) {
        throw Error(
          `The panel transcript limit was reached. The full session is saved in ${harnessName(session.view)}.`,
        );
      }
      const toolId = message.id;
      message = this.store.tools.put(session.view.id, message, groupId);
      session.pendingTools.delete(toolId);
    }
    const index = session.view.messages.findIndex((entry) => entry.id === message.id);
    const reserved = new Map(session.view.messages.map((entry) => [entry.id, entry]));
    for (const [id, entry] of session.widgetReservations) {
      reserved.set(id, entry);
    }
    reserved.set(message.id, message);
    const totalSize = [...reserved.values()].reduce(
      (size, entry) => size + entry.text.length + entry.input.length,
      0,
    );
    if (totalSize > panelTextLimit || reserved.size > panelMessageLimit) {
      throw Error(
        `The panel transcript limit was reached. The full session is saved in ${harnessName(session.view)}.`,
      );
    }

    if (index < 0) {
      session.view.messages.push(message);
    } else {
      session.view.messages[index] = message;
    }
    session.changed.set(message.id, message);
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
      // A timer cannot throw back into Pi's emit callback. Abort the turn and
      // retain an explicit storage failure through its cancellation cleanup.
      session.toolError = `Could not save tool details: ${String(error)}`;
      session.view.status = 'error';
      session.view.error = session.toolError;
      session.controller.abort();
      this.log('agent-history', session.toolError);
    }
  }

  private flush(session: RunningSession): void {
    clearTimeout(session.timer);
    session.timer = undefined;
    this.flushTools(session);
    const event: SessionEvent = {
      type: 'agent-session',
      session: { ...session.view, messages: [...session.changed.values()] },
    };
    session.changed.clear();
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw Error('Question session not found');
    }
    session.controller.abort();
    delete session.view.choices;
    delete session.view.runId;
    this.cancelPending(session);
    this.flush(session);
    await session.done;
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw Error('Question session not found');
    }
    if (session.closing) {
      throw Error('Question session is already closing');
    }
    session.closing = true;
    try {
      await this.stop(id);
      await this.widgets.deactivate(id);
      // Do not discard the visible tab if saving fails. Closing can be retried.
      await this.store.save(session.view);
      const { messages: _messages, ...summary } = session.view;
      this.previous.set(id, summary);
      this.sessions.delete(id);
      for (const listener of this.listeners) {
        listener({ type: 'agent-removed', id });
      }
      this.publishHistory();
      this.publishOrder();
    } finally {
      session.closing = false;
      if (this.sessions.has(id)) {
        try {
          for (const { record, reference } of await this.widgets.restored(id)) {
            this.message(session, {
              ...chatMessage('widget:' + record.id, 'assistant', record.text),
              widget: reference,
            });
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
          const index = view.messages.findIndex((entry) => entry.id === message.id);
          if (index >= 0) {
            view.messages[index] = message;
          } else if (view.messages.length < panelMessageLimit) {
            view.messages.push(message);
          }
        }
      } catch (error) {
        this.log('agent-widget', `Could not restore visuals: ${String(error)}`);
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
        widgetReservations: new Map(),
        depth: 0,
        closeAfterTurn: false,
      });
      this.previous.delete(id);
      for (const listener of this.listeners) {
        listener({ type: 'agent-restored', session: view, ...(reveal ? {} : { reveal: false }) });
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
      return { outcome: 'closing-after-turn', session: this.summary(session.view) };
    }

    // Closing stops a running turn and cancels queued messages. An agent must
    // not discard another conversation's work; the user can still do so.
    if (session.busy || session.pending.length > 0 || session.closing) {
      throw new SessionToolError(
        'busy',
        'That conversation is running, closing or has queued messages, so it was left open.',
      );
    }
    signal.throwIfAborted();
    await this.remove(id);
    return { outcome: 'closed', session: this.summary(session.view) };
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
            : { sessionId: request.origin.sessionId, title: request.origin.title },
      },
      signal,
    );
  }

  async idle(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.done));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.controller.abort();
      delete session.view.choices;
      delete session.view.runId;
      session.view.acceptsFollowUp = false;
      this.cancelPending(session);
    }
    await this.idle();
    await this.sessionTools.close();
    await this.widgets.close();
    this.listeners.clear();
    this.store.tools.close();
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

/** The harness's user-facing name, for messages about its own transcript. */
function harnessName(view: AgentSession): string {
  if (view.harness === 'claude-code') {
    return 'Claude Code';
  }
  return 'Pi';
}
