import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { IntentMode, UserSensorRouter } from '../core/router.ts';
import { inferredIndex, shortcutIndex } from './go-to-session.ts';

/**
 * "Pop out session N": show one of the conversations listed in the sidebar in
 * its own window, by the same session number "go to session N" uses.
 *
 * This is session navigation with another presentation, so it shares
 * GO_TO_SESSION's number rules (exactly one explicit number from 1 to 16,
 * never a guess) and its captured navigation: the order and owning UI
 * captured before transcription, rechecked by the runtime before dispatch.
 * The UI then uses its ordinary Pop out operation, which moves the existing
 * conversation and its unsent text into a window, or focuses the window it
 * already has. Nothing is created, cloned or sent to the conversation.
 *
 * Offered only while the UI that owns navigation can show pop-out windows
 * (the standalone native host); otherwise the command does not exist.
 */
export class PopOutSession implements UserSensorProcessor {
  readonly id = 'pop-out-session';
  readonly label = `Pop out session 1–${MAX_OPEN_AGENT_SESSIONS}`;
  readonly name = 'POP_OUT_SESSION';
  readonly prefixes = ['pop out session'];
  readonly acceptsEmptyPrefix = true;
  readonly dependencies = {};

  readonly instruction =
    'Choose this if the user asks to pop out, or open in its own separate window, one of the conversations listed in the assistant sidebar by its session number, for example "pop out session three". Do not choose this for text that the user is dictating into the active application, for only switching to or showing a session in the sidebar, or for a request to start, continue or close a conversation.';

  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  availableForInference(context: IntentContext): boolean {
    return this.available(context);
  }

  availableForPrefix(context: IntentContext): boolean {
    return this.available(context);
  }

  private available(context: IntentContext): boolean {
    const navigation = context.interaction?.agentNavigation;
    return Boolean(navigation?.ids.length && navigation.popoutHost === true);
  }

  async process(
    frame: UserSensorFrame,
    signal: AbortSignal,
    route: IntentMode = 'shortcut',
  ): Promise<void> {
    signal.throwIfAborted();

    const inferred = route === 'inference';
    const index = inferred ? inferredIndex(frame.utterance) : shortcutIndex(frame.utterance);
    const context = frame.interaction;

    if (index < 0 || index >= MAX_OPEN_AGENT_SESSIONS || !context?.agentNavigation?.ids[index]) {
      this.log(
        'skipped',
        inferred
          ? `Inferred pop-out requires exactly one existing session number from 1 to ${MAX_OPEN_AGENT_SESSIONS}`
          : `Pop out session requires an existing session number from 1 to ${MAX_OPEN_AGENT_SESSIONS}`,
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }

    if (this.preview) {
      this.log('preview', `Would pop out session ${index + 1}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }

    // Admission to the owning UI's ordered stream, like GO_TO_SESSION; the
    // UI reports a refused pop-out (unsent text being confirmed, eight
    // windows already open) in its own error line.
    const requested = this.activity.popOutSession?.(context, index) === true;
    this.log(
      requested ? 'session' : 'skipped',
      requested
        ? `Popped out session ${index + 1}`
        : 'Session navigation target changed while processing',
      frame.id,
    );
    this.activity.outcome?.(frame.id, requested ? 'selected' : 'skipped');
  }
}
