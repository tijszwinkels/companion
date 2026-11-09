import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Chromium, type BrowserPage } from '../../src/widgets/chromium.ts';

/**
 * Drag reordering in the trusted HTML session rail, through the page's real
 * pointer path: the built dist/rail.js and rail.css run in an isolated
 * headless Chromium (no network, private CDP pipe), and input arrives as CDP
 * mouse events, which Chromium turns into the pointer and click events the
 * page handles. The native bridge is a stub QWebChannel object that records
 * calls; its own checks are RailOrder.mjs (rail-order.test.ts) and the
 * listener's move-agent revision check. Synthetic conversations only; no
 * real tabs are touched. Requires `npm run session-apps:build`, Chromium and
 * bwrap.
 */

const dist = fileURLToPath(new URL('../../integrations/session-apps/dist/', import.meta.url));

/** A recording stand-in for TrustedRailView's `companion` bridge object. */
const channelStub = `
window.calls = [];
window.qt = { webChannelTransport: {} };
window.QWebChannel = function (transport, ready) {
  const listeners = [];
  const record = (name) => (...args) => { window.calls.push([name, ...args]); };
  const companion = {
    message: { connect(callback) { listeners.push(callback); } },
    ready: record('ready'),
    select: record('select'),
    popOut: record('popOut'),
    returnToPanel: record('returnToPanel'),
    close: record('close'),
    move: record('move'),
  };
  window.pushState = (state) => { for (const listener of listeners) listener(JSON.stringify(state)); };
  setTimeout(() => ready({ objects: { companion } }), 0);
};`;

interface Session {
  id: string;
  number: number;
  title: string;
  selected: boolean;
  running: boolean;
  unread: boolean;
  poppedOut: boolean;
  wakes: number;
}

let sequence = 0;
function railState(count: number, overrides: Record<string, unknown> = {}) {
  const sessions: Session[] = Array.from({ length: count }, (_, index) => ({
    id: `s${index + 1}`,
    number: index + 1,
    title: `Synthetic conversation ${index + 1}`,
    selected: index === 0,
    running: false,
    unread: false,
    poppedOut: false,
    wakes: 0,
  }));
  return {
    seq: ++sequence,
    sessions,
    online: true,
    popoutAvailable: true,
    canMove: true,
    orderRevision: 'rev-1',
    theme: {
      foreground: 'rgba(224,230,240,1)',
      accent: 'rgba(130,170,255,1)',
      muted: 'rgba(149,159,170,1)',
      selection: 'rgba(40,51,72,1)',
      fontFamily: 'sans-serif',
      unit: 1.25,
    },
    ...overrides,
  };
}

async function openRail(browser: Chromium, width: number, height: number): Promise<BrowserPage> {
  const page = await browser.page();
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const css = await readFile(dist + 'rail.css', 'utf8');
  const script = await readFile(dist + 'rail.js', 'utf8');
  // The bundle is inlined: the isolated browser loads nothing from outside.
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>` +
    `<script>${channelStub}</script></head><body><div id="rail"></div>` +
    `<script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  await page.document(html);
  await waitUntil(page, 'window.calls.some((call) => call[0] === "ready")');
  return page;
}

async function push(page: BrowserPage, state: unknown) {
  await page.evaluate(`window.pushState(${JSON.stringify(state)})`);
  await waitUntil(page, 'document.querySelectorAll(".session[data-id]").length > 0');
}

