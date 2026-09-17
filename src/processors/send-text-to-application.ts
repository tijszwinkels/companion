import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';
import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';

/** Types the original utterance if its captured window is still focused. */
export class SendTextToApplication implements UserSensorProcessor {
  readonly name = 'SEND_TEXT_TO_APPLICATION';

  // This is the user's prompt text; formatting must not change its contents.
  readonly instruction =
    'Choose this if the user likely wants the utterance to be sent to the currently active application as keyboard input. Only use this if the utterance seems a likely text input in the context of the currently open application and its context.';

  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly run: RunCommand = command,
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    if (this.preview) {
      this.log('processor', `Text delivery preview: ${JSON.stringify(frame.utterance)}`, frame.id);
      return;
    }

    // Inference may take seconds. Re-read focus now rather than using the window
    // that happened to be active when the screenshot was captured.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const current = await activeWindow(deadline, this.run);

    if (current.address !== frame.screenshot.window.address) {
      this.log('skipped', 'Focus changed since capture; no text typed', frame.id);
      return;
    }

    deadline.throwIfAborted();

    // Newlines/tabs in ASR output must not submit a message or change fields.
    const text = frame.utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');

    // `--` makes the utterance a literal argument, even when it begins with '-'.
    // This types text only: no Enter key, clipboard operation, or focus restore.
    await this.run('wtype', ['--', text], deadline);

    this.log('processor', 'Text typed into the captured window', frame.id);
  }
}
