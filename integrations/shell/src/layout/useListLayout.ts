/**
 * The list layout of this page: the remembered preference (stored-layout.ts)
 * and the window width it is shown in, combined by the width rules
 * (list-width.ts).
 *
 * The preference is read when the page loads. A change the person makes
 * (divider dragged and released, divider key, ☰) writes only the entry it
 * changes; while the divider is being dragged the width follows the pointer
 * without being written, and a press on the divider that does not move
 * writes nothing. A change another tab of this browser writes is followed
 * here, entry by entry, so the last change of each wins. A storage that
 * cannot be written keeps this page's values. The window width follows
 * `resize`; the width the Activity column takes beside it is subtracted
 * first (see `reservedFor`). The list's style (Settings → Display) decides
 * which widths are valid and which appearance a width has; it is passed in
 * by the workspace, which follows the Display settings.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import {
  appearanceOf,
  defaultListStyle,
  shownListWidth,
  widestShownListWidth,
  type ListAppearance,
  type ListStyle,
} from './list-width.ts';
import {
  listShownKey,
  listWidthKey,
  readLayout,
  writeListShown,
  writeListWidth,
  type LayoutStorage,
  type ListLayout,
} from './stored-layout.ts';

export interface ListLayoutView {
  /** Whether the list is shown. */
  shown: boolean;
  /** The width it is shown at now, in CSS pixels. */
  width: number;
  /** The preferred width as remembered (what the style and the window allow is `width`). */
  preference: number;
  /** The list's style it is shown in. */
  style: ListStyle;
  /** Its appearance at that width. */
  appearance: ListAppearance;
  /** The widest width this window allows now (for the divider's range). */
  widest: number;
  /** Set the preferred width; `remember` writes it to storage. */
  setWidth(width: number, remember: boolean): void;
  /** Write the current preference to storage (the end of a divider drag). */
  remember(): void;
  /** Hide or show the list (remembered). */
  toggleShown(): void;
}

/** This browser's localStorage, or null where the page may not use it. */
function pageStorage(): LayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's width in CSS pixels, without a vertical scroll bar. */
function windowWidth(): number {
  return document.documentElement.clientWidth;
}

/**
 * `reservedFor` gives the width something beside the list and the chat
 * takes from the window (the right column in a wide window), for whether
 * the list is shown and its preferred width; the list's width rules apply
 * to what remains. `style` is the list's style now.
 */
export function useListLayout(
  reservedFor: (listShown: boolean, listPreference: number) => number = () => 0,
  style: ListStyle = defaultListStyle,
): ListLayoutView {
  const [layout, setLayout] = useState<ListLayout>(() => {
    const storage = pageStorage();
    if (storage) {
      return readLayout(storage);
    }
    return readLayout({ getItem: () => null, setItem: () => {} });
  });
  // The latest layout, also for handlers created in an earlier render (a
  // divider drag spans many renders).
  const latest = useRef(layout);
  latest.current = layout;
  const [width, setWindowWidth] = useState(windowWidth);

  useEffect(() => {
    const resized = () => setWindowWidth(windowWidth());
    window.addEventListener('resize', resized);
    // The width can change between the first render and this effect.
    resized();
    return () => window.removeEventListener('resize', resized);
  }, []);

  // Another tab of this browser changed an entry: follow that entry. (The
  // `storage` event reaches only the other tabs.)
  useEffect(() => {
    const follow = (keys: string[]) => {
      const storage = pageStorage();
      if (!storage) {
        return;
      }
      const stored = readLayout(storage);
      const next = { ...latest.current };
      if (keys.includes(listWidthKey)) {
        next.listWidth = stored.listWidth;
      }
      if (keys.includes(listShownKey)) {
        next.listShown = stored.listShown;
      }
      if (
        next.listWidth === latest.current.listWidth &&
        next.listShown === latest.current.listShown
      ) {
        return;
      }
      latest.current = next;
      setLayout(next);
    };
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key === listWidthKey || event.key === listShownKey) {
        follow([event.key]);
      }
    };
    window.addEventListener('storage', changedElsewhere);
    // A change can arrive between the first render and this subscription.
    follow([listWidthKey, listShownKey]);
    return () => window.removeEventListener('storage', changedElsewhere);
  }, []);

  /** Apply one change to this page; `remember` writes the entries it names. */
  function change(update: Partial<ListLayout>, remember: boolean) {
    const next: ListLayout = { ...latest.current, ...update };
    latest.current = next;
    setLayout(next);
    if (!remember) {
      return;
    }
    const storage = pageStorage();
    if (!storage) {
      return;
    }
    if (update.listWidth !== undefined) {
      writeListWidth(storage, next.listWidth);
    }
    if (update.listShown !== undefined) {
      writeListShown(storage, next.listShown);
    }
  }

  const roomWidth = width - reservedFor(layout.listShown, layout.listWidth);
  const shownWidth = shownListWidth(layout.listWidth, roomWidth, style);

  return {
    shown: layout.listShown,
    width: shownWidth,
    preference: layout.listWidth,
    style,
    appearance: appearanceOf(shownWidth, style),
    widest: widestShownListWidth(roomWidth, style),
    setWidth(listWidth, remember) {
      change({ listWidth }, remember);
    },
    remember() {
      // The end of a divider drag: the width this tab followed.
      change({ listWidth: latest.current.listWidth }, true);
    },
    toggleShown() {
      // Toggles what this tab shows (the person pressed ☰ on what they saw).
      change({ listShown: !latest.current.listShown }, true);
    },
  };
}
