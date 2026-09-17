import type { Log, UserSensorFrame } from '../core/frame.ts';
import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from './command.ts';

interface TextInputOptions {
  log: Log;
  preview: boolean;
  run?: RunCommand;
  pressEnter?: boolean;
}

/** Shared keyboard delivery for dictation and explicit prefix commands. */
export async function typeIntoCapturedWindow(
  frame: UserSensorFrame,
  signal: AbortSignal,
  { log, preview, run = command, pressEnter = false }: TextInputOptions,
): Promise<void> {
  signal.throwIfAborted();

  // Newlines/tabs in ASR output must not submit a message or change fields.
  // Only the explicit pressEnter option can request a key after the text.
  const text = frame.utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!text.trim()) {
    log('skipped', 'No text to type', frame.id);
    return;
  }

  if (preview) {
    const suffix = pressEnter ? ' + Enter' : '';
    log('processor', `Text delivery preview: ${JSON.stringify(text)}${suffix}`, frame.id);
    return;
  }

  // Transcription, queued frames, and inference can delay delivery. Check the
  // captured window's identity now, with one deadline for the whole action.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const current = await activeWindow(deadline, run);
  if (current.address !== frame.screenshot.window.address) {
    log('skipped', 'Focus changed since capture; no text typed', frame.id);
    return;
  }

  deadline.throwIfAborted();

  // `--` makes text literal, even when it begins with '-'. Keep key commands in
  // a separate invocation so user text cannot become wtype options.
  await run('wtype', ['--', text], deadline);
  log('processor', 'Text typed into the captured window', frame.id);

  if (pressEnter) {
    // Typing itself takes time. If focus moved during delivery, do not submit
    // into the new window. Window checks and keyboard events are not atomic.
    deadline.throwIfAborted();
    const afterTyping = await activeWindow(deadline, run);
    if (afterTyping.address !== frame.screenshot.window.address) {
      log('skipped', 'Focus changed after typing; Enter not pressed', frame.id);
      return;
    }

    deadline.throwIfAborted();
    await run('wtype', ['-k', 'Return'], deadline);
    log('processor', 'Enter pressed in the captured window', frame.id);
  }
}
