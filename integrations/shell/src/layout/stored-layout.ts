/**
 * The layout this browser remembers: the conversation list's preferred
 * width and whether it is shown, and the same two for the Activity column.
 *
 * Kept in `localStorage` as four independent entries, each JSON
 * `{ "version": 1, "value": … }`:
 *
 * - `companion.shell.layout.listWidth`: the list's preferred width in pixels;
 * - `companion.shell.layout.listShown`: whether the list is shown;
 * - `companion.shell.layout.activityWidth`: the Activity column's preferred
 *   width in pixels;
 * - `companion.shell.layout.activityShown`: whether the column is shown.
 *
 * They describe only the arrangement of this page, not the person or their
 * conversations, so they are not cleared on sign-out. Each change writes
 * only its own entry, so two tabs of this browser changing different things
 * at the same moment cannot undo each other, and a tab never writes back a
 * value it did not change (useListLayout.ts follows the other tabs).
 *
 * An entry that is missing, unreadable, of another version or of the wrong
 * type gives that entry's default: the list as the strip, shown, and the
 * Activity column 320 px wide, hidden (the agreed design's starting
 * arrangement). A storage that cannot be read or written
 * (disabled, full) keeps the layout for this page only.
 */

import { activityDefaultWidth, validActivityWidth } from './activity-width.ts';
import { stripWidth, validListWidth } from './list-width.ts';

/** The entries' common prefix, for recognising them in `storage` events. */
export const layoutStoragePrefix = 'companion.shell.layout.';
export const listWidthKey = `${layoutStoragePrefix}listWidth`;
export const listShownKey = `${layoutStoragePrefix}listShown`;
export const activityWidthKey = `${layoutStoragePrefix}activityWidth`;
export const activityShownKey = `${layoutStoragePrefix}activityShown`;

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
export function writeEntry(storage: LayoutStorage, key: string, value: number | boolean): void {
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
