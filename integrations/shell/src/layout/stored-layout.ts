/**
 * The list layout this browser remembers: the list's preferred width and
 * whether it is shown.
 *
 * Kept in `localStorage` under `layoutStorageKey`, as JSON
 * `{ "version": 1, "listWidth": <pixels>, "listShown": <boolean> }`. It
 * describes only the arrangement of this page, not the person or their
 * conversations, so it is not cleared on sign-out and is shared by the tabs
 * of this browser (each tab reads it when it loads).
 *
 * Anything missing, unreadable or of another version gives the default: the
 * strip, shown (the agreed design's starting arrangement). A storage that
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

  let listWidth = defaultLayout.listWidth;
  if (typeof record.listWidth === 'number') {
    listWidth = validListWidth(record.listWidth);
  }
  let listShown = defaultLayout.listShown;
  if (typeof record.listShown === 'boolean') {
    listShown = record.listShown;
  }
  return { listWidth, listShown };
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
