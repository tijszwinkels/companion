import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import { connectPhone, remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';
import { chromiumPath, TestBrowser, TestPage } from './browser.ts';

/**
 * The phone panel's part of browser shell slice 6.2 (integrations/mobile/README.md,
 * "Unread marks and the visible report" and "The limit page"), in headless
 * Chromium with phone emulation against the real gateway, the real listener
 * control socket and a synthetic agent backend, on loopback only:
 *
 * - the listener's shared unread mark: a turn completed while another
 *   conversation is shown stays marked after a reload, and showing it in
 *   another tab of the same browser clears it in both;
 * - the limit page: the fifth tab of one browser (reason `device`), Retry
 *   after another tab closed, and the ninth connection in all (`total`).
 *
 * The rules are played row by row in Node in test/shell/markers.test.ts
 * and test/shell/limit-page.test.ts (the Store and the Connection are the
 * phone panel's). Set COMPANION_SHELL_SCREENSHOTS to a directory to also
 * save the phone's limit page for each reason at 420 and 1280 px.
 */

const appDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'mobile', 'dist');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(appDirectory, 'index.html'));
  } catch {
    return 'phone app not built (npm run mobile:build)';
  }
  try {
    await access(chromiumPath);
  } catch {
    return 'Chromium not installed';
  }
  return undefined;
}

const skip = await prerequisites();

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

const deviceText =
  'This browser already has four Companion tabs connected. Close one you do not need, then Retry.';
const totalText =
  'Companion already has eight browsers and phones connected. Close one you do not need, then Retry.';

async function setup(context: { after(callback: () => Promise<void>): void }) {
  const fixture = await remoteFixture({ appDirectory });
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser };
}

/**
 * A phone tab (touch, mobile viewport) in the browser context
 * `browserContextId`, so tabs of one context share their storage and
 * pairing; a new context when empty. Opened on the phone panel.
 */
async function phoneTab(
  fixture: Fixture,
  browser: TestBrowser,
  browserContextId = '',
  width = 390,
): Promise<{ page: TestPage; browserContextId: string; sockets: string[] }> {
  let contextId = browserContextId;
  if (!contextId) {
    contextId = String((await browser.call('Target.createBrowserContext')).browserContextId);
  }
  const { targetId } = await browser.call('Target.createTarget', {
    url: 'about:blank',
    browserContextId: contextId,
  });
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  const page = new TestPage(browser, String(targetId), String(sessionId));
  await page.call('Page.enable');
  await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  page.watchConsole();

  // Every WebSocket the page opens.
  const sockets: string[] = [];
  browser.on((message) => {
    if (message.sessionId === sessionId && message.method === 'Network.webSocketCreated') {
      sockets.push(String(message.params.url));
    }
  });

  await page.navigate(`${fixture.origin}/`);
  return { page, browserContextId: contextId, sockets };
}

/** A page expression: the phone panel is connected and shows its pages. */
const connected = `document.querySelector('.shell') !== null && document.querySelector('.banner') === null && document.querySelector('.limit-page') === null`;

/** A paired phone tab in a new browser context, through the real pairing form. */
async function pairedTab(fixture: Fixture, browser: TestBrowser) {
  const tab = await phoneTab(fixture, browser);
  await tab.page.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  await tab.page.tap('#code');
  await tab.page.type(code);
  await tab.page.tap('button[type=submit]');
  await tab.page.waitFor(connected, 8000);
  await showRail(tab.page);
  return tab;
}

/** Show the session rail if it is hidden. */
async function showRail(page: TestPage): Promise<void> {
  await page.waitFor(`document.querySelector('.page-header')`, 8000);
  if (!(await page.evaluate(`Boolean(document.querySelector('.rail'))`))) {
    await page.tap('button[aria-label="Show sessions"]');
    await page.waitFor(`document.querySelector('.rail')`);
  }
}

/** A page expression: the rail tab of the conversation titled `title`. */
function tabExpression(title: string): string {
  return `[...document.querySelectorAll('.session-tab')].find((tab) => tab.title === ${JSON.stringify(title)})`;
}

function unread(title: string): string {
  return `${tabExpression(title)}?.classList.contains('unread') === true`;
}

/** Tap the conversation's rail tab and wait until its page is shown. */
async function openConversation(page: TestPage, title: string): Promise<void> {
  await page.waitFor(`Boolean(${tabExpression(title)})`);
  await page.evaluate(`${tabExpression(title)}.setAttribute('data-target', 'yes')`);
  await page.tap('.session-tab[data-target="yes"]');
  await page.evaluate(`${tabExpression(title)}.removeAttribute('data-target')`);
  await page.waitFor(
    `document.querySelector('.page-header h1')?.textContent === ${JSON.stringify(title)}`,
  );
}

async function start(fixture: Fixture, title: string) {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) => candidate.request.prompt.text.includes(title));
  assert.ok(run);
  return { id, run };
}

function listenerMark(fixture: Fixture, id: string): boolean | undefined {
  return fixture.sessions.snapshot().find((session) => session.id === id)?.unread;
}

function relayCount(fixture: Fixture): number {
  return (fixture.gateway as unknown as { relays: Map<unknown, unknown> }).relays.size;
}

