/**
 * The ⋯ menu of one conversation in the list: Move up, Move down and Close
 * session. The menu works by mouse, touch and keyboard, and it is the way to
 * reorder by touch, where the drag never starts (reorder-gesture.ts, rule 9).
 *
 * The list (ConversationList.tsx) owns which menu is open, what each item
 * does and whether it is available; this component draws the menu over the
 * page, next to its ⋯ button, and reports how the reader leaves it.
 *
 * Drawing: the menu has a fixed position computed from its ⋯ button, below
 * it (above it when there is no room below), and kept inside the window. It
 * is drawn outside the list's scrolling area, so the narrow strip does not
 * clip it, and placed again whenever the list draws, scrolls or the window
 * changes size. If the ⋯ button is gone, the list closes the menu.
 *
 * Keyboard (the WAI-ARIA menu button pattern): opening puts focus on the
 * first item; Up and Down move through the items (wrapping), Home and End
 * go to the first and last; Enter and Space choose. Items that are not
 * available now stay focusable and say so (`aria-disabled`), so focus is
 * never dropped while the list changes underneath. Escape closes the menu
 * and returns focus to the ⋯ button. Tab closes it and continues from the
 * ⋯ button.
 *
 * Pointer: a press outside the menu and its ⋯ button closes it (the press
 * then does what it does there). If that press is on nothing that takes
 * focus, focus returns to the ⋯ button instead of being dropped on the
 * page.
 */

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

/** How the reader left the menu without choosing. */
export type MenuDismissal =
  /** Escape: focus returns to the ⋯ button. */
  | 'escape'
  /** Tab: focus goes on from the ⋯ button. */
  | 'tab'
  /** A press outside: focus goes where the press puts it, else to the ⋯ button. */
  | 'outside'
  /** Focus moved to another control of the page: it stays there. */
  | 'focus-left';

export interface MenuItem {
  label: string;
  /** Available now; an unavailable item is drawn dimmed and does nothing. */
  enabled: boolean;
  /** A longer description (the item's title and accessible description). */
  description?: string;
  choose: () => void;
}

/** Gap between the ⋯ button and the menu, and the menu and the window's edge, in CSS pixels. */
const anchorGap = 2;
const windowMargin = 4;

/** Elements that take focus when pressed. */
const focusableSelector =
  'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';

export function EntryMenu(props: {
  /** The menu's element id (named by the ⋯ button's `aria-controls`). */
  id: string;
  /** The element id of the ⋯ button that opened it. */
  anchorId: string;
  /** The menu's accessible name. */
  label: string;
  items: MenuItem[];
  onDismiss: (how: MenuDismissal) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const itemButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const onDismiss = useRef(props.onDismiss);
  onDismiss.current = props.onDismiss;

  /** Place the menu next to its ⋯ button, inside the window. */
  function place() {
    const element = menu.current;
    const anchor = document.getElementById(props.anchorId);
    if (!element || !anchor) {
      return;
    }
    const anchorBox = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;

    // Left-aligned with the ⋯ button, moved left where the window ends.
    let left = anchorBox.left;
    left = Math.min(left, window.innerWidth - width - windowMargin);
    left = Math.max(left, windowMargin);

    // Below the ⋯ button; above it where there is no room below.
    let top = anchorBox.bottom + anchorGap;
    if (top + height > window.innerHeight - windowMargin) {
      top = anchorBox.top - anchorGap - height;
    }
    top = Math.max(top, windowMargin);

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  // Placed before every paint in which the list may have moved its button.
  useLayoutEffect(() => {
    place();
  });

  // Opening puts focus on the first item (also an unavailable one, which
  // stays focusable), as the menu button pattern does; after placing it.
  useLayoutEffect(() => {
    itemButtons.current[0]?.focus();
  }, []);

  // The window changing size or anything scrolling moves the button.
  useEffect(() => {
    const replace = () => {
      place();
    };
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', replace, true);
    return () => {
      window.removeEventListener('resize', replace);
      window.removeEventListener('scroll', replace, true);
    };
  }, [props.anchorId]);

  // A press outside the menu and its ⋯ button closes it. A press on
  // something that takes no focus would drop focus on the page; its
  // mousedown (for touch, the one that follows the tap) is kept from doing
  // so, and focus returns to the ⋯ button. That listener ends with the
  // press's click, or with the next press when the touch became a scroll
  // and no mousedown came. (A layout effect: listening from the moment the
  // menu is drawn.)
  useLayoutEffect(() => {
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const anchor = document.getElementById(props.anchorId);
      if (!target || menu.current?.contains(target) || anchor?.contains(target)) {
        return;
      }
      if (!target.closest(focusableSelector)) {
        keepFocusThroughPress();
      }
      onDismiss.current('outside');
    };
    window.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('pointerdown', press, true);
    };
  }, [props.anchorId]);

  /** The index of the item that has focus, or -1. */
  function focusedIndex(): number {
    return itemButtons.current.findIndex((button) => button === document.activeElement);
  }

  function focusItem(index: number) {
    const count = props.items.length;
    const wrapped = ((index % count) + count) % count;
    itemButtons.current[wrapped]?.focus();
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss.current('escape');
      return;
    }
    if (event.key === 'Tab') {
      // Not prevented: the list focuses the ⋯ button first, and the Tab
      // then moves on from there.
      onDismiss.current('tab');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(focusedIndex() + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const index = focusedIndex();
      focusItem(index < 0 ? props.items.length - 1 : index - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusItem(props.items.length - 1);
    }
  }

  function focusOut(event: FocusEvent) {
    // Focus going nowhere (the window lost focus, say) keeps the menu.
    const next = event.relatedTarget as Node | null;
    if (!next || menu.current?.contains(next)) {
      return;
    }
    if (next === document.getElementById(props.anchorId)) {
      return;
    }
    onDismiss.current('focus-left');
  }

  const buttons = [];
  for (let index = 0; index < props.items.length; index++) {
    const item = props.items[index];
    buttons.push(
      <button
        key={item.label}
        ref={(element) => {
          itemButtons.current[index] = element;
        }}
        class="entry-menu-item"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={item.enabled ? undefined : 'true'}
        title={item.description}
        onClick={() => {
          if (item.enabled) {
            item.choose();
          }
        }}
      >
        {item.label}
      </button>,
    );
  }

  return (
    <div
      id={props.id}
      ref={menu}
      class="entry-menu"
      role="menu"
      aria-label={props.label}
      onKeyDown={keyDown}
      onFocusOut={focusOut}
    >
      {buttons}
    </div>
  );
}

/**
 * Keep the coming mousedown (of the press now starting) from moving focus:
 * it would drop focus on the page, as the press is on nothing focusable.
 */
function keepFocusThroughPress() {
  let ended = false;
  const prevent = (event: MouseEvent) => {
    event.preventDefault();
    end();
  };
  const end = () => {
    ended = true;
    window.removeEventListener('mousedown', prevent, true);
    window.removeEventListener('click', end, true);
    window.removeEventListener('pointerdown', end, true);
  };
  window.addEventListener('mousedown', prevent, true);
  window.addEventListener('click', end, true);
  // Added after this press's own pointerdown has been dispatched, so only
  // the next press ends it.
  setTimeout(() => {
    if (!ended) {
      window.addEventListener('pointerdown', end, true);
    }
  }, 0);
}
