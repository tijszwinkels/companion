/**
 * A button of the Activity column that stays focusable while its action is
 * unavailable.
 *
 * Why not `disabled`: Chromium moves keyboard focus from an element that
 * becomes disabled to the page itself. The column's actions become
 * unavailable exactly while a request the reader just made with the
 * keyboard awaits its answer (Correct, Start, Pause), or when the connection
 * drops, and the reader's focus would be lost each time. So an unavailable
 * button is marked `aria-disabled` (announced as unavailable, drawn dimmed),
 * keeps its focus and its place in the tab order, and ignores presses.
 *
 * The handler of an available button still has to check its action again
 * when it runs: the button may have been drawn for an older state.
 */

import type { ComponentChildren, Ref } from 'preact';

export function ActionButton(props: {
  /** Whether pressing it does anything now. */
  available: boolean;
  onPress: () => void;
  class: string;
  children: ComponentChildren;
  /** A submit button of its form (Start); presses while unavailable never submit. */
  submit?: boolean;
  label?: string;
  title?: string;
  pressed?: boolean;
  expanded?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * Only a single click presses it: the second click of a double click (or
   * of two quick taps, `detail` 2 and more) is ignored, so a click meant for
   * the button that was in this place a moment ago never presses this one.
   * Keyboard presses (`detail` 0) are unaffected. For the application
   * permission buttons (../application/PermissionRows.tsx).
   */
  singleClick?: boolean;
}) {
  let type: 'button' | 'submit' = 'button';
  if (props.submit) {
    type = 'submit';
  }

  function click(event: MouseEvent) {
    if (props.singleClick && event.detail > 1) {
      event.preventDefault();
      return;
    }
    if (!props.available) {
      // Also keeps an unavailable submit button from submitting its form.
      event.preventDefault();
      return;
    }
    if (props.submit) {
      // The form's submit handler runs the action (also for Enter).
      return;
    }
    props.onPress();
  }

  return (
    <button
      ref={props.buttonRef}
      type={type}
      class={props.class}
      aria-disabled={props.available ? undefined : 'true'}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      title={props.title}
      onClick={click}
    >
      {props.children}
    </button>
  );
}
