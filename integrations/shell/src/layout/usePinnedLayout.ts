/**
 * The pinned widget's layout on this page: the place, band height and fold
 * this browser remembers (stored-layout.ts), and the window's height. The
 * pure rules are in pinned-place.ts; Workspace.tsx combines them with the
 * list's and the Activity column's layouts.
 *
 * The same remembering rules as the list's and the column's: read when the
 * page loads; a change the person makes (a place button, Fold, the band's
 * edge released or moved by a key) writes only the entry it changes; while
 * the edge is dragged the height follows the pointer without being written;
 * a change another tab writes is followed here, entry by entry; a storage
 * that cannot be written keeps this page's values.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { PinnedPlacePreference } from './pinned-place.ts';
import {
  pinnedFoldedKey,
  pinnedHeightKey,
  pinnedPlaceKey,
  readPinnedLayout,
  writePinnedFolded,
  writePinnedHeight,
  writePinnedPlace,
  type LayoutStorage,
  type PinnedLayout,
} from './stored-layout.ts';

export interface PinnedLayoutView {
  /** Where the person put a pinned widget: by the window's shape, or a fixed place. */
  preference: PinnedPlacePreference;
  /** The band's height in percent once dragged here or in another tab, else null. */
  heightPercent: number | null;
  /** Whether the band at the top is folded. */
  folded: boolean;
  /** The page's height in CSS pixels now. */
  windowHeight: number;
  /** Fix a place, or 'auto' (remembered). */
  setPreference(preference: PinnedPlacePreference): void;
  /** Set the band's height; `remember` writes it to storage. */
  setHeight(percent: number, remember: boolean): void;
  /** Write the current band height to storage (the end of a drag). */
  remember(): void;
  /** Fold or unfold the band (remembered). */
  setFolded(folded: boolean): void;
}

/** This browser's localStorage, or null where the page may not use it. */
function pageStorage(): LayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's height in CSS pixels. */
function windowHeight(): number {
  return document.documentElement.clientHeight;
}

const keys = [pinnedPlaceKey, pinnedHeightKey, pinnedFoldedKey];

export function usePinnedLayout(): PinnedLayoutView {
  const [layout, setLayout] = useState<PinnedLayout>(() => {
    const storage = pageStorage();
    if (storage) {
      return readPinnedLayout(storage);
    }
    return readPinnedLayout({ getItem: () => null, setItem: () => {} });
  });
  // The latest layout, also for handlers created in an earlier render (a
  // drag of the band's edge spans many renders).
  const latest = useRef(layout);
  latest.current = layout;
  const [height, setWindowHeight] = useState(windowHeight);

  useEffect(() => {
    const resized = () => setWindowHeight(windowHeight());
    window.addEventListener('resize', resized);
    // The height can change between the first render and this effect.
    resized();
    return () => window.removeEventListener('resize', resized);
  }, []);

  // Another tab of this browser changed an entry: follow that entry. (The
  // `storage` event reaches only the other tabs.)
  useEffect(() => {
    const follow = (changed: string[]) => {
      const storage = pageStorage();
      if (!storage) {
        return;
      }
      const stored = readPinnedLayout(storage);
      const next = { ...latest.current };
      if (changed.includes(pinnedPlaceKey)) {
        next.pinnedPlace = stored.pinnedPlace;
      }
      if (changed.includes(pinnedHeightKey)) {
        next.pinnedHeight = stored.pinnedHeight;
      }
      if (changed.includes(pinnedFoldedKey)) {
        next.pinnedFolded = stored.pinnedFolded;
      }
      if (
        next.pinnedPlace === latest.current.pinnedPlace &&
        next.pinnedHeight === latest.current.pinnedHeight &&
        next.pinnedFolded === latest.current.pinnedFolded
      ) {
        return;
      }
      latest.current = next;
      setLayout(next);
    };
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key !== null && keys.includes(event.key)) {
        follow([event.key]);
      }
    };
    window.addEventListener('storage', changedElsewhere);
    // A change can arrive between the first render and this subscription.
    follow(keys);
    return () => window.removeEventListener('storage', changedElsewhere);
  }, []);

  /** Apply one change to this page; `remember` writes the entries it names. */
  function change(update: Partial<PinnedLayout>, remember: boolean) {
    const next: PinnedLayout = { ...latest.current, ...update };
    latest.current = next;
    setLayout(next);
    if (!remember) {
      return;
    }
    const storage = pageStorage();
    if (!storage) {
      return;
    }
    if (update.pinnedPlace !== undefined) {
      writePinnedPlace(storage, next.pinnedPlace);
    }
    if (update.pinnedHeight !== undefined && next.pinnedHeight !== null) {
      writePinnedHeight(storage, next.pinnedHeight);
    }
    if (update.pinnedFolded !== undefined) {
      writePinnedFolded(storage, next.pinnedFolded);
    }
  }

  return {
    preference: layout.pinnedPlace,
    heightPercent: layout.pinnedHeight,
    folded: layout.pinnedFolded,
    windowHeight: height,
    setPreference(preference) {
      change({ pinnedPlace: preference }, true);
    },
    setHeight(percent, remember) {
      change({ pinnedHeight: percent }, remember);
    },
    remember() {
      // The end of a drag: the height this tab followed.
      if (latest.current.pinnedHeight !== null) {
        change({ pinnedHeight: latest.current.pinnedHeight }, true);
      }
    },
    setFolded(folded) {
      change({ pinnedFolded: folded }, true);
    },
  };
}
