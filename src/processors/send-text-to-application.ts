import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { typeIntoCapturedWindow } from '../system/text-input.ts';
import type { Activity } from '../core/activity.ts';
import { DeliveryControl } from '../core/delivery-control.ts';

/** Types dictated text, selected either by the LLM or by an explicit "insert". */
export class SendTextToApplication implements UserSensorProcessor {
  readonly name = 'SEND_TEXT_TO_APPLICATION';
  readonly prefixes = ['insert'];
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
    await typeIntoCapturedWindow(frame, signal, {
      log: this.log,
      preview: this.preview,
      run: this.run,
      activity: this.activity,
      delivery: this.delivery,
    });
  }
}
