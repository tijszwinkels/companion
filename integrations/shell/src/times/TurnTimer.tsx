/**
 * One running turn time on the page (`2:16`), advanced by the page's
 * ticker (./turn-ticker.ts) without drawing the page again.
 *
 * The element's only child is a text node this component creates and the
 * ticker writes; Preact draws the element but never its text, so a tick
 * and a Preact update cannot overwrite each other. The text node is
 * created and registered in a layout effect, so the time is there before
 * the browser paints, and removed when the timer goes away or counts
 * another turn.
 */

import { useLayoutEffect, useRef } from 'preact/hooks';

import type { TurnTicker } from './turn-ticker.ts';

export function TurnTimer(props: {
  ticker: TurnTicker;
  /** The running turn's start, epoch milliseconds on the listener's clock. */
  startedAt: number;
  className: string;
  /** Hidden from assistive technology where the time is already in a label. */
  hidden?: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const { ticker, startedAt } = props;

  useLayoutEffect(() => {
    const container = element.current;
    if (!container) {
      return;
    }
    const text = document.createTextNode('');
    container.appendChild(text);
    const remove = ticker.add(text, startedAt);
    return () => {
      remove();
      text.remove();
    };
  }, [ticker, startedAt]);

  return (
    <span
      ref={element}
      class={props.className}
      title="How long this turn has been running"
      aria-hidden={props.hidden ? 'true' : undefined}
    />
  );
}
