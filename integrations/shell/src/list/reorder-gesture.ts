/**
 * The reorder gesture of the conversation list, without DOM access.
 *
 * The rules are the native rail's (integrations/session-apps/rail/main.tsx)
 * and use its shared pure functions (../../../session-apps/RailOrder.mjs);
 * the README's "Reordering by dragging" lists them with their cases, and
 * test/shell/reorder-gesture.test.ts checks one table derived from them.
 *
 * In short: a press on a conversation that moves `dragThreshold` pixels with
 * the button held becomes a drag; a shorter press stays a click. The press
 * captures the listener's order revision and the open conversations. One
 * completed drag asks for exactly one move, naming the captured revision,
 * and only when it is released inside the list at a position that changes
 * the order, while the order, membership and connection are as they were.
 * Escape, a cancelled pointer, lost pointer capture, the window losing focus,
 * a release outside the list, a changed order or membership, or the list
 * becoming unavailable (offline, waiting for the listener's snapshot, no
 * order revision) end it without a move. A
 * drag never also selects or closes: the click that follows the release of
 * any activated drag is swallowed. The list never reorders itself; it
 * always shows the listener's order.
 *
 * Inputs: pointer and key events translated by ConversationList.tsx, the
 * insertion point it computes from the rendered rows, and the current order.
 * Outputs: the move to request (if any), whether the next click must be
 * swallowed, and what to draw while dragging.
 */

import { dragThreshold, isNoOp, orderKey } from '../../../session-apps/RailOrder.mjs';

/** The listener's order as the list shows it now. */
export interface OrderState {
  /** Open conversations in the listener's order. */
  ids: readonly string[];
  /** The listener's order revision (`sessionOrderRevision` / `agent-order`). */
  revision: string;
  /** Requests are admitted: connected, after this connection's snapshot. */
  available: boolean;
}

/**
 * Whether a move can be asked for under `order`: requests are admitted and
 * the listener named an order revision (`move-agent` requires one; a
 * listener that sends none cannot be reordered from here).
 */
function movable(order: OrderState): boolean {
  return order.available && order.revision !== '';
}

/** One `move-agent` request. */
export interface MoveRequest {
  id: string;
  /** The conversation it goes before, or "" for the end. */
  beforeId: string;
  /** The order revision captured when the press started. */
  revision: string;
}

/** What the list draws while a drag is active. */
export interface DragView {
  id: string;
  beforeId: string;
  /** False when a release now would move nothing (outside the list, or no change). */
  droppable: boolean;
}

/** Where the pointer is, as the list computed it from its rendered rows. */
export interface DropPosition {
  /** The conversation a drop here goes before, or "" for the end (RailOrder.insertionTarget). */
  beforeId: string;
  /** The pointer is inside the list's scrolling area. */
  inside: boolean;
}

/** The outcome of a release or cancellation. */
export interface GestureEnd {
  move: MoveRequest | null;
  /** The browser's click after this release belongs to a drag: ignore it. */
  swallowClick: boolean;
}

/** The left mouse button, or a touch or pen contact. */
const primaryButton = 0;
const primaryButtonMask = 1;

interface Press {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Membership and order revision when the press started (RailOrder.orderKey). */
  key: string;
  revision: string;
  /** Moved past the threshold with the button held: a drag. */
  active: boolean;
  /**
   * An activated drag that was cancelled. Kept until its button is
   * released, so that release's click is swallowed too; it never moves
   * anything.
   */
  cancelled: boolean;
  /** Latest drop position reported while active. */
  position: DropPosition;
}

const noEnd: GestureEnd = { move: null, swallowClick: false };

export class ReorderGesture {
  private press: Press | null = null;

  /**
   * A pointer went down on conversation `id` (not on its close button). A
   * new press always ends whatever an earlier one left behind. Only the
   * primary button of a mouse or pen starts a gesture, and only while the
   * list is available. A touch never does: on a touchscreen the list
   * scrolls and a tap selects (see the README's rule 9).
   */
  pointerDown(
    id: string,
    pointerId: number,
    pointerType: string,
    button: number,
    x: number,
    y: number,
    order: OrderState,
  ): void {
    this.press = null;
    if (pointerType === 'touch') {
      return;
    }
    if (button !== primaryButton || !movable(order) || !order.ids.includes(id)) {
      return;
    }
    this.press = {
      id,
      pointerId,
      startX: x,
      startY: y,
      key: orderKey(order.ids, order.revision),
      revision: order.revision,
      active: false,
      cancelled: false,
      position: { beforeId: '', inside: true },
    };
  }

