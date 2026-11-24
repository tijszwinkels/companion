/**
 * Session applications in the browser shell, in headless Chromium, against
 * the frame fixture (test/frame-fixture.ts): a real gateway with a frame
 * origin on a second loopback port, a real listener and widget service, and
 * synthetic bundles whose reducers run in Node, among them the `chat-probe`
 * application (./application-page.ts). See integrations/shell/README.md,
 * "Session applications".
 *
 * Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  applicationAddress,
  applicationPanel,
  applicationSetup,
  applyApplication,
  conversation,
  desktopChange,
  drawn,
  dropConnections,
  holdApplicationQueue,
  listenerApplication,
  setSize,
  type ApplicationFixture,
} from './application-page.ts';
import {
  assertNoViolations,
  click,
  clickAt,
  desktopPage,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  requestActions,
  skip,
  type SocketLog,
} from './page.ts';
import { attachFrames, evaluateInFrame, waitInFrame } from './widget-page.ts';

type Json = Record<string, any>;

/** No request left the gateway's origin and the frame origin. */
function assertTwoOrigins(fixture: ApplicationFixture, page: TestPage): void {
  for (const url of page.requests) {
    if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('about:')) {
      continue;
    }
    assert.ok(
      url.startsWith(fixture.origin + '/') || url.startsWith(fixture.frameOrigin + '/'),
      `request to another origin: ${url}`,
    );
  }
}

/**
 * The conversations the listener's remote connections show on a visible
 * page (read from the runtime, as test/app-consent-fixture.ts does), to
 * know when the page's visible report has reached the listener.
 */
function remoteVisibleSelections(fixture: ApplicationFixture): string[] {
  const runtime = fixture.desktop.runtime as unknown as {
    remoteClients: Map<number, { visibleSelection: string }>;
  };
  return [...runtime.remoteClients.values()].map((remote) => remote.visibleSelection);
}

/** Press the button whose text is `label` inside `scope` (a page expression). */
async function press(page: TestPage, label: string, scope = 'document'): Promise<void> {
  const button = `[...(${scope}?.querySelectorAll('button') ?? [])].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
  await page.waitFor(
    `${button} && ${button}.getAttribute('aria-disabled') !== 'true' && !${button}.disabled`,
    10_000,
  );
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = ${button}.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
}

const bar = `document.querySelector('.application-bar')`;
const applicationIframeExpression = `document.querySelector('#application-pane iframe')`;
const rowsElement = `document.querySelector('#application-permissions')`;

/**
 * A conversation with an answer and the probe application, in a fresh
 * paired page at `width` × `height`, showing it.
 */
async function applicationConversation(
  context: { after(callback: () => Promise<void>): void },
  options: { width: number; height?: number; title?: string; bundle?: string },
): Promise<{
  fixture: ApplicationFixture;
  browser: TestBrowser;
  page: TestPage;
  browserContextId: string;
  sockets: SocketLog;
  id: string;
  run: SyntheticRun;
  title: string;
}> {
  const { fixture, browser } = await applicationSetup(context);
  const title = options.title ?? 'Application fixture';
  const { id, run } = await conversation(fixture, title);
  run.emit(chatMessage('answer', 'assistant', 'Here is your note list.'));
  await applyApplication(run, options.bundle ?? 'chat-probe');
  run.finish();

  const { page, browserContextId, sockets } = await pairedPage(
    fixture,
    browser,
    options.width,
    options.height ?? 800,
  );
  await attachFrames(browser, page);
  await openConversation(page, title);
  return { fixture, browser, page, browserContextId, sockets, id, run, title };
}

/** Wait until the application's frame is shown (its first `geometry`). */
async function applicationShown(page: TestPage): Promise<void> {
  await page.waitFor(`${applicationPanel}?.dataset.phase === 'shown'`, 15_000);
}

test(
  'a wide window shows the application at the left and the chat at the right; narrower ones the Chat | application switch',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page } = await applicationConversation(context, { width: 1280 });

    // 1280 px: split, the chat 420 px wide at the right, the bar above both.
    await page.waitFor(`${drawn}.layout === 'split'`);
    await applicationShown(page);
    const split = await page.evaluate<Json>(`(() => {
      const pane = document.querySelector('#application-pane').getBoundingClientRect();
      const chat = document.querySelector('#application-chat').getBoundingClientRect();
      const bar = document.querySelector('.application-bar').getBoundingClientRect();
      return { paneLeft: pane.left, paneRight: pane.right, chatLeft: chat.left, chatRight: chat.right,
        chatWidth: chat.width, barLeft: bar.left, barRight: bar.right, barBottom: bar.bottom, paneTop: pane.top };
    })()`);
    assert.equal(split.chatWidth, 420);
    assert.equal(split.chatRight, 1280);
    assert.ok(split.paneRight <= split.chatLeft, JSON.stringify(split));
    assert.ok(split.barLeft <= split.paneLeft && split.barRight === 1280, JSON.stringify(split));
    assert.ok(split.paneTop >= split.barBottom, JSON.stringify(split));
    assert.equal(await horizontalOverflow(page), 0);
    // The bar: the name and version, the permission status, App only and Permissions….
    const barText = await page.evaluate<string>(`${bar}.textContent`);
    assert.match(barText, /chat-probe · v1/);
    assert.match(barText, /Chat reading off · sending off/);
    assert.match(barText, /▣ App only/);
    assert.match(barText, /Permissions…/);

    // 1600 px: still split, the chat still 420 px.
    await setSize(page, 1600, 900);
    await page.waitFor(`${drawn}.layout === 'split'`);
    assert.equal(
      await page.evaluate(
        `document.querySelector('#application-chat').getBoundingClientRect().width`,
      ),
      420,
    );
    assert.equal(await horizontalOverflow(page), 0);

    // 900 px: the switch, showing the application; the same frame (it was
    // not loaded again), no ◫ (no room for the chat at the right).
    const address = await applicationAddress(page);
    await page.evaluate(
      `window.__frameBefore = ${"document.querySelector('#application-pane iframe')"}`,
    );
    await setSize(page, 900, 800);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    assert.deepEqual(await page.evaluate(drawn), { layout: 'switch', app: true, chat: false });
    assert.equal(
      await page.evaluate(
        `window.__frameBefore === document.querySelector('#application-pane iframe')`,
      ),
      true,
    );
    assert.equal(await applicationAddress(page), address);
    assert.doesNotMatch(await page.evaluate<string>(`${bar}.textContent`), /Chat at the right/);
    assert.equal(await horizontalOverflow(page), 0);

    // Chat, then the application again, with the switch.
    await press(page, 'Chat', bar);
    await page.waitFor(`${drawn}.chat && !${drawn}.app`);
    await press(page, 'chat-probe · v1', bar);
    await page.waitFor(`${drawn}.app && !${drawn}.chat`);

    // 420 px: the switch too; nothing overflows.
    await setSize(page, 420, 800);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    assert.equal(await horizontalOverflow(page), 0);

    // Wide again: the chat at the right returns (the choice was split).
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'split'`);

    // The settings screen lies over all of it: nothing of the conversation,
    // the divider included, is drawn over it.
    await click(page, '.chat-bar .settings-toggle');
    await page.waitFor(`Boolean(document.querySelector('.settings-layer'))`);
    // (A pixel at the divider's line, low on the empty settings page, has
    // the colour of the pixel 20 px beside it.)
    const line = await page.evaluate<number>(
      `document.querySelector('.application-divider').getBoundingClientRect().left + 3`,
    );
    async function pixel(x: number): Promise<string> {
      const { data } = await page.call('Page.captureScreenshot', {
        format: 'png',
        clip: { x, y: 780, width: 1, height: 1, scale: 1 },
      });
      return String(data);
    }
    assert.equal(await pixel(line), await pixel(line + 20));
    await click(page, '.chat-bar .settings-toggle');

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

