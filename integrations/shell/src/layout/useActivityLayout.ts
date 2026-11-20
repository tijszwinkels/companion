/**
 * The Activity column's layout on this page: the remembered preference
 * (stored-layout.ts) and the window width it is shown in. The pure width
 * rules are in activity-width.ts; Workspace.tsx combines this with the
 * list's layout (useListLayout.ts), because in a wide window the column
 * and the list share the width the chat leaves.
 *
 * The same remembering rules as the list's: the preference is read when the
 * page loads; a change the person makes (divider dragged and released,
 * divider key, ☰, the list's Activity entry) writes only the entry it
 * changes; while the divider is dragged the width follows the pointer
 * without being written; a change another tab writes is followed here,
 * entry by entry; a storage that cannot be written keeps this page's values.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import {
  activityShownKey,
  activityWidthKey,
  readActivityLayout,
  writeActivityShown,
  writeActivityWidth,
  type ActivityLayout,
  type LayoutStorage,
} from './stored-layout.ts';

export interface ActivityLayoutView {
  /** Whether the column is shown. */
  shown: boolean;
  /** The preferred width in CSS pixels (what the window allows is Workspace's). */
  preference: number;
  /** The page's width in CSS pixels now. */
  windowWidth: number;
  /** Set the preferred width; `remember` writes it to storage. */
  setWidth(width: number, remember: boolean): void;
  /** Write the current preferred width to storage (the end of a divider drag). */
  remember(): void;
  /** Show or hide the column (remembered). */
  setShown(shown: boolean): void;
  /** Show the column if this tab shows it hidden, else hide it (remembered). */
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

export function useActivityLayout(): ActivityLayoutView {
  const [layout, setLayout] = useState<ActivityLayout>(() => {
    const storage = pageStorage();
    if (storage) {
      return readActivityLayout(storage);
    }
    return readActivityLayout({ getItem: () => null, setItem: () => {} });
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
      const stored = readActivityLayout(storage);
      const next = { ...latest.current };
      if (keys.includes(activityWidthKey)) {
        next.activityWidth = stored.activityWidth;
      }
      if (keys.includes(activityShownKey)) {
        next.activityShown = stored.activityShown;
      }
      if (
        next.activityWidth === latest.current.activityWidth &&
        next.activityShown === latest.current.activityShown
      ) {
        return;
      }
      latest.current = next;
      setLayout(next);
    };
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key === activityWidthKey || event.key === activityShownKey) {
        follow([event.key]);
      }
    };
    window.addEventListener('storage', changedElsewhere);
    // A change can arrive between the first render and this subscription.
    follow([activityWidthKey, activityShownKey]);
    return () => window.removeEventListener('storage', changedElsewhere);
  }, []);

  /** Apply one change to this page; `remember` writes the entries it names. */
  function change(update: Partial<ActivityLayout>, remember: boolean) {
    const next: ActivityLayout = { ...latest.current, ...update };
    latest.current = next;
    setLayout(next);
    if (!remember) {
      return;
    }
    const storage = pageStorage();
    if (!storage) {
      return;
    }
    if (update.activityWidth !== undefined) {
      writeActivityWidth(storage, next.activityWidth);
    }
    if (update.activityShown !== undefined) {
      writeActivityShown(storage, next.activityShown);
    }
  }

  return {
    shown: layout.activityShown,
    preference: layout.activityWidth,
    windowWidth: width,
    setWidth(activityWidth, remember) {
      change({ activityWidth }, remember);
    },
    remember() {
      // The end of a divider drag: the width this tab followed.
      change({ activityWidth: latest.current.activityWidth }, true);
    },
    setShown(shown) {
      change({ activityShown: shown }, true);
    },
    toggleShown() {
      // Toggles what this tab shows (the person pressed on what they saw).
      change({ activityShown: !latest.current.activityShown }, true);
    },
  };
}
