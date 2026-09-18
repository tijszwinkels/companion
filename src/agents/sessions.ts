import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { UserSensorFrame, Log } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import { agentDirectory, loadAgentSettings } from './settings.ts';
import { SessionStore } from './session-store.ts';
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
}

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
    const active = [...this.sessions.values()].filter(({ view }) =>
      ['starting', 'running'].includes(view.status),
    );
    if (active.length >= 4) {
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
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      changed: new Map([[question.id, question]]),
      closing: false,
      busy: true,
    };
    this.sessions.set(id, session);
    this.flush(session);
    session.done = this.run(
      session,
      { text: frame.utterance, screenshot: frame.screenshot },
      false,
      frame.id,
    );
    return id;
  }

  /** A typed follow-up stays in its explicit tab; no intent inference is involved. */
  followUp(id: string, text: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    const session = this.sessions.get(id);
    if (this.closed || !session || session.closing) {
      throw Error('Question session is unavailable');
    }
    if (session.busy) {
      throw Error('Wait for this answer or stop it before sending a follow-up');
    }
    if (!text.trim() || text.length > 4000) {
      throw Error('A follow-up requires 1–4000 characters');
    }
    const active = [...this.sessions.values()].filter(({ view }) =>
      ['starting', 'running'].includes(view.status),
    );
    if (active.length >= 4) {
      throw Error('Four questions are already running; stop one or wait for an answer');
    }

    this.message(session, chatMessage(`user-${randomUUID()}`, 'user', text));
    session.controller = new AbortController();
    session.busy = true;
    session.view.status = 'starting';
    session.view.error = '';
    this.flush(session);
    session.done = this.run(session, { text }, true);
  }

  private async run(
    session: RunningSession,
    prompt: Parameters<AgentBackend['run']>[0]['prompt'],
    resume: boolean,
    frameId?: number,
  ): Promise<void> {
    const turnId = randomUUID();
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
      );
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      session.view.status = session.controller.signal.aborted ? 'cancelled' : 'error';
      if (session.view.status === 'error') {
        session.view.error = error instanceof Error ? error.message : String(error);
        this.log('agent-error', session.view.error, frameId);
      }
    } finally {
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
        session.view.error = `Could not save session history: ${String(error)}`;
        this.log('agent-history', session.view.error, frameId);
      }
      session.busy = false;
      this.flush(session);
      this.log('agent', `${session.view.status}: ${session.view.id}`, frameId);
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
      this.sessions.set(id, {
        view,
        controller: new AbortController(),
        done: Promise.resolve(),
        changed: new Map(),
        closing: false,
        busy: false,
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
    }
    await this.idle();
    this.listeners.clear();
  }
}
