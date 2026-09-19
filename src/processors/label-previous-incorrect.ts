import type { Activity } from '../core/activity.ts';
import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';

/** Negative feedback records a mistake without guessing the intended action. */
export class LabelPreviousIncorrect implements UserSensorProcessor {
  readonly id = 'label-previous-incorrect';
  readonly label = 'Label previous incorrect';
  readonly name = 'LABEL_PREVIOUS_INCORRECT';
  // Also accept the transcription spelling used when this shortcut was requested.
  readonly prefixes = ['label previous incorrect', 'label previous incorrent'];
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
      this.log('skipped', 'Label previous incorrect takes no following text', frame.id);
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    if (this.preview) {
      this.log('preview', 'Would label the previous intent incorrect', frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    const id = this.activity.labelPrevious?.(frame.id, false);

    if (!id) {
      this.log('skipped', 'No preceding intent available in history to label', frame.id);
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    this.log('feedback', `Labeled ${id} incorrect`, frame.id);
    this.activity.outcome?.(frame.id, 'labeled');
  }
}
