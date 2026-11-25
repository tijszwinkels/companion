import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import {
  appearanceOf,
  shownListWidth,
  type ListStyle,
} from '../../integrations/shell/src/layout/list-width.ts';
import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  click,
  desktopPage,
  entryExpression,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  setup,
  skip,
  type Fixture,
} from './page.ts';

/**
 * The conversation list's style, its second line and its title sizes in
 * headless Chromium against the real gateway and listener
 * (integrations/shell/README.md, "List style" and "Look"). The width rules'
 * full tables run in Node (layout.test.ts) and the stored entries' in
 * times.test.ts; this file checks what is drawn: every style with the
 * second line on and off at 420, 900, 1280 and 1600 px without overflow,
 * the markers kept, the settings screen's choices, the divider in Compact,
 * ☰, a second tab, a reload and a storage that refuses writes.
 */

const styleKey = 'companion.shell.display.listStyle';
const subtitlesKey = 'companion.shell.display.listSubtitles';
const widthKey = 'companion.shell.layout.listWidth';

/** Start a conversation whose title is `title`; its run stays open until finished. */
async function start(fixture: Fixture, title: string): Promise<{ id: string; run: SyntheticRun }> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) => candidate.request.prompt.text.includes(title));
  assert.ok(run, `no run for ${title}`);
  return { id, run };
}

/** Finish a run with an answer. */
function answer(run: SyntheticRun, messageId: string, reply: string): void {
  run.emit({ ...chatMessage(messageId, 'assistant', reply), state: 'done' });
  run.finish();
}

async function resize(page: TestPage, width: number, height = 800): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`document.documentElement.clientWidth === ${width}`);
}

/** Write layout or display entries in this page's storage (`undefined` removes one). */
async function remember(page: TestPage, entries: Record<string, unknown>): Promise<void> {
  const statements = Object.entries(entries).map(([key, value]) => {
    if (value === undefined) {
      return `localStorage.removeItem(${JSON.stringify(key)});`;
    }
    const text = JSON.stringify({ version: 1, value });
    return `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(text)});`;
  });
  await page.evaluate(statements.join('\n'));
}

/** Reload and wait until the list shows its conversations again. */
async function reload(page: TestPage, origin: string, count: number): Promise<void> {
  await page.navigate(`${origin}/`);
  await page.waitFor(online, 8000);
  await page.waitFor(`document.querySelectorAll('.conversation-entry').length === ${count}`);
}

/** A stored value, or null when the entry is missing. */
function stored(page: TestPage, key: string): Promise<unknown> {
  return page.evaluate(
    `(() => { const text = localStorage.getItem(${JSON.stringify(key)}); return text === null ? null : JSON.parse(text).value; })()`,
  );
}

/** What the list draws now: its appearance class and width. */
const listDrawn = `(() => {
  const list = document.querySelector('.conversations');
  if (!list) return null;
  return {
    look: list.classList.contains('strip') ? 'strip' : list.classList.contains('full') ? 'full' : '',
    width: Math.round(list.getBoundingClientRect().width),
  };
})()`;

/** Font size in pixels of the first element matching `selector`. */
function fontSize(page: TestPage, selector: string): Promise<number> {
  return page.evaluate<number>(
    `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize)`,
  );
}

