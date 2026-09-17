import type { Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import type { UserSensorRouter } from './router.ts';
import { activeWindow, type RunCommand } from './screen.ts';
import { command } from './command.ts';

export class SendTextToApplication implements UserSensorProcessor {
  readonly name = 'SEND_TEXT_TO_APPLICATION';
  readonly instruction = 'The user wants the utterance to be sent to the currently active application as keyboard input. Perhaps the user is trying to edit a document, or send a message. Based on the content on the screen, it is likely that the user wants to send this utterance to the currently active application. If so, send SEND_TEXT_TO_APPLICATION as intent.';
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
  readonly instruction = "The user is talking to someone else, or listening to a video, or talking to himself. Perhaps someone else is talking, or the transcription service picked up some sound and transcribed it, even if the user wasn't saying anything. If the text that is heard is not likely to be meant for any of the other intents, sent IGNORE as intent name.";
  constructor(private readonly log: Log) {}
  subscribe(router: UserSensorRouter): void { router.register(this); }
  async process(frame: UserSensorFrame): Promise<void> {
    this.log('processor', 'Ignored', frame.id);
  }
}
