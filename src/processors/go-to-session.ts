import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import { voiceLabel } from '../core/voice-shortcut.ts';

// Accept only complete cardinal labels, never a partial or ambiguous navigation request.
const spokenNumbers = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
];

/** Reserve the entire command prefix, including invalid/out-of-range requests. */
export class GoToSession implements UserSensorProcessor {
  readonly id = 'go-to-session';
  readonly label = `Go to session 1–${MAX_OPEN_AGENT_SESSIONS}`;
  readonly name = 'GO_TO_SESSION';
  readonly prefixes = ['go to session'];
  readonly acceptsEmptyPrefix = true;
  readonly dependencies = {};

  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  availableForPrefix(context: IntentContext): boolean {
    return Boolean(context.interaction?.agentNavigation?.ids.length);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const label = voiceLabel(frame.utterance);
    const index = /^(?:[1-9]|[1-9][0-9])$/u.test(label)
      ? Number(label) - 1
      : spokenNumbers.indexOf(label);
    const context = frame.interaction;
    if (index < 0 || index >= MAX_OPEN_AGENT_SESSIONS || !context?.agentNavigation?.ids[index]) {
      this.log(
        'skipped',
        `Go to session requires an existing session number from 1 to ${MAX_OPEN_AGENT_SESSIONS}`,
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }
    if (this.preview) {
      this.log('preview', `Would select session ${index + 1}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }
    const selected = this.activity.selectSession?.(context, index) === true;
    this.log(
      selected ? 'session' : 'skipped',
      selected
        ? `Selected session ${index + 1}`
        : 'Session navigation target changed while processing',
      frame.id,
    );
    this.activity.outcome?.(frame.id, selected ? 'selected' : 'skipped');
  }
}