/** Drag the chat's divider with the mouse to `x` (pressed, moved in steps, released). */
async function dragDivider(page: TestPage, x: number): Promise<void> {
  const start = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('.application-divider').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const base = { button: 'left', clickCount: 1 };
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
  await page.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    ...base,
  });
  for (const step of [0.25, 0.5, 0.75, 1]) {
    const next = start.x + (x - start.x) * step;
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: next,
      y: start.y,
      button: 'left',
      buttons: 1,
    });
  }
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: start.y, ...base });
}

/** The remembered value of a layout entry in this page's storage, or null. */
function remembered(page: TestPage, key: string): Promise<unknown> {
  return page.evaluate(`(() => {
    const text = localStorage.getItem('companion.shell.layout.${key}');
    return text === null ? null : JSON.parse(text).value;
  })()`);
}

const chatWidth = `document.querySelector('#application-chat').getBoundingClientRect().width`;

test(
  'App only and the chat at the right are remembered; the divider by pointer and keys; two tabs; Activity and the full list',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser, page, browserContextId, title } = await applicationConversation(
      context,
      { width: 1280 },
    );
    await page.waitFor(`${drawn}.layout === 'split'`);
    await applicationShown(page);

    // The divider: a press without moving changes and writes nothing.
    const divider = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.application-divider').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await clickAt(page, divider);
    assert.equal(await page.evaluate(chatWidth), 420);
    assert.equal(await remembered(page, 'applicationChatWidth'), null);

    // Dragged to 500 px from the right edge: 500, remembered on release.
    await dragDivider(page, 1280 - 500);
    await page.waitFor(`${chatWidth} === 500`);
    assert.equal(await remembered(page, 'applicationChatWidth'), 500);
    // Beyond its bounds: 640 at most; 320 at least.
    await dragDivider(page, 1280 - 900);
    await page.waitFor(`${chatWidth} === 640`);
    await dragDivider(page, 1280 - 100);
    await page.waitFor(`${chatWidth} === 320`);
    assert.equal(await remembered(page, 'applicationChatWidth'), 320);

    // Keys on the focused divider: Left +20, Right -20, End 640, Home 320.
    await page.evaluate(`document.querySelector('.application-divider').focus()`);
    for (const [key, expected] of [
      ['ArrowLeft', 340],
      ['ArrowRight', 320],
      ['End', 640],
      ['Home', 320],
      ['ArrowLeft', 340],
    ] as const) {
      await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      await page.waitFor(`${chatWidth} === ${expected}`);
      assert.equal(await remembered(page, 'applicationChatWidth'), expected, key);
    }

    // App only: the switch, remembered; after a reload still App only, with ◫.
    await press(page, '▣ App only', bar);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    assert.equal(await remembered(page, 'applicationLayout'), 'app-only');
    await page.navigate(`${fixture.origin}/`);
    await openConversation(page, title);
    await page.waitFor(`${drawn}.layout === 'switch' && ${drawn}.app`);
    assert.match(await page.evaluate<string>(`${bar}.textContent`), /◫ Chat at the right/);
    // Back: the chat at the right, at its remembered width, after a reload too.
    await press(page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await page.navigate(`${fixture.origin}/`);
    await openConversation(page, title);
    await page.waitFor(`${drawn}.layout === 'split' && ${chatWidth} === 340`);

    // A second tab of the same browser follows each choice the other writes.
    const second = await desktopPage(browser, 1280, 800, browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);
    await openConversation(second.page, title);
    await second.page.waitFor(`${drawn}.layout === 'split'`);
    // The second tab's reader types; the first chooses App only: the
    // second follows, but shows its chat and keeps the text box focused.
    await click(second.page, '#application-chat textarea');
    await second.page.waitFor(composerFocused);
    await press(page, '▣ App only', bar);
    await second.page.waitFor(`${drawn}.layout === 'switch'`);
    assert.deepEqual(await second.page.evaluate(drawn), {
      layout: 'switch',
      app: false,
      chat: true,
    });
    assert.equal(await second.page.evaluate(composerFocused), true);
    await press(page, '◫ Chat at the right', bar);
    await second.page.waitFor(`${drawn}.layout === 'split'`);
    await press(page, '▣ App only', bar);
    await second.page.waitFor(`${drawn}.layout === 'switch'`);
    await press(second.page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await second.page.close();

    // The switch last showed the chat here: ▣ App only shows the application.
    await press(page, '▣ App only', bar);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    await press(page, 'Chat', bar);
    await page.waitFor(`${drawn}.chat && !${drawn}.app`);
    await press(page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await press(page, '▣ App only', bar);
    await page.waitFor(`${drawn}.layout === 'switch' && ${drawn}.app && !${drawn}.chat`);
    await press(page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);

    // Activity beside the chat at 1280 px: one more column; the area
    // narrows (1280 - 79 - 321 = 880), the chat keeps its width.
    await click(page, '.chat-bar .activity-toggle');
    await page.waitFor(`Boolean(document.querySelector('.activity-column'))`);
    await page.waitFor(`${drawn}.layout === 'split'`);
    const withActivity = await page.evaluate<Json>(`(() => {
      const chat = document.querySelector('#application-chat').getBoundingClientRect();
      const column = document.querySelector('.activity-column').getBoundingClientRect();
      return { chatRight: chat.right, columnLeft: column.left, chatWidth: chat.width };
    })()`);
    assert.ok(withActivity.chatRight <= withActivity.columnLeft, JSON.stringify(withActivity));
    assert.equal(withActivity.chatWidth, 340);
    assert.equal(await horizontalOverflow(page), 0);

    // At 1100 px with Activity at 520 px and a full list at 420 px the area
    // is 320 px: the switch layout, without ◫.
    await page.evaluate(`(() => {
      localStorage.setItem('companion.shell.layout.activityWidth', JSON.stringify({ version: 1, value: 520 }));
      localStorage.setItem('companion.shell.layout.listWidth', JSON.stringify({ version: 1, value: 420 }));
    })()`);
    await setSize(page, 1100, 800);
    await page.navigate(`${fixture.origin}/`);
    await openConversation(page, title);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    assert.doesNotMatch(await page.evaluate<string>(`${bar}.textContent`), /Chat at the right/);
    assert.equal(await horizontalOverflow(page), 0);

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

/** A page expression: the chat's text box has the keyboard focus. */
const composerFocused = `document.activeElement?.tagName === 'TEXTAREA' && document.querySelector('#application-chat').contains(document.activeElement)`;

const notice = `(document.querySelector('.application-notice')?.textContent ?? '')`;

/** Click into the chat's text box and type `text`. */
async function typeInComposer(page: TestPage, text: string): Promise<void> {
  await click(page, '#application-chat textarea');
  await page.waitFor(composerFocused);
  await page.type(text);
}

test(
  'application changes: arriving while typing waits behind a notice; new versions load a new frame; with the chat at the right nothing waits',
  { skip, timeout: 150_000 },
  async (context) => {
    const { fixture, browser } = await applicationSetup(context);
    const title = 'Changing application';
    const { id, run } = await conversation(fixture, title);
    run.emit(chatMessage('answer', 'assistant', 'Working on an application.'));
    // The run stays open: its lease installs and replaces the application.
    const other = await conversation(fixture, 'Another conversation');
    other.run.finish();

    const { page, sockets } = await pairedPage(fixture, browser, 900, 800);
    await attachFrames(browser, page);
    await openConversation(page, title);
    // No application: the chat alone, no bar.
    assert.equal(await page.evaluate(`document.querySelector('.application-bar')`), null);
    assert.deepEqual(await page.evaluate(drawn), { layout: '', app: false, chat: true });

    // An application arrives while the reader types (switch layout): the
    // chat stays, focused, with its text; the bar says it is ready.
    await typeInComposer(page, 'Half a sentence');
    await applyApplication(run, 'chat-probe', 0);
    await page.waitFor(`${notice}.includes('is ready')`, 10_000);
    assert.equal(
      await page.evaluate(notice),
      '“chat-probe” is ready. It opens when you choose it; you are typing.',
    );
    assert.deepEqual(await page.evaluate(drawn), { layout: 'switch', app: false, chat: true });
    assert.equal(await page.evaluate(composerFocused), true);
    assert.equal(
      await page.evaluate(`document.querySelector('#application-chat textarea').value`),
      'Half a sentence',
    );
    // The chat page offers the application as its footer button too.
    await page.waitFor(
      `[...document.querySelectorAll('#application-chat .panel-action')].some((button) => button.textContent.trim() === 'chat-probe')`,
    );

    // Wide, the application is beside the chat: no notice there. Narrow
    // again (still typing): the switch keeps the chat, the notice is back.
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'split'`);
    assert.equal(await page.evaluate(notice), '');
    await setSize(page, 900, 800);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    await page.waitFor(`${notice}.includes('is ready')`);
    assert.equal(await page.evaluate(composerFocused), true);

    // The reader opens it: shown; the notice goes.
    await press(page, 'chat-probe · v1', bar);
    await page.waitFor(`${drawn}.app && !${drawn}.chat`);
    assert.equal(await page.evaluate(notice), '');
    await applicationShown(page);
    const firstFrame = await page.evaluate(`window.__first = ${applicationIframeExpression}, true`);
    assert.equal(firstFrame, true);

    // A new version while the application is shown: a new frame, shown.
    await applyApplication(run, 'chat-probe', 1);
    await page.waitFor(`${bar}.textContent.includes('chat-probe · v2')`, 10_000);
    await page.waitFor(`window.__first !== ${applicationIframeExpression}`);
    await applicationShown(page);
    assert.deepEqual(await page.evaluate(drawn), { layout: 'switch', app: true, chat: false });

    // Chat chosen; a new version while the reader types: the chat stays.
    await press(page, 'Chat', bar);
    await typeInComposer(page, ' more');
    await applyApplication(run, 'chat-probe', 2);
    await page.waitFor(`${bar}.textContent.includes('chat-probe · v3')`, 10_000);
    assert.equal(
      await page.evaluate(notice),
      '“chat-probe” is ready. It opens when you choose it; you are typing.',
    );
    assert.deepEqual(await page.evaluate(drawn), { layout: 'switch', app: false, chat: true });
    assert.equal(await page.evaluate(composerFocused), true);
    // Choosing Chat clears the notice.
    await press(page, 'Chat', bar);
    await page.waitFor(`${notice} === ''`);

    // Wide, the chat at the right: a new version while typing comes beside
    // the chat; the text box keeps the focus and no notice is shown.
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await typeInComposer(page, '!');
    await page.evaluate(`window.__before = ${applicationIframeExpression}`);
    await applyApplication(run, 'chat-probe', 3);
    await page.waitFor(`${bar}.textContent.includes('chat-probe · v4')`, 10_000);
    await page.waitFor(`window.__before !== ${applicationIframeExpression}`);
    assert.equal(await page.evaluate(notice), '');
    assert.equal(await page.evaluate(composerFocused), true);
    assert.equal(
      await page.evaluate(`document.querySelector('#application-chat textarea').value`),
      'Half a sentence more!',
    );
    await applicationShown(page);

    // ▣ App only pressed while the text box keeps the focus (a press that
    // does not move it): the reader's choice, the application is shown.
    await page.evaluate(
      `[...document.querySelectorAll('.application-bar button')].find((button) => button.textContent.trim() === '▣ App only').click()`,
    );
    await page.waitFor(`${drawn}.layout === 'switch' && ${drawn}.app && !${drawn}.chat`);
    await press(page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await typeInComposer(page, '');

    // The window narrows to the switch while the reader types: the switch
    // shows the chat, the text box keeps the focus. Wide again: split.
    await page.evaluate(`window.__before = ${applicationIframeExpression}`);
    await setSize(page, 900, 800);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    assert.deepEqual(await page.evaluate(drawn), { layout: 'switch', app: false, chat: true });
    assert.equal(await page.evaluate(composerFocused), true);
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'split'`);
    assert.equal(await page.evaluate(`window.__before === ${applicationIframeExpression}`), true);

    // Another conversation, and back: the frame loads again.
    await page.evaluate(`window.__before = ${applicationIframeExpression}`);
    await openConversation(page, 'Another conversation');
    assert.equal(await page.evaluate(`document.querySelector('#application-pane')`), null);
    await openConversation(page, title);
    await applicationShown(page);
    assert.equal(await page.evaluate(`window.__before !== ${applicationIframeExpression}`), true);

    // Disconnected: greyed, the status says so, changes are unavailable;
    // back with the same address: the same frame, not loaded again.
    await page.evaluate(`window.__before = ${applicationIframeExpression}`);
    dropConnections(fixture);
    await page.waitFor(`${applicationPanel}?.dataset.connected === 'false'`, 5000);
    const offline = await page.evaluate<Json>(`(() => ({
      text: ${applicationPanel}.textContent,
      classes: ${applicationPanel}.className,
      status: document.querySelector('.application-status')?.textContent,
    }))()`);
    assert.match(offline.text, /Disconnected · reconnecting…/);
    assert.match(offline.classes, /disconnected/);
    assert.match(offline.status, /Disconnected$/);
    await page.waitFor(`${applicationPanel}?.dataset.connected === 'true'`, 15_000);
    assert.equal(await page.evaluate(`window.__before === ${applicationIframeExpression}`), true);

    // The conversation closes: its application leaves with it.
    run.finish();
    await fixture.sessions.remove(id);
    await page.waitFor(`document.querySelector('#application-pane') === null`, 10_000);

    void sockets;
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

/**
 * Press a button of the probe application (inside its own frame) and wait
 * for its outcome line: `read: …`, `sent: …`, or a refusal.
 */
async function probe(
  page: TestPage,
  address: string,
  button: 'read' | 'send',
  expected: RegExp,
): Promise<string> {
  const result = `#${button}-result`;
  const until = Date.now() + 15_000;
  let last = '';
  while (Date.now() < until) {
    await evaluateInFrame(page, address, `document.querySelector('#${button}').click()`, true);
    await waitInFrame(
      page,
      address,
      `!['reading', 'sending', ''].includes(document.querySelector('${result}')?.textContent ?? '')`,
      true,
    );
    last = await evaluateInFrame<string>(
      page,
      address,
      `document.querySelector('${result}').textContent`,
      true,
    );
    if (expected.test(last)) {
      return last;
    }
    // The page learns a grant (or a revocation) with its next state poll.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw Error(`The probe's ${button} never gave ${expected}: ${last}`);
}

const readStatusText = `document.querySelector('[data-permission="read"] .permission-status')?.textContent`;
const sendStatusText = `document.querySelector('[data-permission="send"] .permission-status')?.textContent`;

test(
  'permissions: allowed and revoked from the shell, changed on the desktop; the application reads and sends only while allowed',
  { skip, timeout: 150_000 },
  async (context) => {
    const { fixture, page, id, sockets } = await applicationConversation(context, {
      width: 1280,
    });
    await applicationShown(page);
    const address = await applicationAddress(page);

    // Nothing allowed: the probe can neither read nor send.
    await probe(page, address, 'read', /^refused/);
    await probe(page, address, 'send', /^refused/);

    // Permissions…: the two rows and the scope line; Hide permissions back.
    await press(page, 'Permissions…', bar);
    await page.waitFor(`Boolean(${rowsElement})`);
    assert.match(
      await page.evaluate<string>(`${rowsElement}.textContent`),
      /Applies to this open conversation until it is closed or the app's code changes, on every screen that shows it\./,
    );
    assert.equal(await page.evaluate(readStatusText), 'Chat reading off');
    assert.equal(await page.evaluate(sendStatusText), 'App sending off');

    // Enter on Review, held (repeated): the focus moves to the disclosure,
    // never to Allow; nothing is sent. Not now closes it again.
    const sentBefore = requestActions(sockets).length;
    await page.evaluate(
      `[...${rowsElement}.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Review chat access').focus()`,
    );
    for (const repeat of [false, true, true]) {
      await page.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        autoRepeat: repeat,
      });
    }
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await page.waitFor(`document.activeElement?.classList.contains('permission-disclosure')`);
    assert.equal(await page.evaluate(readStatusText), 'Chat reading off');
    assert.deepEqual(
      requestActions(sockets)
        .slice(sentBefore)
        .filter((action) => action.startsWith('set-application')),
      [],
    );
    await press(page, 'Not now', rowsElement);

    // Read: review (the desktop's disclosure), then Allow reading.
    await press(page, 'Review chat access', rowsElement);
    await page.waitFor(
      `${rowsElement}.textContent.includes('Allow this app to read recent text from this conversation')`,
    );
    await press(page, 'Allow reading', rowsElement);
    await page.waitFor(`${readStatusText} === 'Chat reading allowed'`, 10_000);
    assert.match(
      await page.evaluate<string>(`${bar}.textContent`),
      /Chat reading on · sending off/,
    );
    const read = await probe(page, address, 'read', /^read:/);
    assert.match(read, /Here is your note list\./);

    // Send: review, then Allow 5 app messages; the probe's message arrives.
    await press(page, 'Review app sending', rowsElement);
    await press(page, 'Allow 5 app messages', rowsElement);
    await page.waitFor(
      `${sendStatusText} === 'App sending allowed · 5 of 5 attempts remaining'`,
      10_000,
    );
    const runsBefore = fixture.runs.length;
    await probe(page, address, 'send', /^sent:/);
    await page.waitFor(
      `[...document.querySelectorAll('#application-chat .message')].some((message) => message.textContent.includes('A message from the probe'))`,
      10_000,
    );
    // The message started a turn of the synthetic agent: it answers.
    await waitFor(() => fixture.runs.length === runsBefore + 1);
    const answered = fixture.runs[runsBefore];
    answered.emit(chatMessage('reply', 'assistant', 'Noted.'));
    answered.finish();
    await page.waitFor(`${sendStatusText}.includes('4 of 5 attempts remaining')`, 10_000);

    // Both went through the frame origin's own operations.
    for (const operation of ['chat-read', 'chat-send', 'chat-receipt']) {
      assert.ok(page.requests.includes(address + operation), operation);
    }

    // Revoke both: the probe is refused again.
    await press(page, 'Revoke reading', rowsElement);
    await page.waitFor(`${readStatusText} === 'Chat reading off'`, 10_000);
    await probe(page, address, 'read', /^refused/);
    await press(page, 'Revoke sending', rowsElement);
    await page.waitFor(`${sendStatusText} === 'App sending off'`, 10_000);
    await probe(page, address, 'send', /^refused/);

    // The desktop (a second connection) allows reading while the rows are
    // open with a review: shown here at once, the review closed.
    await press(page, 'Review app sending', rowsElement);
    const answer = await desktopChange(fixture, id, 'read', true);
    assert.equal(answer.type, 'result', JSON.stringify(answer));
    await page.waitFor(`${readStatusText} === 'Chat reading allowed'`, 10_000);
    await page.waitFor(`!${rowsElement}.textContent.includes('Allow 5 app messages')`);
    await probe(page, address, 'read', /^read:/);
    const revoked = await desktopChange(fixture, id, 'read', false);
    assert.equal(revoked.type, 'result', JSON.stringify(revoked));
    await page.waitFor(`${readStatusText} === 'Chat reading off'`, 10_000);

    // A review open when the reader leaves for Previous sessions and comes
    // back: closed, the rows hidden; Allow is not offered.
    await press(page, 'Review app sending', rowsElement);
    await page.waitFor(`${rowsElement}.textContent.includes('Allow 5 app messages')`);
    await click(page, '.previous-entry');
    await page.waitFor(`document.querySelector('.application-bar') === null`);
    await openConversation(page, 'Application fixture');
    await page.waitFor(`Boolean(${bar})`);
    assert.equal(await page.evaluate(`Boolean(${rowsElement})`), false);
    await press(page, 'Permissions…', bar);
    await page.waitFor(`Boolean(${rowsElement})`);
    assert.doesNotMatch(
      await page.evaluate<string>(`${rowsElement}.textContent`),
      /Allow 5 app messages/,
    );

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'permissions: a change waiting when the connection drops is reported as unknown, never sent again, and shown once the listener says so',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page, id, sockets } = await applicationConversation(context, { width: 1280 });
    await applicationShown(page);
    // Reading allowed on the desktop; the reader revokes it here.
    const allowed = await desktopChange(fixture, id, 'read', true);
    assert.equal(allowed.type, 'result', JSON.stringify(allowed));
    await press(page, 'Permissions…', bar);
    await page.waitFor(`${readStatusText} === 'Chat reading allowed'`, 10_000);

    // The application's queue is held: the change is admitted and waits.
    // (Released at the end, also when the test fails, so the fixture can close.)
    const release = await holdApplicationQueue(fixture, id);
    try {
      await press(page, 'Revoke reading', rowsElement);
      await page.waitFor(
        `${rowsElement}.textContent.includes('Waiting for permission confirmation…')`,
      );
      await waitFor(() => requestActions(sockets).includes('set-application-chat-read'));
      // Not shown as changed while it waits.
      assert.equal(await page.evaluate(readStatusText), 'Chat reading allowed');

      // The connection drops: unknown, in the desktop's words; still shown
      // as allowed, which is what the listener last said.
      dropConnections(fixture);
      await page.waitFor(
        `${rowsElement}.textContent.includes('No confirmation received. Permission may have changed; check its current status before trying again.')`,
        10_000,
      );
      assert.match(await page.evaluate<string>(readStatusText), /^Chat reading allowed/);
      await page.waitFor(online, 15_000);
      await page.waitFor(`${applicationPanel}?.dataset.connected === 'true'`, 15_000);
      assert.equal(await page.evaluate(readStatusText), 'Chat reading allowed');

      // The listener carries the change out (stopping needs only the
      // selection, which the departed connection kept): shown with its next
      // state. The request was sent exactly once.
      await release();
      await page.waitFor(`${readStatusText} === 'Chat reading off'`, 15_000);
      assert.equal(
        requestActions(sockets).filter((action) => action === 'set-application-chat-read').length,
        1,
      );

      assertTwoOrigins(fixture, page);
      await assertNoViolations(page);
    } finally {
      await release();
    }
  },
);

test(
  'permissions: refused by the listener (the page stopped showing the conversation before the change ran): the refusal shown, nothing changed',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page, id } = await applicationConversation(context, { width: 1280 });
    await applicationShown(page);
    await press(page, 'Permissions…', bar);
    await press(page, 'Review chat access', rowsElement);

    const release = await holdApplicationQueue(fixture, id);
    try {
      // Admitted while the page shows the conversation; it waits.
      await press(page, 'Allow reading', rowsElement);
      await page.waitFor(
        `${rowsElement}.textContent.includes('Waiting for permission confirmation…')`,
      );
      // The settings screen covers it: the page reports it as not visible.
      await click(page, '.chat-bar .settings-toggle');
      await waitFor(() => !remoteVisibleSelections(fixture).includes(id), 5000);
      await release();
      await page.waitFor(
        `${rowsElement}.textContent.includes('Show this conversation on this device first')`,
        10_000,
      );
      assert.equal(await page.evaluate(readStatusText), 'Chat reading off');
      assert.equal(listenerApplication(fixture, id)?.chatAccess.read, false);
      // Back from the settings screen: the refusal is still there to read.
      await click(page, '.chat-bar .settings-toggle');
      await page.waitFor(`!${rowsElement}.closest('[inert]')`);
      assert.match(
        await page.evaluate<string>(`${rowsElement}.textContent`),
        /Show this conversation on this device first/,
      );
      assertTwoOrigins(fixture, page);
      await assertNoViolations(page);
    } finally {
      await release();
    }
  },
);

