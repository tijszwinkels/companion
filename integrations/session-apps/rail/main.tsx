/**
 * Companion's trusted HTML session rail (dist/rail.html).
 *
 * Lists the open conversations in their shared order and lets the person
 * select, pop out, focus, return, close or drag them into another order. The
 * native view (TrustedRailView.qml) sends the whole list on every change (at
 * most 16 conversations) and performs each request through the panel's
 * existing signals. Activity, Previous sessions and settings stay in the
 * native rail around this page.
 *
 * Dragging. A press on a conversation that moves more than a few pixels
 * becomes a drag (a shorter press stays a click). The gesture captures the
 * order revision and membership at its start; a line shows where the
 * conversation will go; the page scrolls near its top and bottom edges. On
 * release inside the list, one `move` names the captured revision, and the
 * native view and the listener refuse it if the order changed meanwhile.
 * Escape, a cancelled pointer, release outside the list, a no-op position, a
 * changed order or membership, going offline or controls becoming
 * unavailable all end the drag without a move. The click that follows a
 * completed drag is swallowed, so a drag never also selects, closes or pops
 * out a conversation.
 */

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import {
  dragThreshold,
  insertionTarget,
  isNoOp,
  orderKey,
  scrollEdgeUnits,
  scrollStepUnits,
} from '../RailOrder.mjs';
import { connectChannel } from '../web-channel.ts';
import './styles.css';

interface RailSession {
  id: string;
  number: number;
  title: string;
  selected: boolean;
  running: boolean;
  unread: boolean;
  poppedOut: boolean;
  wakes: number;
}

interface RailState {
  seq: number;
  sessions: RailSession[];
  online: boolean;
  popoutAvailable: boolean;
  /** Drag reordering is possible now (online, controls available, not Previous sessions). */
  canMove: boolean;
  /** The listener's order revision; a gesture captures it at its start. */
  orderRevision: string;
  theme: {
    foreground: string;
    accent: string;
    muted: string;
    selection: string;
    fontFamily: string;
    unit: number;
  };
}

interface RailBridge {
  message: { connect(callback: (json: string) => void): void };
  ready(): void;
  select(id: string): void;
  popOut(id: string): void;
  returnToPanel(id: string): void;
  close(id: string): void;
  move(id: string, beforeId: string, revision: string): void;
}

/** One pointer press on a conversation, possibly becoming a drag. */
interface Gesture {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Membership and order revision when the press started. */
  key: string;
  revision: string;
  active: boolean;
  /** Latest pointer position, in viewport coordinates. */
  x: number;
  y: number;
  beforeId: string;
  inside: boolean;
}

/** What the page draws while a drag is active. */
interface DragView {
  id: string;
  beforeId: string;
  /** False when a release now would cancel (outside the list or no change). */
  droppable: boolean;
}

