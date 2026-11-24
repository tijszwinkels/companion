/**
 * The layout this browser remembers: the conversation list's preferred
 * width and whether it is shown, and the same two for the Activity column.
 *
 * Kept in `localStorage` as independent entries, each JSON
 * `{ "version": 1, "value": … }`:
 *
 * - `companion.shell.layout.listWidth`: the list's preferred width in pixels;
 * - `companion.shell.layout.listShown`: whether the list is shown;
 * - `companion.shell.layout.activityWidth`: the Activity column's preferred
 *   width in pixels;
 * - `companion.shell.layout.activityShown`: whether the column is shown;
 * - `companion.shell.layout.pinnedPlace`: where a pinned widget sits,
 *   `"auto"`, `"right"` or `"top"` (pinned-place.ts);
 * - `companion.shell.layout.pinnedHeight`: the height of the pinned widget's
 *   band at the top, as a percentage, once its lower edge was dragged;
 * - `companion.shell.layout.pinnedFolded`: whether that band is folded;
 * - `companion.shell.layout.applicationLayout`: for a conversation with a
 *   session application, the chat at the right of it (`"split"`) or App
 *   only (`"app-only"`) (../application/application-layout.ts);
 * - `companion.shell.layout.applicationChatWidth`: the width of the chat at
 *   the right of an application, in pixels.
 *
 * They describe only the arrangement of this page, not the person or their
 * conversations, so they are not cleared on sign-out. Each change writes
 * only its own entry, so two tabs of this browser changing different things
 * at the same moment cannot undo each other, and a tab never writes back a
 * value it did not change (useListLayout.ts follows the other tabs).
 *
 * An entry that is missing, unreadable, of another version or of the wrong
 * type gives that entry's default: the list as the strip, shown, the
 * Activity column 320 px wide, hidden (the agreed design's starting
 * arrangement), and a pinned widget placed by the window's shape, as high
 * as the widget asks, not folded, and an application with the chat at its
 * right, 420 px wide. A storage that cannot be read or written
 * (disabled, full) keeps the layout for this page only.
 */

import {
  defaultApplicationLayoutChoice,
  isApplicationLayoutChoice,
  validChatPaneWidth,
  chatPaneDefault,
  type ApplicationLayoutChoice,
} from '../application/application-layout.ts';
import { activityDefaultWidth, validActivityWidth } from './activity-width.ts';
import { stripWidth, validListWidth } from './list-width.ts';
import {
  defaultPinnedPlace,
  isPinnedPlacePreference,
  validBandPercent,
  type PinnedPlacePreference,
} from './pinned-place.ts';

/** The entries' common prefix, for recognising them in `storage` events. */
export const layoutStoragePrefix = 'companion.shell.layout.';
export const listWidthKey = `${layoutStoragePrefix}listWidth`;
export const listShownKey = `${layoutStoragePrefix}listShown`;
export const activityWidthKey = `${layoutStoragePrefix}activityWidth`;
export const activityShownKey = `${layoutStoragePrefix}activityShown`;
export const pinnedPlaceKey = `${layoutStoragePrefix}pinnedPlace`;
export const pinnedHeightKey = `${layoutStoragePrefix}pinnedHeight`;
export const pinnedFoldedKey = `${layoutStoragePrefix}pinnedFolded`;
export const applicationLayoutKey = `${layoutStoragePrefix}applicationLayout`;
export const applicationChatWidthKey = `${layoutStoragePrefix}applicationChatWidth`;

export interface ListLayout {
  /** Preferred width in CSS pixels: the strip's, or a full list's (see list-width.ts). */
  listWidth: number;
  /** Whether the list is shown (the ☰ button hides and shows it). */
  listShown: boolean;
}

export const defaultLayout: ListLayout = { listWidth: stripWidth, listShown: true };

export interface ActivityLayout {
  /** Preferred width of the Activity column in CSS pixels (see activity-width.ts). */
  activityWidth: number;
  /** Whether the column is shown (☰ and the list's Activity entry hide and show it). */
  activityShown: boolean;
}

export const defaultActivityLayout: ActivityLayout = {
  activityWidth: activityDefaultWidth,
  activityShown: false,
};

export interface PinnedLayout {
  /** Where a pinned widget sits: by the window's shape, or a fixed place. */
  pinnedPlace: PinnedPlacePreference;
  /** The band's height in percent once dragged, or null (the widget's own). */
  pinnedHeight: number | null;
  /** Whether the band at the top is folded to its header. */
  pinnedFolded: boolean;
}

export const defaultPinnedLayout: PinnedLayout = {
  pinnedPlace: defaultPinnedPlace,
  pinnedHeight: null,
  pinnedFolded: false,
};

export interface ApplicationLayoutPreference {
  /** The chat at the right of the application, or App only. */
  applicationLayout: ApplicationLayoutChoice;
  /** Preferred width of the chat at the right, in CSS pixels. */
  applicationChatWidth: number;
}

export const defaultApplicationLayout: ApplicationLayoutPreference = {
  applicationLayout: defaultApplicationLayoutChoice,
  applicationChatWidth: chatPaneDefault,
};

