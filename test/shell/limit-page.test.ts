import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { connectPhone, waitFor, type PhoneClient } from '../remote-fixture.ts';
import {
  assertNoViolations,
  clickButton,
  desktopPage,
  online,
  pairedPage,
  setup,
  skip,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * The limit page (integrations/shell/README.md, "The limit page"), row by
 * row of its table:
 *
 * - in Node, against the real phone Connection
 *   (integrations/mobile/src/connection.ts, shared by the shell and the
 *   phone panel) with a stand-in WebSocket and mocked timers: each reason,
 *   an unknown or missing reason, nothing reconnecting by itself (time
 *   passing, the tab shown again, the network back), and Retry admitted or
 *   refused again;
 * - in headless Chromium against the real gateway and listener: the fifth
 *   tab of one browser, a sixth opened while the page is shown, Retry
 *   refused while the limit holds and admitted after another tab closed, and
 *   the ninth connection in all.
 *
 * test/mobile/limit-and-unread.test.ts plays the browser rows for the
 * phone panel. Set COMPANION_SHELL_SCREENSHOTS to a directory to also save
 * the limit page for each reason at 420 and 1280 px (never committed).
 */

// ---- Browser stand-ins for the Connection, before it is loaded ------------------------

const memory = new Map<string, string>();
const network = { onLine: true };
const page = { visibilityState: 'visible' as 'visible' | 'hidden' };
const windowListeners = new Map<string, (() => void)[]>();
const documentListeners = new Map<string, (() => void)[]>();

function listen(map: Map<string, (() => void)[]>, type: string, listener: () => void): void {
  const listeners = map.get(type) ?? [];
  listeners.push(listener);
  map.set(type, listeners);
}

function fire(map: Map<string, (() => void)[]>, type: string): void {
  for (const listener of map.get(type) ?? []) {
    listener();
  }
}

/** A stand-in WebSocket: records what is sent; the test opens and closes it. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket the Connection opened, in order. */
  static readonly opened: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /** The socket opened (the Connection then sends `auth`). */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  /** The gateway admitted the connection. */
  authenticate(): void {
    this.emit('message', { data: JSON.stringify({ type: 'authenticated' }) });
  }

  /** The gateway closed it with this code and reason. */
  refuse(code: number, reason: string): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', { code, reason });
  }
}

Object.assign(globalThis, {
  window: {
    addEventListener(type: string, listener: () => void) {
      listen(windowListeners, type, listener);
    },
    location: { origin: 'http://127.0.0.1:1' },
  },
  document: {
    addEventListener(type: string, listener: () => void) {
      listen(documentListeners, type, listener);
    },
    get visibilityState() {
      return page.visibilityState;
    },
  },
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});
// Node has its own navigator and WebSocket; the Connection reads these.
Object.defineProperty(globalThis, 'navigator', { value: network, configurable: true });
Object.defineProperty(globalThis, 'WebSocket', { value: FakeSocket, configurable: true });

const { Connection, limitMessages } = await import('../../integrations/mobile/src/connection.ts');

const deviceText =
  'This browser already has four Companion tabs connected. Close one you do not need, then Retry.';
const totalText =
  'Companion already has eight browsers and phones connected. Close one you do not need, then Retry.';

/** A paired Connection, started: its first socket is the last one opened. */
function startedConnection() {
  memory.set(
    'companion.remote.device',
    JSON.stringify({ token: 'token', deviceId: 'device', deviceName: 'Browser', server: '' }),
  );
  const connection = new Connection(
    () => {},
    () => {},
    () => {},
  );
  const first = FakeSocket.opened.length;
  connection.start();
  assert.equal(FakeSocket.opened.length, first + 1);
  const socket = FakeSocket.opened.at(-1)!;
  socket.accept();
  return { connection, socket };
}

/** A paired Connection whose first socket the gateway refused with `reason`. */
function refusedConnection(reason: string) {
  const { connection, socket } = startedConnection();
  socket.refuse(4429, reason);
  return { connection, socketsBefore: FakeSocket.opened.length };
}

// ---- The table in Node -----------------------------------------------------------------

