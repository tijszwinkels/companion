import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  clickAt,
  desktopPage,
  entryExpression,
  online,
  openConversation,
  pairedPage,
  setup,
  skip,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * The listener's shared unread mark in the browser shell, end to end:
 * headless Chromium against the real gateway, the real listener control
 * socket and a synthetic agent backend, in temporary directories on
 * loopback only (integrations/shell/README.md, "Markers": marker source and
 * visible report). Tabs of one browser context are tabs of one browser
 * window: opening a tab hides the tab that was in front, and
 * `Target.activateTarget` brings one back, so the pages' visibility is the
 * browser's own. The rule tables themselves are played row by row in Node
 * in markers.test.ts.
 */

// ---- Helpers ----------------------------------------------------------------------

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

/** Ask a follow-up in a conversation and wait until its run has started. */
async function followUp(fixture: Fixture, id: string, text: string): Promise<SyntheticRun> {
  const before = fixture.runs.length;
  fixture.sessions.followUp(id, text, signal());
  await waitFor(() => fixture.runs.length > before);
  return fixture.runs.at(-1)!;
}

/** The listener's own mark of a conversation. */
function listenerMark(fixture: Fixture, id: string): boolean | undefined {
  return fixture.sessions.snapshot().find((session) => session.id === id)?.unread;
}

/** A page expression: the list entry whose title contains `title` is marked unread. */
function unread(title: string): string {
  return `${entryExpression(title)}?.classList.contains('unread') === true`;
}

/** The `panel-state` reports a page sent, in order, from index `from` on. */
function reports(sockets: SocketLog, from = 0): { id: unknown; visible: unknown }[] {
  const found: { id: unknown; visible: unknown }[] = [];
  for (const sent of sockets.sent.slice(from)) {
    if (sent.type === 'request' && sent.action === 'panel-state') {
      found.push({ id: sent.id, visible: sent.visible });
    }
  }
  return found;
}

/** Another tab of the browser context `context` on the shell; it comes to the front. */
async function openTab(
  fixture: Fixture,
  browser: TestBrowser,
  browserContextId: string,
  width = 1280,
): Promise<{ page: TestPage; sockets: SocketLog }> {
  const { page, sockets } = await desktopPage(browser, width, 800, browserContextId);
  await page.navigate(`${fixture.origin}/`);
  await page.waitFor(online, 8000);
  return { page, sockets };
}

/** Click the element `selector` with the mouse. */
async function clickSelector(page: TestPage, selector: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
}

async function resize(page: TestPage, width: number): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`document.documentElement.clientWidth === ${width}`);
}

const barToggle = '.chat-bar .activity-toggle';
const columnToggle = '.activity-header .activity-toggle';

// ---- Tests ------------------------------------------------------------------------

