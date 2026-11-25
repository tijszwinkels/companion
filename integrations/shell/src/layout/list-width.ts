/**
 * Width rules of the conversation list (the README's "Remembered width and
 * hidden state" and "List style" list them with their cases).
 *
 * The list has two appearances:
 *
 * - the strip: icon, number and a short name below the icon, in small
 *   text;
 * - the full list: icon, number, title and the conversation's last line.
 *
 * Which appearance a width gives depends on the list style the person chose
 * in Settings → Display (../settings/display-settings.ts):
 *
 * - `by-width` (the default, the behaviour before there was a choice): the
 *   strip is exactly `stripWidth` pixels, the full list `fullListMinimum`
 *   to `listMaximum` pixels, and a divider dragged between the two snaps
 *   to the nearer;
 * - `compact`: always the strip, at any width from `stripWidth` to
 *   `listMaximum` (a wider strip shows more of each name);
 * - `full`: always the full list, from `fullListMinimum` to `listMaximum`;
 *   only a window too narrow for that beside the chat shows the strip, as
 *   `by-width` does.
 *
 * The person's preference (`listWidth`) is one width, stored the same for
 * every style (any whole number from `stripWidth` to `listMaximum`); each
 * style reads it by its own range, so switching the style never rewrites
 * it. The width actually shown also depends on the window: the chat keeps
 * at least `chatMinimum` pixels next to the list and the divider. The
 * window never changes the preference itself, so widening the window again
 * restores the list the person chose.
 *
 * Pure functions without DOM access; all widths are CSS pixels.
 * test/shell/layout.test.ts checks them with tables of cases.
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

/** The list styles of Settings → Display (see the module comment). */
export type ListStyle = 'by-width' | 'compact' | 'full';

/** The style of a browser that has chosen none: today's behaviour. */
export const defaultListStyle: ListStyle = 'by-width';

/** Whether a stored value is one of the list styles. */
export function isListStyle(value: unknown): value is ListStyle {
  return value === 'by-width' || value === 'compact' || value === 'full';
}

/** The narrowest width a style's preference can be. */
export function narrowestListWidth(style: ListStyle): number {
  if (style === 'full') {
    return fullListMinimum;
  }
  return stripWidth;
}

/**
 * A width as it is remembered, for every style: a whole number from the
 * strip's width to the maximum. Anything that is not a finite number is
 * the strip's width.
 */
export function storedListWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return stripWidth;
  }
  const rounded = Math.round(width);
  return Math.min(Math.max(rounded, stripWidth), listMaximum);
}

/**
 * A preferred width made valid for a style:
 *
 * - `by-width`: the strip, or a full list between its minimum and maximum;
 *   a width left of the snap point (or not a finite number) is the strip;
 * - `compact`: any whole width from the strip's to the maximum;
 * - `full`: any whole width from the full list's minimum to the maximum.
 */
export function validListWidth(width: number, style: ListStyle = defaultListStyle): number {
  if (style === 'compact') {
    return storedListWidth(width);
  }
  if (style === 'full') {
    const stored = storedListWidth(width);
    return Math.max(stored, fullListMinimum);
  }
  if (!Number.isFinite(width) || width < snapPoint) {
    return stripWidth;
  }
  const rounded = Math.round(width);
  return Math.min(Math.max(rounded, fullListMinimum), listMaximum);
}

/**
 * The width the list is shown at for a preference, a window width and a
 * style: the preference made valid for the style, narrowed so the chat
 * keeps `chatMinimum`. A compact list is never narrower than the strip; in
 * the other styles a full list that no longer fits at its minimum is shown
 * as the strip.
 */
export function shownListWidth(
  preference: number,
  windowWidth: number,
  style: ListStyle = defaultListStyle,
): number {
  const valid = validListWidth(preference, style);
  const room = windowWidth - dividerLayoutWidth - chatMinimum;

  if (style === 'compact') {
    return Math.max(Math.min(valid, room), stripWidth);
  }

  if (valid === stripWidth) {
    return stripWidth;
  }
  const width = Math.min(valid, room);
  if (width < fullListMinimum) {
    return stripWidth;
  }
  return width;
}

/** The widest list this window allows now for a style (the strip when nothing wider fits). */
export function widestShownListWidth(
  windowWidth: number,
  style: ListStyle = defaultListStyle,
): number {
  return shownListWidth(listMaximum, windowWidth, style);
}

/**
 * Which appearance a shown width has in a style: a compact list is always
 * the strip; otherwise a width under the full list's minimum is the strip.
 */
export function appearanceOf(
  shownWidth: number,
  style: ListStyle = defaultListStyle,
): ListAppearance {
  if (style === 'compact') {
    return 'strip';
  }
  if (shownWidth < fullListMinimum) {
    return 'strip';
  }
  return 'full';
}

/**
 * The preference for a divider dragged to `pointerX`, the pointer's
 * distance in pixels from the left edge of the page (where the list
 * starts). By width: left of the snap point the strip, else a full list as
 * wide as the pointer's position, within the minimum and maximum. Compact
 * and full: as wide as the pointer's position, within the style's range.
 */
export function widthFromPointer(pointerX: number, style: ListStyle = defaultListStyle): number {
  return validListWidth(pointerX, style);
}

/**
 * The preference after a key press on the focused divider, starting from
 * the width shown now, or `null` for a key the divider does not handle.
 *
 * By width:
 * - ArrowRight widens by one step; from the strip it gives the narrowest
 *   full list.
 * - ArrowLeft narrows by one step; below the full list's minimum it gives
 *   the strip.
 * - Home gives the strip, End the widest list.
 *
 * Compact and full: ArrowRight and ArrowLeft widen and narrow by one step
 * within the style's range; Home gives the style's narrowest list, End the
 * widest.
 */
export function widthFromKey(
  key: string,
  shownWidth: number,
  style: ListStyle = defaultListStyle,
): number | null {
  if (key === 'Home') {
    return narrowestListWidth(style);
  }
  if (key === 'End') {
    return listMaximum;
  }
  if (style !== 'by-width') {
    if (key === 'ArrowRight') {
      return validListWidth(shownWidth + keyboardStep, style);
    }
    if (key === 'ArrowLeft') {
      return validListWidth(shownWidth - keyboardStep, style);
    }
    return null;
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
