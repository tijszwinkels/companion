/**
 * The Display settings this browser remembers (see the shell README,
 * "Settings"): four switches and the conversation list's style.
 *
 * - `turnTimers`: how long a running turn has been going, in the bar above
 *   the chat and on that conversation in the list;
 * - `lastTurnDuration`: how long the last turn took, in the bar while the
 *   shown conversation has no running turn;
 * - `messageTimestamps`: when each message was written, on its heading line;
 * - `listSubtitles`: the second line (the conversation's last line) under
 *   each conversation's title in the full list;
 * - `listStyle`: the conversation list as the strip or the full list by
 *   its width (`by-width`), always the strip (`compact`) or always the full
 *   list (`full`); ../layout/list-width.ts has its width rules.
 *
 * The switches are on by default, the style is `by-width`: a browser that
 * remembers nothing looks as before these settings existed. Each is kept in
 * `localStorage` as its own entry, JSON `{ "version": 1, "value": … }`,
 * with the layout entries' rules (../layout/stored-layout.ts):
 *
 * - `companion.shell.display.turnTimers` (`true` or `false`)
 * - `companion.shell.display.lastTurnDuration` (`true` or `false`)
 * - `companion.shell.display.messageTimestamps` (`true` or `false`)
 * - `companion.shell.display.listSubtitles` (`true` or `false`)
 * - `companion.shell.display.listStyle` (`"by-width"`, `"compact"` or
 *   `"full"`)
 *
 * An entry that is missing, unreadable, of another version or of the wrong
 * type or value gives its default. A change writes only its own entry, so two tabs
 * changing different switches never undo each other; another tab's change
 * is followed entry by entry (`followStorage`). A storage that refuses
 * writes (or cannot be read at all) keeps the values for this page only.
 * They describe how this browser shows things, not the person or their
 * conversations, so they are not cleared on sign-out.
 *
 * `DisplaySettings` is one object per page (created in main.tsx), read by
 * the workspace (bar, list, settings screen) and by the chat bridge (the
 * message times it puts into the chat page's rows).
 */

import { defaultListStyle, isListStyle, type ListStyle } from '../layout/list-width.ts';
import { readEntry, writeEntry, type LayoutStorage } from '../layout/stored-layout.ts';

/** The on/off switches. */
export type DisplaySettingName =
  'turnTimers' | 'lastTurnDuration' | 'messageTimestamps' | 'listSubtitles';

/** Every switch's value, and the list's style. */
export type DisplaySettingsValues = Record<DisplaySettingName, boolean> & {
  listStyle: ListStyle;
};

/** The entries' common prefix, for recognising them in `storage` events. */
export const displayStoragePrefix = 'companion.shell.display.';

/** Every switch. */
export const displaySettingNames: readonly DisplaySettingName[] = [
  'turnTimers',
  'lastTurnDuration',
  'messageTimestamps',
  'listSubtitles',
];

/** The storage key of one switch. */
export function displaySettingKey(name: DisplaySettingName): string {
  return displayStoragePrefix + name;
}

/** The storage key of the list's style. */
export const listStyleKey = `${displayStoragePrefix}listStyle`;

export const defaultDisplaySettings: DisplaySettingsValues = {
  turnTimers: true,
  lastTurnDuration: true,
  messageTimestamps: true,
  listSubtitles: true,
  listStyle: defaultListStyle,
};

/** One remembered switch; missing or not valid gives its default (on). */
function readSetting(storage: LayoutStorage, name: DisplaySettingName): boolean {
  const value = readEntry(storage, displaySettingKey(name));
  if (typeof value === 'boolean') {
    return value;
  }
  return defaultDisplaySettings[name];
}

/** The remembered list style; missing or not valid gives the default (`by-width`). */
function readListStyle(storage: LayoutStorage): ListStyle {
  const value = readEntry(storage, listStyleKey);
  if (isListStyle(value)) {
    return value;
  }
  return defaultListStyle;
}

/** The remembered settings; each that is missing or not valid gives its default. */
export function readDisplaySettings(storage: LayoutStorage): DisplaySettingsValues {
  const values = { ...defaultDisplaySettings };
  for (const name of displaySettingNames) {
    values[name] = readSetting(storage, name);
  }
  values.listStyle = readListStyle(storage);
  return values;
}

/** Remember one switch (and only it); a storage that refuses keeps nothing. */
export function writeDisplaySetting(
  storage: LayoutStorage,
  name: DisplaySettingName,
  value: boolean,
): void {
  writeEntry(storage, displaySettingKey(name), value);
}

/** Remember the list's style (and only it); a storage that refuses keeps nothing. */
export function writeListStyle(storage: LayoutStorage, style: ListStyle): void {
  writeEntry(storage, listStyleKey, style);
}

/** The switch a storage key names, or undefined for any other key. */
export function displaySettingOfKey(key: string): DisplaySettingName | undefined {
  for (const name of displaySettingNames) {
    if (displaySettingKey(name) === key) {
      return name;
    }
  }
  return undefined;
}

/**
 * This page's Display settings: the remembered values, the changes made
 * here and those followed from other tabs. Listeners are told after every
 * change of a value (not when a write or a followed entry changes nothing).
 */
export class DisplaySettings {
  private current: DisplaySettingsValues;
  private readonly listeners = new Set<() => void>();

  /**
   * `storage` gives this browser's storage, or null where the page may not
   * use it (then the values are this page's only, starting at the defaults).
   */
  constructor(private readonly storage: () => LayoutStorage | null) {
    const available = storage();
    if (available) {
      this.current = readDisplaySettings(available);
    } else {
      this.current = { ...defaultDisplaySettings };
    }
  }

  /** The values shown now (a new object after every change). */
  get values(): DisplaySettingsValues {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The person switched one: applied at once, and only its entry is written. */
  set(name: DisplaySettingName, value: boolean): void {
    const storage = this.storage();
    if (storage) {
      writeDisplaySetting(storage, name, value);
    }
    this.apply(name, value);
  }

  /** The person chose the list's style: applied at once, and only its entry is written. */
  setListStyle(style: ListStyle): void {
    const storage = this.storage();
    if (storage) {
      writeListStyle(storage, style);
    }
    this.applyListStyle(style);
  }

  /**
   * Another tab of this browser wrote `key` (a `storage` event; `null` when
   * it cleared the whole storage): follow that entry, or every entry.
   */
  followStorage(key: string | null): void {
    const storage = this.storage();
    if (!storage) {
      return;
    }
    if (key === null) {
      for (const name of displaySettingNames) {
        this.apply(name, readSetting(storage, name));
      }
      this.applyListStyle(readListStyle(storage));
      return;
    }
    if (key === listStyleKey) {
      this.applyListStyle(readListStyle(storage));
      return;
    }
    const name = displaySettingOfKey(key);
    if (name === undefined) {
      return;
    }
    this.apply(name, readSetting(storage, name));
  }

  private apply(name: DisplaySettingName, value: boolean): void {
    if (this.current[name] === value) {
      return;
    }
    this.current = { ...this.current, [name]: value };
    this.notify();
  }

  private applyListStyle(style: ListStyle): void {
    if (this.current.listStyle === style) {
      return;
    }
    this.current = { ...this.current, listStyle: style };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
