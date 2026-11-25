/**
 * The intent "detector" of a listener without a desktop and without an
 * intent model (`npm start -- --headless`, the default there).
 *
 * Commands never reach a detector: their prefixes ("new session …", "go to
 * session N", "close session", "insert …"), and exact labels such as "stop",
 * are routed before inference (UserSensorRouter). Every other utterance is
 * decided here by a fixed rule instead of a model:
 *
 * 1. the listening tab shows a conversation: a message to it
 *    (CONTINUE_OPEN_AGENT_CONVERSATION, offered only then);
 * 2. it shows none: not delivered (NO_CONVERSATION_SHOWN);
 * 3. both switched off in the settings: IGNORE.
 *
 * The rule uses only which intents the router offers for this frame, so the
 * intent switches and the existing staleness checks of the processors apply
 * unchanged. No request leaves the machine. See "Running without a desktop"
 * in src/desktop/README.md.
 */

import type { Intent, SensorFrame } from './frame.ts';
import type { Detector } from './router.ts';

/** The rule above, in order of preference. IGNORE is always offered. */
const ruleOrder = ['CONTINUE_OPEN_AGENT_CONVERSATION', 'NO_CONVERSATION_SHOWN'] as const;

export class NoIntentModel implements Detector {
  readonly id = 'no-intent-model';
  readonly label = 'No intent model (fixed rule)';
  readonly dependencies = {};

  async detect(frame: SensorFrame, intents: readonly Intent[], signal: AbortSignal) {
    return this.choose(intents, signal);
  }

  async detectWithoutScreenshot(
    frame: SensorFrame,
    intents: readonly Intent[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.choose(intents, signal);
  }

  private choose(intents: readonly Intent[], signal: AbortSignal): string {
    signal.throwIfAborted();

    for (const name of ruleOrder) {
      if (intents.some((intent) => intent.name === name)) {
        return name;
      }
    }
    return 'IGNORE';
  }
}
