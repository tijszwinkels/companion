/**
 * Width rules of the Activity column on the right of the chat (the
 * README's "Activity column width and hidden state" lists them with their
 * cases).
 *
 * The person's preference (`activityWidth`) is a width between
 * `activityMinimum` and `activityMaximum`. What is shown also depends on
 * the window:
 *
 * - a wide window (at least `narrowWindowBelow` pixels) shows list, chat and
 *   column side by side. The chat keeps `chatMinimum`; the column gives way
 *   first, but never below its minimum, and the list then follows its own
 *   rules (list-width.ts) in the width the column leaves;
 * - a narrow window lays the column over the chat, from the list's right
 *   edge to the window's right edge, without a divider.
 *
 * The window never changes the preference itself. Pure functions without
 * DOM access; all widths are CSS pixels. test/shell/activity-layout.test.ts
 * checks them with one table of cases.
 */

import { chatMinimum, dividerLayoutWidth, stripWidth } from './list-width.ts';

/** The narrowest column. */
export const activityMinimum = 240;

/** The widest column. */
export const activityMaximum = 520;

/** The column's width before the person chooses one (the agreed design's). */
export const activityDefaultWidth = 320;

/** Windows narrower than this lay the column over the chat. */
export const narrowWindowBelow = 640;

/** Width change of one arrow key press on the column's divider. */
export const activityKeyboardStep = 20;

/**
 * A preferred width made valid: rounded and within the minimum and the
 * maximum. Anything that is not a finite number is the default width.
 */
export function validActivityWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return activityDefaultWidth;
  }
  const rounded = Math.round(width);
  return Math.min(Math.max(rounded, activityMinimum), activityMaximum);
}

/** Whether a window this wide lays the column over the chat. */
export function isNarrowWindow(windowWidth: number): boolean {
  return windowWidth < narrowWindowBelow;
}

/**
 * The width the column is shown at beside the chat in a wide window: the
 * preference, narrowed so the chat keeps `chatMinimum` next to the column's
 * divider and, while the list is shown, the strip and its divider; never
 * below the column's minimum.
 */
export function sideColumnWidth(
  preference: number,
  windowWidth: number,
  listShown: boolean,
): number {
  let room = windowWidth - chatMinimum - dividerLayoutWidth;
  if (listShown) {
    room = room - stripWidth - dividerLayoutWidth;
  }
  const width = Math.min(validActivityWidth(preference), room);
  return Math.max(width, activityMinimum);
}

/**
 * The width the column takes from the list's window: the column and its
 * divider beside the chat in a wide window, nothing when it is hidden or
 * lies over the chat in a narrow one.
 */
export function activityReservedWidth(
  preference: number,
  shown: boolean,
  windowWidth: number,
  listShown: boolean,
): number {
  if (!shown || isNarrowWindow(windowWidth)) {
    return 0;
  }
  return sideColumnWidth(preference, windowWidth, listShown) + dividerLayoutWidth;
}

/**
 * The preference for the column's divider dragged to `distanceFromRight`,
 * the pointer's distance in pixels from the right edge of the window (where
 * the column ends).
 */
export function activityWidthFromPointer(distanceFromRight: number): number {
  return validActivityWidth(distanceFromRight);
}

/**
 * The preference after a key press on the focused divider, starting from
 * the width shown now, or `null` for a key the divider does not handle.
 * The column is on the right, so ArrowLeft (the divider moves left) widens
 * it and ArrowRight narrows it; Home gives the minimum, End the maximum.
 */
export function activityWidthFromKey(key: string, shownWidth: number): number | null {
  if (key === 'Home') {
    return activityMinimum;
  }
  if (key === 'End') {
    return activityMaximum;
  }
  if (key === 'ArrowLeft') {
    return validActivityWidth(shownWidth + activityKeyboardStep);
  }
  if (key === 'ArrowRight') {
    return validActivityWidth(shownWidth - activityKeyboardStep);
  }
  return null;
}