async function waitUntil(page: BrowserPage, expression: string, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await page.evaluate(`Boolean(${expression})`))) {
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${expression}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function center(page: BrowserPage, id: string) {
  return (await page.evaluate(`(() => {
    const box = document.querySelector('.session[data-id="${id}"]').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.top, bottom: box.bottom };
  })()`)) as { x: number; y: number; top: number; bottom: number };
}

async function mouse(
  page: BrowserPage,
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  x: number,
  y: number,
) {
  await page.call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

/** Press on `from`, move in steps to (x, y) without releasing. */
async function dragTo(page: BrowserPage, from: string, x: number, y: number) {
  const start = await center(page, from);
  await mouse(page, 'mousePressed', start.x, start.y);
  const steps = 6;
  for (let step = 1; step <= steps; step++) {
    await mouse(
      page,
      'mouseMoved',
      start.x + ((x - start.x) * step) / steps,
      start.y + ((y - start.y) * step) / steps,
    );
  }
}

async function calls(page: BrowserPage, name: string) {
  return (await page.evaluate(
    `window.calls.filter((call) => call[0] === ${JSON.stringify(name)})`,
  )) as unknown[][];
}

async function resetCalls(page: BrowserPage) {
  await page.evaluate('window.calls = []');
}

async function markerVisible(page: BrowserPage) {
  return (
    (await page.evaluate('document.querySelectorAll("[data-testid=drop-marker]").length')) === 1
  );
}

test('HTML rail: pointer drag reorders through one move with the gesture revision', async (context) => {
  const browser = new Chromium();
  context.after(() => browser.close());
  const page = await openRail(browser, 160, 900);
  await push(page, railState(4));

  // Drag s1 below s3: one move before s4, with the revision from the start.
  const s3 = await center(page, 's3');
  const s4 = await center(page, 's4');
  await dragTo(page, 's1', s3.x, (s3.y + s4.top) / 2 + 4);
  assert.equal(await markerVisible(page), true, 'An insertion line shows the destination');
  assert.equal(
    await page.evaluate(
      'document.querySelector(".session[data-id=s1]").classList.contains("dragged")',
    ),
    true,
  );
  await mouse(page, 'mouseReleased', s3.x, (s3.y + s4.top) / 2 + 4);
  assert.deepEqual(await calls(page, 'move'), [['move', 's1', 's4', 'rev-1']]);
  assert.deepEqual(await calls(page, 'select'), [], 'A completed drag does not also select');
  assert.equal(await markerVisible(page), false);

  // To the end.
  await resetCalls(page);
  await dragTo(page, 's2', s4.x, s4.bottom + 20);
  await mouse(page, 'mouseReleased', s4.x, s4.bottom + 20);
  assert.deepEqual(await calls(page, 'move'), [['move', 's2', '', 'rev-1']]);

  // A short press is an ordinary click: select, no move.
  await resetCalls(page);
  const s2 = await center(page, 's2');
  await mouse(page, 'mousePressed', s2.x, s2.y);
  await mouse(page, 'mouseMoved', s2.x + 2, s2.y + 2);
  await mouse(page, 'mouseReleased', s2.x + 2, s2.y + 2);
  assert.deepEqual(await calls(page, 'select'), [['select', 's2']]);
  assert.deepEqual(await calls(page, 'move'), []);

  // A drag back onto its own place is a no-op: nothing at all.
  await resetCalls(page);
  await dragTo(page, 's2', s2.x, s2.y + 12);
  assert.equal(await markerVisible(page), false, 'No line for a no-op position');
  await mouse(page, 'mouseReleased', s2.x, s2.y + 12);
  assert.deepEqual(await page.evaluate('window.calls'), []);

  // The hover buttons keep their own click and never start a drag.
  await resetCalls(page);
  await page.evaluate(
    'document.querySelector(".session[data-id=s3] .actions").style.display = "flex"',
  );
  const close = (await page.evaluate(`(() => {
    const box = document.querySelector('.session[data-id="s3"] .close').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`)) as { x: number; y: number };
  await mouse(page, 'mousePressed', close.x, close.y);
  await mouse(page, 'mouseMoved', close.x, close.y + 40);
  await mouse(page, 'mouseReleased', close.x, close.y + 40);
  assert.deepEqual(await calls(page, 'move'), []);
});

test('HTML rail: Escape, release outside, stale order, membership change and disconnect cancel', async (context) => {
  const browser = new Chromium();
  context.after(() => browser.close());
  const page = await openRail(browser, 160, 900);
  await push(page, railState(4));
  const s3 = await center(page, 's3');
  const s4 = await center(page, 's4');
  const target = { x: s3.x, y: (s3.y + s4.top) / 2 + 4 };

  // Escape.
  await dragTo(page, 's1', target.x, target.y);
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  assert.equal(await markerVisible(page), false);
  await mouse(page, 'mouseReleased', target.x, target.y);
  assert.deepEqual(await page.evaluate('window.calls.filter((call) => call[0] !== "ready")'), []);

  // Release outside the list.
  await dragTo(page, 's1', 400, target.y);
  await mouse(page, 'mouseReleased', 400, target.y);
  assert.deepEqual(await calls(page, 'move'), []);

  // The order revision changes during the drag (another client moved one).
  await dragTo(page, 's1', target.x, target.y);
  await push(page, railState(4, { orderRevision: 'rev-2' }));
  await waitUntil(page, '!document.querySelector("[data-testid=drop-marker]")');
  await mouse(page, 'mouseReleased', target.x, target.y);
  assert.deepEqual(await calls(page, 'move'), [], 'A stale gesture never moves');

  // Membership changes during the drag (a conversation closed elsewhere).
  const fewer = railState(4, { orderRevision: 'rev-2' });
  fewer.sessions = fewer.sessions.slice(0, 3);
  await dragTo(page, 's1', target.x, target.y - 30);
  await push(page, fewer);
  await mouse(page, 'mouseReleased', target.x, target.y - 30);
  assert.deepEqual(await calls(page, 'move'), []);

  // Disconnect during the drag, then controls unavailable: no drag starts.
  await push(page, railState(4, { orderRevision: 'rev-3' }));
  await dragTo(page, 's1', target.x, target.y);
  await push(page, railState(4, { orderRevision: 'rev-3', online: false }));
  await mouse(page, 'mouseReleased', target.x, target.y);
  await push(page, railState(4, { orderRevision: 'rev-3', canMove: false }));
  await dragTo(page, 's1', target.x, target.y);
  assert.equal(await markerVisible(page), false, 'No drag while reordering is unavailable');
  await mouse(page, 'mouseReleased', target.x, target.y);
  assert.deepEqual(await calls(page, 'move'), []);
});

test('HTML rail: a long list scrolls while dragging near its edge; narrow and zoomed layout', async (context) => {
  const browser = new Chromium();
  context.after(() => browser.close());
  const page = await openRail(browser, 110, 320);
  await push(page, railState(16, { theme: { ...railState(1).theme, unit: 1.6 } }));
  assert.ok(
    ((await page.evaluate('document.scrollingElement.scrollHeight')) as number) > 320,
    'The synthetic list is longer than the view',
  );

  // Hold the pointer near the bottom edge: the list scrolls, the line follows.
  const first = await center(page, 's1');
  await dragTo(page, 's1', first.x, 312);
  const before = (await page.evaluate('window.scrollY')) as number;
  await new Promise((resolve) => setTimeout(resolve, 600));
  await mouse(page, 'mouseMoved', first.x, 313);
  const after = (await page.evaluate('window.scrollY')) as number;
  assert.ok(after > before + 40, `The list scrolled while dragging (${before} → ${after})`);
  assert.equal(await markerVisible(page), true);
  await mouse(page, 'mouseReleased', first.x, 313);
  const moves = await calls(page, 'move');
  assert.equal(moves.length, 1);
  const beforeId = String(moves[0][2]);
  assert.ok(
    beforeId === '' || Number(beforeId.slice(1)) > 4,
    `The drop lands beyond the first screen (${beforeId})`,
  );
  assert.deepEqual(await calls(page, 'select'), []);
  // The rows stay within the narrow, zoomed view (no horizontal overflow).
  assert.ok(
    ((await page.evaluate('document.scrollingElement.scrollWidth')) as number) <= 111,
    'No horizontal overflow at 110 px and 160 %',
  );
});

// ---- Regressions for review R2 (d2e679d), from the reviewer's probes.

test('R2-F5: a press released in the blank page below the list leaves no hover drag', async (context) => {
  const browser = new Chromium();
  context.after(() => browser.close());
  const page = await openRail(browser, 160, 900);
  await push(page, railState(4));
  const s4 = await center(page, 's4');
  const s3 = await center(page, 's3');

  // Press at the bottom of the last row, move into the blank page, release there.
  await mouse(page, 'mousePressed', s4.x, s4.bottom - 2);
  await mouse(page, 'mouseMoved', s4.x, s4.bottom + 50);
  await mouse(page, 'mouseReleased', s4.x, s4.bottom + 50);
  // Hover back with no button held: not a drag.
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s3.x, y: s3.y, buttons: 0 });
  assert.equal(
    await page.evaluate('document.querySelector(".rail").classList.contains("dragging")'),
    false,
  );

  // A later Close click is just a Close.
  await page.evaluate(
    'document.querySelector(".session[data-id=s2] .actions").style.display = "flex"',
  );
  const close = (await page.evaluate(`(() => {
    const box = document.querySelector('.session[data-id="s2"] .close').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`)) as { x: number; y: number };
  await mouse(page, 'mousePressed', close.x, close.y);
  await mouse(page, 'mouseReleased', close.x, close.y);
  assert.deepEqual(await calls(page, 'move'), [], 'An abandoned press never reorders');
  assert.deepEqual(await calls(page, 'close'), [['close', 's2']], 'The Close click still works');

  // A move without the button held (a missed release) never activates a drag.
  await resetCalls(page);
  const s1 = await center(page, 's1');
  await mouse(page, 'mousePressed', s1.x, s1.y);
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s1.x, y: s3.y, buttons: 0 });
  assert.equal(await markerVisible(page), false);
  await mouse(page, 'mouseReleased', s1.x, s3.y);
  assert.deepEqual(await calls(page, 'move'), []);
});

