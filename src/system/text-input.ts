import type { Log, UserSensorFrame } from '../core/frame.ts';
import type { RunCommand } from '../sensors/screen/capture.ts';
import type { Activity } from '../core/activity.ts';
import type { DeliveryControl } from '../core/delivery-control.ts';
import { command } from './command.ts';
import { typeText } from './type-text.ts';

interface TextInputOptions {
  log: Log;
  preview: boolean;
  run?: RunCommand;
  pressEnter?: boolean;
  activity: Activity;
  delivery: DeliveryControl;
}

/** Shared keyboard delivery for dictation and explicit prefix commands. */
export async function typeIntoCapturedWindow(
  frame: UserSensorFrame,
  signal: AbortSignal,
  { log, preview, run = command, pressEnter = false, activity, delivery }: TextInputOptions,
): Promise<void> {
  signal.throwIfAborted();

  // Newlines/tabs in ASR output must not submit a message or change fields.
  // Only the explicit pressEnter option can request a key after the text.
  const text = frame.utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!text.trim()) {
    log('skipped', 'No text to type', frame.id);
    activity.outcome?.(frame.id, 'skipped');
    return;
  }

  if (preview) {
    const suffix = pressEnter ? ' + Enter' : '';
    log('processor', `Text delivery preview: ${JSON.stringify(text)}${suffix}`, frame.id);
    activity.outcome?.(frame.id, 'preview');
    return;
  }

  // The queue covers text AND Enter. Manual recovery cannot interleave with
  // either command, and focus is checked only after earlier writers finish.
  const delivered = await delivery.automatic(frame.id, signal, (claim) =>
    typeText(
      text,
      frame.screenshot.window.address,
      signal,
      run,
      () => activity.deliveryAllowed?.(frame.id) !== false && claim(),
      () => activity.deliveryStarted?.(frame.id),
      pressEnter,
    ),
  );

  if (!delivered) {
    log('skipped', 'Focus changed or manual recovery superseded delivery; no text typed', frame.id);
    activity.outcome?.(frame.id, 'skipped');
    return;
  }

  log('processor', 'Text typed into the captured window', frame.id);
  if (pressEnter) {
    log('processor', 'Enter pressed in the captured window', frame.id);
  }
  activity.outcome?.(frame.id, 'sent');
}
