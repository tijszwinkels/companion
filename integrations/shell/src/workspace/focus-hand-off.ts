/**
 * Keyboard focus that would be lost with an element that goes away.
 *
 * When a focused element is removed from the page, the browser puts focus
 * on the page's body and a keyboard reader has to start over. In the
 * Activity side that happens when another tab of this browser shows or
 * hides the column (the bar's ☰, or anything inside the column, goes away),
 * when a focused history entry is deleted or its run ends, and when Retry
 * goes away. This hook notices it for one element and everything inside
 * it, while the element is still in the page, and tells its owner, which
 * then moves focus to what replaced it.
 *
 * Timing: Preact runs layout-effect cleanups of a component that unmounts
 * before it removes the component's elements, so `document.activeElement`
 * still is inside the element there.
 */

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

export function useFocusHandOff(elementRef: RefObject<HTMLElement>, onFocusLost: () => void): void {
  // The latest callback, for the cleanup registered at the first render.
  const latest = useRef(onFocusLost);
  latest.current = onFocusLost;

  useLayoutEffect(() => {
    return () => {
      const element = elementRef.current;
      const focused = document.activeElement;
      if (element && focused && element.contains(focused)) {
        latest.current();
      }
    };
  }, [elementRef]);
}
