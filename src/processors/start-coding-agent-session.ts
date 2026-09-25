import type { Activity } from '../core/activity.ts';
import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { AgentHarness, AgentProfile } from '../agents/types.ts';

/** Start an independent question with the same captured context as detection. */
export class StartCodingAgentSession implements UserSensorProcessor {
  readonly id: string = 'start-agent-session';
  readonly label: string = 'Start a coding session';
  readonly name: string = 'START_CODING_AGENT_SESSION';
  readonly prefixes: readonly string[] = ['new session'];
  readonly instruction: string | undefined =
    'Choose this if the user is asking the AI assistant on this computer a question or requesting its help, including a question about what is visible on the screen. Do not choose this for text that the user is dictating into the active application or for speech not addressed to the assistant.';

  protected readonly profile: AgentProfile = 'coding';
  /** Absent: the configured `codingDefaultHarness`, read when the first turn starts. */
  protected readonly harness: AgentHarness | undefined = undefined;

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
      this.log(
        'preview',
        `Would ask ${this.agentName()} (${this.profile}): ${frame.utterance}`,
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    const id = this.dependencies.sessions.start(frame, signal, this.profile, this.harness);
    this.log('agent', `Started question ${id}`, frame.id);
    this.activity.outcome?.(frame.id, 'started', 'new-agent-session');
  }

  /** For preview logs only. Quick questions always use Pi. */
  private agentName(): string {
    if (this.harness === 'claude-code') {
      return 'Claude Code';
    }
    if (this.harness === 'pi' || this.profile === 'quickQuestion') {
      return 'Pi';
    }
    return 'the configured coding harness';
  }
}
