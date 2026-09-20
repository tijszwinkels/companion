import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { AgentSessions } from '../agents/sessions.ts';

/** Send a follow-up directly to the conversation captured at speech end. */
export class ContinueOpenAgentConversation implements UserSensorProcessor {
  readonly id = 'continue-agent-conversation';
  readonly label = 'Continue the open agent conversation';
  readonly name = 'CONTINUE_OPEN_AGENT_CONVERSATION';
  readonly prefixes = ['message coding agent'];

  // Exact user-supplied prompt, including its spacing. Only offer it when its
  // premise was true in the captured interaction, not merely when a tab exists.
  readonly instruction =
    'The user has  a coding agent session open and has the input field selected. Unless your context gives you strong reasons to think that the user has a different intention, select this intent.';

  constructor(
    readonly dependencies: { sessions: AgentSessions },
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  availableForInference(frame: IntentContext): boolean {
    return Boolean(frame.interaction?.agentSessionId && frame.interaction.agentComposerFocused);
  }

  availableForPrefix(frame: IntentContext): boolean {
    return Boolean(frame.interaction?.agentSessionId);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const context = frame.interaction;

    // Explicit voice prefixes need an open chat but not a focused textbox. They
    // never fall through to keyboard typing, create a new chat, or pick another
    // tab if the originally captured one disappeared during transcription.
    if (!context?.agentSessionId) {
      this.skip(frame.id, 'Open an agent conversation before saying "message coding agent"');
      return;
    }
    if (
      !this.dependencies.sessions.has(context.agentSessionId) ||
      !this.activity.interactionCurrent?.(context)
    ) {
      this.skip(frame.id, 'The selected agent conversation or its focus changed');
      return;
    }

    if (this.preview) {
      this.log(
        'preview',
        `Would message agent ${context.agentSessionId}: ${frame.utterance}`,
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    // The session manager queues this behind any current answer, just as it
    // does for typed input. Acceptance is independent of microphone pause.
    this.dependencies.sessions.followUp(context.agentSessionId, frame.utterance, signal);
    this.log('agent', `Continued question ${context.agentSessionId}`, frame.id);
    this.activity.outcome?.(frame.id, 'started');
  }

  private skip(frameId: number, reason: string): void {
    this.log('skipped', reason, frameId);
    this.activity.outcome?.(frameId, 'skipped');
  }
}
