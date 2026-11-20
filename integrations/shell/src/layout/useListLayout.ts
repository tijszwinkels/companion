/**
 * The list layout of this page: the remembered preference (stored-layout.ts)
 * and the window width it is shown in, combined by the width rules
 * (list-width.ts).
 *
 * The preference is read when the page loads and written whenever the
 * person changes it (divider released, divider key, ☰); a change written by
 * another tab of this browser is followed here too (the last change wins). While the divider
 * is being dragged the preference follows the pointer without being
 * written; the release writes it. The window width follows `resize`.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import {
  appearanceOf,
  shownListWidth,
  widestShownListWidth,
  type ListAppearance,
} from './list-width.ts';
import {
  layoutStorageKey,
  readLayout,
  writeLayout,
  type LayoutStorage,
  type ListLayout,
} from './stored-layout.ts';

export interface ListLayoutView {
  /** Whether the list is shown. */
  shown: boolean;
  /** The width it is shown at now, in CSS pixels. */
  width: number;
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

export function useListLayout(): ListLayoutView {
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

  // Another tab of this browser changed the layout: follow it, so a later
  // change here (☰, say) does not write this tab's older width back over
  // the one chosen there. The `storage` event reaches only the other tabs.
  useEffect(() => {
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key !== layoutStorageKey) {
        return;
      }
      const storage = pageStorage();
      if (!storage) {
        return;
      }
      const next = readLayout(storage);
      latest.current = next;
      setLayout(next);
    };
    window.addEventListener('storage', changedElsewhere);
    return () => window.removeEventListener('storage', changedElsewhere);
  }, []);

  function change(next: ListLayout, remember: boolean) {
    latest.current = next;
    setLayout(next);
    if (!remember) {
      return;
    }
    const storage = pageStorage();
    if (storage) {
      writeLayout(storage, next);
    }
  }

  const shownWidth = shownListWidth(layout.listWidth, width);

  return {
    shown: layout.listShown,
    width: shownWidth,
    appearance: appearanceOf(shownWidth),
    widest: widestShownListWidth(width),
    setWidth(listWidth, remember) {
      change({ ...latest.current, listWidth }, remember);
    },
    remember() {
      change(latest.current, true);
    },
    toggleShown() {
      change({ ...latest.current, listShown: !latest.current.listShown }, true);
    },
  };
}
