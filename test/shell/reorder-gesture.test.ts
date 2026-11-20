import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ReorderGesture,
  type DropPosition,
  type MoveRequest,
  type OrderState,
} from '../../integrations/shell/src/list/reorder-gesture.ts';

/**
 * The reorder gesture, checked with the cases of the README's "Reordering by
 * dragging" table (integrations/shell/README.md), derived from its rules
 * 1–7: for each case, the move requests a sequence of pointer, key and order
 * events produces, and whether the click after the release still selects.
 * The browser suite (shell.test.ts) drives the same rules with real pointer
 * input against the real gateway and listener, including a refused move.
 */

const ids = ['a', 'b', 'c', 'd'];
const revision = 'revision-1';

function order(change: Partial<OrderState> = {}): OrderState {
  return { ids, revision, available: true, ...change };
}

/** Inside the list, before `beforeId`. */
function inside(beforeId: string): DropPosition {
  return { beforeId, inside: true };
}

const outside: DropPosition = { beforeId: 'a', inside: false };

type Step =
  | { down: string; button?: number; at?: [number, number]; order?: OrderState; pointer?: number }
  | {
      move: [number, number];
      buttons?: number;
      to?: DropPosition;
      order?: OrderState;
      pointer?: number;
    }
  | { up: DropPosition; order?: OrderState; pointer?: number }
  | { cancel: true; pointer?: number }
  | { lostCapture: true; pointer?: number }
  | { windowLeft: true }
  | { pressElsewhere: true }
  | { escape: true }
  | { orderChanged: OrderState };

interface Outcome {
  moves: MoveRequest[];
  /** Whether the click after the last release selects (is not swallowed). */
  clickSelects: boolean;
}

/** Play the steps as ConversationList.tsx forwards the browser's events. */
function play(steps: Step[]): Outcome {
  const gesture = new ReorderGesture();
  const moves: MoveRequest[] = [];
  let clickSelects = true;
  for (const step of steps) {
    if ('down' in step) {
      const [x, y] = step.at ?? [10, 10];
      gesture.pointerDown(
        step.down,
        step.pointer ?? 1,
        step.button ?? 0,
        x,
        y,
        step.order ?? order(),
      );
      clickSelects = true;
    } else if ('move' in step) {
      const [x, y] = step.move;
      const dragging = gesture.pointerMove(step.pointer ?? 1, step.buttons ?? 1, x, y);
      if (dragging) {
        gesture.track(step.to ?? inside(''), step.order ?? order());
      }
    } else if ('up' in step) {
      const end = gesture.pointerUp(step.pointer ?? 1, step.up, step.order ?? order());
      if (end.move) {
        moves.push(end.move);
      }
      clickSelects = !end.swallowClick;
    } else if ('cancel' in step) {
      const end = gesture.pointerCancel(step.pointer ?? 1);
      clickSelects = !end.swallowClick;
    } else if ('lostCapture' in step) {
      gesture.lostCapture(step.pointer ?? 1);
    } else if ('windowLeft' in step) {
      gesture.windowLeft();
    } else if ('pressElsewhere' in step) {
      gesture.anotherPress();
    } else if ('escape' in step) {
      gesture.escape();
    } else {
      gesture.orderChanged(step.orderChanged);
    }
  }
  return { moves, clickSelects };
}

/** Press on `a` at (10, 10) and drag 40 px down, past the threshold. */
const dragA: Step[] = [{ down: 'a' }, { move: [10, 50], to: inside('c') }];

const moveAToC: MoveRequest = { id: 'a', beforeId: 'c', revision };

