import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentMessage, AgentSession } from '../../src/agents/types.ts';
import {
  bandHeight,
  bandPercent,
  bandPercentFromKey,
  bandPercentFromPointer,
  pinnedPlace,
  placeChoices,
  type PinnedPlacePreference,
} from '../../integrations/shell/src/layout/pinned-place.ts';
import {
  pinnedFoldedKey,
  pinnedHeightKey,
  pinnedPlaceKey,
  readPinnedLayout,
  writePinnedFolded,
  writePinnedHeight,
  writePinnedPlace,
  type LayoutStorage,
} from '../../integrations/shell/src/layout/stored-layout.ts';
import { stripWidth } from '../../integrations/shell/src/layout/list-width.ts';
import { pinnedWidget, rowOfMessage } from '../../integrations/shell/src/widgets/pinned-widget.ts';

/**
 * The pinned widget's rules (integrations/shell/README.md, "Pinned
 * widgets"), each with one table of cases derived from it: the place, the
 * band at the top, and which widget is pinned. The browser suite
 * (pinned-widgets.test.ts) checks the same rules through the real page,
 * gateway and listener.
 */

/** An in-memory stand-in for localStorage (shared by two "tabs" below). */
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

// ---- Place ---------------------------------------------------------------------

interface PlaceCase {
  case: string;
  width: number;
  height: number;
  /** 'strip', a full list's preferred width, or 'hidden'. */
  list: 'strip' | 'hidden' | number;
  preference: PinnedPlacePreference;
  place: 'right' | 'top';
}

const placeCases: PlaceCase[] = [
  {
    case: 'wider than tall',
    width: 1280,
    height: 800,
    list: 'strip',
    preference: 'auto',
    place: 'right',
  },
  {
    case: 'taller than wide',
    width: 900,
    height: 1000,
    list: 'strip',
    preference: 'auto',
    place: 'top',
  },
  {
    case: 'exactly square (879 − 79 = 800)',
    width: 879,
    height: 800,
    list: 'strip',
    preference: 'auto',
    place: 'top',
  },
  {
    case: 'one pixel wider than square',
    width: 880,
    height: 800,
    list: 'strip',
    preference: 'auto',
    place: 'right',
  },
  {
    case: 'list as strip (1100 − 79 = 1021 > 900)',
    width: 1100,
    height: 900,
    list: 'strip',
    preference: 'auto',
    place: 'right',
  },
  {
    case: 'list as full list (1100 − 301 = 799 < 900)',
    width: 1100,
    height: 900,
    list: 300,
    preference: 'auto',
    place: 'top',
  },
  {
    case: 'list hidden (1000 > 950)',
    width: 1000,
    height: 950,
    list: 'hidden',
    preference: 'auto',
    place: 'right',
  },
  {
    case: 'strip shown (921 < 950)',
    width: 1000,
    height: 950,
    list: 'strip',
    preference: 'auto',
    place: 'top',
  },
  {
    case: 'below 640 px, wider than tall',
    width: 600,
    height: 300,
    list: 'strip',
    preference: 'auto',
    place: 'top',
  },
  {
    case: 'below 640 px, right fixed',
    width: 600,
    height: 300,
    list: 'strip',
    preference: 'right',
    place: 'top',
  },
  {
    case: '640 px, right fixed',
    width: 640,
    height: 300,
    list: 'strip',
    preference: 'right',
    place: 'right',
  },
  {
    case: '639 px, right fixed',
    width: 639,
    height: 300,
    list: 'strip',
    preference: 'right',
    place: 'top',
  },
  {
    case: 'taller than wide, right fixed',
    width: 900,
    height: 1000,
    list: 'strip',
    preference: 'right',
    place: 'right',
  },
  {
    case: 'wider than tall, top fixed',
    width: 1280,
    height: 800,
    list: 'strip',
    preference: 'top',
    place: 'top',
  },
  {
    case: 'Auto again, wider than tall',
    width: 1280,
    height: 800,
    list: 'strip',
    preference: 'auto',
    place: 'right',
  },
  {
    case: 'a full list narrowed by the window (700 − 380 = 320 < 600)',
    width: 700,
    height: 600,
    list: 420,
    preference: 'auto',
    place: 'top',
  },
];

test('place: one case per row of the README table', () => {
  for (const row of placeCases) {
    let listPreference = stripWidth;
    if (typeof row.list === 'number') {
      listPreference = row.list;
    }
    const place = pinnedPlace({
      windowWidth: row.width,
      windowHeight: row.height,
      listShown: row.list !== 'hidden',
      listPreference,
      preference: row.preference,
    });
    assert.equal(place, row.place, row.case);
  }
});

