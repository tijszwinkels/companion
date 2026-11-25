/**
 * "insert …" and "enter …" on a listener without a desktop (`--headless`).
 *
 * With a desktop these commands type into the application in front
 * (SEND_TEXT_TO_APPLICATION, ENTER_TEXT_TO_APPLICATION). Without one there is
 * no application and nothing to type with, so the same prefixes are refused
 * here instead: nothing is typed, nothing is delivered elsewhere, and the
 * Activity entry says why through this processor's label. It has no
 * instruction, so an intent model can never choose it.
 *
 * Input: a frame routed by its prefix. Output: the outcome `skipped`.
 */

import type { Activity } from '../../core/activity.ts';
import type { Log, ScreenlessProcessor, SensorFrame } from '../../core/frame.ts';
import type { UserSensorRouter } from '../../core/router.ts';

/** The reason, worded like the runtime's refusals of `paste` and `submit-utterance`. */
export const typingWithoutDesktopReason =
  'This Companion runs without a desktop: it cannot type into applications.';

export class TypingWithoutDesktop implements ScreenlessProcessor {
  readonly id = 'typing-without-desktop';
  readonly label = 'Not typed: this Companion runs without a desktop';
  readonly name = 'TYPING_WITHOUT_DESKTOP';
  readonly screenless = true;
  readonly prefixes = ['insert', 'enter'];
  // "insert" alone is refused with the same reason, not as an empty command.
  readonly acceptsEmptyPrefix = true;
  readonly dependencies = {};

  constructor(
    private readonly log: Log,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: SensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.log('skipped', typingWithoutDesktopReason, frame.id);
    this.activity.outcome?.(frame.id, 'skipped');
  }
}
