import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { AgentSessions } from '../agents/sessions.ts';

const unfocusedInstruction =
  "The user has a coding agent conversation selected in the open sidebar, but its input field is not selected. Choose this intent if the utterance is a follow-up, answer, correction, or request addressed to that conversation. Use the selected conversation's title and message excerpts together with the utterance and screenshot to judge this. The open sidebar alone is not a reason to choose this intent. Choose another intent if the utterance is intended for the active application, starts an independent request to the assistant, or is not addressed to the assistant.";

/** Send a follow-up directly to the conversation captured at speech end. */
export class ContinueOpenAgentConversation implements UserSensorProcessor {
  readonly id = 'continue-agent-conversation';
  readonly label = 'Continue the open agent conversation';
  readonly name = 'CONTINUE_OPEN_AGENT_CONVERSATION';
  readonly prefixes = ['continue session'];

  // Exact user-supplied prompt, including its spacing. Use this strong default
  // only when the captured conversation's input field was actually focused.
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
    return Boolean(frame.interaction?.agentSessionId);
  }

  instructionForInference(frame: IntentContext): string {
    if (frame.interaction?.agentComposerFocused) {
      return this.instruction;
    }

    return unfocusedInstruction;
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
      this.skip(frame.id, 'Open an agent conversation before saying "continue session"');
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
    this.activity.outcome?.(frame.id, 'started', 'agent-session');
  }

  private skip(frameId: number, reason: string): void {
    this.log('skipped', reason, frameId);
    this.activity.outcome?.(frameId, 'skipped');
  }
}
