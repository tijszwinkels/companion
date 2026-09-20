import type { AgentProfile } from '../agents/types.ts';
import { StartCodingAgentSession } from './start-coding-agent-session.ts';

/**
 * An explicit shortcut selects the local model. Reuse the session handoff,
 * cancellation and preview behavior, without changing the detector's prompts.
 */
export class QuickQuestion extends StartCodingAgentSession {
  override readonly id = 'quick-question';
  override readonly label = 'Quick question';
  override readonly name = 'QUICK_QUESTION';
  override readonly prefixes = ['quick question'];
  override readonly instruction = undefined;
  protected override readonly profile: AgentProfile = 'quickQuestion';
}
