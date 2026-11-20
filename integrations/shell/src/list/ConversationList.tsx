/**
 * The conversation list on the left of the browser shell: the open
 * conversations in the listener's order, then Previous sessions.
 *
 * One list with two appearances (see ../layout/list-width.ts): the strip
 * (icon, number, short name) and the full list (icon, number, title and the
 * last line). Each conversation shows the native rail's markers: selected
 * (the selection background and the accent bar), working (a turning ring
 * around the icon) and an answer not yet seen (the green dot and tint).
 *
 * Actions, all through the phone panel's Store and the gateway's remote
 * role:
 * - select: a click (or Enter/Space on the focused entry) shows the
 *   conversation (`Store.open`, which also clears its unread mark);
 * - close: the × that appears on hover or keyboard focus (`close-agent`);
 * - reorder: dragging (`move-agent` with the captured order revision); the
 *   rules are in reorder-gesture.ts. The list never reorders itself: it
 *   draws `state.order`, and a completed move shows up when the listener
 *   reports the new order;
 * - Previous sessions: the entry at the bottom (`Store.showPrevious`).
 *
 * Closing and reordering are offered only while requests are admitted
 * (connected, after this connection's snapshot; `bridge.admitted`), the
 * same rule as the chat page's own Close.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import {
  insertionTarget,
  scrollEdgeUnits,
  scrollStepUnits,
} from '../../../session-apps/RailOrder.mjs';
import type { GatewayChatBridge } from '../bridge.ts';
import type { ListAppearance } from '../layout/list-width.ts';
import { entryLabel, listEntries, type ListEntry } from './entries.ts';
import {
  ReorderGesture,
  type DragView,
  type DropPosition,
  type MoveRequest,
  type OrderState,
} from './reorder-gesture.ts';

/** Interval of edge scrolling while a drag is near the list's top or bottom. */
const edgeScrollMilliseconds = 40;

/** The list's id, named by the ☰ button and the divider (`aria-controls`). */
export const conversationListId = 'conversation-list';