function Rail(props: {
  bridge: RailBridge;
  initial: RailState | null;
  subscribe: (set: (state: RailState) => void) => void;
}) {
  const [state, setState] = useState<RailState | null>(props.initial);
  const [drag, setDrag] = useState<DragView | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const stateRef = useRef<RailState | null>(state);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Set when a drag completes; the click the browser sends next is ignored.
  const swallowClick = useRef(false);
  stateRef.current = state;

  useEffect(() => {
    props.subscribe(setState);
  }, []);

  const ids = state ? state.sessions.map((session) => session.id) : [];

  function cancelDrag() {
    gesture.current = null;
    if (scrollTimer.current !== undefined) {
      clearInterval(scrollTimer.current);
      scrollTimer.current = undefined;
    }
    setDrag(null);
  }

  // A changed order or membership, going offline, or controls becoming
  // unavailable ends a gesture started under the old state.
  useEffect(() => {
    const current = gesture.current;
    if (!current || !state) {
      return;
    }
    if (!state.canMove || !state.online || orderKey(ids, state.orderRevision) !== current.key) {
      cancelDrag();
    }
  }, [state]);

  // Escape cancels a drag; the gesture never outlives the page.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current?.active) {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      cancelDrag();
    };
  }, []);

  /** Recompute the insertion point for the gesture's latest position. */
  function track(current: Gesture) {
    const latest = stateRef.current;
    if (!latest) {
      return;
    }
    current.inside =
      current.x >= 0 &&
      current.x <= window.innerWidth &&
      current.y >= 0 &&
      current.y <= window.innerHeight;
    const rows: { id: string; top: number; height: number }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('.session[data-id]')) {
      const box = element.getBoundingClientRect();
      rows.push({ id: element.dataset.id!, top: box.top + window.scrollY, height: box.height });
    }
    current.beforeId = insertionTarget(rows, current.id, current.y + window.scrollY);
    const order = latest.sessions.map((session) => session.id);
    setDrag({
      id: current.id,
      beforeId: current.beforeId,
      droppable: current.inside && !isNoOp(order, current.id, current.beforeId),
    });
  }

  /** Scroll near the top or bottom edge while dragging, like the native list. */
  function scrollTick() {
    const current = gesture.current;
    const latest = stateRef.current;
    if (!current?.active || !latest || !current.inside) {
      return;
    }
    const unit = latest.theme.unit || 1;
    const edge = scrollEdgeUnits * unit;
    const step = scrollStepUnits * unit;
    if (current.y < edge) {
      window.scrollBy(0, -step);
    } else if (current.y > window.innerHeight - edge) {
      window.scrollBy(0, step);
    }
    track(current);
  }

  function pointerDown(event: PointerEvent) {
    const latest = stateRef.current;
    if (event.button !== 0 || !latest?.canMove || !latest.online) {
      return;
    }
    const target = event.target as HTMLElement;
    // The hover buttons keep their own click; they never start a drag.
    if (target.closest('.actions, button')) {
      return;
    }
    const row = target.closest<HTMLElement>('.session[data-id]');
    if (!row) {
      return;
    }
    const order = latest.sessions.map((session) => session.id);
    gesture.current = {
      id: row.dataset.id!,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      key: orderKey(order, latest.orderRevision),
      revision: latest.orderRevision,
      active: false,
      x: event.clientX,
      y: event.clientY,
      beforeId: '',
      inside: true,
    };
  }

  function pointerMove(event: PointerEvent) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) {
      return;
    }
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.active) {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (distance < dragThreshold) {
        return;
      }
      current.active = true;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      scrollTimer.current = setInterval(scrollTick, 40);
    }
    event.preventDefault();
    track(current);
  }

  function pointerUp(event: PointerEvent) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) {
      return;
    }
    if (!current.active) {
      // A press that never moved far enough: an ordinary click follows.
      gesture.current = null;
      return;
    }
    current.x = event.clientX;
    current.y = event.clientY;
    track(current);
    const latest = stateRef.current;
    const order = latest ? latest.sessions.map((session) => session.id) : [];
    const stillValid =
      latest !== null &&
      latest.canMove &&
      latest.online &&
      orderKey(order, latest.orderRevision) === current.key;
    if (stillValid && current.inside && !isNoOp(order, current.id, current.beforeId)) {
      props.bridge.move(current.id, current.beforeId, current.revision);
    }
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 0);
    cancelDrag();
  }

  function clickCapture(event: MouseEvent) {
    if (swallowClick.current) {
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }

  if (!state) {
    return null;
  }

  const theme = state.theme;
  const style = {
    '--foreground': theme.foreground,
    '--accent': theme.accent,
    '--muted': theme.muted,
    '--selection': theme.selection,
    '--font': theme.fontFamily,
    '--unit': String(theme.unit || 1),
  };

  return (
    <nav
      class={drag ? 'rail dragging' : 'rail'}
      style={style}
      aria-label="Conversations"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => cancelDrag()}
      onLostPointerCapture={() => {
        if (gesture.current?.active) {
          cancelDrag();
        }
      }}
      onClickCapture={clickCapture}
    >
      {state.sessions.map((session) => {
        const { glyph, caption, emoji } = badgeOf(session);
        const marker = drag?.droppable && drag.beforeId === session.id;
        return [
          marker && (
            <div key={`marker-${session.id}`} class="drop-marker" data-testid="drop-marker" />
          ),
          <div
            key={session.id}
            data-id={session.id}
            class={`session ${session.selected ? 'selected' : ''} ${session.unread ? 'unread' : ''} ${drag?.id === session.id ? 'dragged' : ''}`}
            role="tab"
            aria-selected={session.selected}
            title={
              session.poppedOut
                ? `${session.title}\nIn its own window · click to focus it`
                : session.title
            }
            onClick={() => props.bridge.select(session.id)}
          >
            <div class="badge">
              {session.running && <span class="running" aria-label="Answering" />}
              <span class={`glyph ${emoji ? 'emoji' : ''}`}>{glyph}</span>
              {emoji && <span class="number">{session.number}</span>}
              {session.poppedOut && (
                <span class="popped" aria-label="In its own window">
                  ↗
                </span>
              )}
              {session.unread && <span class="unread-dot" aria-label="Unread" />}
            </div>
            {session.wakes > 0 && <div class="wakes">◷{session.wakes}</div>}
            <div class="title">{caption}</div>
            {/* Shown on hover or keyboard focus, like the classic tab's close
                button; the tab itself looks like the classic tab otherwise. */}
            <div class="actions" onClick={(event) => event.stopPropagation()}>
              {state.popoutAvailable && !session.poppedOut && (
                <button disabled={!state.online} onClick={() => props.bridge.popOut(session.id)}>
                  Pop out
                </button>
              )}
              {session.poppedOut && (
                <button onClick={() => props.bridge.returnToPanel(session.id)}>Return</button>
              )}
              <button
                class="close"
                disabled={!state.online}
                onClick={() => props.bridge.close(session.id)}
                aria-label="Close conversation"
              >
                ×
              </button>
            </div>
          </div>,
        ];
      })}
      {drag?.droppable && drag.beforeId === '' && (
        <div class="drop-marker" data-testid="drop-marker" />
      )}
    </nav>
  );
}

