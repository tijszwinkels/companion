/**
 * The frame states rule (integrations/shell/README.md, "Inline widgets"):
 * what one inline widget panel shows, as a pure function of what happened
 * to its frame. The panel (InlineWidget.tsx) feeds it the frame's checked
 * messages (frame-messages.ts), its load deadline and Try again; whether the
 * shell is connected is not part of this state, it only greys the panel
 * (`disconnected`) and pauses the deadline, so the phase survives a
 * reconnect with the same address.
 *
 * Phases:
 * - `loading`: the frame was created for the address and has not yet
 *   reported its first height;
 * - `shown`: it reported one (host.js sends the first height only after the
 *   widget drew its first state);
 * - `failed`: it reported an error before that, or did not report within
 *   the deadline; the frame is removed until Try again.
 *
 * A panel without a frame address never has a frame state: it shows the
 * "not set up" card.
 */

import { minimumFrameHeight } from './frame-messages.ts';

/** How long a loading frame has to report its height, counted while it is visible. */
export const loadDeadlineMilliseconds = 10_000;

export const deadlineReason = 'Its page did not answer within 10 seconds.';

export type FramePhase = 'loading' | 'shown' | 'failed';

export interface FrameState {
  phase: FramePhase;
  /** Why it failed (shown under "The <name> widget could not load."), else ''. */
  reason: string;
  /** The frame's height in CSS pixels, within the inline bounds. */
  height: number;
  /** Counts frames created for this panel; a new value is a new frame. */
  attempt: number;
}

export type FrameEvent =
  | { type: 'geometry'; height: number }
  | { type: 'error'; text: string }
  | { type: 'deadline' }
  | { type: 'retry' };

/**
 * A new panel's state. `rememberedHeight` is the height this page last saw
 * for the same address (a conversation shown again), so the transcript does
 * not jump while the frame loads again.
 */
export function initialFrameState(rememberedHeight?: number): FrameState {
  return {
    phase: 'loading',
    reason: '',
    height: rememberedHeight ?? minimumFrameHeight,
    attempt: 0,
  };
}

export function nextFrameState(state: FrameState, event: FrameEvent): FrameState {
  if (event.type === 'retry') {
    if (state.phase !== 'failed') {
      return state;
    }
    return { ...state, phase: 'loading', reason: '', attempt: state.attempt + 1 };
  }

  if (state.phase === 'failed') {
    // The failed frame is no longer in the page; nothing it sent counts.
    return state;
  }

  if (event.type === 'geometry') {
    if (state.phase === 'shown' && state.height === event.height) {
      return state;
    }
    return { ...state, phase: 'shown', height: event.height };
  }

  if (event.type === 'error') {
    if (state.phase === 'shown') {
      // host.js shows later errors inside the frame itself.
      return state;
    }
    return { ...state, phase: 'failed', reason: errorReason(event.text) };
  }

  // The deadline only matters while the frame is still loading.
  if (state.phase === 'loading') {
    return { ...state, phase: 'failed', reason: deadlineReason };
  }
  return state;
}

function errorReason(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 'Its page reported an error.';
  }
  return trimmed;
}
