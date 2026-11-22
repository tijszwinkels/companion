/**
 * Where a pinned widget sits, and how tall its band at the top is (the
 * README's "Pinned widgets" lists both rules with their cases).
 *
 * Place:
 * - In a window narrower than `narrowWindowBelow` (640 px) it is always at
 *   the top of the chat.
 * - Otherwise a place this browser fixed ("→ Right" or "↑ Top") wins.
 * - Otherwise ("Auto") the shape of the space next to the conversation list
 *   decides: wider than tall puts it in the right column, taller than wide
 *   (or exactly square) at the top. That space is the window less the list
 *   and its divider while the list is shown, as tall as the window. The
 *   list's width counted here is the one it has with nothing beside it, so
 *   the place never depends on the right column the place itself shows.
 *
 * Band height at the top:
 * - A percentage of the height below the bar: the one this browser
 *   remembered from dragging the band's lower edge, else the widget's own
 *   `heightPercent`, else 25 %; always within 10 % and 70 %.
 * - In pixels, never more than leaves the chat `bandChatMinimum` below it,
 *   and never less than `bandMinimum`.
 *
 * Pure functions without DOM access; all sizes are CSS pixels.
 * test/shell/pinned-layout.test.ts checks them with one table of cases.
 */

import { narrowWindowBelow } from './activity-width.ts';
import { dividerLayoutWidth, shownListWidth } from './list-width.ts';

/** Where the person put the pinned widget in this browser. */
export type PinnedPlacePreference = 'auto' | 'right' | 'top';

/** Where the pinned widget is shown now. */
export type PinnedPlace = 'right' | 'top';

/** The preference before the person chooses one. */
export const defaultPinnedPlace: PinnedPlacePreference = 'auto';

/** The band's height before anything else says otherwise (the desktop's default). */
export const bandDefaultPercent = 25;

/** The lowest and highest band height, as a percentage of the height below the bar. */
export const bandMinimumPercent = 10;
export const bandMaximumPercent = 70;

/** Height change of one arrow key press on the band's lower edge, in percent. */
export const bandKeyboardStep = 5;

/** The band never gets lower than this (its header and a little of the widget). */
export const bandMinimum = 80;

/** The chat below the band keeps at least this height where the window allows. */
export const bandChatMinimum = 160;

export interface PlaceInputs {
  /** The page's width and height in CSS pixels. */
  windowWidth: number;
  windowHeight: number;
  /** Whether the conversation list is shown, and its preferred width. */
  listShown: boolean;
  listPreference: number;
  /** The place fixed in this browser, or 'auto'. */
  preference: PinnedPlacePreference;
}

/** Whether a value is one of the stored place preferences. */
export function isPinnedPlacePreference(value: unknown): value is PinnedPlacePreference {
  return value === 'auto' || value === 'right' || value === 'top';
}

/** The width of the space next to the conversation list (see the rule above). */
export function spaceBesideList(windowWidth: number, listShown: boolean, listPreference: number) {
  if (!listShown) {
    return windowWidth;
  }
  return windowWidth - shownListWidth(listPreference, windowWidth) - dividerLayoutWidth;
}

/** Where the pinned widget is shown for these inputs. */
export function pinnedPlace(inputs: PlaceInputs): PinnedPlace {
  if (inputs.windowWidth < narrowWindowBelow) {
    return 'top';
  }
  if (inputs.preference === 'right' || inputs.preference === 'top') {
    return inputs.preference;
  }

  const spaceWidth = spaceBesideList(inputs.windowWidth, inputs.listShown, inputs.listPreference);
  if (spaceWidth > inputs.windowHeight) {
    return 'right';
  }
  return 'top';
}

/**
 * Which place buttons the pinned widget's header offers where it is shown:
 * "→ Right" at the top while the window allows the right column, "↑ Top" at
 * the right, and "Auto" while a place is fixed.
 */
export function placeChoices(
  place: PinnedPlace,
  preference: PinnedPlacePreference,
  windowWidth: number,
): PinnedPlacePreference[] {
  const choices: PinnedPlacePreference[] = [];
  if (place === 'top' && windowWidth >= narrowWindowBelow) {
    choices.push('right');
  }
  if (place === 'right') {
    choices.push('top');
  }
  if (preference !== 'auto') {
    choices.push('auto');
  }
  return choices;
}

/**
 * A band percentage made valid: rounded and within the minimum and the
 * maximum; anything that is not a finite number gives the default.
 */
export function validBandPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return bandDefaultPercent;
  }
  const rounded = Math.round(percent);
  return Math.min(Math.max(rounded, bandMinimumPercent), bandMaximumPercent);
}

/**
 * The band's percentage: the one remembered in this browser (null when
 * none), else the widget's own `heightPercent` (undefined when the
 * listener sent none), else the default.
 */
export function bandPercent(remembered: number | null, widgetPercent: number | undefined): number {
  if (remembered !== null) {
    return validBandPercent(remembered);
  }
  if (typeof widgetPercent === 'number') {
    return validBandPercent(widgetPercent);
  }
  return bandDefaultPercent;
}

/** The band's height in pixels for a percentage of `bodyHeight`, the height below the bar. */
export function bandHeight(percent: number, bodyHeight: number): number {
  const wanted = Math.round((validBandPercent(percent) * bodyHeight) / 100);
  const most = bodyHeight - bandChatMinimum;
  return Math.max(Math.min(wanted, most), bandMinimum);
}

/**
 * The percentage for the band's lower edge dragged to `pointerY`, the
 * pointer's distance in pixels from the top of the area below the bar.
 */
export function bandPercentFromPointer(pointerY: number, bodyHeight: number): number {
  if (!(bodyHeight > 0)) {
    return bandDefaultPercent;
  }
  return validBandPercent((pointerY / bodyHeight) * 100);
}

/**
 * The percentage after a key press on the focused lower edge, from the one
 * shown now, or `null` for a key it does not handle. ArrowDown moves the
 * edge down (a taller band), ArrowUp up; Home gives the lowest band, End
 * the highest.
 */
export function bandPercentFromKey(key: string, shownPercent: number): number | null {
  if (key === 'Home') {
    return bandMinimumPercent;
  }
  if (key === 'End') {
    return bandMaximumPercent;
  }
  if (key === 'ArrowDown') {
    return validBandPercent(shownPercent + bandKeyboardStep);
  }
  if (key === 'ArrowUp') {
    return validBandPercent(shownPercent - bandKeyboardStep);
  }
  return null;
}
