/**
 * Types for showing a real conversation in its own native window ("pop out")
 * or returning it to the sidebar.
 *
 * The conversation itself never changes: pop-out and return are view
 * operations performed by the native Companion UI, which owns its windows.
 * The agent tool `companion_session_present` (session-tools.ts) reaches the UI
 * through `AgentSessions` and the desktop runtime, which forwards one
 * `agent-present` request to one native panel and waits for its answer.
 */

/** Where a conversation's view should be: its own window or the sidebar. */
export type SessionPresentation = 'window' | 'sidebar';

export interface AgentPresentRequest {
  /** The calling conversation, established by its turn lease. Never chosen by the model. */
  sessionId: string;
  presentation: SessionPresentation;
  /**
   * Ask the UI to activate the resulting view. A request is not proof that
   * the compositor granted focus; the answer's `focused` says what happened.
   */
  focus: boolean;
}

/**
 * Outcomes the native panel itself may report:
 * - `shown`: the conversation now has its own window (it may already have had one).
 * - `returned`: the conversation's view is back in the sidebar.
 * - `unsupported`: this panel cannot pop conversations out.
 * - `unavailable`: the panel does not have this conversation open.
 * - `conflict`: a pending send, choice or recording cannot move between views
 *   yet; the existing view and its draft were kept.
 */
export const presentPanelOutcomes = [
  'shown',
  'returned',
  'unsupported',
  'unavailable',
  'conflict',
] as const;

export type PresentPanelOutcome = (typeof presentPanelOutcomes)[number];

/**
 * What the caller learns. Besides the panel's own outcomes:
 * - `offline`: no native panel was connected, so nothing was sent.
 * - `unconfirmed`: the request was sent, but no answer arrived (timeout,
 *   disconnect or the turn ended). The panel may have acted; do not resend.
 */
export type AgentPresentOutcome =
  | {
      outcome: 'shown' | 'returned';
      /** Whether the UI observed its view actually gaining focus. */
      focused: boolean;
      reason: string;
    }
  | {
      outcome: 'unsupported' | 'unavailable' | 'conflict' | 'unconfirmed' | 'offline';
      reason: string;
    };

/** The desktop runtime's side of presentation requests. */
export interface AgentPresentationHost {
  /**
   * Whether a connected native panel currently offers pop-out windows. Read
   * when a turn's tools are leased, so the tool list stays fixed for a turn.
   */
  available(): boolean;
  present(request: AgentPresentRequest, signal: AbortSignal): Promise<AgentPresentOutcome>;
}