test('limit page: each reason, unknown reasons and Retry against the real Connection', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  // The texts are the brief's, exactly.
  assert.equal(limitMessages.device, deviceText);
  assert.equal(limitMessages.total, totalText);

  // Fifth tab of one browser (reason `device`): the limit page's state.
  const device = refusedConnection('device');
  assert.deepEqual(
    { ...device.connection.state },
    {
      status: 'limited',
      message: deviceText,
      retryAt: 0,
      deviceName: 'Browser',
      limit: 'device',
    },
    'device',
  );

  // Limit page shown: time passes, the tab is hidden and shown, the
  // network goes and comes back: no new connection.
  context.mock.timers.tick(10 * 60_000);
  page.visibilityState = 'hidden';
  fire(documentListeners, 'visibilitychange');
  page.visibilityState = 'visible';
  fire(documentListeners, 'visibilitychange');
  network.onLine = false;
  fire(windowListeners, 'offline');
  network.onLine = true;
  fire(windowListeners, 'online');
  device.connection.connectNow();
  context.mock.timers.tick(10 * 60_000);
  assert.equal(FakeSocket.opened.length, device.socketsBefore, 'nothing reconnects by itself');
  assert.equal(device.connection.state.status, 'limited');

  // Retry while the limit still holds: one attempt, refused again, the
  // limit page again.
  device.connection.retryAfterLimit();
  assert.equal(FakeSocket.opened.length, device.socketsBefore + 1, 'Retry tries once');
  assert.equal(device.connection.state.status, 'connecting');
  assert.equal(device.connection.state.limit, undefined);
  const again = FakeSocket.opened.at(-1)!;
  again.accept();
  again.refuse(4429, 'device');
  assert.equal(device.connection.state.status, 'limited', 'refused again');
  context.mock.timers.tick(10 * 60_000);
  assert.equal(FakeSocket.opened.length, device.socketsBefore + 1, 'still nothing by itself');

  // Retry after another tab was closed: admitted, the limit page goes.
  device.connection.retryAfterLimit();
  const admitted = FakeSocket.opened.at(-1)!;
  admitted.accept();
  assert.deepEqual(admitted.sent[0], { type: 'auth', token: 'token', incrementalSessions: true });
  admitted.authenticate();
  assert.equal(device.connection.state.status, 'online', 'admitted');
  assert.equal(device.connection.state.limit, undefined);
  device.connection.forget();

  // Ninth connection in all (reason `total`).
  const total = refusedConnection('total');
  assert.equal(total.connection.state.status, 'limited');
  assert.equal(total.connection.state.message, totalText);
  assert.equal(total.connection.state.limit, 'total');

  // Retry with the network down: "offline", and it reconnects when the
  // network returns (as before).
  network.onLine = false;
  total.connection.retryAfterLimit();
  assert.equal(total.connection.state.status, 'offline');
  network.onLine = true;
  fire(windowListeners, 'online');
  assert.equal(FakeSocket.opened.length, total.socketsBefore + 1, 'reconnects with the network');
  total.connection.forget();

  // A named refusal that arrives while the browser already reports itself
  // offline: still the limit page, and the network's return reconnects
  // nothing.
  const { connection: offline, socket: handedOver } = startedConnection();
  network.onLine = false;
  handedOver.refuse(4429, 'device');
  assert.equal(offline.state.status, 'limited', 'limited, not offline');
  const socketsWhileOffline = FakeSocket.opened.length;
  network.onLine = true;
  fire(windowListeners, 'online');
  assert.equal(FakeSocket.opened.length, socketsWhileOffline, 'no reconnect with the network');
  offline.forget();

  // 4429 with an unknown reason or none (an older gateway): the earlier
  // behaviour, the banner's text and a retry with backoff.
  for (const reason of ['crowded', '']) {
    const older = refusedConnection(reason);
    assert.equal(older.connection.state.status, 'reconnecting', `reason "${reason}"`);
    assert.equal(older.connection.state.message, 'Too many phones are connected. Retrying…');
    assert.ok(older.connection.state.retryAt > 0);
    assert.equal(older.connection.state.limit, undefined);
    context.mock.timers.tick(2_000);
    assert.equal(FakeSocket.opened.length, older.socketsBefore + 1, 'retried by itself');
    older.connection.forget();
  }
});

// ---- In the browser, against the real gateway --------------------------------------

/** A page expression: the limit page shows `text`. */
function limitPageShows(text: string): string {
  return `document.querySelector('.shell[data-connection="limited"] .limit-page p')?.textContent === ${JSON.stringify(text)}`;
}

/** The gateway's relayed connections right now. */
function relayCount(fixture: Fixture): number {
  return (fixture.gateway as unknown as { relays: Map<unknown, unknown> }).relays.size;
}

