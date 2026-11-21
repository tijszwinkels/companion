import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PendingMove,
  stepKey,
  stepMove,
  type StepDirection,
} from '../../integrations/shell/src/list/move-steps.ts';
import type { OrderState } from '../../integrations/shell/src/list/reorder-gesture.ts';

/**
 * The pure part of moving a conversation one place by key or ⋯ menu
 * (integrations/shell/README.md, "Moving by key and by the ⋯ menu"): which
 * `move-agent` a step asks for, and the pending rule shared with the drag.
 * The browser side of the same table (real keys, real menu, focus, a second
 * page) is list-menu.test.ts.
 */

const ids = ['a', 'b', 'c'];

function order(overrides: Partial<OrderState> = {}): OrderState {
  return { ids, revision: 'r1', available: true, ...overrides };
}

// ---- Which move a step asks for ---------------------------------------------------

/**
 * The moving table's rows for the request: first, middle and last entry ×
 * up and down (the same for key and menu, which both call `stepMove`), one
 * conversation, and the conditions under which nothing is sent.
 */
const stepCases: {
  name: string;
  order: OrderState;
  id: string;
  direction: StepDirection;
  /** The conversation it goes before ("" for the end), or null for no move. */
  beforeId: string | null;
}[] = [
  { name: 'first, up (an end)', order: order(), id: 'a', direction: 'up', beforeId: null },
  { name: 'first, down', order: order(), id: 'a', direction: 'down', beforeId: 'c' },
  { name: 'middle, up', order: order(), id: 'b', direction: 'up', beforeId: 'a' },
  { name: 'middle, down (to the end)', order: order(), id: 'b', direction: 'down', beforeId: '' },
  { name: 'last, up', order: order(), id: 'c', direction: 'up', beforeId: 'b' },
  { name: 'last, down (an end)', order: order(), id: 'c', direction: 'down', beforeId: null },
  {
    name: 'one conversation, up',
    order: order({ ids: ['a'] }),
    id: 'a',
    direction: 'up',
    beforeId: null,
  },
  {
    name: 'one conversation, down',
    order: order({ ids: ['a'] }),
    id: 'a',
    direction: 'down',
    beforeId: null,
  },
  {
    name: 'not admitted (offline, before the snapshot) or a move pending',
    order: order({ available: false }),
    id: 'b',
    direction: 'up',
    beforeId: null,
  },
  {
    name: 'the listener names no order revision',
    order: order({ revision: '' }),
    id: 'b',
    direction: 'up',
    beforeId: null,
  },
  {
    name: 'a conversation no longer listed (closed elsewhere)',
    order: order(),
    id: 'gone',
    direction: 'up',
    beforeId: null,
  },
  {
    name: 'four conversations, second down',
    order: order({ ids: ['a', 'b', 'c', 'd'] }),
    id: 'b',
    direction: 'down',
    beforeId: 'd',
  },
];

for (const step of stepCases) {
  test(`a step: ${step.name}`, () => {
    const move = stepMove(step.order, step.id, step.direction);
    if (step.beforeId === null) {
      assert.equal(move, null);
      return;
    }
    // Exactly what the drag sends: the conversation, its target and the
    // current order revision.
    assert.deepEqual(move, { id: step.id, beforeId: step.beforeId, revision: 'r1' });
  });
}

test('a step applied as the listener applies it moves exactly one place', () => {
  // The listener's insertion (AgentSessions.move): remove, then insert before.
  const apply = (list: string[], id: string, beforeId: string) => {
    const remaining = list.filter((candidate) => candidate !== id);
    const position = beforeId ? remaining.indexOf(beforeId) : remaining.length;
    remaining.splice(position, 0, id);
    return remaining;
  };
  const list = ['a', 'b', 'c', 'd'];
  for (let index = 0; index < list.length; index++) {
    for (const direction of ['up', 'down'] as const) {
      const move = stepMove(order({ ids: list }), list[index], direction);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= list.length) {
        assert.equal(move, null);
        continue;
      }
      const moved = apply(list, move!.id, move!.beforeId);
      assert.equal(moved.indexOf(list[index]), target, `${list[index]} ${direction}`);
    }
  }
});

// ---- The keys ---------------------------------------------------------------------

