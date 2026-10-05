import type { AgentHarness } from '../agents/types.ts';
import { StartCodingAgentSession } from './start-coding-agent-session.ts';

/**
 * An explicit shortcut starts a coding conversation in Pi with its configured
 * coding model and thinking, whatever the coding default harness is. It
 * never starts a native Codex CLI or any other harness. Prefix-only: the
 * detector's prompts are unchanged.
 *
 * Renamed from "new codex session" (`START_CODEX_SESSION`) at Tijs's request;
 * there is deliberately no legacy alias. A stale disabled-intent entry under
 * the old name is ignored, and older history keeps the name it was saved with.
 */
export class StartPiSession extends StartCodingAgentSession {
  override readonly id = 'start-pi-session';
  override readonly label = 'Start a Pi session';
  override readonly name = 'START_PI_SESSION';
  override readonly prefixes = ['new pi session'];
  override readonly instruction = undefined;
  protected override readonly harness: AgentHarness = 'pi';
}
