/**
 * The processors of a listener without a desktop (`npm start -- --headless`).
 *
 * The same commands as with a desktop, except the ones that type into the
 * application in front: there is none, so "insert …" and "enter …" are
 * refused (TypingWithoutDesktop) and an intent model is never offered a
 * typing intent. Without an intent model, NoConversationShown is added for
 * speech that the rule cannot deliver (src/core/no-intent-model.ts).
 * Every processor here is screenless: none reads a screenshot.
 */

import type { Activity } from '../../core/activity.ts';
import type { Log } from '../../core/frame.ts';
import type { UserSensorRouter } from '../../core/router.ts';
import type { AgentSessions } from '../../agents/sessions.ts';
import { AgentChoiceIntents } from '../../agents/choice-intents.ts';
import { CloseAgentSession } from '../close-agent-session.ts';
import { ContinueOpenAgentConversation } from '../continue-open-agent-conversation.ts';
import { GoToSession } from '../go-to-session.ts';
import { Ignore } from '../ignore.ts';
import { LabelPreviousCorrect } from '../label-previous-correct.ts';
import { LabelPreviousIncorrect } from '../label-previous-incorrect.ts';
import { PopOutSession } from '../pop-out-session.ts';
import { QuickQuestion } from '../quick-question.ts';
import { StartClaudeCodeSession } from '../start-claude-code-session.ts';
import { StartCodingAgentSession } from '../start-coding-agent-session.ts';
import { StartPiSession } from '../start-pi-session.ts';
import { NoConversationShown } from './no-conversation-shown.ts';
import { TypingWithoutDesktop } from './typing-without-desktop.ts';

export function subscribeHeadlessProcessors(
  router: UserSensorRouter,
  options: {
    sessions: AgentSessions;
    log: Log;
    activity: Activity;
    /** Whether an intent model classifies utterances (`--intent-model`). */
    intentModel: boolean;
  },
): void {
  const { sessions, log, activity } = options;
  const preview = false;

  new TypingWithoutDesktop(log, activity).subscribe(router);
  new Ignore(log, activity).subscribe(router);
  new StartCodingAgentSession({ sessions }, log, preview, activity).subscribe(router);
  new QuickQuestion({ sessions }, log, preview, activity).subscribe(router);
  new StartClaudeCodeSession({ sessions }, log, preview, activity).subscribe(router);
  new StartPiSession({ sessions }, log, preview, activity).subscribe(router);
  new GoToSession(log, preview, activity).subscribe(router);
  new PopOutSession(log, preview, activity).subscribe(router);
  new ContinueOpenAgentConversation({ sessions }, log, preview, activity).subscribe(router);
  new CloseAgentSession({ sessions }, log, preview, activity).subscribe(router);
  new LabelPreviousCorrect(log, preview, activity).subscribe(router);
  new LabelPreviousIncorrect(log, preview, activity).subscribe(router);
  new AgentChoiceIntents({ sessions }, log, preview, activity).subscribe(router);

  if (!options.intentModel) {
    new NoConversationShown(log, activity).subscribe(router);
  }
}