  /**
   * The pointer moved, anywhere in the window. Returns true while the
   * movement belongs to an active drag: the list then reports the drop
   * position with `track` and keeps the browser from selecting text.
   *
   * Movement without the primary button held means the release was missed
   * (released outside the window, say): the press is forgotten, as hovering
   * is not dragging. A press whose order, membership or availability
   * changed before it became a drag is forgotten too, here and not only
   * when the list reports the change (`orderChanged`), so it stays an
   * ordinary click whichever comes first.
   */
  pointerMove(
    pointerId: number,
    buttons: number,
    x: number,
    y: number,
    order: OrderState,
  ): boolean {
    const press = this.press;
    if (!press || pointerId !== press.pointerId) {
      return false;
    }
    if ((buttons & primaryButtonMask) === 0) {
      this.press = null;
      return false;
    }
    if (press.cancelled) {
      return false;
    }
    if (!press.active) {
      if (!movable(order) || orderKey(order.ids, order.revision) !== press.key) {
        this.press = null;
        return false;
      }
      const distance = Math.hypot(x - press.startX, y - press.startY);
      if (distance < dragThreshold) {
        return false;
      }
      press.active = true;
    }
    return true;
  }

  /** The drop position for the latest movement of an active drag. */
  track(position: DropPosition, order: OrderState): void {
    const press = this.press;
    if (!press || !press.active || press.cancelled) {
      return;
    }
    press.position = position;
    this.orderChanged(order);
  }

  /** What to draw now: the dragged conversation and the insertion line. */
  view(order: OrderState): DragView | null {
    const press = this.press;
    if (!press || !press.active || press.cancelled) {
      return null;
    }
    const changesOrder = !isNoOp(order.ids, press.id, press.position.beforeId);
    return {
      id: press.id,
      beforeId: press.position.beforeId,
      droppable: press.position.inside && changesOrder,
    };
  }

  /** A press is being followed (possibly not yet a drag). */
  get pressed(): boolean {
    return this.press !== null;
  }

  /** An activated drag is in progress (not cancelled). */
  get dragging(): boolean {
    return this.press !== null && this.press.active && !this.press.cancelled;
  }

  /**
   * The pointer was released, anywhere. A press that never became a drag
   * ends quietly and its click selects as usual. An active drag asks for one
   * move when it is still valid; any activated drag swallows the click.
   */
  pointerUp(pointerId: number, position: DropPosition, order: OrderState): GestureEnd {
    const press = this.press;
    if (!press || pointerId !== press.pointerId) {
      return noEnd;
    }
    this.press = null;
    if (!press.active) {
      return noEnd;
    }
    if (press.cancelled) {
      return { move: null, swallowClick: true };
    }

    const unchanged = movable(order) && orderKey(order.ids, order.revision) === press.key;
    const changesOrder = !isNoOp(order.ids, press.id, position.beforeId);
    let move: MoveRequest | null = null;
    if (unchanged && position.inside && changesOrder) {
      move = { id: press.id, beforeId: position.beforeId, revision: press.revision };
    }
    return { move, swallowClick: true };
  }

  /** The browser cancelled the pointer (a touch turned into scrolling, say). */
  pointerCancel(pointerId: number): GestureEnd {
    const press = this.press;
    if (!press || pointerId !== press.pointerId) {
      return noEnd;
    }
    this.press = null;
    return { move: null, swallowClick: press.active };
  }

  /**
   * The list itself lost pointer capture of the gesture's pointer during a
   * drag: it ends without a move. (Capture moving from the pressed entry to
   * the list when the drag starts is not this: the list reports only its
   * own loss, see ConversationList.tsx.)
   */
  lostCapture(pointerId: number): void {
    if (this.dragging && this.press?.pointerId === pointerId) {
      this.cancel();
    }
  }

  /**
   * A pointer went down anywhere in the page. Whatever an earlier press
   * left behind (its release was missed) ends here without a move, so a
   * new press, in the list or elsewhere, never continues an old gesture.
   * A press on an entry then starts its own gesture with `pointerDown`.
   */
  anotherPress(): void {
    this.press = null;
  }

  /**
   * The window lost focus or was hidden. The release may now happen where
   * this page cannot see it, and the same pointer may press again elsewhere
   * and come back with the button held; neither may continue this gesture.
   * It ends without a move.
   */
  windowLeft(): void {
    this.cancel();
  }

  /** Escape: returns true when it cancelled an active drag (then the key is consumed). */
  escape(): boolean {
    if (!this.dragging) {
      return false;
    }
    this.cancel();
    return true;
  }

  /**
   * The order, membership or availability changed. A press started under
   * another order ends without a move (also before it became a drag).
   */
  orderChanged(order: OrderState): void {
    const press = this.press;
    if (!press || press.cancelled) {
      return;
    }
    if (!movable(order) || orderKey(order.ids, order.revision) !== press.key) {
      this.cancel();
    }
  }

  /** Forget everything, for example when the list unmounts. */
  reset(): void {
    this.press = null;
  }

  /**
   * End the gesture without a move. An activated drag keeps its record,
   * marked cancelled, until its button is released, so the click of that
   * release is swallowed; a press that never became a drag is forgotten.
   */
  private cancel(): void {
    const press = this.press;
    if (!press) {
      return;
    }
    if (press.active) {
      press.cancelled = true;
    } else {
      this.press = null;
    }
  }
}