/** The parts of `Storage` used here, so tests can pass a stand-in. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * One entry's value, or undefined when it is missing or not valid. Also
 * used for the display settings (../settings/display-settings.ts), which
 * follow the same storage rules.
 */
export function readEntry(storage: LayoutStorage, key: string): unknown {
  let text: string | null = null;
  try {
    text = storage.getItem(key);
  } catch {
    return undefined;
  }
  if (text === null) {
    return undefined;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof stored !== 'object' || stored === null) {
    return undefined;
  }
  const record = stored as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  return record.value;
}

/** Write one entry; a storage that refuses keeps the value for this page only. */
export function writeEntry(
  storage: LayoutStorage,
  key: string,
  value: number | boolean | string,
): void {
  try {
    storage.setItem(key, JSON.stringify({ version: 1, value }));
  } catch {
    // Storage disabled or full: the layout still applies to this page.
  }
}

/** The remembered layout; each entry that is missing or not valid gives its default. */
export function readLayout(storage: LayoutStorage): ListLayout {
  const layout = { ...defaultLayout };
  const width = readEntry(storage, listWidthKey);
  if (typeof width === 'number') {
    layout.listWidth = validListWidth(width);
  }
  const shown = readEntry(storage, listShownKey);
  if (typeof shown === 'boolean') {
    layout.listShown = shown;
  }
  return layout;
}

/** Remember the preferred width (and only it). */
export function writeListWidth(storage: LayoutStorage, width: number): void {
  writeEntry(storage, listWidthKey, validListWidth(width));
}

/** Remember whether the list is shown (and only that). */
export function writeListShown(storage: LayoutStorage, shown: boolean): void {
  writeEntry(storage, listShownKey, shown);
}

/** The remembered Activity layout; each entry that is missing or not valid gives its default. */
export function readActivityLayout(storage: LayoutStorage): ActivityLayout {
  const layout = { ...defaultActivityLayout };
  const width = readEntry(storage, activityWidthKey);
  if (typeof width === 'number') {
    layout.activityWidth = validActivityWidth(width);
  }
  const shown = readEntry(storage, activityShownKey);
  if (typeof shown === 'boolean') {
    layout.activityShown = shown;
  }
  return layout;
}

/** Remember the Activity column's preferred width (and only it). */
export function writeActivityWidth(storage: LayoutStorage, width: number): void {
  writeEntry(storage, activityWidthKey, validActivityWidth(width));
}

/** Remember whether the Activity column is shown (and only that). */
export function writeActivityShown(storage: LayoutStorage, shown: boolean): void {
  writeEntry(storage, activityShownKey, shown);
}

/** The remembered pinned widget layout; each entry that is missing or not valid gives its default. */
export function readPinnedLayout(storage: LayoutStorage): PinnedLayout {
  const layout = { ...defaultPinnedLayout };
  const place = readEntry(storage, pinnedPlaceKey);
  if (isPinnedPlacePreference(place)) {
    layout.pinnedPlace = place;
  }
  const height = readEntry(storage, pinnedHeightKey);
  if (typeof height === 'number' && Number.isFinite(height)) {
    layout.pinnedHeight = validBandPercent(height);
  }
  const folded = readEntry(storage, pinnedFoldedKey);
  if (typeof folded === 'boolean') {
    layout.pinnedFolded = folded;
  }
  return layout;
}

/** Remember where a pinned widget sits (and only that). */
export function writePinnedPlace(storage: LayoutStorage, place: PinnedPlacePreference): void {
  writeEntry(storage, pinnedPlaceKey, place);
}

/** Remember the band's dragged height (and only it). */
export function writePinnedHeight(storage: LayoutStorage, percent: number): void {
  writeEntry(storage, pinnedHeightKey, validBandPercent(percent));
}

/** Remember whether the band is folded (and only that). */
export function writePinnedFolded(storage: LayoutStorage, folded: boolean): void {
  writeEntry(storage, pinnedFoldedKey, folded);
}

/** The remembered application layout; each entry that is missing or not valid gives its default. */
export function readApplicationLayout(storage: LayoutStorage): ApplicationLayoutPreference {
  const layout = { ...defaultApplicationLayout };
  const choice = readEntry(storage, applicationLayoutKey);
  if (isApplicationLayoutChoice(choice)) {
    layout.applicationLayout = choice;
  }
  const width = readEntry(storage, applicationChatWidthKey);
  if (typeof width === 'number' && Number.isFinite(width)) {
    layout.applicationChatWidth = validChatPaneWidth(width);
  }
  return layout;
}

/** Remember the chat at the right or App only (and only that). */
export function writeApplicationLayout(
  storage: LayoutStorage,
  choice: ApplicationLayoutChoice,
): void {
  writeEntry(storage, applicationLayoutKey, choice);
}

/** Remember the width of the chat at the right (and only it). */
export function writeApplicationChatWidth(storage: LayoutStorage, width: number): void {
  writeEntry(storage, applicationChatWidthKey, validChatPaneWidth(width));
}