test(
  'every list style, with the second line on and off, fits at 420, 900, 1280 and 1600 px; markers stay',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    // Three conversations: one with a long title that has answered (and
    // is unread once another is shown), one working, one plain.
    const long = await start(
      fixture,
      'A rather long conversation title that will not fit on any single line of the list',
    );
    const working = await start(fixture, 'Working conversation');
    const plain = await start(fixture, 'Plain conversation');
    answer(plain.run, 'p1', 'Plain answer.');
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Plain conversation');
    answer(
      long.run,
      'l1',
      'A long answer that also makes the last line long enough to be cut off.',
    );
    await page.waitFor(`${entryExpression('A rather long')}?.classList.contains('unread')`);
    await page.waitFor(
      `Boolean(${entryExpression('Working conversation')}?.querySelector('.entry-working'))`,
    );
    void working;

    for (const style of ['by-width', 'compact', 'full'] as ListStyle[]) {
      for (const subtitles of [true, false]) {
        await resize(page, 1280);
        await remember(page, { [styleKey]: style, [subtitlesKey]: subtitles, [widthKey]: 200 });
        await reload(page, fixture.origin, 3);
        for (const width of [420, 900, 1280, 1600]) {
          const name = `${style}, second line ${subtitles ? 'on' : 'off'}, ${width} px`;
          await resize(page, width);
          const expectedWidth = shownListWidth(200, width, style);
          const expected = { look: appearanceOf(expectedWidth, style), width: expectedWidth };
          await page.waitFor(
            `JSON.stringify(${listDrawn}) === ${JSON.stringify(JSON.stringify(expected))}`,
          );
          assert.equal(await horizontalOverflow(page), 0, name);

          // Nothing in an entry reaches past the list or overflows the entry.
          const overflowing = await page.evaluate<string[]>(`(() => {
            const list = document.querySelector('.conversations').getBoundingClientRect();
            const found = [];
            for (const entry of document.querySelectorAll('.conversation-entry, .previous-entry, .activity-list-entry')) {
              const box = entry.getBoundingClientRect();
              if (box.left < list.left - 0.5 || box.right > list.right + 0.5 || entry.scrollWidth > entry.clientWidth + 1) {
                found.push(entry.textContent.slice(0, 30));
              }
            }
            return found;
          })()`);
          assert.deepEqual(overflowing, [], name);

          // The markers stay visible: the unread dot and the working ring.
          const markers = await page.evaluate<{ unread: number; working: number }>(`(() => {
            const size = (element) => element ? element.getBoundingClientRect().width : 0;
            return {
              unread: size(${entryExpression('A rather long')}.querySelector('.entry-unread')),
              working: size(${entryExpression('Working conversation')}.querySelector('.entry-working')),
            };
          })()`);
          assert.ok(
            markers.unread > 0 && markers.working > 0,
            `${name}: ${JSON.stringify(markers)}`,
          );

          // The second line: drawn only in the full list with the switch on;
          // Activity keeps its own line in the full list either way.
          const lines = await page.evaluate<{ conversation: string; activity: string }>(`({
            conversation: getComputedStyle(${entryExpression('A rather long')}.querySelector('.entry-last-line')).display,
            activity: getComputedStyle(document.querySelector('.activity-list-entry .entry-last-line')).display,
          })`);
          const full = expected.look === 'full';
          assert.equal(lines.conversation !== 'none', full && subtitles, `${name}: conversation`);
          assert.equal(lines.activity !== 'none', full, `${name}: activity`);
        }
      }
    }

    // Title sizes (README "Look"): conversations 11.25 px in the strip and
    // 14 px in the full list; Activity keeps 9 px and 13 px.
    await resize(page, 1280);
    await remember(page, { [styleKey]: 'compact', [subtitlesKey]: undefined });
    await reload(page, fixture.origin, 3);
    assert.equal(await fontSize(page, '.conversation-entry .entry-title'), 11.25);
    assert.equal(await fontSize(page, '.activity-list-entry .entry-title'), 9);
    await remember(page, { [styleKey]: 'full' });
    await reload(page, fixture.origin, 3);
    assert.equal(await fontSize(page, '.conversation-entry .entry-title'), 14);
    assert.equal(await fontSize(page, '.activity-list-entry .entry-title'), 13);
    assert.equal(await fontSize(page, '.conversation-entry .entry-last-line'), 11.5);
  },
);

/** One mouse event with the left button. */
async function mouse(
  page: TestPage,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  held: boolean,
): Promise<void> {
  await page.call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !held ? 'none' : 'left',
    buttons: held ? 1 : 0,
    clickCount: 1,
  });
}

/** Drag the list's divider to `x` and release it there. */
async function dragDivider(page: TestPage, x: number): Promise<void> {
  const handle = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('.list-divider').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouse(page, 'mouseMoved', handle.x, handle.y, false);
  await mouse(page, 'mousePressed', handle.x, handle.y, true);
  const steps = 6;
  for (let step = 1; step <= steps; step++) {
    await mouse(page, 'mouseMoved', handle.x + ((x - handle.x) * step) / steps, handle.y, true);
  }
  await mouse(page, 'mouseReleased', x, handle.y, false);
}

