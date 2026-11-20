/**
 * A divider between two parts of the workspace: the conversation list and
 * the chat, or the chat and the Activity column. Dragging it changes the
 * width of the part it belongs to by that part's rules (list-width.ts,
 * activity-width.ts), given as `fromPointer` and `fromKey`. It is also a
 * focusable separator for the keyboard: each key the part's rules handle
 * changes the width by one step.
 *
 * During a drag the width follows the pointer without being remembered;
 * the release (or a cancelled pointer or lost capture, which keep the width
 * reached) writes it once. The pointer is captured by the divider, so the drag continues
 * over the chat and ends wherever the button is released.
 */

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { useFocusHandOff } from '../workspace/focus-hand-off.ts';

export function Divider(props: {
  /** The resized part's shown width in CSS pixels. */
  width: number;
  /** The narrowest and widest width the window allows now (`aria-valuemin/max`). */
  narrowest: number;
  widest: number;
  /** The divider's accessible name, for example "Conversation list width". */
  label: string;
  /** Its tooltip. */
  title: string;
  /** The shown width in words (`aria-valuetext`). */
  valueText: string;
  /** Extra class for the side it is on. */
  className?: string;
  /** The element the divider resizes (`aria-controls`). */
  controls: string;
  /**
   * The preferred width for the pointer at `clientX`, given the box of the
   * element the divider is in (the workspace).
   */
  fromPointer: (clientX: number, container: DOMRect) => number;
  /** The preferred width after `key` from the shown width, or null for other keys. */
  fromKey: (key: string, shownWidth: number) => number | null;
  /** Change the preferred width; `remember` writes it to storage. */
  onWidth: (width: number, remember: boolean) => void;
  /** Write the current preferred width to storage (the end of a drag). */
  onRemember: () => void;
  /** The divider had keyboard focus when it went away (its owner moves focus on). */
  onFocusLost?: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useFocusHandOff(element, () => {
    props.onFocusLost?.();
  });

  // The pointer that is dragging the divider, if any, and whether it has
  // moved: a press that does not move (a click) changes nothing, also when
  // a narrow window shows the strip for a wider remembered list.
  const dragPointer = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const [dragging, setDragging] = useState(false);

  // The divider goes away during a drag that moved (the window narrowed,
  // another tab hid what it resizes): that also ends the drag, and the
  // width reached is remembered once, as on release. A press that did not
  // move still writes nothing.
  const latestRemember = useRef(props.onRemember);
  latestRemember.current = props.onRemember;
  useLayoutEffect(() => {
    return () => {
      if (dragPointer.current !== null && dragMoved.current) {
        dragPointer.current = null;
        latestRemember.current();
      }
    };
  }, []);

  /** The preferred width for the pointer's position in the divider's container. */
  function pointerWidth(event: PointerEvent): number {
    const element = event.currentTarget as HTMLElement;
    const parent = element.parentElement;
    let container = new DOMRect(0, 0, document.documentElement.clientWidth, 0);
    if (parent) {
      container = parent.getBoundingClientRect();
    }
    return props.fromPointer(event.clientX, container);
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }
    // No text selection and no focus change from this press; the pointer
    // is captured, so the drag continues over the chat.
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture?.(event.pointerId);
    dragPointer.current = event.pointerId;
    dragMoved.current = false;
    setDragging(true);
  }

  function pointerMove(event: PointerEvent) {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    dragMoved.current = true;
    props.onWidth(pointerWidth(event), false);
  }

  /** Release, cancellation or lost capture: remember the width reached. */
  function end(event: PointerEvent) {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    dragPointer.current = null;
    setDragging(false);
    if (!dragMoved.current) {
      return;
    }
    if (event.type === 'pointerup') {
      props.onWidth(pointerWidth(event), false);
    }
    props.onRemember();
  }

  function keyDown(event: KeyboardEvent) {
    const width = props.fromKey(event.key, props.width);
    if (width === null) {
      return;
    }
    event.preventDefault();
    props.onWidth(width, true);
  }

  const classes = ['list-divider'];
  if (props.className) {
    classes.push(props.className);
  }
  if (dragging) {
    classes.push('dragging');
  }

  return (
    <div
      class={classes.join(' ')}
      ref={element}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-valuemin={props.narrowest}
      aria-valuemax={Math.max(props.widest, props.narrowest)}
      aria-valuenow={props.width}
      aria-valuetext={props.valueText}
      tabIndex={0}
      title={props.title}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={keyDown}
    />
  );
}