test('R2-F6: a drag cancelled by lost capture or Escape never selects; the next click does', async (context) => {
  const browser = new Chromium();
  context.after(() => browser.close());
  const page = await openRail(browser, 160, 900);
  await push(page, railState(4));
  const s2 = await center(page, 's2');

  // Lost capture during a drag within the starting row, then release over it.
  await dragTo(page, 's2', s2.x, s2.y + 12);
  assert.equal(
    await page.evaluate('document.querySelector(".rail").classList.contains("dragging")'),
    true,
  );
  await page.evaluate('document.querySelector(".rail").releasePointerCapture(1)');
  await page.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: s2.x,
    y: s2.y + 13,
    button: 'left',
    buttons: 1,
  });
  await mouse(page, 'mouseReleased', s2.x, s2.y + 13);
  assert.deepEqual(await calls(page, 'select'), [], 'Lost capture never becomes a row click');
  assert.deepEqual(await calls(page, 'move'), []);

  // Escape, then release over another row: no selection either.
  const s3 = await center(page, 's3');
  await dragTo(page, 's1', s3.x, s3.y);
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await mouse(page, 'mouseReleased', s3.x, s3.y);
  assert.deepEqual(await calls(page, 'select'), []);
  assert.deepEqual(await calls(page, 'move'), []);

  // The next genuine click is not consumed.
  await mouse(page, 'mousePressed', s3.x, s3.y);
  await mouse(page, 'mouseReleased', s3.x, s3.y);
  assert.deepEqual(await calls(page, 'select'), [['select', 's3']]);
});
