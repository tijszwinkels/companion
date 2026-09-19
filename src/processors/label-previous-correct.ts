import type { Activity } from '../core/activity.ts';
import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';

/** Explicit evaluation feedback; never offered as an LLM-selected action. */
export class LabelPreviousCorrect implements UserSensorProcessor {
  readonly id = 'label-previous-correct';
  readonly label = 'Label previous correct';
  readonly name = 'LABEL_PREVIOUS_CORRECT';
  readonly prefixes = ['label previous correct'];
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

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    if (frame.utterance.trim()) {
      this.log('skipped', 'Label previous correct takes no following text', frame.id);
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    if (this.preview) {
      this.log('preview', 'Would label the previous intent correct', frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    const id = this.activity.labelPrevious?.(frame.id, true);

    if (!id) {
      this.log('skipped', 'No preceding intent available in history to label', frame.id);
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    this.log('feedback', `Labeled ${id} correct`, frame.id);
    this.activity.outcome?.(frame.id, 'labeled');
  }
}
