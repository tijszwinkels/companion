import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appearanceOf,
  shownListWidth,
  stripWidth,
  widthFromKey,
  widthFromPointer,
  type ListAppearance,
} from '../../integrations/shell/src/layout/list-width.ts';
import {
  listShownKey,
  listWidthKey,
  readLayout,
  writeListShown,
  writeListWidth,
  type LayoutStorage,
  type ListLayout,
} from '../../integrations/shell/src/layout/stored-layout.ts';

/**
 * The conversation list's width rules and remembered layout, checked with
 * the cases of the README's "Remembered width and hidden state" table
 * (integrations/shell/README.md), derived from its rules 1–6. The browser
 * suite (shell.test.ts) checks the same rules through the real divider,
 * ☰ button and reloads.
 */

/** A window wide enough for every list width. */
const wideWindow = 1600;

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

function shown(layout: ListLayout, windowWidth: number): { width: number; look: ListAppearance } {
  const width = shownListWidth(layout.listWidth, windowWidth);
  return { width, look: appearanceOf(width) };
}

test('divider dragged: strip left of the snap point, else a full list within its range', () => {
  const cases: { pointer: number; width: number; look: ListAppearance }[] = [
    { pointer: 40, width: 78, look: 'strip' },
    { pointer: 100, width: 78, look: 'strip' },
    { pointer: 113, width: 78, look: 'strip' },
    { pointer: 114, width: 150, look: 'full' },
    { pointer: 120, width: 150, look: 'full' },
    { pointer: 300, width: 300, look: 'full' },
    { pointer: 420, width: 420, look: 'full' },
    { pointer: 600, width: 420, look: 'full' },
    { pointer: Number.NaN, width: 78, look: 'strip' },
  ];
  for (const testCase of cases) {
    const preference = widthFromPointer(testCase.pointer);
    const result = shown({ listWidth: preference, listShown: true }, wideWindow);
    assert.deepEqual(
      result,
      { width: testCase.width, look: testCase.look },
      `${testCase.pointer} px`,
    );
  }
});

test('divider keys: one step at a time, the strip below the full list, Home and End', () => {
  const cases: { key: string; from: number; to: number | null }[] = [
    { key: 'ArrowRight', from: 78, to: 150 },
    { key: 'ArrowRight', from: 150, to: 170 },
    { key: 'ArrowRight', from: 410, to: 420 },
    { key: 'ArrowRight', from: 420, to: 420 },
    { key: 'ArrowLeft', from: 300, to: 280 },
    { key: 'ArrowLeft', from: 169, to: 78 },
    { key: 'ArrowLeft', from: 150, to: 78 },
    { key: 'ArrowLeft', from: 78, to: 78 },
    { key: 'Home', from: 300, to: 78 },
    { key: 'End', from: 78, to: 420 },
    { key: 'Enter', from: 300, to: null },
    { key: 'ArrowUp', from: 300, to: null },
  ];
  for (const testCase of cases) {
    assert.equal(
      widthFromKey(testCase.key, testCase.from),
      testCase.to,
      `${testCase.key} from ${testCase.from}`,
    );
  }
});

test('narrow windows: the chat keeps 320 px beside list and divider; a full list that does not fit is the strip', () => {
  const cases: { window: number; preference: number; width: number; look: ListAppearance }[] = [
    { window: 420, preference: 300, width: 78, look: 'strip' },
    { window: 420, preference: 78, width: 78, look: 'strip' },
    { window: 470, preference: 300, width: 78, look: 'strip' },
    { window: 471, preference: 300, width: 150, look: 'full' },
    { window: 600, preference: 420, width: 279, look: 'full' },
    { window: 760, preference: 420, width: 420, look: 'full' },
    { window: 1280, preference: 300, width: 300, look: 'full' },
    { window: 300, preference: 78, width: 78, look: 'strip' },
  ];
  for (const testCase of cases) {
    const result = shown({ listWidth: testCase.preference, listShown: true }, testCase.window);
    assert.deepEqual(
      result,
      { width: testCase.width, look: testCase.look },
      `${testCase.preference} px in a ${testCase.window} px window`,
    );
  }
  // The window never changes the preference: a wider window shows it again.
  assert.equal(shownListWidth(300, 420), stripWidth);
  assert.equal(shownListWidth(300, 1280), 300);
});

test('icons: a leading emoji (one grapheme) is the icon, else "Q" and the number', async () => {
  const { badgeOf } = await import('../../integrations/shell/src/list/entries.ts');
  const cases: { title: string; glyph: string; caption: string; emoji: boolean }[] = [
    { title: '🗺️ Route planner', glyph: '🗺️', caption: 'Route planner', emoji: true },
    {
      title: '🧪Investigate the regression',
      glyph: '🧪',
      caption: 'Investigate the regression',
      emoji: true,
    },
    { title: '🇳🇱 Dutch holidays', glyph: '🇳🇱', caption: 'Dutch holidays', emoji: true },
    { title: '👩‍💻 Pairing notes', glyph: '👩‍💻', caption: 'Pairing notes', emoji: true },
    { title: '1️⃣ First step', glyph: '1️⃣', caption: 'First step', emoji: true },
    { title: '🐛', glyph: '🐛', caption: '', emoji: true },
    { title: 'Invoice export', glyph: 'Q3', caption: 'Invoice export', emoji: false },
    { title: '  Padded title ', glyph: 'Q3', caption: 'Padded title', emoji: false },
    { title: '1 plain number', glyph: 'Q3', caption: '1 plain number', emoji: false },
  ];
  for (const testCase of cases) {
    assert.deepEqual(
      badgeOf(testCase.title, 3),
      { glyph: testCase.glyph, caption: testCase.caption, emoji: testCase.emoji },
      testCase.title,
    );
  }
});

