import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from './command.ts';
import { DeliveryInterruptedError } from '../core/delivery-error.ts';

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
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const current = await activeWindow(deadline, run);

  if (current.address !== targetAddress || !deliveryAllowed()) {
    return false;
  }

  deadline.throwIfAborted();
  const text = utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');

  // `--` treats leading dashes literally, with no command expansion.
  // Commit the delivery marker before spawning, so even a hard crash preserves
  // uncertainty. No asynchronous gap separates the ownership claim and spawn.
  deliveryStarted();

  try {
    await run('wtype', ['--', text], deadline);

    if (pressEnter) {
      // Typing takes time. Recheck focus before submitting, while still owning
      // the delivery queue. A partial text-and-Enter action is interrupted.
      deadline.throwIfAborted();
      const afterTyping = await activeWindow(deadline, run);
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