test(
  'a turn completed while another conversation is shown stays unread after a reload; showing it in a second tab clears it in both; a hidden tab clears nothing',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const shown = await start(fixture, '🗺️ Shown conversation');
    const other = await start(fixture, '🐛 Other conversation');
    const first = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(first.page, 'Shown conversation');
    await waitFor(() =>
      reports(first.sockets).some((report) => report.id === shown.id && report.visible === true),
    );

    // A turn completes in the conversation that is not shown: the listener
    // marks it, and so does the list.
    answer(other.run, 'b1', 'Other answer.');
    await first.page.waitFor(unread('Other conversation'));
    assert.equal(listenerMark(fixture, other.id), true);

    // A turn in the shown conversation, page visible: not marked.
    answer(shown.run, 'a1', 'Shown answer.');
    await waitFor(() =>
      fixture.sessions.snapshot().some((s) => s.id === shown.id && s.status === 'completed'),
    );
    assert.equal(listenerMark(fixture, shown.id), false);
    assert.equal(await first.page.evaluate(unread('Shown conversation')), false);

    // Reload: still marked (the page's own rule kept nothing across a
    // reload; the listener's mark is saved). The shown conversation is not.
    await first.page.navigate(`${fixture.origin}/`);
    await first.page.waitFor(online, 8000);
    await first.page.waitFor(`Boolean(${entryExpression('Other conversation')})`);
    assert.equal(await first.page.evaluate(unread('Other conversation')), true, 'after reload');
    assert.equal(await first.page.evaluate(unread('Shown conversation')), false);
    await openConversation(first.page, 'Shown conversation');

    // A second tab of the same browser comes to the front: the first one is
    // hidden and reports so.
    const reportsBefore = first.sockets.sent.length;
    const second = await openTab(fixture, browser, first.browserContextId);
    assert.equal(await first.page.evaluate(`document.visibilityState`), 'hidden');
    await waitFor(() =>
      reports(first.sockets, reportsBefore).some(
        (report) => report.id === shown.id && report.visible === false,
      ),
    );

    // A hidden tab does not clear marks: the first tab selects the marked
    // conversation while hidden (as a started conversation is selected by
    // itself); the listener's mark stays.
    const hiddenFrom = first.sockets.sent.length;
    await first.page.evaluate(
      `${entryExpression('Other conversation')}.querySelector('.entry-select').click()`,
    );
    await waitFor(() =>
      reports(first.sockets, hiddenFrom).some(
        (report) => report.id === other.id && report.visible === false,
      ),
    );
    assert.equal(listenerMark(fixture, other.id), true, 'not cleared by a hidden tab');

    // ... and a turn completing in the conversation the hidden tab shows is
    // marked.
    const next = await followUp(fixture, other.id, 'One more question');
    answer(next, 'b2', 'Another answer.');
    await waitFor(() =>
      fixture.sessions.snapshot().some((s) => s.id === other.id && s.status === 'completed'),
    );
    await waitFor(() => listenerMark(fixture, other.id) === true);
    await second.page.waitFor(unread('Other conversation'));

    // The second tab (in front) shows it: the mark goes, in the second tab
    // and in the hidden first tab as well.
    await openConversation(second.page, 'Other conversation');
    await waitFor(() => listenerMark(fixture, other.id) === false);
    await second.page.waitFor(`!(${unread('Other conversation')})`);
    await first.page.waitFor(`!(${unread('Other conversation')})`);

    // The first tab back in front: it reports its selection as visible.
    const shownFrom = first.sockets.sent.length;
    await browser.call('Target.activateTarget', { targetId: first.page.targetId });
    await first.page.waitFor(`document.visibilityState === 'visible'`);
    await waitFor(() =>
      reports(first.sockets, shownFrom).some(
        (report) => report.id === other.id && report.visible === true,
      ),
    );

    await assertNoViolations(first.page);
    await assertNoViolations(second.page);
  },
);

test(
  'the narrow Activity column covers the chat: reported as not visible, an answer behind it stays unread; only crossing the narrow limit reports',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const covered = await start(fixture, '🧾 Covered conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Covered conversation');
    await waitFor(() =>
      reports(sockets).some((report) => report.id === covered.id && report.visible === true),
    );

    // Wide window: the column beside the chat covers nothing; resizing
    // above the narrow limit reports nothing.
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('#activity-column')`);
    const wideFrom = sockets.sent.length;
    for (const width of [1100, 900, 700, 1280]) {
      await resize(page, width);
    }
    assert.deepEqual(reports(sockets, wideFrom), [], 'no report while nothing changes');

    // Narrowed under 640 px: the column lies over the chat.
    await resize(page, 420);
    await waitFor(() => reports(sockets, wideFrom).some((report) => report.visible === false));
    assert.deepEqual(reports(sockets, wideFrom), [{ id: covered.id, visible: false }]);

    // An answer completes behind the column: marked, on the listener and
    // in the list.
    answer(covered.run, 'c1', 'Covered answer.');
    await waitFor(() => listenerMark(fixture, covered.id) === true);
    await page.waitFor(unread('Covered conversation'));

    // The column hidden: shown, reported visible, the mark goes.
    const hideFrom = sockets.sent.length;
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('#activity-column')`);
    await waitFor(() => listenerMark(fixture, covered.id) === false);
    await page.waitFor(`!(${unread('Covered conversation')})`);
    assert.deepEqual(reports(sockets, hideFrom), [{ id: covered.id, visible: true }]);

    // Resizing across the narrow limit with the column hidden: nothing.
    const hiddenColumnFrom = sockets.sent.length;
    await resize(page, 1280);
    await resize(page, 420);
    await resize(page, 1280);
    assert.deepEqual(reports(sockets, hiddenColumnFrom), []);

    await assertNoViolations(page);
  },
);
