import type { AgentHarness } from '../agents/types.ts';
import { StartCodingAgentSession } from './start-coding-agent-session.ts';

/**
 * An explicit shortcut starts a coding conversation in Pi with its configured
 * coding settings (the OpenAI Codex model), whatever the coding default
 * harness is. "Codex" never means a native Codex CLI. Prefix-only: the
 * detector's prompts are unchanged.
 */
export class StartCodexSession extends StartCodingAgentSession {
  override readonly id = 'start-codex-session';
  override readonly label = 'Start a Codex session';
  override readonly name = 'START_CODEX_SESSION';
  override readonly prefixes = ['new codex session'];
  override readonly instruction = undefined;
  protected override readonly harness: AgentHarness = 'pi';
}
