import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityReservedWidth,
  activityWidthFromKey,
  activityWidthFromPointer,
  isNarrowWindow,
  sideColumnWidth,
} from '../../integrations/shell/src/layout/activity-width.ts';
import { shownListWidth, stripWidth } from '../../integrations/shell/src/layout/list-width.ts';
import {
  activityShownKey,
  activityWidthKey,
  listShownKey,
  listWidthKey,
  readActivityLayout,
  readLayout,
  writeActivityShown,
  writeActivityWidth,
  writeListWidth,
  type LayoutStorage,
} from '../../integrations/shell/src/layout/stored-layout.ts';

/**
 * The Activity column's width rules and remembered layout, checked with
 * the cases of the README's "Activity column width and hidden state" table
 * (integrations/shell/README.md), derived from its rules 1–7. The browser
 * suite (activity.test.ts) checks the same rules through the real divider,
 * ☰ buttons, the list's Activity entry and reloads.
 */

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}): LayoutStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function entry(value: unknown, version = 1): string {
  return JSON.stringify({ version, value });
}

/**
 * The whole arrangement for a window, as Workspace.tsx computes it: the
 * column beside the chat (wide) or over it (narrow), the list in what the
 * column leaves, and the chat's width.
 */
function arrangement(
  windowWidth: number,
  layout: { listWidth: number; listShown: boolean; activityWidth: number; activityShown: boolean },
) {
  const reserved = activityReservedWidth(
    layout.activityWidth,
    layout.activityShown,
    windowWidth,
    layout.listShown,
  );
  let list = 0;
  if (layout.listShown) {
    list = shownListWidth(layout.listWidth, windowWidth - reserved);
  }
  let listSpace = 0;
  if (layout.listShown) {
    listSpace = list + 1;
  }
  const overlay = layout.activityShown && isNarrowWindow(windowWidth);
  let column = 0;
  if (layout.activityShown && !overlay) {
    column = sideColumnWidth(layout.activityWidth, windowWidth, layout.listShown);
  } else if (overlay) {
    column = windowWidth - listSpace;
  }
  const chat = windowWidth - listSpace - reserved;
  return { list, column, overlay, chat };
}

test('remembered Activity layout: each entry that is missing or not valid gives its default', () => {
  const cases: {
    name: string;
    initial: Record<string, string>;
    expected: { activityWidth: number; activityShown: boolean };
  }[] = [
    {
      name: 'initial (nothing remembered)',
      initial: {},
      expected: { activityWidth: 320, activityShown: false },
    },
    {
      name: 'both invalid',
      initial: { [activityWidthKey]: '{not json', [activityShownKey]: entry('yes') },
      expected: { activityWidth: 320, activityShown: false },
    },
    {
      name: 'both of another version',
      initial: { [activityWidthKey]: entry(400, 2), [activityShownKey]: entry(true, 2) },
      expected: { activityWidth: 320, activityShown: false },
    },
    {
      name: 'only the width invalid; column shown',
      initial: { [activityWidthKey]: entry('wide'), [activityShownKey]: entry(true) },
      expected: { activityWidth: 320, activityShown: true },
    },
    {
      name: 'only the shown state invalid; 400 px',
      initial: { [activityWidthKey]: entry(400), [activityShownKey]: entry(1) },
      expected: { activityWidth: 400, activityShown: false },
    },
    {
      name: 'remembered 100 px (under the minimum)',
      initial: { [activityWidthKey]: entry(100) },
      expected: { activityWidth: 240, activityShown: false },
    },
    {
      name: 'remembered 900 px (over the maximum)',
      initial: { [activityWidthKey]: entry(900) },
      expected: { activityWidth: 520, activityShown: false },
    },
    {
      name: 'a number in a non-object entry',
      initial: { [activityWidthKey]: '400' },
      expected: { activityWidth: 320, activityShown: false },
    },
  ];
  for (const testCase of cases) {
    assert.deepEqual(
      readActivityLayout(memoryStorage(testCase.initial)),
      testCase.expected,
      testCase.name,
    );
  }

  // A storage that cannot be read gives the defaults.
  const refusing: LayoutStorage = {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('denied');
    },
  };
  assert.deepEqual(readActivityLayout(refusing), { activityWidth: 320, activityShown: false });
  // Writing to it throws nothing: the page keeps its own values.
  writeActivityWidth(refusing, 400);
  writeActivityShown(refusing, true);
});

test('Activity entries are read back (reload); each write touches only its own entry', () => {
  const storage = memoryStorage({ [listWidthKey]: entry(300), [listShownKey]: entry(false) });
  writeActivityShown(storage, true);
  assert.deepEqual(readActivityLayout(storage), { activityWidth: 320, activityShown: true });
  assert.equal(storage.items.has(activityWidthKey), false, 'shown writes only its entry');

  writeActivityWidth(storage, 400);
  assert.deepEqual(readActivityLayout(storage), { activityWidth: 400, activityShown: true });

  // ☰ in the column hides it; the width is kept.
  writeActivityShown(storage, false);
  assert.deepEqual(readActivityLayout(storage), { activityWidth: 400, activityShown: false });

  // The list's entries are untouched and independent.
  assert.deepEqual(readLayout(storage), { listWidth: 300, listShown: false });
  writeListWidth(storage, 200);
  assert.deepEqual(readActivityLayout(storage), { activityWidth: 400, activityShown: false });
  assert.equal(storage.items.get(activityWidthKey), entry(400));
});

