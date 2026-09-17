import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { typeIntoCapturedWindow } from '../system/text-input.ts';

/** An explicit "enter …" command types its payload and then presses Enter. */
export class EnterTextToApplication implements UserSensorProcessor {
  readonly name = 'ENTER_TEXT_TO_APPLICATION';
  readonly prefixes = ['enter'];

  // No instruction: the LLM cannot select an action that submits text.
  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly run: RunCommand = command,
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    await typeIntoCapturedWindow(frame, signal, {
      log: this.log,
      preview: this.preview,
      run: this.run,
      pressEnter: true,
    });
  }
}
