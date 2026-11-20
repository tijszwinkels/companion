/**
 * What the bar above the chat and the conversation list show about a
 * conversation's turns (the shell README, "Turn timers and the last turn
 * duration"), without DOM access.
 *
 * Inputs, per conversation, from the listener (src/agents/README.md, "Turn
 * and message times"):
 * - `turnStartedAt`: present exactly while a turn runs; its start in epoch
 *   milliseconds on the listener's clock;
 * - `lastTurnDurationMs`: how long the last finished turn took;
 * - `status`: `starting` and `running` mean the agent works on a turn
 *   (`status` can still say `running` a moment after the turn's times
 *   ended, while the listener saves it).
 *
 * And from this page: whether requests are admitted (connected, and this
 * connection's snapshot arrived: the conversation's state is known now) and
 * the Display switches.
 *
 * Rule:
 * 1. A running time is shown only while `turnStartedAt` is present, the
 *    Turn timers switch is on and the state is known. Offline, or
 *    reconnected before the new snapshot, the last known start is not
 *    counted as if live: the turn may have ended meanwhile.
 * 2. The bar shows `working · m:ss` then; otherwise, while the agent works
 *    (status, or a `turnStartedAt` not counted by rule 1), `working…`.
 * 3. With no running turn, the bar shows `ready · last turn m:ss` while the
 *    conversation has `lastTurnDurationMs` and the Last turn duration
 *    switch is on; otherwise `ready`. A finished turn's duration is a
 *    stored value, not a running count, so it is shown whatever the
 *    connection.
 * 4. The list shows the running time of rule 1 on each conversation, and
 *    nothing else.
 * 5. Times are `m:ss` under one hour and `h:mm:ss` from one hour, whole
 *    seconds rounded down; a negative time (clocks that disagree by more
 *    than the delivery delay) is 0:00.
 */

import type { AgentSession } from '../../../../src/agents/types.ts';
import type { DisplaySettingsValues } from '../settings/display-settings.ts';

/** What the bar shows as the conversation's state. */
export type BarState =
  /** `working · ` followed by the running time since `startedAt` (listener clock). */
  | { kind: 'timer'; startedAt: number }
  /** Fixed text: `working…`, `ready · last turn m:ss` or `ready`. */
  | { kind: 'text'; text: string };

/** A usable epoch time or duration from the listener: a finite number, not negative. */
function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A duration as the bar and the list show it: `m:ss`, or `h:mm:ss` from one hour. */
export function elapsedText(milliseconds: number): string {
  let totalSeconds = 0;
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    totalSeconds = Math.floor(milliseconds / 1000);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigitSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const twoDigitMinutes = String(minutes).padStart(2, '0');
    return `${hours}:${twoDigitMinutes}:${twoDigitSeconds}`;
  }
  return `${minutes}:${twoDigitSeconds}`;
}

/**
 * The start of the running turn to count (rule 1), or undefined when no
 * running time is shown for this conversation.
 */
export function runningTurnStart(
  session: Pick<AgentSession, 'turnStartedAt'>,
  admitted: boolean,
  settings: DisplaySettingsValues,
): number | undefined {
  if (!settings.turnTimers || !admitted) {
    return undefined;
  }
  if (!validTime(session.turnStartedAt)) {
    return undefined;
  }
  return session.turnStartedAt;
}

/** The bar's state for the shown conversation (rules 1 to 3). */
export function barState(
  session: Pick<AgentSession, 'status' | 'turnStartedAt' | 'lastTurnDurationMs'>,
  admitted: boolean,
  settings: DisplaySettingsValues,
): BarState {
  const startedAt = runningTurnStart(session, admitted, settings);
  if (startedAt !== undefined) {
    return { kind: 'timer', startedAt };
  }

  const working =
    session.status === 'starting' ||
    session.status === 'running' ||
    validTime(session.turnStartedAt);
  if (working) {
    return { kind: 'text', text: 'working…' };
  }

  if (settings.lastTurnDuration && validTime(session.lastTurnDurationMs)) {
    return { kind: 'text', text: `ready · last turn ${elapsedText(session.lastTurnDurationMs)}` };
  }
  return { kind: 'text', text: 'ready' };
}
