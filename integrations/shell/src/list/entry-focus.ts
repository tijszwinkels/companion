/**
 * Keyboard focus in the conversation list across a redraw.
 *
 * Moving a conversation (by key, by its ⋯ menu or by dragging) redraws the
 * list in the listener's new order, and the browser may drop the focus of
 * an element it moves (Preact reinserts moved entries). A conversation
 * closed by the listener takes its focused controls with it. The rule:
 *
 * 1. If focus was on a control of an entry (its select button, ⋯ button or
 *    ×) or in its open ⋯ menu just before the list drew, and the drawing
 *    dropped it (focus is now on nothing), it returns to the same control of
 *    the same conversation; from a menu that went away, to the ⋯ button.
 * 2. If that conversation is gone, focus goes to the select button of the
 *    entry now at its place, else the last one, else Previous sessions.
 * 3. Focus that is elsewhere after the drawing (the reader moved on) is
 *    left alone.
 *
 * ConversationList.tsx reads the focus while it renders, before the
 * drawing is committed (`focusedEntryControl`), and restores it in a layout
 * effect, before the browser paints (`restoreEntryFocus`).
 */

/** Which control of an entry has focus. */
export type EntryControl = 'select' | 'menu' | 'close';

export interface FocusedEntryControl {
  /** The conversation's ID. */
  id: string;
  control: EntryControl;
  /** The entry's place in the list, to find its successor if it goes. */
  index: number;
}

/** The class name of each control's element in an entry. */
const controlClass: Record<EntryControl, string> = {
  select: 'entry-select',
  menu: 'entry-menu-button',
  close: 'entry-close',
};

/**
 * The entry control that has focus now in the drawn list, or null.
 * `menuEntryId` is the conversation whose ⋯ menu is open (focus in the menu
 * counts as its ⋯ button).
 */
export function focusedEntryControl(
  list: HTMLElement | null,
  menuEntryId: string | null,
): FocusedEntryControl | null {
  const focused = document.activeElement;
  if (!list || !focused || !list.contains(focused)) {
    return null;
  }

  // In the open menu: the menu's own entry, through its ⋯ button.
  if (focused.closest('.entry-menu')) {
    if (menuEntryId === null) {
      return null;
    }
    return { id: menuEntryId, control: 'menu', index: drawnIndex(list, menuEntryId) };
  }

  const entry = focused.closest<HTMLElement>('.conversation-entry[data-id]');
  if (!entry) {
    return null;
  }
  const id = entry.dataset.id!;

  let control: EntryControl | null = null;
  for (const name of ['select', 'menu', 'close'] as const) {
    if (focused.classList.contains(controlClass[name])) {
      control = name;
    }
  }
  if (control === null) {
    return null;
  }
  return { id, control, index: drawnIndex(list, id) };
}

/**
 * After the list drew: put focus back by the rule above if the drawing
 * dropped it. `ids` are the conversations as now drawn.
 */
export function restoreEntryFocus(
  list: HTMLElement | null,
  before: FocusedEntryControl | null,
  ids: readonly string[],
): void {
  if (!list || !before) {
    return;
  }

  // Rule 3: focus somewhere (still on the control, or the reader moved on).
  const focused = document.activeElement;
  if (focused && focused !== document.body && focused.isConnected) {
    return;
  }

  // Rule 1: the same control of the same conversation.
  const entry = entryElement(list, before.id);
  if (entry) {
    const control = entry.querySelector<HTMLElement>(`.${controlClass[before.control]}`);
    const target = control ?? entry.querySelector<HTMLElement>('.entry-select');
    target?.focus();
    return;
  }

  // Rule 2: the entry now at its place, else the last, else Previous sessions.
  if (ids.length > 0) {
    let index = before.index;
    if (index < 0 || index >= ids.length) {
      index = ids.length - 1;
    }
    entryElement(list, ids[index])?.querySelector<HTMLElement>('.entry-select')?.focus();
    return;
  }
  list.querySelector<HTMLElement>('.previous-entry:not(.settings-entry)')?.focus();
}

/** The place of conversation `id` among the drawn entries, or -1. */
function drawnIndex(list: HTMLElement, id: string): number {
  const drawn = [...list.querySelectorAll<HTMLElement>('.conversation-entry[data-id]')];
  return drawn.findIndex((element) => element.dataset.id === id);
}

function entryElement(list: HTMLElement, id: string): HTMLElement | null {
  for (const element of list.querySelectorAll<HTMLElement>('.conversation-entry[data-id]')) {
    if (element.dataset.id === id) {
      return element;
    }
  }
  return null;
}
