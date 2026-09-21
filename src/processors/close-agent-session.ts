import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { AgentSessions } from '../agents/sessions.ts';

/** Close the captured visible conversation, retaining its saved transcript. */
export class CloseAgentSession implements UserSensorProcessor {
  readonly id = 'close-agent-session';
  readonly label = 'Close session';
  readonly name = 'CLOSE_AGENT_SESSION';
  readonly prefixes = ['close session'];
  readonly acceptsEmptyPrefix = true;

  // Closing is an explicit command, never an LLM inference option.
  constructor(
    readonly dependencies: { sessions: AgentSessions },
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  availableForPrefix(context: IntentContext): boolean {
    return Boolean(context.interaction?.agentSessionId);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const context = frame.interaction;

    // A longer utterance or a changed tab cannot accidentally close a session.
    // The router has already stripped the command and its ASR punctuation.
    if (
      frame.utterance.trim() ||
      !context?.agentSessionId ||
      !this.dependencies.sessions.has(context.agentSessionId) ||
      !this.activity.interactionCurrent?.(context)
    ) {
      this.log(
        'skipped',
        'Close session requires the same selected conversation and no extra text',
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    if (this.preview) {
      this.log('preview', `Would close session ${context.agentSessionId}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    // Share the tab's close operation: stop the current run, cancel queued turns,
    // save, then remove. A failed save retains the tab so closing can be retried.
    await this.dependencies.sessions.remove(context.agentSessionId);
    this.log('agent', `Closed session ${context.agentSessionId}`, frame.id);
    this.activity.outcome?.(frame.id, 'closed');
  }
}