test(
  'security: the application frame cannot read the shell\u2019s storage, reach the permission rows, or post anything the shell acts on; the page policy is unchanged',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page, sockets } = await applicationConversation(context, { width: 1280 });

    // The page's policy is the gateway's, with exactly frame-src for frames.
    const response = await fetch(`${fixture.origin}/`);
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src " +
        fixture.frameOrigin,
    );

    await applicationShown(page);
    const address = await applicationAddress(page);
    assert.ok(address.startsWith(fixture.frameOrigin + '/f/'), address);
    const attributes = await page.evaluate<Json>(`(() => {
      const frame = ${applicationIframeExpression};
      return { sandbox: frame.getAttribute('sandbox'), referrer: frame.getAttribute('referrerpolicy'), allow: frame.getAttribute('allow') };
    })()`);
    assert.equal(attributes.sandbox, 'allow-scripts allow-same-origin allow-forms');
    assert.equal(attributes.referrer, 'no-referrer');
    assert.match(attributes.allow, /camera 'none'; microphone 'none'/);

    // The device token is in the shell's storage, not the frame's.
    assert.ok(await page.evaluate(`localStorage.getItem('companion.remote.device')`));
    const reach = await evaluateInFrame<Json>(
      page,
      address,
      `(() => {
        const attempt = (read) => { try { return String(read()); } catch (error) { return error.name; } };
        return {
          ownToken: localStorage.getItem('companion.remote.device'),
          parentStorage: attempt(() => window.parent.localStorage.length),
          parentDocument: attempt(() => window.parent.document.querySelector('#application-permissions')),
          topDocument: attempt(() => window.top.document.title),
        };
      })()`,
    );
    assert.deepEqual(reach, {
      ownToken: null,
      parentStorage: 'SecurityError',
      parentDocument: 'SecurityError',
      topDocument: 'SecurityError',
    });

    // Messages the frame posts: nothing beyond the embedded-mode messages
    // is acted on, and none of them changes a permission or sends a request.
    const before = sockets.sent.length;
    const rowsBefore = await page.evaluate(`Boolean(${rowsElement})`);
    await evaluateInFrame(
      page,
      address,
      `(() => {
        const post = (message) => window.parent.postMessage(message, '*');
        post({ type: 'set-application-chat-read', allowed: true });
        post({ type: 'set-application-chat-send', allowed: true });
        post({ type: 'permissions', open: true });
        post({ type: 'present', placement: 'pinned' });
        post({ type: 'visible', visible: true });
        post({ type: 'geometry', height: 5000, extra: 1 });
        post({ type: 'geometry', height: 5000 });
        post('Allow reading');
        return true;
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      requestActions(sockets, before).filter((action) => action !== 'panel-state'),
      [],
    );
    assert.equal(await page.evaluate(`Boolean(${rowsElement})`), rowsBefore);
    assert.equal(await page.evaluate(`${applicationPanel}.dataset.phase`), 'shown');
    // A geometry never sizes the application: it fills its pane.
    const sizes = await page.evaluate<Json>(`(() => ({
      frame: ${applicationIframeExpression}.getBoundingClientRect().height,
      pane: document.querySelector('#application-pane').getBoundingClientRect().height,
    }))()`);
    assert.equal(sizes.frame, sizes.pane);

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'an inline widget in a conversation with an application: no Pin, and not visible while the application is in the chat\u2019s place',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser } = await applicationSetup(context);
    const { run } = await conversation(fixture, 'Widget and application');
    run.emit(chatMessage('answer', 'assistant', 'A counter, and an application.'));
    await fixture.publishCounter(run);
    await applyApplication(run, 'chat-probe');
    run.finish();
    const { page } = await pairedPage(fixture, browser, 900, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'Widget and application');

    const counter = `[...document.querySelectorAll('#application-chat .inline-widget')].find((panel) => panel.querySelector('.inline-widget-name')?.textContent === 'counter')`;
    // The switch shows the application: the counter is out of sight.
    await page.waitFor(`${drawn}.app && !${drawn}.chat`);
    await page.waitFor(`${counter}?.dataset.visible === 'false'`);
    // Chat: the counter is shown and visible, without Pin.
    await press(page, 'Chat', bar);
    await page.waitFor(
      `${counter}?.dataset.phase === 'shown' && ${counter}?.dataset.visible === 'true'`,
      15_000,
    );
    assert.equal(
      await page.evaluate(
        `[...${counter}.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Pin')`,
      ),
      false,
    );
    // The application again: the counter out of sight; its own frame visible.
    await press(page, 'chat-probe · v1', bar);
    await page.waitFor(`${counter}?.dataset.visible === 'false'`);
    await page.waitFor(`${applicationPanel}?.dataset.visible === 'true'`, 15_000);
    // The chat at the right: both visible.
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'split'`);
    await page.waitFor(`${counter}?.dataset.visible === 'true'`);
    assert.equal(await page.evaluate(`${applicationPanel}.dataset.visible`), 'true');
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'typing in another conversation does not hold back an application shown with browser Back',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser } = await applicationSetup(context);
    const first = await conversation(fixture, 'First with application');
    first.run.emit(chatMessage('answer', 'assistant', 'An application.'));
    await applyApplication(first.run, 'chat-probe', 0);
    const second = await conversation(fixture, 'Second conversation');
    second.run.finish();
    const { page } = await pairedPage(fixture, browser, 900, 800);
    await attachFrames(browser, page);

    // The first conversation, its chat chosen; then the second, typing there.
    await openConversation(page, 'First with application');
    await page.waitFor(`${drawn}.app`);
    await press(page, 'Chat', bar);
    await openConversation(page, 'Second conversation');
    await typeInComposer(page, 'Typing here');
    // The first one's application is replaced meanwhile; Back shows it:
    // its new version comes forward, no notice (the typing was elsewhere).
    // (Back only once this page has received the new version: arriving
    // after Back, it would meet this conversation's own focused text box.)
    const received: string[] = [];
    browser.on((message) => {
      if (
        message.sessionId === page.sessionId &&
        message.method === 'Network.webSocketFrameReceived'
      ) {
        received.push(String(message.params.response.payloadData));
      }
    });
    await applyApplication(first.run, 'chat-probe', 1);
    await waitFor(() =>
      received.some((payload) => /"name":"chat-probe","version":2/.test(payload)),
    );
    await page.evaluate(`history.back()`);
    await page.waitFor(`${bar}?.textContent.includes('chat-probe · v2')`, 10_000);
    await page.waitFor(`${drawn}.app && !${drawn}.chat`);
    assert.equal(await page.evaluate(notice), '');
    first.run.finish();
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'failure states: could not load (Try again, its description, the way back to the chat) and no frame address (named only)',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page } = await applicationConversation(context, {
      width: 900,
      bundle: 'broken-app',
    });

    // Its page cannot draw its first state: failed, with the frame's error.
    await page.waitFor(`${applicationPanel}?.dataset.phase === 'failed'`, 15_000);
    const failed = await page.evaluate<string>(`${applicationPanel}.textContent`);
    assert.match(failed, /The broken-app application could not load\. Synthetic mount failure/);
    assert.match(failed, /The conversation and the application's saved data are unchanged\./);
    assert.match(failed, /Description: Probe notes: 0/);
    assert.equal(await page.evaluate(`${applicationPanel}.querySelector('iframe')`), null);
    // Show the chat: the way back.
    await press(page, 'Show the chat', applicationPanel);
    await page.waitFor(`${drawn}.chat && !${drawn}.app`);
    // Try again loads a new frame (which fails again here).
    await press(page, 'broken-app · v1', bar);
    await press(page, 'Try again', applicationPanel);
    await page.waitFor(`${applicationPanel}?.dataset.phase === 'failed'`, 15_000);
    assertTwoOrigins(fixture, page);
  },
);

test(
  'no frame address: the application is only named above the chat',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser } = await applicationSetup(context, { frames: false });
    const { run } = await conversation(fixture, 'Without frames');
    run.emit(chatMessage('answer', 'assistant', 'Here is your note list.'));
    await applyApplication(run, 'chat-probe');
    run.finish();
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Without frames');
    await page.waitFor(`Boolean(${bar})`);
    assert.equal(
      await page.evaluate(`${bar}.textContent`),
      "chat-probe · v1Applications are not set up for this browser, so only the application's name is shown.",
    );
    assert.deepEqual(await page.evaluate(drawn), { layout: '', app: false, chat: true });
    assert.equal(await page.evaluate(`document.querySelectorAll('iframe').length`), 0);
    for (const url of page.requests) {
      assert.ok(
        url.startsWith(fixture.origin + '/') || url.startsWith('data:') || url === 'about:blank',
        url,
      );
    }
    await assertNoViolations(page);
  },
);

test(
  'screenshots: chat at the right, App only with the switch, the permission rows, failure states',
  {
    skip:
      skip ??
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
    timeout: 180_000,
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { fixture, page } = await applicationConversation(context, { width: 1280 });
    await applicationShown(page);

    async function save(name: string) {
      // Two frames, so the page has drawn what the step changed.
      await page.evaluate(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      );
      await writeFile(join(directory, name), await page.screenshot());
    }

    await save('application-1280-chat-at-the-right.png');
    await setSize(page, 1600, 900);
    await save('application-1600-chat-at-the-right.png');
    await press(page, 'Permissions…', bar);
    await page.waitFor(`Boolean(${rowsElement})`);
    await save('application-1600-permissions.png');
    await press(page, 'Review chat access', rowsElement);
    await save('application-1600-permissions-review.png');
    await press(page, 'Not now', rowsElement);
    await setSize(page, 1280, 800);
    await save('application-1280-permissions.png');
    await press(page, 'Hide permissions', bar);
    await press(page, '▣ App only', bar);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    await save('application-1280-app-only.png');
    await setSize(page, 1600, 900);
    await save('application-1600-app-only.png');
    await setSize(page, 420, 800);
    await save('application-420-switch.png');
    await press(page, 'Permissions…', bar);
    await save('application-420-permissions.png');
    await press(page, 'Hide permissions', bar);
    await press(page, 'Chat', bar);
    await save('application-420-chat.png');
    await press(page, 'chat-probe · v1', bar);
    await setSize(page, 1280, 800);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    await press(page, '◫ Chat at the right', bar);
    await page.waitFor(`${drawn}.layout === 'split'`);

    // A broken application: could not load.
    const broken = await conversation(fixture, 'Broken application');
    broken.run.emit(chatMessage('answer', 'assistant', 'This one cannot draw.'));
    await applyApplication(broken.run, 'broken-app');
    broken.run.finish();
    await openConversation(page, 'Broken application');
    await page.waitFor(`${applicationPanel}?.dataset.phase === 'failed'`, 15_000);
    await save('application-1280-could-not-load.png');
    await setSize(page, 420, 800);
    await save('application-420-could-not-load.png');
    await setSize(page, 1280, 800);

    // Disconnected, held there by stopping the gateway.
    await openConversation(page, 'Application fixture');
    await applicationShown(page);
    await fixture.gateway.close();
    await page.waitFor(`${applicationPanel}?.dataset.connected === 'false'`, 5000);
    await save('application-1280-disconnected.png');
  },
);

test(
  'screenshot: no frame address',
  {
    skip:
      skip ??
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
    timeout: 120_000,
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    const { fixture, browser } = await applicationSetup(context, { frames: false });
    const { run } = await conversation(fixture, 'Without frames');
    run.emit(chatMessage('answer', 'assistant', 'Here is your note list.'));
    await applyApplication(run, 'chat-probe');
    run.finish();
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Without frames');
    await page.waitFor(`Boolean(${bar})`);
    await writeFile(join(directory, 'application-1280-not-set-up.png'), await page.screenshot());
  },
);
