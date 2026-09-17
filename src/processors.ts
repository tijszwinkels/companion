import type { Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import type { UserSensorRouter } from './router.ts';
import { activeWindow, type RunCommand } from './screen.ts';
import { command } from './command.ts';

export class SendTextToApplication implements UserSensorProcessor {
  readonly name = 'SEND_TEXT_TO_APPLICATION';
  readonly instruction = 'Choose this if the user likely wants the utterance to be sent to the currently active application as keyboard input. Only use this if the utterance seems a likely text input in the context of the currently open application and its context.';
  constructor(private readonly log: Log, private readonly preview = false, private readonly run: RunCommand = command) {}
  subscribe(router: UserSensorRouter): void { router.register(this); }
  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    if (this.preview) {
      this.log('processor', `Text delivery preview: ${JSON.stringify(frame.utterance)}`, frame.id);
      return;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const current = await activeWindow(deadline, this.run);
    if (current.address !== frame.screenshot.window.address) {
      this.log('skipped', 'Focus changed since capture; no text typed', frame.id);
      return;
    }
    deadline.throwIfAborted();
    // Newlines/tabs in ASR output must not submit a message or change fields.
    const text = frame.utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');
    await this.run('wtype', ['--', text], deadline);
    this.log('processor', 'Text typed into the captured window', frame.id);
  }
}

export class Ignore implements UserSensorProcessor {
  readonly name = 'IGNORE';
  readonly instruction = "Choose this if the utterance is likely not meant to be sent to the system in any of the other defined intents. This can happen, for example, if the user is talking to someone else, talking to himself, or listening to a podcast.";
  constructor(private readonly log: Log) {}
  subscribe(router: UserSensorRouter): void { router.register(this); }
  async process(frame: UserSensorFrame): Promise<void> {
    this.log('processor', 'Ignored', frame.id);
  }
}
