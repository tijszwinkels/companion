import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chromiumPath, TestBrowser } from '../mobile/browser.ts';
import { drawRows, drawRowsWithTimes, referenceRows } from './chat-rows-page.ts';

/**
 * The shared chat page's one change for message times (`ChatRow.time`,
 * integrations/shell/README.md, "Changes to the shared chat page"):
 *
 * - without the field the page draws exactly what it drew before the change:
 *   every kind of row and heading, drawn by the current Chat.tsx, equals
 *   fixtures/chat-rows-reference.txt, drawn by the base revision's Chat.tsx
 *   (see chat-rows-page.ts). The Qt host never sends the field, so its
 *   output is unchanged;
 * - with it, each "You" and "Pi" heading (user, assistant, notice and widget
 *   rows) ends with one `.message-time` holding the text, and nothing else
 *   changes; tool groups, which have no such heading, show none.
 */

const chatDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'session-apps', 'chat');
const referencePath = join(import.meta.dirname, 'fixtures', 'chat-rows-reference.txt');

let skip: string | undefined;
try {
  await access(chromiumPath);
} catch {
  skip = 'Chromium not installed';
}

/** The output without the time elements the field adds. */
function withoutTimes(html: string): string {
  return html.replace(/<span class="message-time">[^<]*<\/span>/g, '');
}

test(
  'the chat page draws every row exactly as before when rows carry no time',
  { skip },
  async (context) => {
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    const reference = await readFile(referencePath, 'utf8');
    const drawn = await drawRows(browser, chatDirectory, referenceRows);
    assert.equal(drawn, reference);

    // An empty time is no time.
    const emptyTimes = referenceRows.map((row) => ({ ...row, time: '' }));
    assert.equal(await drawRows(browser, chatDirectory, emptyTimes), reference);
  },
);

test(
  'with a time, each “You” and “Pi” heading ends with it and nothing else changes',
  { skip },
  async (context) => {
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    const reference = await readFile(referencePath, 'utf8');
    const timed = referenceRows.map((row, index) => ({
      ...row,
      time: `Yesterday 16:${String(10 + index).padStart(2, '0')}`,
    }));
    const { html: drawn, times: places } = await drawRowsWithTimes(browser, chatDirectory, timed);

    assert.equal(withoutTimes(drawn), reference);

    // In the DOM: each time is the last element of its row's own heading.
    assert.deepEqual(
      places,
      timed.map((row) => (row.kind === 'tool' ? 'none' : 'heading')),
    );

    // One row element per line; a row's own HTML can contain line breaks
    // (rendered Markdown), so lines are split where a row element starts.
    const lines = drawn.trimEnd().split(/\n(?=<div class="message )/);
    assert.equal(lines.length, timed.length);
    for (let index = 0; index < timed.length; index++) {
      const row = timed[index];
      const line = lines[index];
      const times = line.match(/<span class="message-time">([^<]*)<\/span>/g) ?? [];
      if (row.kind === 'tool') {
        assert.equal(times.length, 0, `tool row ${row.key} has no time`);
        continue;
      }
      assert.equal(times.length, 1, `row ${row.key} has one time`);
      // The time is the heading's last child, after the sender and notes.
      const expected = `<span class="message-time">${row.time}</span></div>`;
      assert.ok(line.includes(expected), `row ${row.key}: ${line.slice(0, 300)}`);
    }
  },
);
