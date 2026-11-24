/**
 * Layout rules of a conversation with a session application
 * (integrations/shell/README.md, "Session applications", layout rule).
 * Pure functions without DOM access; all widths are CSS pixels.
 * test/shell/application-rules.test.ts checks them with one table of cases.
 *
 * Two layouts:
 * - `split`: the application at the left and the chat at the right, with a
 *   divider between them (the default in a wide window);
 * - `switch`: one of the two at a time, chosen with the bar's
 *   `Chat | <application>` switch (App only, and every narrower window).
 *
 * The person's choice (`split` or `app-only`) is remembered in this browser
 * (stored-layout.ts); the window decides whether `split` can be used.
 */

import { chatMinimum, dividerLayoutWidth } from '../layout/list-width.ts';

/** The person's choice: the chat at the right of the application, or App only. */
export type ApplicationLayoutChoice = 'split' | 'app-only';

export const defaultApplicationLayoutChoice: ApplicationLayoutChoice = 'split';

/** What is drawn now. */
export type ApplicationLayout = 'split' | 'switch';

/** Windows narrower than this always use the switch layout. */
export const splitWindowMinimum = 1100;

/** The chat at the right: its narrowest, widest and first width. */
export const chatPaneMinimum = chatMinimum;
export const chatPaneMaximum = 640;
export const chatPaneDefault = 420;

/** The application keeps at least this much beside the chat. */
export const applicationMinimum = 320;

/** Width change of one arrow key press on the divider. */
export const chatPaneKeyboardStep = 20;

/**
 * The room the split layout needs beside the list and the Activity column:
 * the application's minimum, the divider and the chat's minimum.
 */
export const splitAreaMinimum = applicationMinimum + dividerLayoutWidth + chatPaneMinimum;

export function isApplicationLayoutChoice(value: unknown): value is ApplicationLayoutChoice {
  return value === 'split' || value === 'app-only';
}

/**
 * Whether the split layout can be drawn: the window is at least 1100 px
 * wide, and the area beside the list and the Activity column (`areaWidth`,
 * as their own rules leave it) has room for both minimums and the divider.
 */
export function splitPossible(windowWidth: number, areaWidth: number): boolean {
  return windowWidth >= splitWindowMinimum && areaWidth >= splitAreaMinimum;
}

/** The layout drawn for the person's choice in this window. */
export function applicationLayout(
  choice: ApplicationLayoutChoice,
  windowWidth: number,
  areaWidth: number,
): ApplicationLayout {
  if (choice === 'split' && splitPossible(windowWidth, areaWidth)) {
    return 'split';
  }
  return 'switch';
}

/**
 * A preferred chat width made valid: rounded and within the minimum and the
 * maximum. Anything that is not a finite number is the default width.
 */
export function validChatPaneWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return chatPaneDefault;
  }
  const rounded = Math.round(width);
  return Math.min(Math.max(rounded, chatPaneMinimum), chatPaneMaximum);
}

/**
 * The widest the chat may be shown in an area this wide: the application
 * keeps its minimum beside it and the divider. Never under the chat's own
 * minimum (the split layout is drawn only where both fit).
 */
export function widestChatPane(areaWidth: number): number {
  const room = areaWidth - dividerLayoutWidth - applicationMinimum;
  return Math.max(chatPaneMinimum, Math.min(chatPaneMaximum, room));
}

/** The chat's shown width: the preference, narrowed to what the area allows. */
export function shownChatPaneWidth(preference: number, areaWidth: number): number {
  return Math.min(validChatPaneWidth(preference), widestChatPane(areaWidth));
}

/**
 * The preference for the divider dragged to `distanceFromRight`, the
 * pointer's distance from the right edge of the area (where the chat ends).
 */
export function chatPaneWidthFromPointer(distanceFromRight: number): number {
  return validChatPaneWidth(distanceFromRight);
}

/**
 * The preference after a key press on the focused divider, from the width
 * shown now, or null for a key the divider does not handle. The chat is at
 * the right, so ArrowLeft widens it and ArrowRight narrows it, as on the
 * Activity column's divider; Home gives the minimum, End the maximum.
 */
export function chatPaneWidthFromKey(key: string, shownWidth: number): number | null {
  if (key === 'Home') {
    return chatPaneMinimum;
  }
  if (key === 'End') {
    return chatPaneMaximum;
  }
  if (key === 'ArrowLeft') {
    return validChatPaneWidth(shownWidth + chatPaneKeyboardStep);
  }
  if (key === 'ArrowRight') {
    return validChatPaneWidth(shownWidth - chatPaneKeyboardStep);
  }
  return null;
}

/**
 * The width of the area beside the list and the Activity column: the
 * window less the list and its divider while it is shown, and less the
 * right column and its divider while that sits beside the chat.
 */
export function areaWidth(input: {
  windowWidth: number;
  listShown: boolean;
  listWidth: number;
  rightColumnBeside: boolean;
  rightColumnWidth: number;
}): number {
  let width = input.windowWidth;
  if (input.listShown) {
    width = width - input.listWidth - dividerLayoutWidth;
  }
  if (input.rightColumnBeside) {
    width = width - input.rightColumnWidth - dividerLayoutWidth;
  }
  return width;
}
