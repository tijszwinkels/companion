import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { UserSensorFrame, Log } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import { agentDirectory, loadAgentSettings } from './settings.ts';
import { SessionStore } from './session-store.ts';
import { choiceText, parseChoices, type AgentChoiceSet } from './choices.ts';
import { parseSessionName } from './session-name.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentMessage,
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

  constructor(
    readonly dependencies: { backend: AgentBackend },
    private readonly log: Log,
    private readonly directory = agentDirectory(),
  ) {
    this.store = new SessionStore(join(directory, '.companion-sessions'));
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

  has(id: string): boolean {
    return this.sessions.has(id);
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

  start(frame: UserSensorFrame, signal: AbortSignal): string {
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
        model: '',
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
      const settings = await loadAgentSettings(this.directory);
      session.controller.signal.throwIfAborted();
      session.view.model = settings.model;
      session.view.status = 'running';
      this.flush(session);
      await this.dependencies.backend.run(
        { id: session.view.id, directory: this.directory, settings, prompt, resume },
        session.controller.signal,
        (message) => this.message(session, { ...message, id: `${turnId}:${message.id}` }),
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
      if (session.view.status !== 'completed') {
        delete session.view.choices;
      }
      delete session.view.runId;
      if (session.view.status !== 'completed' || session.controller.signal.aborted) {
        this.cancelPending(session);
      }
      // A stopped partial answer/tool must not retain a running spinner.
      for (const message of session.view.messages) {
        if (message.state === 'running') {
          const finished = { ...message, state: 'error' as const };
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
      this.flush(session);
      this.log('agent', `${session.view.status}: ${session.view.id}`, frameId);
      // One event per successful turn, after persistence. Repeated snapshots,
      // reconnects, cancellations and failed saves are not completion signals.
      if (session.view.status === 'completed' && !session.controller.signal.aborted) {
        for (const listener of this.listeners) {
          listener({ type: 'agent-turn-completed', id: session.view.id, turnId });
        }
      }
    }
  }

  private message(session: RunningSession, message: AgentMessage): void {
    const index = session.view.messages.findIndex((entry) => entry.id === message.id);
    const otherSize = session.view.messages.reduce(
      (size, entry) =>
        size + (entry.id === message.id ? 0 : entry.text.length + entry.input.length),
      0,
    );
    if (
      otherSize + message.text.length + message.input.length > 256 * 1024 ||
      (index < 0 && session.view.messages.length >= 200)
    ) {
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
      view.acceptsFollowUp = true;
      this.sessions.set(id, {
        view,
        controller: new AbortController(),
        done: Promise.resolve(),
        changed: new Map(),
        closing: false,
        busy: false,
        pending: [],
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
    this.listeners.clear();
  }
}