export function ConversationList(props: {
  appearance: ListAppearance;
  /** Shown width in CSS pixels. */
  width: number;
  bridge: GatewayChatBridge;
}) {
  const store = useStore();
  const state = useAppState();
  const entries = listEntries(state);
  const available = props.bridge.admitted;

  const order: OrderState = {
    ids: entries.map((entry) => entry.id),
    revision: state.orderRevision,
    available,
  };

  const gesture = useRef(new ReorderGesture());
  const orderRef = useRef(order);
  orderRef.current = order;
  const [drag, setDrag] = useState<DragView | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Set when an activated drag ends; the click the browser sends next is ignored.
  const swallowClick = useRef(false);
  // Latest pointer position of an active drag, in viewport coordinates.
  const pointer = useRef({ x: 0, y: 0 });

  // Whether the editor holds input of a conversation changes the close
  // buttons (`bridge.canClose`) without a phone Store change: re-render then.
  const [, setHeldInputVersion] = useState(0);
  useEffect(() => {
    const changed = () => {
      setHeldInputVersion((version) => version + 1);
    };
    const unsubscribe = props.bridge.onHeldInputChange(changed);
    // It can change between the first render and this subscription.
    changed();
    return unsubscribe;
  }, [props.bridge]);

  /** Redraw the drag feedback; stop edge scrolling when no drag is active. */
  function refresh() {
    setDrag(gesture.current.view(orderRef.current));
    if (!gesture.current.dragging && scrollTimer.current !== undefined) {
      clearInterval(scrollTimer.current);
      scrollTimer.current = undefined;
    }
  }

  /**
   * Where a drop at the viewport point would go: the insertion point from
   * the rendered rows (list coordinates, including the list's scrolling)
   * and whether the point is inside the list's scrolling area.
   */
  function dropPosition(x: number, y: number): DropPosition {
    const element = scroller.current;
    if (!element) {
      return { beforeId: '', inside: false };
    }
    const box = element.getBoundingClientRect();
    // Inside means the list is what the pointer is over: not the divider
    // that overlaps its edge, a toast above it, or anything else on top.
    const over = document.elementFromPoint(x, y);
    const inside = over !== null && element.contains(over);

    const rows: { id: string; top: number; height: number }[] = [];
    for (const row of element.querySelectorAll<HTMLElement>('.conversation-entry[data-id]')) {
      const rowBox = row.getBoundingClientRect();
      rows.push({
        id: row.dataset.id!,
        top: rowBox.top - box.top + element.scrollTop,
        height: rowBox.height,
      });
    }
    const draggedId = gesture.current.view(orderRef.current)?.id ?? '';
    const listY = y - box.top + element.scrollTop;
    return { beforeId: insertionTarget(rows, draggedId, listY), inside };
  }

  /** Scroll near the list's top or bottom edge while dragging, like the native list. */
  function edgeScroll() {
    const element = scroller.current;
    if (!element || !gesture.current.dragging) {
      refresh();
      return;
    }
    const position = dropPosition(pointer.current.x, pointer.current.y);
    if (position.inside) {
      const box = element.getBoundingClientRect();
      if (pointer.current.y < box.top + scrollEdgeUnits) {
        element.scrollBy(0, -scrollStepUnits);
      } else if (pointer.current.y > box.bottom - scrollEdgeUnits) {
        element.scrollBy(0, scrollStepUnits);
      }
    }
    gesture.current.track(dropPosition(pointer.current.x, pointer.current.y), orderRef.current);
    refresh();
  }

  /** Swallow the click the browser sends right after this release, and only that one. */
  function swallowNextClick() {
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
  }

  function requestMove(move: MoveRequest) {
    // A refused move (the order changed meanwhile) is explained by the
    // Store's toast; the list keeps showing the listener's order.
    void store
      .request('move-agent', { id: move.id, beforeId: move.beforeId, revision: move.revision })
      .catch(() => {});
  }

  function pointerDown(event: PointerEvent, id: string) {
    // A click owed to an earlier drag can no longer arrive.
    swallowClick.current = false;
    const target = event.target as HTMLElement;
    // The close button keeps its own click and never starts a drag.
    if (target.closest('.entry-close')) {
      gesture.current.reset();
      refresh();
      return;
    }
    gesture.current.pointerDown(
      id,
      event.pointerId,
      event.button,
      event.clientX,
      event.clientY,
      orderRef.current,
    );
    refresh();
  }

  // The press is followed from the window for its whole lifetime, not only
  // over the list: a release or cancellation anywhere ends it, and movement
  // without the button held never drags. The listeners live as long as the
  // list; unmounting forgets the gesture.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const wasDragging = gesture.current.dragging;
      const dragging = gesture.current.pointerMove(
        event.pointerId,
        event.buttons,
        event.clientX,
        event.clientY,
      );
      if (!dragging) {
        if (wasDragging || !gesture.current.pressed) {
          refresh();
        }
        return;
      }
      if (!wasDragging) {
        // Just became a drag: the list follows the pointer from now on and
        // scrolls near its edges.
        scroller.current?.setPointerCapture?.(event.pointerId);
        scrollTimer.current = setInterval(edgeScroll, edgeScrollMilliseconds);
      }
      event.preventDefault();
      pointer.current = { x: event.clientX, y: event.clientY };
      gesture.current.track(dropPosition(event.clientX, event.clientY), orderRef.current);
      refresh();
    };

    const release = (event: PointerEvent) => {
      const position = dropPosition(event.clientX, event.clientY);
      const end = gesture.current.pointerUp(event.pointerId, position, orderRef.current);
      if (end.move) {
        requestMove(end.move);
      }
      if (end.swallowClick) {
        swallowNextClick();
      }
      refresh();
    };

    const cancel = (event: PointerEvent) => {
      const end = gesture.current.pointerCancel(event.pointerId);
      if (end.swallowClick) {
        swallowNextClick();
      }
      refresh();
    };

    // Any new press, in the list or elsewhere, ends what an earlier press
    // left behind. (Capture phase: before an entry starts its own gesture.)
    const anyPress = () => {
      gesture.current.anotherPress();
      refresh();
    };

    // The window lost focus or was hidden: the release may happen where the
    // page cannot see it, so the gesture ends without a move.
    const left = () => {
      gesture.current.windowLeft();
      refresh();
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') {
        left();
      }
    };

    // Escape cancels a drag; its release then selects nothing.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current.escape()) {
        event.preventDefault();
        event.stopPropagation();
        refresh();
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', anyPress, true);
    window.addEventListener('blur', left);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerdown', anyPress, true);
      window.removeEventListener('blur', left);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      gesture.current.reset();
      if (scrollTimer.current !== undefined) {
        clearInterval(scrollTimer.current);
        scrollTimer.current = undefined;
      }
    };
  }, []);

  // A changed order or membership, or the list becoming unavailable, ends a
  // gesture started under the old state.
  const orderSignature = `${available}|${order.revision}|${order.ids.join(',')}`;
  useEffect(() => {
    gesture.current.orderChanged(orderRef.current);
    refresh();
  }, [orderSignature]);

  function clickCapture(event: MouseEvent) {
    if (swallowClick.current) {
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function close(entry: ListEntry) {
    // Refused (offline, input only the editor holds) or failed: the Store's
    // toast explains a failure, and the conversation stays in the list.
    if (!props.bridge.canClose(entry.id)) {
      return;
    }
    void store.request('close-agent', { id: entry.id }).catch(() => {});
  }

  const classes = ['conversations', props.appearance];
  if (drag) {
    classes.push('dragging');
  }

  const children = [];
  for (const entry of entries) {
    if (drag?.droppable && drag.beforeId === entry.id) {
      children.push(<li key={`marker-${entry.id}`} class="drop-marker" aria-hidden="true" />);
    }
    children.push(
      <Entry
        key={entry.id}
        entry={entry}
        dragged={drag?.id === entry.id}
        canClose={props.bridge.canClose(entry.id)}
        onPointerDown={(event) => pointerDown(event, entry.id)}
        onSelect={() => store.open(entry.id)}
        onClose={() => close(entry)}
      />,
    );
  }
  if (drag?.droppable && drag.beforeId === '') {
    children.push(<li key="marker-end" class="drop-marker" aria-hidden="true" />);
  }

  return (
    <aside
      id={conversationListId}
      class={classes.join(' ')}
      style={{ width: `${props.width}px` }}
      aria-label="Conversations"
    >
      <nav
        class="conversation-scroll"
        ref={scroller}
        aria-label="Open conversations"
        onClickCapture={clickCapture}
        onLostPointerCapture={(event) => {
          // Only the list's own capture: when a drag starts, capture moves
          // from the pressed entry (touch and pen capture implicitly) to the
          // list, and the entry's loss bubbles up to here.
          if (event.target !== event.currentTarget) {
            return;
          }
          gesture.current.lostCapture(event.pointerId);
          refresh();
        }}
      >
        {entries.length === 0 ? (
          <p class="conversation-none">No open conversations</p>
        ) : (
          <ul class="conversation-entries">{children}</ul>
        )}
      </nav>
      <PreviousEntry
        count={state.previous.length}
        shown={state.showingPrevious}
        onShow={() => store.showPrevious()}
      />
    </aside>
  );
}

/** One open conversation: the select button with its markers, and its close button. */
function Entry(props: {
  entry: ListEntry;
  dragged: boolean;
  canClose: boolean;
  onPointerDown: (event: PointerEvent) => void;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { entry } = props;
  const classes = ['conversation-entry'];
  if (entry.selected) {
    classes.push('selected');
  }
  if (entry.unread) {
    classes.push('unread');
  }
  if (props.dragged) {
    classes.push('dragged');
  }

  return (
    <li class={classes.join(' ')} data-id={entry.id} onPointerDown={props.onPointerDown}>
      <button
        class="entry-select"
        aria-current={entry.selected ? 'page' : undefined}
        aria-label={entryLabel(entry)}
        aria-describedby={entry.lastLine ? lastLineId(entry) : undefined}
        title={entry.title}
        onClick={props.onSelect}
      >
        <span class="entry-badge" aria-hidden="true">
          {entry.working && <span class="entry-working" />}
          <span class={entry.emoji ? 'entry-glyph emoji' : 'entry-glyph'}>{entry.glyph}</span>
          {entry.emoji && <span class="entry-number">{entry.number}</span>}
          {entry.unread && <span class="entry-unread" />}
        </span>
        {/* The title is in the accessible name; the last line is its
            description (also in the strip, where it is not drawn). */}
        <span class="entry-text" aria-hidden="true">
          <span class="entry-title">{entry.caption}</span>
          <span class="entry-last-line" id={lastLineId(entry)}>
            {entry.lastLine}
          </span>
        </span>
      </button>
      {/* Shown on hover or keyboard focus, like the rail's close button. */}
      <button
        class="entry-close"
        disabled={!props.canClose}
        aria-label={`Close ${entry.title}`}
        title="Close session · saved in Previous sessions"
        onClick={props.onClose}
      >
        ×
      </button>
    </li>
  );
}

/** The element id of an entry's last line (its accessible description). */
function lastLineId(entry: ListEntry): string {
  return `last-line-${entry.id}`;
}

/** The Previous sessions entry at the bottom of the list. */
function PreviousEntry(props: { count: number; shown: boolean; onShow: () => void }) {
  let summary = `${props.count} saved conversations`;
  if (props.count === 1) {
    summary = '1 saved conversation';
  }
  const classes = ['previous-entry'];
  if (props.shown) {
    classes.push('selected');
  }
  return (
    <button
      class={classes.join(' ')}
      aria-current={props.shown ? 'page' : undefined}
      title="Previous sessions"
      onClick={props.onShow}
    >
      <span class="entry-badge" aria-hidden="true">
        <span class="entry-glyph">◷</span>
      </span>
      <span class="entry-text">
        <span class="entry-title">Previous sessions</span>
        <span class="entry-last-line">{summary}</span>
      </span>
    </button>
  );
}
