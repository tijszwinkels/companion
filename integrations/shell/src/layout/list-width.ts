/**
 * Width rules of the conversation list (the README's "Remembered width and
 * hidden state" lists them with their cases).
 *
 * The list has two appearances that depend only on the width it is shown
 * at:
 *
 * - the strip, exactly `stripWidth` pixels: icon, number and a short name;
 * - the full list, from `fullListMinimum` to `listMaximum` pixels: icon,
 *   number, title and the conversation's last line.
 *
 * The person's preference (`listWidth`) is one of those widths. The width
 * actually shown also depends on the window: the chat keeps at least
 * `chatMinimum` pixels next to the list and the divider, and a full list that no longer fits at its minimum
 * becomes the strip. The window never changes the preference itself, so
 * widening the window again restores the list the person chose.
 *
 * Pure functions without DOM access; all widths are CSS pixels.
 * test/shell/layout.test.ts checks them with one table of cases.
 */

/** The strip's one width. */
export const stripWidth = 78;

/** The narrowest full list; anything narrower is shown as the strip. */
export const fullListMinimum = 150;

/** The widest list. */
export const listMaximum = 420;

/** Width the chat keeps next to a full list. */
export const chatMinimum = 320;

/**
 * Width the divider takes in the layout between list and chat (a 7 px
 * handle with −3 px margins on both sides, styles.css `.list-divider`).
 */
export const dividerLayoutWidth = 1;

/**
 * A divider released (or dragged) left of this point gives the strip; at or
 * right of it the full list. It is halfway between the two appearances, so
 * the divider snaps to whichever is nearer.
 */
export const snapPoint = (stripWidth + fullListMinimum) / 2;

/** Width change of one arrow key press on the divider. */
export const keyboardStep = 20;

/** The two appearances of the list. */
export type ListAppearance = 'strip' | 'full';

/**
 * A preferred width made valid: the strip, or a full list between its
 * minimum and maximum. Anything that is not a finite number is the strip.
 */
export function validListWidth(width: number): number {
  if (!Number.isFinite(width) || width < snapPoint) {
    return stripWidth;
  }
  const rounded = Math.round(width);
  return Math.min(Math.max(rounded, fullListMinimum), listMaximum);
}

/**
 * The width the list is shown at for a preference and a window width: the
 * preference, narrowed so the chat keeps `chatMinimum`, and the strip when
 * a full list no longer fits.
 */
export function shownListWidth(preference: number, windowWidth: number): number {
  const valid = validListWidth(preference);
  if (valid === stripWidth) {
    return stripWidth;
  }
  const room = windowWidth - dividerLayoutWidth - chatMinimum;
  const width = Math.min(valid, room);
  if (width < fullListMinimum) {
    return stripWidth;
  }
  return width;
}

/** The widest list this window allows now (the strip when no full list fits). */
export function widestShownListWidth(windowWidth: number): number {
  return shownListWidth(listMaximum, windowWidth);
}

/** Which appearance a shown width has. */
export function appearanceOf(shownWidth: number): ListAppearance {
  if (shownWidth < fullListMinimum) {
    return 'strip';
  }
  return 'full';
}

/**
 * The preference for a divider dragged to `pointerX`, the pointer's
 * distance in pixels from the left edge of the page (where the list
 * starts): left of the snap point the strip, else a full list as wide as the
 * pointer's position, within the minimum and maximum.
 */
export function widthFromPointer(pointerX: number): number {
  return validListWidth(pointerX);
}

/**
 * The preference after a key press on the focused divider, starting from
 * the width shown now, or `null` for a key the divider does not handle.
 *
 * - ArrowRight widens by one step; from the strip it gives the narrowest
 *   full list.
 * - ArrowLeft narrows by one step; below the full list's minimum it gives
 *   the strip.
 * - Home gives the strip, End the widest list.
 */
export function widthFromKey(key: string, shownWidth: number): number | null {
  if (key === 'Home') {
    return stripWidth;
  }
  if (key === 'End') {
    return listMaximum;
  }
  if (key === 'ArrowRight') {
    if (shownWidth < fullListMinimum) {
      return fullListMinimum;
    }
    return Math.min(shownWidth + keyboardStep, listMaximum);
  }
  if (key === 'ArrowLeft') {
    const narrower = shownWidth - keyboardStep;
    if (narrower < fullListMinimum) {
      return stripWidth;
    }
    return narrower;
  }
  return null;
}
