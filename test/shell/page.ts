import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { TestBrowser, TestPage, chromiumPath } from '../mobile/browser.ts';
import { remoteFixture } from '../remote-fixture.ts';

/**
 * Shared helpers of the browser shell's headless suites (shell.test.ts,
 * list.test.ts): the built shell (integrations/shell/dist) in headless
 * Chromium, against the real gateway and listener control socket with a
 * synthetic agent backend, in temporary directories on loopback only.
 * Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 */

export const appDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'shell', 'dist');

export async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(appDirectory, 'index.html'));
  } catch {
    return 'browser shell not built (npm run shell:build)';
  }
  try {
    await access(chromiumPath);
  } catch {
    return 'Chromium not installed';
  }
  return undefined;
}

export const skip = await prerequisites();

export type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

/** WebSocket traffic of one page, recorded through the DevTools protocol. */
export interface SocketLog {
  /** Every WebSocket URL the page opened. */
  urls: string[];
  /** Every frame the page sent, parsed, in order. */
  sent: Record<string, unknown>[];
}

export async function setup(context: { after(callback: () => Promise<void>): void }) {
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
 * A fresh desktop page (own browser context, so its own storage and pairing)
 * that records WebSocket traffic and Content-Security-Policy violations.
 */
export async function desktopPage(
  browser: TestBrowser,
  width: number,
  height = 800,
  sharedContext = '',
): Promise<{ page: TestPage; sockets: SocketLog; browserContextId: string }> {
  // Another tab of an existing context shares its storage (and pairing).
  let browserContextId = sharedContext;
  if (!browserContextId) {
    const created = await browser.call('Target.createBrowserContext');
    browserContextId = String(created.browserContextId);
  }
  const { targetId } = await browser.call('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  const page = new TestPage(browser, targetId, sessionId);
  await page.call('Page.enable');
  await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Recorded by the page itself: violations would mean the shell needs a
  // weaker policy than the gateway serves.
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__violations.push(event.violatedDirective + ' ' + event.blockedURI);
      });`,
  });
  page.watchConsole();

  const sockets: SocketLog = { urls: [], sent: [] };
  browser.on((message) => {
    if (message.sessionId !== sessionId) {
      return;
    }
    if (message.method === 'Network.webSocketCreated') {
      sockets.urls.push(String(message.params.url));
    }
    if (message.method === 'Network.webSocketFrameSent') {
      try {
        sockets.sent.push(JSON.parse(String(message.params.response.payloadData)));
      } catch {
        sockets.sent.push({ unparsed: true });
      }
    }
  });
  return { page, sockets, browserContextId };
}

/** Click the centre of an element with the mouse, as a desktop user would. */
export async function clickAt(page: TestPage, point: { x: number; y: number }): Promise<void> {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

export async function click(page: TestPage, selector: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) {
    throw Error(`No element for ${selector}`);
  }
  await clickAt(page, point);
}

/** The enabled button whose text is exactly `label`, clicked with the mouse. */
export async function clickButton(page: TestPage, label: string): Promise<void> {
  const expression = buttonExpression(label);
  await page.waitFor(`${expression} && !${expression}.disabled`);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const element = ${expression};
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
}

export function buttonExpression(label: string): string {
  return `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
}

export function text(page: TestPage, selector: string): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
  );
}

export function horizontalOverflow(page: TestPage): Promise<number> {
  return page.evaluate<number>(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  );
}

/** Pair through the real UI with a code from the device store. */
export async function pairedPage(
  fixture: Fixture,
  browser: TestBrowser,
  width = 1280,
  height = 800,
) {
  const { page, sockets, browserContextId } = await desktopPage(browser, width, height);
  await page.navigate(`${fixture.origin}/`);
  await page.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  await click(page, '#code');
  await page.type(code);
  await click(page, 'button[type=submit]');
  await page.waitFor(online, 8000);
  return { page, sockets, browserContextId };
}

/** A page expression: the shell is paired and connected. */
export const online = `document.querySelector('.shell[data-connection="online"]') !== null`;

/** A page expression: the list's entry whose title contains `title`. */
export function entryExpression(title: string): string {
  return `[...document.querySelectorAll('.conversation-entry')].find((entry) => entry.querySelector('.entry-select').title.includes(${JSON.stringify(title)}))`;
}

/**
 * Select the conversation whose title contains `title` in the list with the
 * mouse, and wait until the chat shows it.
 */
export async function openConversation(page: TestPage, title = ''): Promise<void> {
  await page.waitFor(`Boolean(${entryExpression(title)})`);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const select = ${entryExpression(title)}.querySelector('.entry-select');
    select.scrollIntoView({ block: 'nearest' });
    const rect = select.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
  await page.waitFor(
    `document.querySelector('.chat textarea') && document.querySelector('.chat-bar-title')?.textContent.includes(${JSON.stringify(title)})`,
  );
}

/** No request and no socket went anywhere but the gateway's own origin. */
export function assertOwnOrigin(fixture: Fixture, page: TestPage, sockets: SocketLog): void {
  for (const url of page.requests) {
    if (url === 'about:blank' || url.startsWith('data:')) {
      continue;
    }
    assert.ok(url.startsWith(fixture.origin + '/'), `request to another origin: ${url}`);
  }
  const socketOrigin = fixture.origin.replace(/^http/, 'ws') + '/';
  for (const url of sockets.urls) {
    assert.ok(url.startsWith(socketOrigin), `socket to another origin: ${url}`);
  }
}

export async function assertNoViolations(page: TestPage): Promise<void> {
  assert.deepEqual(await page.evaluate(`window.__violations`), []);
  assert.deepEqual(page.errors, []);
}

/** Requests (not auth or ping frames) the page sent, by action. */
export function requestActions(sockets: SocketLog, from = 0): string[] {
  const actions: string[] = [];
  for (const sent of sockets.sent.slice(from)) {
    if (sent.type === 'request') {
      actions.push(String(sent.action));
    }
  }
  return actions;
}