/** A page expression: the limit page shows `text`. */
function limitPageShows(text: string): string {
  return `document.querySelector('.limit-page p')?.textContent === ${JSON.stringify(text)}`;
}

/** Save the page at 420 and 1280 px when screenshots were asked for. */
async function screenshots(page: TestPage, name: string): Promise<void> {
  const directory = process.env.COMPANION_SHELL_SCREENSHOTS;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  for (const width of [420, 1280]) {
    await page.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await page.waitFor(`document.documentElement.clientWidth === ${width}`);
    await writeFile(join(directory, `phone-${name}-${width}.png`), await page.screenshot());
  }
}

// ---- Tests ------------------------------------------------------------------------

test(
  'the phone panel shows the listener’s mark: kept after a reload, cleared by another tab showing it',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const shown = await start(fixture, 'Shown on the phone');
    const other = await start(fixture, 'Other on the phone');
    const first = await pairedTab(fixture, browser);
    await openConversation(first.page, 'Shown on the phone');

    // A turn completes in the conversation that is not shown: marked.
    other.run.emit({ ...chatMessage('b1', 'assistant', 'Other answer.'), state: 'done' });
    other.run.finish();
    await waitFor(() => listenerMark(fixture, other.id) === true);
    await first.page.waitFor(unread('Other on the phone'));

    // The shown one completes: not marked.
    shown.run.emit({ ...chatMessage('a1', 'assistant', 'Shown answer.'), state: 'done' });
    shown.run.finish();
    await waitFor(() =>
      fixture.sessions.snapshot().some((s) => s.id === shown.id && s.status === 'completed'),
    );
    assert.equal(listenerMark(fixture, shown.id), false);

    // Reload: still marked; the shown one is not.
    await first.page.navigate(`${fixture.origin}/`);
    await first.page.waitFor(connected, 8000);
    await showRail(first.page);
    await first.page.waitFor(`Boolean(${tabExpression('Other on the phone')})`);
    assert.equal(await first.page.evaluate(unread('Other on the phone')), true, 'after reload');
    assert.equal(await first.page.evaluate(unread('Shown on the phone')), false);

    // Another tab of the same browser shows it: cleared there and in the
    // first tab (hidden behind it now).
    const second = await phoneTab(fixture, browser, first.browserContextId);
    await second.page.waitFor(connected, 8000);
    await showRail(second.page);
    await openConversation(second.page, 'Other on the phone');
    await waitFor(() => listenerMark(fixture, other.id) === false);
    await first.page.waitFor(`!(${unread('Other on the phone')})`);
    await second.page.waitFor(`!(${unread('Other on the phone')})`);

    assert.deepEqual(first.page.errors, []);
    assert.deepEqual(second.page.errors, []);
  },
);

test(
  'the phone panel’s limit page: the fifth tab (device), Retry after a tab closed, the ninth connection (total)',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await pairedTab(fixture, browser);
    const tabs: TestPage[] = [first.page];
    for (let index = 2; index <= 4; index++) {
      const tab = await phoneTab(fixture, browser, first.browserContextId);
      await tab.page.waitFor(connected, 8000);
      tabs.push(tab.page);
    }
    await waitFor(() => relayCount(fixture) === 4);

    // The fifth tab: the limit page with the `device` text; Retry focused.
    const fifth = await phoneTab(fixture, browser, first.browserContextId);
    await fifth.page.waitFor(limitPageShows(deviceText), 8000);
    assert.equal(await fifth.page.evaluate(`document.activeElement?.textContent`), 'Retry');
    assert.equal(await fifth.page.evaluate(`document.querySelector('.app-content').inert`), true);
    assert.equal(await fifth.page.evaluate(`document.querySelector('.banner')`), null);
    await screenshots(fifth.page, 'limit-device');
    await fifth.page.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });

    // Another tab closes; once the gateway let it go, Retry connects.
    await tabs[0].close();
    await waitFor(() => relayCount(fixture) === 3, 5000);
    await fifth.page.tap('.limit-page button');
    await fifth.page.waitFor(connected, 8000);
    assert.equal(fifth.sockets.length, 2, 'one attempt per Retry, none by itself');

    // Eight in all: four of this browser, four of another device. A tab of
    // a third device is refused with `total`.
    const others: PhoneClient[] = [];
    context.after(async () => {
      for (const client of others) {
        client.socket.terminate();
      }
    });
    const { token } = await fixture.pair('Device B');
    for (let index = 0; index < 4; index++) {
      const client = await connectPhone(
        `ws://127.0.0.1:${fixture.port}/api/socket`,
        token,
        fixture.origin,
        true,
      );
      await waitFor(() => client.messages.some((message) => message.type === 'authenticated'));
      others.push(client);
    }
    await waitFor(() => relayCount(fixture) === 8);
    const third = await phoneTab(fixture, browser);
    await third.page.waitFor(`document.querySelector('#code')`);
    const { code } = await fixture.devices.createPairingCode();
    await third.page.tap('#code');
    await third.page.type(code);
    await third.page.tap('button[type=submit]');
    await third.page.waitFor(limitPageShows(totalText), 8000);
    await screenshots(third.page, 'limit-total');

    for (const tab of [...tabs.slice(1), fifth.page, third.page]) {
      assert.deepEqual(tab.errors, []);
    }
  },
);