test('place: the window resized across each limit moves it at once; nothing remembered changes', () => {
  const storage = memoryStorage();
  writePinnedPlace(storage, 'auto');
  const before = [...storage.items];
  const at = (width: number, height: number, preference: PinnedPlacePreference = 'auto') =>
    pinnedPlace({
      windowWidth: width,
      windowHeight: height,
      listShown: true,
      listPreference: stripWidth,
      preference,
    });
  // The square limit, both ways.
  assert.deepEqual([at(879, 800), at(880, 800), at(879, 800)], ['top', 'right', 'top']);
  // The 640 px limit with the right fixed, both ways.
  assert.deepEqual(
    [at(639, 300, 'right'), at(640, 300, 'right'), at(639, 300, 'right')],
    ['top', 'right', 'top'],
  );
  assert.deepEqual([...storage.items], before);
});

test('place: the header offers the other place, Auto while one is fixed', () => {
  const cases: [string, ReturnType<typeof placeChoices>, PinnedPlacePreference[]][] = [
    ['top by shape, wide window', placeChoices('top', 'auto', 900), ['right']],
    ['top fixed', placeChoices('top', 'top', 1280), ['right', 'auto']],
    ['top below 640 px', placeChoices('top', 'auto', 600), []],
    ['top below 640 px, right fixed', placeChoices('top', 'right', 600), ['auto']],
    ['right by shape', placeChoices('right', 'auto', 1280), ['top']],
    ['right fixed', placeChoices('right', 'right', 900), ['top', 'auto']],
  ];
  for (const [name, actual, expected] of cases) {
    assert.deepEqual(actual, expected, name);
  }
});

test('place: remembered per browser; invalid entries give Auto; two tabs share the entry', () => {
  // Nothing remembered: Auto, not folded, the widget's own height.
  assert.deepEqual(readPinnedLayout(memoryStorage()), {
    pinnedPlace: 'auto',
    pinnedHeight: null,
    pinnedFolded: false,
  });

  // Invalid or of another version: Auto.
  for (const stored of [entry('left'), entry(3), entry('right', 2), 'not json', entry(null)]) {
    const storage = memoryStorage({ [pinnedPlaceKey]: stored });
    assert.equal(readPinnedLayout(storage).pinnedPlace, 'auto', stored);
  }

  // A fixed place is written as its own entry only.
  const storage = memoryStorage();
  writePinnedPlace(storage, 'right');
  assert.deepEqual([...storage.items.keys()], [pinnedPlaceKey]);
  assert.equal(storage.items.get(pinnedPlaceKey), entry('right'));
  // After a reload: as remembered.
  assert.equal(readPinnedLayout(storage).pinnedPlace, 'right');

  // Two tabs of one browser fix different places one after the other: the
  // last one applies (each tab follows the entry the other writes).
  writePinnedPlace(storage, 'top');
  assert.equal(readPinnedLayout(storage).pinnedPlace, 'top');
  writePinnedPlace(storage, 'auto');
  assert.equal(readPinnedLayout(storage).pinnedPlace, 'auto');

  // A storage that refuses writes: nothing is thrown (the page keeps its own).
  const refusing: LayoutStorage = {
    getItem: () => null,
    setItem: () => {
      throw Error('QuotaExceededError');
    },
  };
  writePinnedPlace(refusing, 'top');
  writePinnedHeight(refusing, 40);
  writePinnedFolded(refusing, true);
});

// ---- Band at the top -------------------------------------------------------------

test('band: its percentage, its height in pixels, the edge by pointer and keys', () => {
  const percentCases: [string, number | null, number | undefined, number][] = [
    ['nothing remembered, the widget asks nothing', null, undefined, 25],
    ['the widget asks 40', null, 40, 40],
    ['the widget asks 100 (the desktop shows it full)', null, 100, 70],
    ['the widget asks 5', null, 5, 10],
    ['dragged to 55, the widget asks 40', 55, 40, 55],
    ['a remembered value out of bounds', 90, undefined, 70],
  ];
  for (const [name, remembered, widget, expected] of percentCases) {
    assert.equal(bandPercent(remembered, widget), expected, name);
  }

  const heightCases: [string, number, number, number][] = [
    ['25 % of 752 px', 25, 752, 188],
    ['70 % of 752 px', 70, 752, 526],
    ['70 % of 400 px: the chat keeps 160 px', 70, 400, 240],
    ['25 % of 300 px: at least 80 px', 25, 300, 80],
    ['an area of 200 px: 80 px', 50, 200, 80],
  ];
  for (const [name, percent, body, expected] of heightCases) {
    assert.equal(bandHeight(percent, body), expected, name);
  }

  const pointerCases: [string, number, number, number][] = [
    ['dragged to half', 376, 752, 50],
    ['dragged above 70 %', 700, 752, 70],
    ['dragged below 10 %', 10, 752, 10],
    ['dragged above the area', -40, 752, 10],
  ];
  for (const [name, y, body, expected] of pointerCases) {
    assert.equal(bandPercentFromPointer(y, body), expected, name);
  }

  const keyCases: [string, number, number | null][] = [
    ['ArrowDown', 25, 30],
    ['ArrowUp', 25, 20],
    ['ArrowDown', 70, 70],
    ['ArrowUp', 10, 10],
    ['Home', 40, 10],
    ['End', 40, 70],
    ['ArrowLeft', 40, null],
  ];
  for (const [key, from, expected] of keyCases) {
    assert.equal(bandPercentFromKey(key, from), expected, `${key} from ${from}`);
  }
});

