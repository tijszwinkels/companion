import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { typeIntoCapturedWindow } from '../system/text-input.ts';
import type { Activity } from '../core/activity.ts';
import { DeliveryControl } from '../core/delivery-control.ts';

/** An explicit "enter …" command types its payload and then presses Enter. */
export class EnterTextToApplication implements UserSensorProcessor {
  readonly label = 'Type text and Enter';
  readonly name = 'ENTER_TEXT_TO_APPLICATION';
  readonly prefixes = ['enter'];
  readonly dependencies: { readonly delivery: DeliveryControl };

  // No instruction: the LLM cannot select an action that submits text.
  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly run: RunCommand = command,
    private readonly activity: Activity = {},
    readonly id = 'enter-text',
  ) {
    this.dependencies = {
      delivery: activity.delivery ?? new DeliveryControl(`keyboard-${id}`),
    };
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
      delivery: this.dependencies.delivery,
      pressEnter: true,
    });
  }
}
