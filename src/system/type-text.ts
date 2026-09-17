import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from './command.ts';

/**
 * Both automatic delivery and explicit history recovery use the same focus
 * guard and literal input. The latter behaves like paste without overwriting
 * the clipboard. It never submits a message or restores a different window.
 */
export async function typeText(
  utterance: string,
  targetAddress: string,
  signal: AbortSignal,
  run: RunCommand = command,
  deliveryAllowed: () => boolean = () => true,
): Promise<boolean> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const current = await activeWindow(deadline, run);

  if (current.address !== targetAddress || !deliveryAllowed()) {
    return false;
  }

  deadline.throwIfAborted();
  const text = utterance.replace(/[\u0000-\u001f\u007f]/g, ' ');

  // `--` treats leading dashes literally. No Enter key or command expansion.
  await run('wtype', ['--', text], deadline);
  return true;
}
