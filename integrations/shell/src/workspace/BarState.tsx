/**
 * The shown conversation's state in the bar above the chat, by the rules in
 * ../times/turn-times.ts: `working · 2:16` while a turn runs (the time
 * advanced by the page's ticker), `working…` while it works without a
 * counted start, `ready · last turn 0:42` or `ready`.
 */

import type { AgentSession } from '../../../../src/agents/types.ts';
import type { DisplaySettingsValues } from '../settings/display-settings.ts';
import { TurnTimer } from '../times/TurnTimer.tsx';
import type { TurnTicker } from '../times/turn-ticker.ts';
import { barState } from '../times/turn-times.ts';

export function BarState(props: {
  session: AgentSession;
  /** Whether requests are admitted: the conversation's state is known now. */
  admitted: boolean;
  settings: DisplaySettingsValues;
  ticker: TurnTicker;
}) {
  const state = barState(props.session, props.admitted, props.settings);
  if (state.kind === 'timer') {
    return (
      <>
        working ·{' '}
        <TurnTimer ticker={props.ticker} startedAt={state.startedAt} className="turn-timer" />
      </>
    );
  }
  return <>{state.text}</>;
}