test('icons without Intl.Segmenter (Firefox before 125): the whole first word, as the rail', async () => {
  const { badgeOf } = await import('../../integrations/shell/src/list/entries.ts');
  const segmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  // Removed to stand for a browser without it.
  Reflect.deleteProperty(Intl, 'Segmenter');
  try {
    assert.deepEqual(badgeOf('🗺️ Route planner', 1), {
      glyph: '🗺️',
      caption: 'Route planner',
      emoji: true,
    });
    assert.deepEqual(badgeOf('1️⃣ First step', 1), {
      glyph: '1️⃣',
      caption: 'First step',
      emoji: true,
    });
    assert.deepEqual(badgeOf('Invoice export', 4), {
      glyph: 'Q4',
      caption: 'Invoice export',
      emoji: false,
    });
  } finally {
    Object.defineProperty(Intl, 'Segmenter', segmenter);
  }
});

/** One stored entry as the shell writes it. */
function entry(value: unknown, version = 1): string {
  return JSON.stringify({ version, value });
}

test('remembered layout: each entry that is missing or not valid gives its default', () => {
  const cases: { name: string; width?: string; shown?: string; expected: ListLayout }[] = [
    { name: 'nothing remembered', expected: { listWidth: 78, listShown: true } },
    {
      name: 'both valid',
      width: entry(300),
      shown: entry(false),
      expected: { listWidth: 300, listShown: false },
    },
    {
      name: 'width not JSON, hidden state valid',
      width: '{',
      shown: entry(false),
      expected: { listWidth: 78, listShown: false },
    },
    {
      name: 'width of the wrong type, hidden state valid',
      width: entry('300'),
      shown: entry(false),
      expected: { listWidth: 78, listShown: false },
    },
    {
      name: 'width valid, hidden state of the wrong type',
      width: entry(300),
      shown: entry('no'),
      expected: { listWidth: 300, listShown: true },
    },
    {
      name: 'another version',
      width: entry(300, 2),
      shown: entry(false, 2),
      expected: { listWidth: 78, listShown: true },
    },
    {
      name: 'not an object',
      width: '42',
      shown: 'true',
      expected: { listWidth: 78, listShown: true },
    },
    {
      name: 'a width between the appearances snaps (rule 1)',
      width: entry(130),
      expected: { listWidth: 150, listShown: true },
    },
    {
      name: 'a width beyond the maximum',
      width: entry(900),
      expected: { listWidth: 420, listShown: true },
    },
  ];
  for (const testCase of cases) {
    const initial: Record<string, string> = {};
    if (testCase.width !== undefined) {
      initial[listWidthKey] = testCase.width;
    }
    if (testCase.shown !== undefined) {
      initial[listShownKey] = testCase.shown;
    }
    assert.deepEqual(readLayout(memoryStorage(initial)), testCase.expected, testCase.name);
  }

  // Storage that throws (disabled): the default, and writing does not throw.
  const broken: LayoutStorage = {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('disabled');
    },
  };
  assert.deepEqual(readLayout(broken), { listWidth: 78, listShown: true });
  writeListWidth(broken, 300);
  writeListShown(broken, false);
});

test('written entries are read back (reload); each write touches only its own entry', () => {
  const storage = memoryStorage();
  writeListWidth(storage, 300);
  assert.deepEqual(readLayout(storage), { listWidth: 300, listShown: true });
  assert.equal(storage.items.has(listShownKey), false, 'the hidden state is not written');
  writeListShown(storage, false);
  assert.deepEqual(readLayout(storage), { listWidth: 300, listShown: false });
  writeListWidth(storage, 78);
  assert.deepEqual(readLayout(storage), { listWidth: 78, listShown: false });
  assert.deepEqual(JSON.parse(storage.items.get(listWidthKey)!), { version: 1, value: 78 });
  assert.deepEqual(JSON.parse(storage.items.get(listShownKey)!), { version: 1, value: false });
  // An invalid width is stored made valid.
  writeListWidth(storage, 130);
  assert.deepEqual(JSON.parse(storage.items.get(listWidthKey)!), { version: 1, value: 150 });
});

test('tabs: changes of different entries from two tabs, in any order, both survive', () => {
  // Each tab writes only the entry it changed, whatever its own copy of the
  // other entry is; every interleaving keeps both changes.
  const orders: string[][] = [
    ['width', 'shown'],
    ['shown', 'width'],
  ];
  for (const order of orders) {
    const storage = memoryStorage();
    for (const step of order) {
      if (step === 'width') {
        writeListWidth(storage, 300);
      } else {
        writeListShown(storage, false);
      }
    }
    assert.deepEqual(readLayout(storage), { listWidth: 300, listShown: false }, order.join(', '));
  }
});
