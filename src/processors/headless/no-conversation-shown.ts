/**
 * Speech that goes nowhere on a listener without a desktop and without an
 * intent model (`--headless`): the browser tab that heard it shows no
 * conversation.
 *
 * Without a model, every utterance that is not a command is a message to
 * the conversation the listening tab shows (CONTINUE_OPEN_AGENT_CONVERSATION,
 * chosen by NoIntentModel). When the tab shows none (Activity, Previous
 * sessions, or a tab whose view changed since the speech was heard), the
 * utterance is chosen for this processor instead: it is not delivered, and
 * the Activity entry says why through this processor's label. It is never
 * sent anywhere else, in particular not to a conversation another tab or the
 * desktop shows.
 *
 * Registered only without an intent model: with a model, the model decides
 * (IGNORE, a new session, …). Its instruction exists because the router
 * offers only processors with one; no model ever reads it.
 *
 * Input: a frame. Output: the outcome `skipped`.
 */

import type { Activity } from '../../core/activity.ts';
import type { IntentContext, Log, ScreenlessProcessor, SensorFrame } from '../../core/frame.ts';
import type { UserSensorRouter } from '../../core/router.ts';

export class NoConversationShown implements ScreenlessProcessor {
  readonly id = 'no-conversation-shown';
  readonly label = 'Not delivered: this tab shows no conversation';
  readonly name = 'NO_CONVERSATION_SHOWN';
  readonly screenless = true;
  readonly dependencies = {};
  readonly instruction =
    'Chosen without an intent model when the browser tab that heard the utterance shows no conversation. The utterance is not delivered.';

  constructor(
    private readonly log: Log,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  /** Only when the utterance names no conversation; otherwise it is a follow-up. */
  availableForInference(context: IntentContext): boolean {
    return !context.interaction?.agentSessionId;
  }

  async process(frame: SensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.log('skipped', 'Not delivered: the tab that heard it shows no conversation', frame.id);
    this.activity.outcome?.(frame.id, 'skipped');
  }
}