test('band: dragged height and fold are remembered as their own entries, after a reload', () => {
  const storage = memoryStorage();
  writePinnedHeight(storage, 55);
  assert.deepEqual([...storage.items.keys()], [pinnedHeightKey]);
  writePinnedFolded(storage, true);
  assert.deepEqual([...storage.items.keys()], [pinnedHeightKey, pinnedFoldedKey]);
  assert.deepEqual(readPinnedLayout(storage), {
    pinnedPlace: 'auto',
    pinnedHeight: 55,
    pinnedFolded: true,
  });

  // Written at the bounds.
  writePinnedHeight(storage, 95);
  assert.equal(readPinnedLayout(storage).pinnedHeight, 70);
  writePinnedHeight(storage, 2);
  assert.equal(readPinnedLayout(storage).pinnedHeight, 10);
  // Unfolded.
  writePinnedFolded(storage, false);
  assert.equal(readPinnedLayout(storage).pinnedFolded, false);

  // Invalid entries give their defaults.
  for (const [key, stored] of [
    [pinnedHeightKey, entry('55')],
    [pinnedHeightKey, entry(Number.NaN)],
    [pinnedFoldedKey, entry('yes')],
    [pinnedFoldedKey, entry(true, 2)],
  ] as const) {
    const layout = readPinnedLayout(memoryStorage({ [key]: stored }));
    assert.equal(layout.pinnedHeight, null, stored);
    assert.equal(layout.pinnedFolded, false, stored);
  }
});

// ---- Which widget is pinned ------------------------------------------------------

const handle = 'A'.repeat(43);
const address = `http://127.0.0.1:8789/f/${handle}/`;

function widgetMessage(
  id: string,
  placement: 'pinned' | 'inline',
  frameUrl: string | null = address,
  heightPercent = 25,
): AgentMessage {
  const message = {
    id,
    kind: 'assistant',
    text: '',
    widget: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'counter',
      revision: 1,
      presentation: { placement, heightPercent, replaceActivity: true },
      ...(frameUrl === null ? {} : { frameUrl }),
    },
  };
  return message as unknown as AgentMessage;
}

function session(fields: Partial<AgentSession>): AgentSession {
  return { id: 'conversation', messages: [], ...fields } as unknown as AgentSession;
}

test('pinned state: one case per row of the README table', () => {
  const pinned = widgetMessage('w', 'pinned', address, 40);
  const shown = { messageId: 'w', name: 'counter', address, heightPercent: 40 };

  const cases: [string, AgentSession | undefined, unknown][] = [
    [
      'none (pinnedMessage null)',
      session({ pinnedMessage: null, messages: [widgetMessage('w', 'inline')] }),
      null,
    ],
    [
      'pinned (here, elsewhere or by an agent)',
      session({ pinnedMessage: pinned, messages: [pinned] }),
      shown,
    ],
    [
      'the pinned message outside the loaded history',
      session({ pinnedMessage: pinned, messages: [] }),
      shown,
    ],
    [
      'unpinned: the listener reports null, the message inline',
      session({ pinnedMessage: null, messages: [widgetMessage('w', 'inline')] }),
      null,
    ],
    [
      'a listener without the field, pinned message loaded',
      session({ messages: [widgetMessage('a', 'inline'), pinned] }),
      shown,
    ],
    [
      'a listener without the field, nothing pinned',
      session({ messages: [widgetMessage('a', 'inline')] }),
      null,
    ],
    [
      'no frame origin (no frameUrl)',
      session({ pinnedMessage: widgetMessage('w', 'pinned', null) }),
      null,
    ],
    [
      'a frame address of another shape',
      session({ pinnedMessage: widgetMessage('w', 'pinned', 'https://elsewhere.example/x') }),
      null,
    ],
    ['no conversation shown', undefined, null],
    [
      'the address ended: the new one after the reconnect',
      session({
        pinnedMessage: widgetMessage('w', 'pinned', address.replace(handle, 'B'.repeat(43))),
      }),
      { ...shown, heightPercent: 25, address: address.replace(handle, 'B'.repeat(43)) },
    ],
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(pinnedWidget(input), expected, name);
  }

  // Its message in the chat ("Pinned", no frame) and the others.
  assert.equal(rowOfMessage('w', 'w@0'), true);
  assert.equal(rowOfMessage('w', 'w@1024'), true, 'a fragment of the message');
  assert.equal(rowOfMessage('w', 'w2@0'), false);
  assert.equal(rowOfMessage('', 'w@0'), false, 'nothing pinned');
});