test('tabs: Activity and list entries changed in two tabs at the same moment both survive', () => {
  // Each tab writes only the entry it changes, so the order does not matter.
  for (const order of [
    ['width', 'shown'],
    ['shown', 'width'],
  ]) {
    const storage = memoryStorage();
    for (const change of order) {
      if (change === 'width') {
        writeActivityWidth(storage, 460);
      } else {
        writeActivityShown(storage, true);
      }
    }
    assert.deepEqual(readActivityLayout(storage), { activityWidth: 460, activityShown: true });
  }
});

test('divider dragged: the distance to the right edge, within 240 and 520 px', () => {
  const cases: { distance: number; width: number }[] = [
    { distance: 300, width: 300 },
    { distance: 100, width: 240 },
    { distance: 239.6, width: 240 },
    { distance: 900, width: 520 },
    { distance: 400.4, width: 400 },
    { distance: Number.NaN, width: 320 },
  ];
  for (const testCase of cases) {
    assert.equal(
      activityWidthFromPointer(testCase.distance),
      testCase.width,
      `${testCase.distance} px`,
    );
  }
});

test('divider keys: Left widens, Right narrows by 20 px, Home 240, End 520', () => {
  const cases: { key: string; from: number; to: number | null }[] = [
    { key: 'ArrowLeft', from: 320, to: 340 },
    { key: 'ArrowLeft', from: 510, to: 520 },
    { key: 'ArrowLeft', from: 520, to: 520 },
    { key: 'ArrowRight', from: 320, to: 300 },
    { key: 'ArrowRight', from: 250, to: 240 },
    { key: 'ArrowRight', from: 240, to: 240 },
    { key: 'Home', from: 400, to: 240 },
    { key: 'End', from: 300, to: 520 },
    { key: 'ArrowUp', from: 300, to: null },
    { key: 'Enter', from: 300, to: null },
  ];
  for (const testCase of cases) {
    assert.equal(
      activityWidthFromKey(testCase.key, testCase.from),
      testCase.to,
      `${testCase.key} from ${testCase.from}`,
    );
  }
});

test('windows: the column beside the chat from 640 px, over it below; the chat keeps 320 px', () => {
  const cases: {
    name: string;
    window: number;
    listWidth: number;
    listShown: boolean;
    activityWidth: number;
    expected: { list: number; column: number; overlay: boolean; chat: number };
  }[] = [
    {
      name: '1600 px, strip, column 320',
      window: 1600,
      listWidth: stripWidth,
      listShown: true,
      activityWidth: 320,
      expected: { list: 78, column: 320, overlay: false, chat: 1200 },
    },
    {
      name: '1000 px, full list 420, column 520',
      window: 1000,
      listWidth: 420,
      listShown: true,
      activityWidth: 520,
      expected: { list: 158, column: 520, overlay: false, chat: 320 },
    },
    {
      name: '700 px, strip, column 520',
      window: 700,
      listWidth: stripWidth,
      listShown: true,
      activityWidth: 520,
      expected: { list: 78, column: 300, overlay: false, chat: 320 },
    },
    {
      name: '640 px, strip, column 320',
      window: 640,
      listWidth: stripWidth,
      listShown: true,
      activityWidth: 320,
      expected: { list: 78, column: 240, overlay: false, chat: 320 },
    },
    {
      name: '640 px, list hidden, column 520',
      window: 640,
      listWidth: stripWidth,
      listShown: false,
      activityWidth: 520,
      expected: { list: 0, column: 319, overlay: false, chat: 320 },
    },
    {
      name: '639 px, strip, column shown',
      window: 639,
      listWidth: stripWidth,
      listShown: true,
      activityWidth: 320,
      expected: { list: 78, column: 560, overlay: true, chat: 560 },
    },
    {
      name: '420 px, strip, column shown',
      window: 420,
      listWidth: stripWidth,
      listShown: true,
      activityWidth: 520,
      expected: { list: 78, column: 341, overlay: true, chat: 341 },
    },
    {
      name: '600 px, full list 420, column shown (the list keeps its own rule)',
      window: 600,
      listWidth: 420,
      listShown: true,
      activityWidth: 320,
      expected: { list: 279, column: 320, overlay: true, chat: 320 },
    },
    {
      name: '420 px, list hidden, column shown',
      window: 420,
      listWidth: stripWidth,
      listShown: false,
      activityWidth: 320,
      expected: { list: 0, column: 420, overlay: true, chat: 420 },
    },
  ];
  for (const testCase of cases) {
    const result = arrangement(testCase.window, {
      listWidth: testCase.listWidth,
      listShown: testCase.listShown,
      activityWidth: testCase.activityWidth,
      activityShown: true,
    });
    assert.deepEqual(result, testCase.expected, testCase.name);
    // Nothing is wider than the window.
    if (!result.overlay) {
      let total = result.chat + result.column + 1;
      if (testCase.listShown) {
        total = total + result.list + 1;
      }
      assert.equal(total, testCase.window, `${testCase.name}: fills the window`);
    }
  }

  // Hidden, the column takes nothing and the list has the whole window (the
  // list's own table applies unchanged).
  const hidden = arrangement(600, {
    listWidth: 420,
    listShown: true,
    activityWidth: 520,
    activityShown: false,
  });
  assert.deepEqual(hidden, { list: 279, column: 0, overlay: false, chat: 320 });
});
