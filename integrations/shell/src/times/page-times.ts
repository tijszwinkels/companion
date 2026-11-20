/**
 * The page's time parts, created once in main.tsx and handed down to the
 * workspace: the Display settings, the listener's clock and the ticker that
 * advances the running turn timers.
 */

import type { DisplaySettings } from '../settings/display-settings.ts';
import type { ListenerClock } from './listener-clock.ts';
import type { TurnTicker } from './turn-ticker.ts';

export interface PageTimes {
  settings: DisplaySettings;
  clock: ListenerClock;
  ticker: TurnTicker;
}
