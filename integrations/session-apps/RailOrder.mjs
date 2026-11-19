// Drag reordering rules of the trusted HTML session rail.
//
// Pure functions without Qt or DOM objects, shared by the rail page
// (rail/main.tsx) and its native bridge (TrustedRailView.qml), and tested
// directly by test/session-apps-ui/rail-order.test.ts.
//
// The order itself is the listener's: a drop asks for the existing
// `move-agent` operation with the order revision captured when the gesture
// started (the native list's rule, PanelContent.qml). Nothing here keeps an
// order of its own.

// Pointer travel, in CSS pixels, before a press becomes a drag. A smaller
// movement stays an ordinary click (select the conversation).
export const dragThreshold = 6;

// Distance from the list's top or bottom edge, in units, where a drag
// scrolls the list, and the step per scroll tick (the native list's values).
export const scrollEdgeUnits = 28;
export const scrollStepUnits = 12;

// The conversation a drop at `y` goes before, or "" for the end. `rows` are
// the rendered rows in order ({id, top, height}, list coordinates including
// scrolling); the dragged row itself is skipped, as in the native list.
export function insertionTarget(rows, draggedId, y) {
  for (const row of rows) {
    if (row.id === draggedId) {
      continue;
    }
    if (y < row.top + row.height / 2) {
      return row.id;
    }
  }
  return '';
}

// Whether dropping `draggedId` before `beforeId` leaves the order as it is.
export function isNoOp(ids, draggedId, beforeId) {
  const index = ids.indexOf(draggedId);
  if (index < 0) {
    return true;
  }
  const next = index + 1 < ids.length ? ids[index + 1] : '';
  return beforeId === next || beforeId === draggedId;
}

// A key for the open conversations' membership and order; a drag started
// under one key is cancelled as soon as the key changes.
export function orderKey(ids, revision) {
  return revision + '|' + ids.join(',');
}

// The bridge's check before it asks for a move: an open conversation, a
// valid open target (or the end), no no-op, controls available, and the
// revision the gesture captured still the current one.
export function moveAllowed(state, id, beforeId, revision) {
  if (!state || !state.canMove || !state.online) {
    return false;
  }
  if (typeof id !== 'string' || typeof beforeId !== 'string' || typeof revision !== 'string') {
    return false;
  }
  if (!revision || revision !== state.orderRevision) {
    return false;
  }
  const ids = state.ids;
  if (!ids.includes(id) || id === beforeId) {
    return false;
  }
  if (beforeId !== '' && !ids.includes(beforeId)) {
    return false;
  }
  return !isNoOp(ids, id, beforeId);
}
