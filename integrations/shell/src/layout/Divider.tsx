/**
 * The divider between the conversation list and the chat. Dragging it
 * changes the list's width; it snaps to the strip or a full list by the
 * rules in list-width.ts. It is also a focusable separator for the keyboard:
 * the arrow keys narrow and widen the list by one step, Home gives the
 * strip, End the widest list.
 *
 * During a drag the width follows the pointer without being remembered;
 * the release (or a cancelled pointer or lost capture, which keep the width
 * reached) writes it once. The pointer is captured by the divider, so the drag continues
 * over the chat and ends wherever the button is released.
 */

import { useRef, useState } from 'preact/hooks';

import { stripWidth, widthFromKey, widthFromPointer } from './list-width.ts';

export function Divider(props: {
  /** The list's shown width in CSS pixels. */
  width: number;
  /** The widest width the window allows now. */
  widest: number;
  /** The element the divider resizes (`aria-controls`). */
  controls: string;
  /** Change the preferred width; `remember` writes it to storage. */
  onWidth: (width: number, remember: boolean) => void;
  /** Write the current preferred width to storage (the end of a drag). */
  onRemember: () => void;
}) {
  // The pointer that is dragging the divider, if any.
  const dragPointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * The pointer's distance from the left edge of the list, which starts at
   * the left edge of the page's content.
   */
  function pointerWidth(event: PointerEvent): number {
    const element = event.currentTarget as HTMLElement;
    const parent = element.parentElement;
    let left = 0;
    if (parent) {
      left = parent.getBoundingClientRect().left;
    }
    return widthFromPointer(event.clientX - left);
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
    setDragging(true);
  }

  function pointerMove(event: PointerEvent) {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    props.onWidth(pointerWidth(event), false);
  }

  /** Release, cancellation or lost capture: remember the width reached. */
  function end(event: PointerEvent) {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    dragPointer.current = null;
    setDragging(false);
    if (event.type === 'pointerup') {
      props.onWidth(pointerWidth(event), false);
    }
    props.onRemember();
  }

  function keyDown(event: KeyboardEvent) {
    const width = widthFromKey(event.key, props.width);
    if (width === null) {
      return;
    }
    event.preventDefault();
    props.onWidth(width, true);
  }

  let valueText = `Full list, ${props.width} pixels`;
  if (props.width === stripWidth) {
    valueText = 'Strip';
  }

  return (
    <div
      class={dragging ? 'list-divider dragging' : 'list-divider'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Conversation list width"
      aria-controls={props.controls}
      aria-valuemin={stripWidth}
      aria-valuemax={Math.max(props.widest, stripWidth)}
      aria-valuenow={props.width}
      aria-valuetext={valueText}
      tabIndex={0}
      title="Drag to change the width of the conversation list"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={keyDown}
    />
  );
}