/** One more tab of the browser context `context`, opened on the shell. */
async function openTab(
  fixture: Fixture,
  browser: TestBrowser,
  browserContextId: string,
  width = 1280,
): Promise<{ page: TestPage; sockets: SocketLog }> {
  const { page, sockets } = await desktopPage(browser, width, 800, browserContextId);
  await page.navigate(`${fixture.origin}/`);
  return { page, sockets };
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
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.documentElement.clientWidth === ${width}`);
    await writeFile(join(directory, `shell-${name}-${width}.png`), await page.screenshot());
  }
}

test(
  'the fifth tab shows the device limit page; Retry is refused while the limit holds and works after a tab closed',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await pairedPage(fixture, browser, 1280, 800);
    const tabs: TestPage[] = [first.page];
    for (let index = 2; index <= 4; index++) {
      const { page } = await openTab(fixture, browser, first.browserContextId);
      await page.waitFor(online, 8000);
      tabs.push(page);
    }
    await waitFor(() => relayCount(fixture) === 4);

    // The fifth tab: refused with `device`; the limit page with its text,
    // Retry focused, the page underneath inert.
    const fifth = await openTab(fixture, browser, first.browserContextId);
    await fifth.page.waitFor(limitPageShows(deviceText), 8000);
    assert.equal(
      await fifth.page.evaluate(`document.activeElement?.textContent`),
      'Retry',
      'Retry has the focus',
    );
    assert.equal(await fifth.page.evaluate(`document.querySelector('.shell-content').inert`), true);
    assert.equal(
      await fifth.page.evaluate(`document.querySelector('.connection-banner')`),
      null,
      'no banner with its own Retry now',
    );
    assert.equal(fifth.sockets.urls.length, 1);
    await screenshots(fifth.page, 'limit-device');

    // A sixth tab opened while the page is shown: refused too, its own
    // limit page; nothing else closes.
    const sixth = await openTab(fixture, browser, first.browserContextId);
    await sixth.page.waitFor(limitPageShows(deviceText), 8000);
    assert.equal(relayCount(fixture), 4);
    for (const tab of tabs) {
      assert.equal(await tab.evaluate(online), true, 'the open tabs stay connected');
    }
    await sixth.page.close();

    // Retry while the limit holds: one more attempt, refused again.
    // (The page leaves the limit page while it tries; the refusal may come
    // back before a check could see that, so the test waits for the attempt.)
    await clickButton(fifth.page, 'Retry');
    await waitFor(() => fifth.sockets.urls.length === 2);
    await fifth.page.waitFor(limitPageShows(deviceText), 8000);

    // Another tab closes; once the gateway has let it go, Retry connects.
    await tabs[0].close();
    await waitFor(() => relayCount(fixture) === 3, 5000);
    await clickButton(fifth.page, 'Retry');
    await fifth.page.waitFor(online, 8000);
    assert.equal(fifth.sockets.urls.length, 3, 'one attempt per Retry, none by itself');
    assert.equal(await fifth.page.evaluate(`document.querySelector('.limit-page')`), null);
    assert.equal(
      await fifth.page.evaluate(`document.querySelector('.shell-content').inert`),
      false,
    );

    await assertNoViolations(fifth.page);
  },
);

test('the ninth connection in all shows the total limit page', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const first = await pairedPage(fixture, browser, 1280, 800);

  // Seven more connections of two other devices (4 and 3): eight in all.
  const others: PhoneClient[] = [];
  const url = `ws://127.0.0.1:${fixture.port}/api/socket`;
  for (const [name, count] of [
    ['Device B', 4],
    ['Device C', 3],
  ] as const) {
    const { token } = await fixture.pair(name);
    for (let index = 0; index < count; index++) {
      const client = await connectPhone(url, token, fixture.origin, true);
      await waitFor(() => client.messages.some((message) => message.type === 'authenticated'));
      others.push(client);
    }
  }
  context.after(() => {
    for (const client of others) {
      client.socket.terminate();
    }
  });
  await waitFor(() => relayCount(fixture) === 8);

  // A second tab of the browser (its device has one): refused with `total`.
  const second = await openTab(fixture, browser, first.browserContextId);
  await second.page.waitFor(limitPageShows(totalText), 8000);
  assert.equal(await first.page.evaluate(online), true, 'the first tab stays connected');
  await screenshots(second.page, 'limit-total');

  // One of the other device's connections closes: Retry connects.
  others[0].socket.close();
  await waitFor(() => relayCount(fixture) === 7, 5000);
  await clickButton(second.page, 'Retry');
  await second.page.waitFor(online, 8000);

  await assertNoViolations(second.page);
});
