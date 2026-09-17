import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { typeText } from '../system/type-text.ts';
import type { Activity } from '../core/activity.ts';
import { DeliveryControl } from '../core/delivery-control.ts';

/** Types the original utterance if its captured window is still focused. */
export class SendTextToApplication implements UserSensorProcessor {
  readonly name = 'SEND_TEXT_TO_APPLICATION';
  private readonly delivery: DeliveryControl;

  // This is the user's prompt text; formatting must not change its contents.
  readonly instruction =
    'Choose this if the user likely wants the utterance to be sent to the currently active application as keyboard input. Only use this if the utterance seems a likely text input in the context of the currently open application and its context.';

  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly run: RunCommand = command,
    private readonly activity: Activity = {},
  ) {
    this.delivery = activity.delivery ?? new DeliveryControl();
  }

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    if (this.preview) {
      this.log('processor', `Text delivery preview: ${JSON.stringify(frame.utterance)}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    // Inference may take seconds. Re-read focus now rather than using the window
    // that happened to be active when the screenshot was captured.
    const delivered = await this.delivery.automatic(frame.id, signal, (claim) =>
      typeText(
        frame.utterance,
        frame.screenshot.window.address,
        signal,
        this.run,
        () => this.activity.deliveryAllowed?.(frame.id) !== false && claim(),
        () => this.activity.deliveryStarted?.(frame.id),
      ),
    );
    if (!delivered) {
      this.log(
        'skipped',
        'Focus changed or manual recovery superseded delivery; no text typed',
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    this.log('processor', 'Text typed into the captured window', frame.id);
    this.activity.outcome?.(frame.id, 'sent');
  }
}