/** Choose a list style on the settings screen, by its label. */
async function chooseStyle(page: TestPage, label: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const option = [...document.querySelectorAll('.setting-option')].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
    option.scrollIntoView({ block: 'nearest' });
    const rect = option.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouse(page, 'mouseMoved', point.x, point.y, false);
  await mouse(page, 'mousePressed', point.x, point.y, true);
  await mouse(page, 'mouseReleased', point.x, point.y, false);
}

test(
  'Settings → Display: the list style and the second line apply at once, follow in a second tab, survive a reload',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await start(fixture, 'First conversation');
    answer(first.run, 'f1', 'First answer.');
    const second = await start(fixture, 'Second conversation');
    answer(second.run, 's1', 'Second answer.');
    const { page, browserContextId } = await pairedPage(fixture, browser, 1280, 800);
    await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`);

    // Nothing remembered: By width, the strip; the radio says so.
    assert.deepEqual(await page.evaluate(listDrawn), { look: 'strip', width: 78 });
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.settings-screen')`);
    assert.equal(
      await page.evaluate(`document.querySelector('input[name="list-style"]:checked').value`),
      'by-width',
    );

    // A second tab of the same browser.
    const other = (await desktopPage(browser, 1280, 800, browserContextId)).page;
    await other.navigate(`${fixture.origin}/`);
    await other.waitFor(online, 8000);
    await other.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`);

    // The first tab in front again (a background tab gets no input events).
    await page.call('Page.bringToFront');

    // Compact: the strip; dragged to 200 px it stays the strip, 200 px wide.
    await chooseStyle(page, 'Compact');
    await page.waitFor(
      `document.querySelector('input[name="list-style"]:checked').value === 'compact'`,
    );
    assert.equal(await stored(page, styleKey), 'compact');
    await dragDivider(page, 200);
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"strip","width":200}'`);
    assert.equal(await stored(page, widthKey), 200);
    // The other tab follows the style and the width.
    await other.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"strip","width":200}'`);

    // ☰ hides and shows it at its width, in its style.
    await click(page, '.list-toggle');
    await page.waitFor(`!document.querySelector('.conversations')`);
    await click(page, '.list-toggle');
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"strip","width":200}'`);

    // Full: the same remembered width as the full list.
    await chooseStyle(page, 'Full');
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"full","width":200}'`);
    await other.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"full","width":200}'`);
    assert.equal(await stored(page, widthKey), 200);
    // Dragged left of the strip, it stays the full list at 150 px.
    await dragDivider(page, 60);
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"full","width":150}'`);

    // The second line off: titles only in both tabs.
    const lastLineShown = `getComputedStyle(${entryExpression('First conversation')}.querySelector('.entry-last-line')).display !== 'none'`;
    assert.equal(await page.evaluate(lastLineShown), true);
    await click(page, '#setting-listSubtitles-title');
    await page.waitFor(`!(${lastLineShown})`);
    assert.equal(await stored(page, subtitlesKey), false);
    await other.waitFor(`!(${lastLineShown})`);

    // Reload: as remembered.
    await reload(page, fixture.origin, 2);
    assert.deepEqual(await page.evaluate(listDrawn), { look: 'full', width: 150 });
    assert.equal(await page.evaluate(lastLineShown), false);

    // By width again: the remembered 150 px is the full list; the strip
    // only left of the snap point.
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.settings-screen')`);
    await chooseStyle(page, 'By width');
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"full","width":150}'`);
    await dragDivider(page, 100);
    await page.waitFor(`JSON.stringify(${listDrawn}) === '{"look":"strip","width":78}'`);

    // A storage that refuses writes: the choice holds for this page only.
    await page.evaluate(
      `Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }`,
    );
    await chooseStyle(page, 'Compact');
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    await page.waitFor(
      `document.querySelector('input[name="list-style"]:checked').value === 'compact'`,
    );
    assert.equal(await stored(page, styleKey), 'by-width');
    assert.equal(await horizontalOverflow(page), 0);
    await other.close();
  },
);
