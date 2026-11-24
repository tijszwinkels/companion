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
import type { SyntheticRun } from '../remote-fixture.ts';
import {
  applicationAddress,
  applicationPanel,
  applicationSetup,
  applyApplication,
  conversation,
  drawn,
  setSize,
  type ApplicationFixture,
} from './application-page.ts';
import {
  assertNoViolations,
  clickAt,
  horizontalOverflow,
  openConversation,
  pairedPage,
  skip,
} from './page.ts';
import { attachFrames } from './widget-page.ts';

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

  const { page, browserContextId } = await pairedPage(
    fixture,
    browser,
    options.width,
    options.height ?? 800,
  );
  await attachFrames(browser, page);
  await openConversation(page, title);
  return { fixture, browser, page, browserContextId, id, run, title };
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

    assertTwoOrigins(fixture, page);
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
    const { page } = await applicationConversation(context, { width: 1280 });
    await applicationShown(page);

    async function save(name: string) {
      // Two frames, so the page has drawn what the step changed.
      await page.evaluate(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      );
      await writeFile(join(directory, name), await page.screenshot());
    }

    await save('application-1280-split.png');
    await setSize(page, 1600, 900);
    await save('application-1600-split.png');
    await press(page, 'Permissions…', bar);
    await page.waitFor(`Boolean(${rowsElement})`);
    await press(page, 'Review chat access', rowsElement);
    await save('application-1600-permissions.png');
    await press(page, 'Not now', rowsElement);
    await press(page, 'Hide permissions', bar);
    await press(page, '▣ App only', bar);
    await page.waitFor(`${drawn}.layout === 'switch'`);
    await save('application-1600-app-only.png');
    await setSize(page, 420, 800);
    await save('application-420-switch.png');
    await press(page, 'Chat', bar);
    await save('application-420-chat.png');
  },
);
