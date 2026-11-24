/**
 * The application layout of this page: the person's choice between the
 * chat at the right of a session application and App only, and the width
 * of the chat at the right, as this browser remembers them
 * (../layout/stored-layout.ts). The pure rules are in
 * application-layout.ts; Workspace.tsx combines them with the window and
 * the list's and the Activity column's layouts.
 *
 * The same remembering rules as the list's and the column's: read when the
 * page loads; a change the person makes (the bar's ▣ App only or ◫ Chat at
 * the right, the divider released or moved by a key) writes only the entry
 * it changes; while the divider is dragged the width follows the pointer
 * without being written; a change another tab writes is followed here,
 * entry by entry; a storage that cannot be written keeps this page's
 * values.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import {
  applicationChatWidthKey,
  applicationLayoutKey,
  readApplicationLayout,
  writeApplicationChatWidth,
  writeApplicationLayout,
  type ApplicationLayoutPreference,
  type LayoutStorage,
} from '../layout/stored-layout.ts';
import type { ApplicationLayoutChoice } from './application-layout.ts';

export interface ApplicationLayoutView {
  /** The person's choice: the chat at the right, or App only. */
  choice: ApplicationLayoutChoice;
  /** The preferred width of the chat at the right, in CSS pixels. */
  chatWidth: number;
  /** Choose the chat at the right or App only (remembered). */
  setChoice(choice: ApplicationLayoutChoice): void;
  /** Set the chat's preferred width; `remember` writes it to storage. */
  setChatWidth(width: number, remember: boolean): void;
  /** Write the current chat width to storage (the end of a divider drag). */
  remember(): void;
}

/** This browser's localStorage, or null where the page may not use it. */
function pageStorage(): LayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const keys = [applicationLayoutKey, applicationChatWidthKey];

export function useApplicationLayout(): ApplicationLayoutView {
  const [layout, setLayout] = useState<ApplicationLayoutPreference>(() => {
    const storage = pageStorage();
    if (storage) {
      return readApplicationLayout(storage);
    }
    return readApplicationLayout({ getItem: () => null, setItem: () => {} });
  });

  // The latest layout, also for handlers created in an earlier render (a
  // divider drag spans many renders).
  const latest = useRef(layout);
  latest.current = layout;

  // Another tab of this browser changed an entry: follow that entry. (The
  // `storage` event reaches only the other tabs.)
  useEffect(() => {
    const follow = (changed: string[]) => {
      const storage = pageStorage();
      if (!storage) {
        return;
      }
      const stored = readApplicationLayout(storage);
      const next = { ...latest.current };
      if (changed.includes(applicationLayoutKey)) {
        next.applicationLayout = stored.applicationLayout;
      }
      if (changed.includes(applicationChatWidthKey)) {
        next.applicationChatWidth = stored.applicationChatWidth;
      }
      if (
        next.applicationLayout === latest.current.applicationLayout &&
        next.applicationChatWidth === latest.current.applicationChatWidth
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

  /** Apply one change to this page; `remember` writes the entry it names. */
  function change(update: Partial<ApplicationLayoutPreference>, remember: boolean) {
    const next: ApplicationLayoutPreference = { ...latest.current, ...update };
    latest.current = next;
    setLayout(next);
    if (!remember) {
      return;
    }
    const storage = pageStorage();
    if (!storage) {
      return;
    }
    if (update.applicationLayout !== undefined) {
      writeApplicationLayout(storage, next.applicationLayout);
    }
    if (update.applicationChatWidth !== undefined) {
      writeApplicationChatWidth(storage, next.applicationChatWidth);
    }
  }

  return {
    choice: layout.applicationLayout,
    chatWidth: layout.applicationChatWidth,
    setChoice(choice) {
      change({ applicationLayout: choice }, true);
    },
    setChatWidth(width, remember) {
      change({ applicationChatWidth: width }, remember);
    },
    remember() {
      // The end of a divider drag: the width this tab followed.
      change({ applicationChatWidth: latest.current.applicationChatWidth }, true);
    },
  };
}
