import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { WidgetService } from '../widgets/service.ts';
import type { WidgetLease, WidgetRecord } from '../widgets/types.ts';
import type { UserSensorFrame, Log } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import { agentDirectory, loadAgentSettings } from './settings.ts';
import type { ToolPage, ToolPageRequest } from './tool-transcripts.ts';
import { SessionStore } from './session-store.ts';
import { panelMessageLimit, panelTextLimit } from './transcript-limits.ts';
import { choiceText, parseChoices, type AgentChoiceSet } from './choices.ts';
import { parseSessionName } from './session-name.ts';
import { conversationContext, type AgentConversationContext } from './conversation-context.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentMessage,
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
  timer?: ReturnType<typeof setTimeout>;
  // Closing blocks new turns until the archive write settles. Busy also covers
  // final persistence, when the displayed model status may already be terminal.
  closing: boolean;
  busy: boolean;
  pending: AgentMessage[];
  widgetReservations: Map<string, AgentMessage>;
}

const maxPendingFollowUps = 8;

/**
 * Owns independent question lifetimes. The sensor worker only hands off a frame;
 * it never waits for a long answer. Microphone pause therefore does not cancel
 * accepted questions. Stop, close-tab, and application shutdown do cancel them.
 * Closed tabs are saved for reopening. Pi owns the resumable model transcript;
 * Companion owns its display transcript and the original screenshot attachment.
 */
export class AgentSessions implements InspectableModule {
  readonly id = 'agent-sessions';
  readonly label = 'Question sessions';
  private readonly sessions = new Map<string, RunningSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private closed = false;
  private readonly previous = new Map<string, PreviousSession>();
  private readonly restoring = new Set<string>();
  private readonly store: SessionStore;
  private readonly widgets: WidgetService;

  constructor(
    readonly dependencies: { backend: AgentBackend },
    private readonly log: Log,
    private readonly directory = agentDirectory(),
  ) {
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
      undefined,
      undefined,
      (records) => this.validateWidgetChanges(records),
    );
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
    return this.store.tools.page(request);
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

