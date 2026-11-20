/**
 * The list layout this browser remembers: the list's preferred width and
 * whether it is shown.
 *
 * Kept in `localStorage` under `layoutStorageKey`, as JSON
 * `{ "version": 1, "listWidth": <pixels>, "listShown": <boolean> }`. It
 * describes only the arrangement of this page, not the person or their
 * conversations, so it is not cleared on sign-out and is shared by the tabs
 * of this browser (each tab follows the last change, useListLayout.ts).
 *
 * Anything missing, unreadable, of another version or with a field of the
 * wrong type gives the default: the strip, shown (the agreed design's
 * starting arrangement). A storage that
 * cannot be read or written (disabled, full) keeps the layout for this page
 * only.
 */

import { stripWidth, validListWidth } from './list-width.ts';

export const layoutStorageKey = 'companion.shell.layout';

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

/** The remembered layout, or the default when there is none or it is not valid. */
export function readLayout(storage: LayoutStorage): ListLayout {
  let text: string | null = null;
  try {
    text = storage.getItem(layoutStorageKey);
  } catch {
    return { ...defaultLayout };
  }
  if (text === null) {
    return { ...defaultLayout };
  }

  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return { ...defaultLayout };
  }
  if (typeof stored !== 'object' || stored === null) {
    return { ...defaultLayout };
  }

  const record = stored as Record<string, unknown>;
  if (record.version !== 1) {
    return { ...defaultLayout };
  }

  // Both fields or neither: a record with one unusable field is not
  // trusted for the other either.
  if (typeof record.listWidth !== 'number' || typeof record.listShown !== 'boolean') {
    return { ...defaultLayout };
  }
  return { listWidth: validListWidth(record.listWidth), listShown: record.listShown };
}

/** Remember `layout`; a storage that refuses keeps it for this page only. */
export function writeLayout(storage: LayoutStorage, layout: ListLayout): void {
  const stored = {
    version: 1,
    listWidth: validListWidth(layout.listWidth),
    listShown: layout.listShown,
  };
  try {
    storage.setItem(layoutStorageKey, JSON.stringify(stored));
  } catch {
    // Storage disabled or full: the layout still applies to this page.
  }
}

/**
 * Remember one change made in this tab and return the layout that results.
 *
 * The change is applied onto what is stored now, not onto this tab's copy
 * (`current`): another tab may have written since, and its `storage` event
 * may not have reached this tab yet. Only the fields `update` names come
 * from this tab, so hiding the list here never writes back an older width,
 * and a width set here never writes back an older hidden state. With
 * nothing stored yet (or a storage that cannot be read), `current` is the
 * base.
 */
export function rememberChange(
  storage: LayoutStorage,
  current: ListLayout,
  update: Partial<ListLayout>,
): ListLayout {
  let stored: string | null = null;
  try {
    stored = storage.getItem(layoutStorageKey);
  } catch {
    stored = null;
  }
  let base = current;
  if (stored !== null) {
    base = readLayout(storage);
  }
  const next = { ...base, ...update };
  writeLayout(storage, next);
  return next;
}