const keyCases: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  step: StepDirection | null;
}[] = [
  { key: 'ArrowUp', altKey: true, shiftKey: true, step: 'up' },
  { key: 'ArrowDown', altKey: true, shiftKey: true, step: 'down' },
  { key: 'ArrowUp', altKey: true, shiftKey: false, step: null },
  { key: 'ArrowUp', altKey: false, shiftKey: true, step: null },
  { key: 'ArrowDown', altKey: true, shiftKey: true, ctrlKey: true, step: null },
  { key: 'ArrowDown', altKey: true, shiftKey: true, metaKey: true, step: null },
  { key: 'ArrowLeft', altKey: true, shiftKey: true, step: null },
  { key: 'ArrowUp', altKey: false, shiftKey: false, step: null },
];

for (const pressed of keyCases) {
  const modifiers = [
    pressed.altKey ? 'Alt' : '',
    pressed.shiftKey ? 'Shift' : '',
    pressed.ctrlKey ? 'Control' : '',
    pressed.metaKey ? 'Meta' : '',
  ].filter(Boolean);
  test(`the key ${[...modifiers, pressed.key].join('+')}: ${pressed.step ?? 'no step'}`, () => {
    assert.equal(stepKey({ ctrlKey: false, metaKey: false, ...pressed }), pressed.step);
  });
}

// ---- One move at a time -----------------------------------------------------------

/**
 * The pending rule's sequences: each event, and whether a move is pending
 * after it (then the list offers no move: drag, keys and menu send nothing).
 */
type PendingEvent =
  { sent: string } | { answered: boolean; shown: string } | { shown: string } | { reset: true };

const pendingCases: { name: string; events: PendingEvent[]; pending: boolean[] }[] = [
  {
    name: 'accepted, the new order already shown (the listener publishes it first)',
    events: [{ sent: 'r1' }, { shown: 'r2' }, { answered: true, shown: 'r2' }],
    // Shown before the answer: the move still awaits its answer.
    pending: [true, true, false],
  },
  {
    name: 'accepted before the new order arrives: pending until it does',
    events: [{ sent: 'r1' }, { answered: true, shown: 'r1' }, { shown: 'r2' }],
    pending: [true, true, false],
  },
  {
    name: 'refused (the order changed elsewhere): ends with the answer',
    events: [{ sent: 'r1' }, { answered: false, shown: 'r1' }],
    pending: [true, false],
  },
  {
    name: 'a lost or expired request: ends like a refusal',
    events: [{ sent: 'r1' }, { shown: 'r2' }, { answered: false, shown: 'r2' }],
    pending: [true, true, false],
  },
  {
    name: 'the order changes elsewhere while it awaits the answer',
    events: [{ sent: 'r1' }, { shown: 'r9' }],
    pending: [true, true],
  },
  {
    name: 'a second move after the first ended',
    events: [
      { sent: 'r1' },
      { answered: true, shown: 'r2' },
      { sent: 'r2' },
      { answered: true, shown: 'r3' },
    ],
    pending: [true, false, true, false],
  },
  {
    name: 'an answer after a reset is ignored',
    events: [{ sent: 'r1' }, { reset: true }, { answered: false, shown: 'r1' }],
    pending: [true, false, false],
  },
];

for (const sequence of pendingCases) {
  test(`one move at a time: ${sequence.name}`, () => {
    const pending = new PendingMove();
    const seen: boolean[] = [];
    for (const event of sequence.events) {
      if ('sent' in event) {
        pending.sent(event.sent);
      } else if ('answered' in event) {
        pending.answered(event.answered, event.shown);
      } else if ('reset' in event) {
        pending.reset();
      } else {
        pending.orderShown(event.shown);
      }
      seen.push(pending.pending);
    }
    assert.deepEqual(seen, sequence.pending);
  });
}

test('while a move is pending the list offers no step and no drag', () => {
  // ConversationList.tsx passes `available: admitted && !pending`, the
  // condition every way of moving checks (`movable`).
  const pending = new PendingMove();
  pending.sent('r1');
  const shown = order({ available: true && !pending.pending });
  assert.equal(stepMove(shown, 'b', 'up'), null);
  assert.equal(stepMove(shown, 'b', 'down'), null);
});
