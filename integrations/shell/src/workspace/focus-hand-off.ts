/**
 * Keyboard focus that would be lost with a button that goes away.
 *
 * The two ☰ buttons for Activity replace each other: the bar's while the
 * column is hidden, the column's while it is shown. When the person presses
 * one, Workspace.tsx moves focus to the other. When the change comes from
 * elsewhere (another tab of this browser shows or hides the column), the
 * focused button is simply removed and the browser puts focus on the page's
 * body. This hook notices that, while the button is still in the page, and
 * tells its owner, which then moves focus to the button that replaced it.
 *
 * Timing: Preact runs layout-effect cleanups of a component that unmounts
 * before it removes the component's elements, so `document.activeElement`
 * still is the button there.
 */

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

export function useFocusHandOff(button: RefObject<HTMLElement>, onFocusLost: () => void): void {
  // The latest callback, for the cleanup registered at the first render.
  const latest = useRef(onFocusLost);
  latest.current = onFocusLost;

  useLayoutEffect(() => {
    return () => {
      const element = button.current;
      if (element && document.activeElement === element) {
        latest.current();
      }
    };
  }, [button]);
}
