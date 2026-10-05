import type { AgentHarness } from '../agents/types.ts';
import { StartCodingAgentSession } from './start-coding-agent-session.ts';

/**
 * An explicit shortcut starts a coding conversation in the native Claude Code
 * CLI with the configured `claudeCode` model and effort, whatever the coding
 * default harness is. Prefix-only: the detector's prompts are unchanged.
 */
export class StartClaudeCodeSession extends StartCodingAgentSession {
  override readonly id = 'start-claude-code-session';
  override readonly label = 'Start a Claude Code session';
  override readonly name = 'START_CLAUDE_CODE_SESSION';
  override readonly prefixes = ['new claude session'];
  override readonly instruction = undefined;
  protected override readonly harness: AgentHarness = 'claude-code';
}
