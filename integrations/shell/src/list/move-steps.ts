/**
 * Moving a conversation one place up or down, by key (Alt+Shift+Up and
 * Alt+Shift+Down on its focused entry) or by its ⋯ menu (Move up, Move
 * down), and the one move that may be awaiting its answer. Without DOM
 * access.
 *
 * A step is the same request a drag sends (reorder-gesture.ts): one
 * `move-agent` naming the conversation, the conversation it goes before
 * ("" for the end) and the listener's current order revision. It is
 * possible under the drag's own condition (`movable`: requests admitted and
 * an order revision named) and never at the ends: the first conversation
 * has no Move up, the last no Move down.
 *
 * Pending rule (one move at a time, for the drag, the keys and the menu
 * alike): a move is pending from the moment it is sent until the listener
 * refuses it (or the request fails), or until it was accepted and the list
 * shows an order revision other than the one it named. The listener
 * publishes the new order before it answers, so an accepted move normally
 * ends at once; waiting for the new revision means a second step never
 * names the revision the first one just used up. ConversationList.tsx
 * reports the list as unavailable to every gesture while a move is
 * pending, so nothing else is sent meanwhile.
 *
 * Inputs: the list's order (`OrderState`), the conversation and the
 * direction; the request's answer and the order the list shows.
 * Outputs: the move to send, or null; whether a move is pending.
 */

import { movable, type MoveRequest, type OrderState } from './reorder-gesture.ts';

export type StepDirection = 'up' | 'down';

/**
 * The move that takes conversation `id` one place in `direction`, or null
 * when there is none: at that end of the list, a conversation not in the
 * list, or a list that cannot be reordered now.
 */
export function stepMove(
  order: OrderState,
  id: string,
  direction: StepDirection,
): MoveRequest | null {
  if (!movable(order)) {
    return null;
  }

  const index = order.ids.indexOf(id);
  if (index < 0) {
    return null;
  }

  // Up: before the conversation above it.
  if (direction === 'up') {
    if (index === 0) {
      return null;
    }
    return { id, beforeId: order.ids[index - 1], revision: order.revision };
  }

  // Down: before the conversation two places below it, or at the end when
  // it passes the last one.
  if (index === order.ids.length - 1) {
    return null;
  }
  const beforeId = order.ids[index + 2] ?? '';
  return { id, beforeId, revision: order.revision };
}

/**
 * The step a key press asks for: Alt+Shift+Up or Alt+Shift+Down (the
 * desktop's keys, PanelContent.qml), without Control or Meta; otherwise
 * null.
 */
export function stepKey(event: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): StepDirection | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  if (event.key === 'ArrowUp') {
    return 'up';
  }
  if (event.key === 'ArrowDown') {
    return 'down';
  }
  return null;
}

/**
 * The one move awaiting its answer, by the pending rule above. One object
 * per list; it holds no timers.
 */
export class PendingMove {
  /** The revision the pending move named, or null when none is pending. */
  private revision: string | null = null;
  /** The listener accepted it; it ends once the order moves past `revision`. */
  private accepted = false;

  get pending(): boolean {
    return this.revision !== null;
  }

  /** A move naming `revision` was sent. */
  sent(revision: string): void {
    this.revision = revision;
    this.accepted = false;
  }

  /**
   * Its answer arrived: accepted, or refused (also a failed request). Returns
   * true when that ended the pending move.
   */
  answered(accepted: boolean, shownRevision: string): boolean {
    if (this.revision === null) {
      return false;
    }
    if (!accepted) {
      this.revision = null;
      return true;
    }
    this.accepted = true;
    return this.orderShown(shownRevision);
  }

  /**
   * The list shows the order with `shownRevision`. Returns true when that
   * ended an accepted move.
   */
  orderShown(shownRevision: string): boolean {
    if (this.revision === null || !this.accepted) {
      return false;
    }
    if (shownRevision === this.revision) {
      return false;
    }
    this.revision = null;
    this.accepted = false;
    return true;
  }

  /** Forget it (the list unmounts, or a new pairing). */
  reset(): void {
    this.revision = null;
    this.accepted = false;
  }
}