/**
 * The classic tab's badge: a leading emoji of the title, or "Q" and the
 * session number; the caption is the rest of the title. Mirrors
 * SessionTab.qml (whole emoji token, the same code point ranges).
 */
function badgeOf(session: RailSession): { glyph: string; caption: string; emoji: boolean } {
  const trimmed = session.title.trim();
  const firstToken = trimmed.split(/\s+/)[0] || '';
  const point = firstToken.codePointAt(0) ?? 0;
  const emoji =
    (point >= 0x1f000 && point <= 0x1faff) ||
    (point >= 0x2600 && point <= 0x27bf) ||
    firstToken.includes('️') ||
    firstToken.includes('⃣');
  if (emoji) {
    return { glyph: firstToken, caption: trimmed.slice(firstToken.length).trim(), emoji: true };
  }
  return { glyph: `Q${session.number}`, caption: session.title, emoji: false };
}

const root = document.getElementById('rail')!;

const connected = connectChannel<RailBridge>((bridge) => {
  let latest: RailState | null = null;
  let setter: ((state: RailState) => void) | null = null;

  bridge.message.connect((json) => {
    try {
      latest = JSON.parse(json) as RailState;
    } catch {
      return;
    }
    setter?.(latest);
  });

  render(
    <Rail
      bridge={bridge}
      initial={latest}
      subscribe={(set) => {
        setter = set;
        if (latest) {
          set(latest);
        }
      }}
    />,
    root,
  );
  bridge.ready();
  // The native view's liveness signal (TrustedRailView.qml).
  (window as unknown as { companionRail: { connected: boolean } }).companionRail = {
    connected: true,
  };
});

if (!connected) {
  root.textContent = 'This page only runs inside Companion.';
}
