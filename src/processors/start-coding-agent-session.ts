import type { Activity } from '../core/activity.ts';
import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { AgentProfile } from '../agents/types.ts';

/** Start an independent question with the same captured context as detection. */
export class StartCodingAgentSession implements UserSensorProcessor {
  readonly id: string = 'start-agent-session';
  readonly label: string = 'Start a coding session';
  readonly name: string = 'START_CODING_AGENT_SESSION';
  readonly prefixes: readonly string[] = ['new session'];
  readonly instruction: string | undefined =
    'Choose this if the user is asking the AI assistant on this computer a question or requesting its help, including a question about what is visible on the screen. Do not choose this for text that the user is dictating into the active application or for speech not addressed to the assistant.';

  protected readonly profile: AgentProfile = 'coding';

  constructor(
    readonly dependencies: { sessions: AgentSessions },
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.preview) {
      this.log('preview', `Would ask Pi (${this.profile}): ${frame.utterance}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    const id = this.dependencies.sessions.start(frame, signal, this.profile);
    this.log('agent', `Started question ${id}`, frame.id);
    this.activity.outcome?.(frame.id, 'started', 'new-agent-session');
  }
}