const cases: { name: string; steps: Step[]; expected: Outcome }[] = [
  {
    name: 'press and release without moving',
    steps: [{ down: 'a' }, { up: inside('b') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'movement under 6 px, then release',
    steps: [{ down: 'a' }, { move: [13, 14] }, { up: inside('c') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'secondary button pressed and moved',
    steps: [{ down: 'a', button: 2 }, { move: [10, 50], buttons: 2 }, { up: inside('c') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'press while requests are not admitted (offline, before the snapshot)',
    steps: [
      { down: 'a', order: order({ available: false }) },
      { move: [10, 50], order: order({ available: false }) },
      { up: inside('c'), order: order({ available: false }) },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'drag released inside at a new position',
    steps: [...dragA, { up: inside('c') }],
    expected: { moves: [moveAToC], clickSelects: false },
  },
  {
    name: 'drag released inside at the end',
    steps: [...dragA, { up: inside('') }],
    expected: { moves: [{ id: 'a', beforeId: '', revision }], clickSelects: false },
  },
  {
    name: 'drag released inside where it already is (before the next one)',
    steps: [...dragA, { up: inside('b') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'drag released inside before itself',
    steps: [...dragA, { up: inside('a') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'drag released outside the list',
    steps: [...dragA, { up: outside }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'Escape during the drag, then release',
    steps: [...dragA, { escape: true }, { move: [10, 60], to: inside('d') }, { up: inside('d') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'pointer cancelled during the drag',
    steps: [...dragA, { cancel: true }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'pointer capture lost during the drag, then release',
    steps: [...dragA, { lostCapture: true }, { up: inside('c') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'capture of another pointer lost during the drag',
    steps: [...dragA, { lostCapture: true, pointer: 2 }, { up: inside('c') }],
    expected: { moves: [moveAToC], clickSelects: false },
  },
  {
    name: 'window lost focus during the drag, then a release',
    steps: [...dragA, { windowLeft: true }, { up: inside('c') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'window lost focus before the threshold; the press comes back with the button held',
    steps: [
      { down: 'a' },
      { windowLeft: true },
      { move: [10, 50], to: inside('') },
      { up: inside('') },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'release missed, then a new press elsewhere dragged back over the list',
    steps: [
      { down: 'a' },
      { pressElsewhere: true },
      { move: [10, 50], to: inside('') },
      { up: inside('') },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'a drag whose release was missed, then a new press elsewhere',
    steps: [
      ...dragA,
      { pressElsewhere: true },
      { move: [10, 60], to: inside('d') },
      { up: inside('d') },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'press without an order revision (the listener named none)',
    steps: [
      { down: 'a', order: order({ revision: '' }) },
      { move: [10, 50], to: inside('c'), order: order({ revision: '' }) },
      { up: inside('c'), order: order({ revision: '' }) },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'order revision changed during the drag',
    steps: [...dragA, { orderChanged: order({ revision: 'revision-2' }) }, { up: inside('c') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'order revision changed during the drag, seen only at the release',
    steps: [...dragA, { up: inside('c'), order: order({ revision: 'revision-2' }) }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'a conversation opened during the drag (same revision)',
    steps: [
      ...dragA,
      { orderChanged: order({ ids: [...ids, 'e'] }) },
      { up: inside('c'), order: order({ ids: [...ids, 'e'] }) },
    ],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'a conversation closed during the drag, seen only at the release',
    steps: [...dragA, { up: inside('c'), order: order({ ids: ['a', 'b', 'c'] }) }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'connection lost during the drag',
    steps: [...dragA, { orderChanged: order({ available: false }) }, { up: inside('c') }],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'connection lost and back (new snapshot, same order) during the drag',
    steps: [
      ...dragA,
      { orderChanged: order({ available: false }) },
      { orderChanged: order() },
      { up: inside('c') },
    ],
    expected: { moves: [], clickSelects: false },
  },
  {
    name: 'order changed after the press, before the threshold',
    steps: [
      { down: 'a' },
      { orderChanged: order({ revision: 'revision-2' }) },
      { move: [10, 50], to: inside('c'), order: order({ revision: 'revision-2' }) },
      { up: inside('c'), order: order({ revision: 'revision-2' }) },
    ],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'movement without the button held (the release was missed)',
    steps: [{ down: 'a' }, { move: [10, 50], buttons: 0 }, { up: inside('c') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'a missed release during an active drag, then a later release',
    steps: [...dragA, { move: [10, 70], buttons: 0 }, { up: inside('c') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'another pointer released during the drag',
    steps: [...dragA, { up: inside('c'), pointer: 2 }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'a new press after a cancelled drag: its own click selects',
    steps: [...dragA, { escape: true }, { down: 'b' }, { up: inside('c') }],
    expected: { moves: [], clickSelects: true },
  },
  {
    name: 'a new press after a cancelled drag can drag again',
    steps: [
      ...dragA,
      { escape: true },
      { down: 'a' },
      { move: [10, 50], to: inside('c') },
      { up: inside('c') },
    ],
    expected: { moves: [moveAToC], clickSelects: false },
  },
  {
    name: 'the captured revision is named even when the release reports the same order',
    steps: [{ down: 'b', order: order() }, { move: [10, 50], to: inside('') }, { up: inside('') }],
    expected: { moves: [{ id: 'b', beforeId: '', revision }], clickSelects: false },
  },
];

test('reorder gesture: the README table, one case at a time', () => {
  for (const testCase of cases) {
    assert.deepEqual(play(testCase.steps), testCase.expected, testCase.name);
  }
});

test('reorder gesture: the drag view shows where a release would move to', () => {
  const gesture = new ReorderGesture();
  gesture.pointerDown('a', 1, 0, 10, 10, order());
  assert.equal(gesture.view(order()), null, 'no drag before the threshold');
  assert.equal(gesture.pointerMove(1, 1, 10, 50), true);
  gesture.track(inside('c'), order());
  assert.deepEqual(gesture.view(order()), { id: 'a', beforeId: 'c', droppable: true });
  gesture.track(inside('b'), order());
  assert.deepEqual(gesture.view(order()), { id: 'a', beforeId: 'b', droppable: false });
  gesture.track(outside, order());
  assert.deepEqual(gesture.view(order()), { id: 'a', beforeId: 'a', droppable: false });
  assert.equal(gesture.escape(), true);
  assert.equal(gesture.view(order()), null, 'nothing drawn after a cancellation');
  assert.equal(gesture.escape(), false, 'Escape is not consumed without a drag');
});
