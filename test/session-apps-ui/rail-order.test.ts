import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertionTarget,
  isNoOp,
  moveAllowed,
  orderKey,
} from '../../integrations/session-apps/RailOrder.mjs';

/**
 * The HTML rail's drag-reorder rules (RailOrder.mjs), shared by the page and
 * its native bridge. The order itself stays the listener's (move-agent).
 */

const rows = [
  { id: 'a', top: 0, height: 60 },
  { id: 'b', top: 70, height: 60 },
  { id: 'c', top: 140, height: 60 },
];

test('the insertion point follows row midpoints and skips the dragged row', () => {
  assert.equal(insertionTarget(rows, 'a', 10), 'b', 'Above b’s middle, a lands before b');
  assert.equal(insertionTarget(rows, 'a', 120), 'c');
  assert.equal(insertionTarget(rows, 'a', 190), '', 'Below the last middle: the end');
  assert.equal(insertionTarget(rows, 'c', 20), 'a');
});

test('no-op positions are recognized', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(isNoOp(ids, 'a', 'b'), true, 'Before its own successor');
  assert.equal(isNoOp(ids, 'c', ''), true, 'The last one to the end');
  assert.equal(isNoOp(ids, 'a', 'a'), true);
  assert.equal(isNoOp(ids, 'a', 'c'), false);
  assert.equal(isNoOp(ids, 'a', ''), false);
  assert.equal(isNoOp(ids, 'z', ''), true, 'An unknown conversation never moves');
});

test('the bridge accepts only a current, valid move', () => {
  const state = { ids: ['a', 'b', 'c'], canMove: true, online: true, orderRevision: 'r1' };
  assert.equal(moveAllowed(state, 'a', 'c', 'r1'), true);
  assert.equal(moveAllowed(state, 'a', '', 'r1'), true);
  assert.equal(moveAllowed(state, 'a', 'c', 'r0'), false, 'A stale gesture revision');
  assert.equal(moveAllowed(state, 'a', 'c', ''), false);
  assert.equal(moveAllowed(state, 'x', 'c', 'r1'), false, 'Not an open conversation');
  assert.equal(moveAllowed(state, 'a', 'x', 'r1'), false, 'Not an open target');
  assert.equal(moveAllowed(state, 'a', 'a', 'r1'), false);
  assert.equal(moveAllowed(state, 'a', 'b', 'r1'), false, 'No-op');
  assert.equal(moveAllowed({ ...state, online: false }, 'a', 'c', 'r1'), false);
  assert.equal(moveAllowed({ ...state, canMove: false }, 'a', 'c', 'r1'), false);
  assert.equal(moveAllowed(state, 1, 'c', 'r1'), false);
  assert.equal(moveAllowed(null, 'a', 'c', 'r1'), false);
  assert.notEqual(orderKey(['a', 'b'], 'r1'), orderKey(['b', 'a'], 'r1'));
  assert.notEqual(orderKey(['a', 'b'], 'r1'), orderKey(['a', 'b'], 'r2'));
});