  start(frame: UserSensorFrame, signal: AbortSignal, profile: AgentProfile = 'coding'): string {
    signal.throwIfAborted();
    if (this.closed) {
      throw Error('Agent sessions are shutting down');
    }
    if (this.sessions.size + this.restoring.size >= 12) {
      throw Error('Close a question tab before starting another (12 tabs maximum)');
    }
    if (this.activeRuns() >= 4) {
      throw Error('Four questions are already running; stop one or wait for an answer');
    }

    const id = randomUUID();
    const question = chatMessage('user', 'user', frame.utterance);
    question.screenshot = true;
    const session: RunningSession = {
      view: {
        id,
        title: frame.utterance.slice(0, 80),
        status: 'starting',
        toolEpoch: randomUUID(),
        model: '',
        profile,
        error: '',
        messages: [question],
        updatedAt: Date.now(),
        runId: randomUUID(),
        acceptsFollowUp: false,
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      changed: new Map([[question.id, question]]),
      closing: false,
      busy: true,
      pending: [],
      widgetReservations: new Map(),
    };
    this.sessions.set(id, session);
    this.flush(session);
    session.done = this.drain(
      session,
      { text: frame.utterance, screenshot: frame.screenshot },
      false,
      frame.id,
    );
    return id;
  }

  /** Spoken and typed follow-ups share one FIFO, owned by their captured tab. */
  followUp(id: string, text: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    const session = this.sessions.get(id);
    if (this.closed || !session || session.closing) {
      throw Error('Question session is unavailable');
    }
    if (session.busy && session.controller.signal.aborted) {
      throw Error('Wait for this question to stop before sending a follow-up');
    }
    if (!text.trim() || text.length > 4000) {
      throw Error('A follow-up requires 1–4000 characters');
    }
    if (session.pending.length >= maxPendingFollowUps) {
      throw Error(`This conversation already has ${maxPendingFollowUps} queued messages`);
    }
    if (!session.busy && this.activeRuns() >= 4) {
      throw Error('Four questions are already running; stop one or wait for an answer');
    }

    const message = chatMessage(`user-${randomUUID()}`, 'user', text);
    message.state = session.busy ? 'queued' : 'done';
    this.message(session, message);
    delete session.view.choices;
    if (session.busy) {
      session.pending.push(message);
      this.flush(session);
      return;
    }

    this.prepareFollowUp(session, message);
    session.done = this.drain(session, { text }, true);
  }

  private prepareFollowUp(session: RunningSession, message: AgentMessage): void {
    this.message(session, { ...message, state: 'done' });
    session.controller = new AbortController();
    session.busy = true;
    session.view.status = 'starting';
    session.view.error = '';
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
   * work. Await both the backend and its final save before resuming Pi. Once
   * accepted, a message is independent of microphone pause and UI tab changes.
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
          this.cancelPending(session);
          delete session.view.choices;
          return;
        }

        const next = session.pending.shift();
        if (!next) {
          return;
        }
        this.prepareFollowUp(session, next);
        prompt = { text: next.text };
        resume = true;
        frameId = undefined;
      }
    } finally {
      session.busy = false;
      session.view.acceptsFollowUp = !session.closing && !this.closed;
      this.flush(session);
    }
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
    try {
      if (prompt.screenshot) {
        const question = session.view.messages[0];
        question.screenshotUrl = await this.store.screenshot(
          session.view.id,
          prompt.screenshot.png,
        );
        session.changed.set(question.id, question);
      }
      // Save the question before launching Pi. An interrupted turn can still be
      // found in history after a restart and is shown as stopped, never running.
      session.view.updatedAt = Date.now();
      await this.store.save(session.view);
      session.controller.signal.throwIfAborted();
      const settings = await loadAgentSettings(this.directory, session.view.profile);
      session.controller.signal.throwIfAborted();
      session.view.model = settings.model;
      session.view.status = 'running';
      this.flush(session);
      try {
        widgetLease = await this.widgets.lease(session.view.id, session.controller.signal);
      } catch (error) {
        session.controller.signal.throwIfAborted();
        // A damaged visual cache must not block an ordinary answer/follow-up.
        this.log('agent-widget', `Widget tools unavailable: ${String(error)}`, frameId);
      }
      await this.dependencies.backend.run(
        {
          id: session.view.id,
          directory: this.directory,
          settings,
          prompt,
          resume,
          widgets: widgetLease,
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
      widgetLease?.release();
      if (session.view.status !== 'completed') {
        delete session.view.choices;
      }
      delete session.view.runId;
      if (session.view.status !== 'completed' || session.controller.signal.aborted) {
        this.cancelPending(session);
      }
      try {
        this.store.tools.stop(session.view.id);
      } catch (error) {
        session.view.status = 'error';
        session.view.error = `Could not finalize tool details: ${String(error)}`;
        this.log('agent-history', session.view.error, frameId);
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

  private message(session: RunningSession, message: AgentMessage): void {
    if (message.kind === 'tool' && !message.toolGroup) {
      const last = session.view.messages.at(-1);
      const groupId =
        this.store.tools.groupFor(session.view.id, message.id) ??
        (last?.toolGroup ? last.id : randomUUID());
      if (
        new Set([
          ...session.view.messages.map((entry) => entry.id),
          ...session.widgetReservations.keys(),
          groupId,
        ]).size > panelMessageLimit
      ) {
        throw Error('The panel transcript limit was reached. The full session is saved in Pi.');
      }
      message = this.store.tools.put(session.view.id, message, groupId);
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
      throw Error('The panel transcript limit was reached. The full session is saved in Pi.');
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
    session.timer ??= setTimeout(() => this.flush(session), 40);
  }

  private flush(session: RunningSession): void {
    clearTimeout(session.timer);
    session.timer = undefined;
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

  async reopen(id: string): Promise<void> {
    if (this.closed || !this.previous.has(id) || this.restoring.has(id)) {
      throw Error('Previous session is unavailable');
    }
    if (this.sessions.size + this.restoring.size >= 12) {
      throw Error('Close a question tab before reopening another (12 tabs maximum)');
    }
    this.restoring.add(id);
    try {
      const view = await this.store.read(id);
      if (this.closed) {
        throw Error('Agent sessions are shutting down');
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
      if (this.closed) {
        await this.widgets.deactivate(id);
        throw Error('Agent sessions are shutting down');
      }
      view.acceptsFollowUp = true;
      view.toolEpoch = randomUUID();
      this.sessions.set(id, {
        view,
        controller: new AbortController(),
        done: Promise.resolve(),
        changed: new Map(),
        closing: false,
        busy: false,
        pending: [],
        widgetReservations: new Map(),
      });
      this.previous.delete(id);
      for (const listener of this.listeners) {
        listener({ type: 'agent-restored', session: view });
      }
      this.publishHistory();
    } finally {
      this.restoring.delete(id);
    }
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
    await this.widgets.close();
    this.listeners.clear();
    this.store.tools.close();
  }
}
