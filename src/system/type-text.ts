import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from './command.ts';
import { DeliveryInterruptedError } from '../core/delivery-error.ts';

// Match Voxtype's configured extra pause between text characters.
const KEY_DELAY_MS = 1;

/**
 * Both automatic delivery and explicit history recovery use the same focus
 * guard and literal input. Manual recovery leaves pressEnter false; only the
 * explicit Enter processor enables it. Neither path changes the clipboard.
 */
export async function typeText(
  utterance: string,
  targetAddress: string,
  signal: AbortSignal,
  run: RunCommand = command,
  deliveryAllowed: () => boolean = () => true,
  deliveryStarted: () => void = () => {},
  pressEnter = false,
): Promise<boolean> {
  const focusDeadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const current = await activeWindow(focusDeadline, run);

  if (current.address !== targetAddress || !deliveryAllowed()) {
    return false;
  }

  focusDeadline.throwIfAborted();
  const text = utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');

  // wtype already waits 2 ms after key-down and 2 ms after key-up. Budget
  // those waits plus our extra spacing, with five seconds for command/desktop
  // overhead. UTF-16 length slightly overbudgets characters outside the BMP.
  // Start this budget after the separately bounded focus lookup.
  const typingTimeoutMs = 5000 + text.length * (4 + KEY_DELAY_MS);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(typingTimeoutMs)]);

  // `--` treats leading dashes literally, with no command expansion.
  // Commit the delivery marker before spawning, so even a hard crash preserves
  // uncertainty. No asynchronous gap separates the ownership claim and spawn.
  deliveryStarted();

  try {
    await run('wtype', ['-d', String(KEY_DELAY_MS), '--', text], deadline);

    if (pressEnter) {
      // Typing takes time. Recheck focus before submitting, while still owning
      // the delivery queue. A partial text-and-Enter action is interrupted.
      deadline.throwIfAborted();
      const enterFocusDeadline = AbortSignal.any([deadline, AbortSignal.timeout(5000)]);
      const afterTyping = await activeWindow(enterFocusDeadline, run);
      if (afterTyping.address !== targetAddress) {
        throw Error('Focus changed after typing; Enter not pressed');
      }

      deadline.throwIfAborted();
      await run('wtype', ['-k', 'Return'], deadline);
    }
  } catch (error) {
    throw new DeliveryInterruptedError(error);
  }

  return true;
}
