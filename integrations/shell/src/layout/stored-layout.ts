/**
 * The list layout this browser remembers: the list's preferred width and
 * whether it is shown.
 *
 * Kept in `localStorage` as two independent entries, each JSON
 * `{ "version": 1, "value": … }`:
 *
 * - `companion.shell.layout.listWidth`: the preferred width in pixels;
 * - `companion.shell.layout.listShown`: whether the list is shown.
 *
 * They describe only the arrangement of this page, not the person or their
 * conversations, so they are not cleared on sign-out. Each change writes
 * only its own entry, so two tabs of this browser changing different things
 * at the same moment cannot undo each other, and a tab never writes back a
 * value it did not change (useListLayout.ts follows the other tabs).
 *
 * An entry that is missing, unreadable, of another version or of the wrong
 * type gives that entry's default: the strip, shown (the agreed design's
 * starting arrangement). A storage that cannot be read or written
 * (disabled, full) keeps the layout for this page only.
 */

import { stripWidth, validListWidth } from './list-width.ts';

/** The entries' common prefix, for recognising them in `storage` events. */
export const layoutStoragePrefix = 'companion.shell.layout.';
export const listWidthKey = `${layoutStoragePrefix}listWidth`;
export const listShownKey = `${layoutStoragePrefix}listShown`;

export interface ListLayout {
  /** Preferred width in CSS pixels: the strip's, or a full list's (see list-width.ts). */
  listWidth: number;
  /** Whether the list is shown (the ☰ button hides and shows it). */
  listShown: boolean;
}

export const defaultLayout: ListLayout = { listWidth: stripWidth, listShown: true };

/** The parts of `Storage` used here, so tests can pass a stand-in. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One entry's value, or undefined when it is missing or not valid. */
function readEntry(storage: LayoutStorage, key: string): unknown {
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
function writeEntry(storage: LayoutStorage, key: string, value: number | boolean): void {
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
