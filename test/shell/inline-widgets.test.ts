/**
 * Inline widgets in the browser shell, in headless Chromium, against the
 * frame fixture (test/frame-fixture.ts): a real gateway with a frame origin
 * on a second loopback port, a real listener and widget service, and
 * synthetic widgets whose reducers run in Node (the isolated widget renderer
 * is not used). See integrations/shell/README.md, "Inline widgets".
 *
 * Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebSocketServer } from 'ws';

import { chatMessage } from '../../src/agents/types.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { frameFixture } from '../frame-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  click,
  clickButton,
  horizontalOverflow,
  openConversation,
  pairedPage,
  skip,
} from './page.ts';
import {
  attachFrames,
  evaluateInFrame,
  frameErrors,
  frameSetup,
  panelExpression,
  quiet,
  waitInFrame,
  writeShellWidgets,
  type ShellFrameFixture,
} from './widget-page.ts';

type Json = Record<string, any>;

/** Start a conversation titled `title` and return its id and run. */
async function conversation(
  fixture: ShellFrameFixture,
  title: string,
): Promise<{ id: string; run: SyntheticRun }> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length === before + 1);
  return { id, run: fixture.runs[before] };
}

/** The frame address of the widget panel named `name`, from the page's DOM. */
function frameSource(page: TestPage, name: string, index = 0): Promise<string> {
  return page.evaluate<string>(
    `${panelExpression(name, index)}?.querySelector('iframe')?.src ?? ''`,
  );
}

/** No request left the gateway's origin and the frame origin. */
function assertTwoOrigins(fixture: ShellFrameFixture, page: TestPage): void {
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

/** The panel's state as the page shows it. */
function phase(page: TestPage, name: string, index = 0): Promise<string> {
  return page.evaluate<string>(`${panelExpression(name, index)}?.dataset.phase ?? ''`);
}

/** A page expression: the panel's frame height in CSS pixels, or -1. */
function frameHeight(name: string, index = 0): string {
  return `(${panelExpression(name, index)}?.querySelector('iframe')?.getBoundingClientRect().height ?? -1)`;
}

/** How many times the page loaded a frame's document. */
function documentLoads(page: TestPage, address: string): number {
  return page.requests.filter((url) => url === address).length;
}

/** How many state requests a frame made. */
function statePolls(page: TestPage, address: string): number {
  return page.requests.filter((url) => url === address + 'state').length;
}

/** Let the page draw twice, so a change applied in a frame is on screen. */
function drawn(page: TestPage): Promise<unknown> {
  return page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
}

/**
 * With COMPANION_SHELL_SCREENSHOTS naming a directory, saves the panel
 * named `name` in its state at 420 and 1280 px (`inline-<state>-<width>.png`),
 * then returns to `restoreWidth`.
 */
async function screenshots(
  page: TestPage,
  name: string,
  state: string,
  restoreWidth = 1280,
): Promise<void> {
  const directory = process.env.COMPANION_SHELL_SCREENSHOTS;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  for (const width of [420, 1280]) {
    await setWidth(page, width);
    await page.evaluate(`${panelExpression(name)}?.scrollIntoView({ block: 'center' })`);
    await drawn(page);
    await writeFile(join(directory, `inline-${state}-${width}.png`), await page.screenshot());
  }
  await setWidth(page, restoreWidth);
}

async function setWidth(page: TestPage, width: number, height = 800): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`window.innerWidth === ${width}`);
}

/** Scroll the transcript with the mouse wheel, as the reader would, until `expression` holds. */
async function wheelUntil(page: TestPage, deltaY: number, expression: string): Promise<void> {
  for (let step = 0; step < 60; step++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) {
      return;
    }
    const point = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: deltaY,
    });
    await drawn(page);
  }
  await page.waitFor(expression);
}

/** A page expression: the panel named `name` is entirely inside the transcript's view. */
function panelInView(name: string): string {
  return `(() => {
    const panel = ${panelExpression(name)};
    if (!panel) return false;
    const box = panel.getBoundingClientRect();
    const view = document.querySelector('.transcript').getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  })()`;
}

/** A page expression: the panel named `name` is entirely outside the transcript's view. */
function panelOutOfView(name: string): string {
  return `(() => {
    const panel = ${panelExpression(name)};
    if (!panel) return false;
    const box = panel.getBoundingClientRect();
    const view = document.querySelector('.transcript').getBoundingClientRect();
    return box.bottom < view.top || box.top > view.bottom;
  })()`;
}

/**
 * Replace a row of a conversation through the listener's own message path,
 * without a widget attachment. (Backends cannot do this: their message ids
 * are scoped to their run.)
 */
function replaceWithoutWidget(
  fixture: ShellFrameFixture,
  conversationId: string,
  rowId: string,
  text: string,
): void {
  const sessions = fixture.sessions as unknown as {
    sessions: Map<string, unknown>;
    message(session: unknown, message: ReturnType<typeof chatMessage>): void;
  };
  sessions.message(sessions.sessions.get(conversationId), chatMessage(rowId, 'assistant', text));
}

/** Close every WebSocket of the gateway: the browser loses its connection and reconnects. */
function dropConnections(fixture: ShellFrameFixture): void {
  const sockets = (fixture.gateway as unknown as { sockets: WebSocketServer }).sockets;
  for (const socket of sockets.clients) {
    socket.terminate();
  }
}

test(
  'a widget renders inline at the message width, works, and cannot reach the shell',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);

    // The policy is the gateway's: its base policy plus exactly frame-src.
    const response = await fetch(`${fixture.origin}/`);
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src " +
        fixture.frameOrigin,
    );

    const { run } = await conversation(fixture, 'Widget fixture');
    run.emit(chatMessage('answer', 'assistant', 'Here is a counter.'));
    await fixture.publishCounter(run);
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await page.evaluate(`localStorage.setItem('shell-secret', 'synthetic-device-secret')`);
    await openConversation(page, 'Widget fixture');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);

    const address = await frameSource(page, 'counter');
    assert.match(address, new RegExp('^' + fixture.frameOrigin + '/f/[A-Za-z0-9_-]{43}/$'));

    // The iframe's attributes.
    const attributes = await page.evaluate<Json>(`(() => {
      const iframe = ${panelExpression('counter')}.querySelector('iframe');
      return {
        sandbox: iframe.getAttribute('sandbox'),
        allow: iframe.getAttribute('allow'),
        referrer: iframe.getAttribute('referrerpolicy'),
        loading: iframe.getAttribute('loading'),
        src: iframe.getAttribute('src'),
      };
    })()`);
    assert.equal(attributes.sandbox, 'allow-scripts allow-same-origin allow-forms');
    assert.equal(attributes.referrer, 'no-referrer');
    assert.equal(attributes.loading, 'lazy');
    assert.equal(attributes.src, address);
    for (const feature of String(attributes.allow).split(';')) {
      assert.match(feature.trim(), /^[a-z-]+ 'none'$/);
    }

    // The header names the widget and, as message headings do, its time.
    const header = await page.evaluate<Json>(`(() => {
      const header = ${panelExpression('counter')}.querySelector('.inline-widget-header');
      return {
        name: header.querySelector('.inline-widget-name').textContent,
        time: header.querySelector('.message-time')?.textContent ?? '',
        last: header.lastElementChild.className,
      };
    })()`);
    assert.equal(header.name, 'counter');
    assert.match(header.time, /^\d\d:\d\d$/);
    assert.equal(header.last, 'message-time');

    // As wide as the agent's message above it.
    const widths = await page.evaluate<Json>(`(() => {
      const panel = ${panelExpression('counter')};
      const answer = [...document.querySelectorAll('.message.assistant .panel')].find((element) => element.textContent.includes('Here is a counter.'));
      return { panel: panel.getBoundingClientRect().width, answer: answer.getBoundingClientRect().width, frame: panel.querySelector('iframe').getBoundingClientRect().width };
    })()`);
    assert.ok(Math.abs(widths.panel - widths.answer) < 1, JSON.stringify(widths));
    assert.ok(Math.abs(widths.frame - widths.panel) < 1, JSON.stringify(widths));

    // An action in the widget changes its state, saved by the listener and shown.
    await waitInFrame(page, address, `document.getElementById('increment')`, true);
    await evaluateInFrame(page, address, `document.getElementById('increment').click()`, true);
    await waitInFrame(
      page,
      address,
      `document.getElementById('increment')?.textContent === 'Clicks: 1'`,
      true,
    );

    // The frame cannot read the shell's storage.
    assert.equal(
      await evaluateInFrame(page, address, `localStorage.getItem('shell-secret')`),
      null,
    );
    assert.equal(
      await evaluateInFrame(
        page,
        address,
        `(() => { try { return parent.localStorage.getItem('shell-secret'); } catch (error) { return 'blocked: ' + error.name; } })()`,
      ),
      'blocked: SecurityError',
    );

    // Layouts without overflow.
    for (const width of [420, 1600]) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.waitFor(`window.innerWidth === ${width}`);
      assert.equal(await horizontalOverflow(page), 0, `overflow at ${width} px`);
      const box = await page.evaluate<Json>(`(() => {
        const panel = ${panelExpression('counter')}.getBoundingClientRect();
        const chat = document.querySelector('.chat-column').getBoundingClientRect();
        return { left: panel.left, right: panel.right, chatLeft: chat.left, chatRight: chat.right };
      })()`);
      assert.ok(box.left >= box.chatLeft && box.right <= box.chatRight, JSON.stringify(box));
    }

    assertTwoOrigins(fixture, page);
    assert.ok(page.requests.some((url) => url.startsWith(address + 'state')));
    await assertNoViolations(page);
  },
);

test(
  'frame states: shown at the content height, failed with Try again, WebRTC removed',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const { run } = await conversation(fixture, 'States fixture');
    run.emit(chatMessage('answer', 'assistant', 'Two widgets follow.'));
    await fixture.publishWidget(run, 'probe', { label: 'Tall', height: 300 });
    await fixture.publishWidget(run, 'broken', { label: 'Broken' });
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'States fixture');

    // Shown at the content height: 300 px of content plus the frame's
    // 24 px padding (frame.js), within 100–420.
    await page.waitFor(`${panelExpression('probe')}?.dataset.phase === 'shown'`, 15_000);
    await page.waitFor(`${frameHeight('probe')} === 324`);
    await screenshots(page, 'probe', 'shown');

    // Widget code sees no WebRTC, and the child frame it makes is unreachable.
    const probeAddress = await frameSource(page, 'probe');
    await waitInFrame(page, probeAddress, `document.getElementById('probe')?.dataset.webrtc`, true);
    assert.equal(
      await evaluateInFrame(
        page,
        probeAddress,
        `document.getElementById('probe').dataset.webrtc`,
        true,
      ),
      'undefined undefined child blocked SecurityError',
    );

    // Failed: host.js reports the widget's error before any height.
    await page.waitFor(`${panelExpression('broken')}?.dataset.phase === 'failed'`, 15_000);
    const failedText = await page.evaluate<string>(`${panelExpression('broken')}.textContent`);
    assert.match(failedText, /The broken widget could not load\. Synthetic mount failure/);
    assert.match(failedText, /The conversation and the widget's saved data are unchanged\./);
    assert.equal(
      await page.evaluate(`Boolean(${panelExpression('broken')}.querySelector('iframe'))`),
      false,
    );
    await screenshots(page, 'broken', 'failed');

    // Try again: a new frame for the same address, which fails again.
    // (The broken widget's document address: the one frame document that is
    // not the probe's.)
    const documentAddress = new RegExp('^' + fixture.frameOrigin + '/f/[A-Za-z0-9_-]{43}/$');
    const brokenAddress = page.requests.find(
      (url) => documentAddress.test(url) && url !== probeAddress,
    )!;
    const loadsBefore = documentLoads(page, brokenAddress);
    assert.equal(loadsBefore, 1);
    const button = `[...${panelExpression('broken')}.querySelectorAll('button')].find((element) => element.textContent === 'Try again')`;
    await page.evaluate(`${button}.scrollIntoView({ block: 'center' })`);
    await click(page, `.inline-widget[data-phase="failed"] button`);
    await waitFor(() => documentLoads(page, brokenAddress) === loadsBefore + 1, 10_000);
    await page.waitFor(`${panelExpression('broken')}?.dataset.phase === 'failed'`, 15_000);
    assert.equal(documentLoads(page, brokenAddress), loadsBefore + 1);

    // The probe was not touched by the other panel's frame.
    assert.equal(await page.evaluate(frameHeight('probe')), 324);
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'not set up: a gateway without a frame origin shows the widget name only',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context, { frames: false });
    const { run } = await conversation(fixture, 'Unconfigured fixture');
    await fixture.publishCounter(run);
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Unconfigured fixture');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'not-set-up'`);
    // The widget's name, the message's time and one line.
    assert.match(
      await page.evaluate<string>(`${panelExpression('counter')}.textContent`),
      /^🧩counter\d\d:\d\dWidgets are not set up for this browser, so only the widget's name is shown\.$/,
    );
    assert.equal(await page.evaluate(`document.querySelectorAll('iframe').length`), 0);
    await screenshots(page, 'counter', 'not-set-up');
    for (const url of page.requests) {
      assert.ok(url.startsWith(fixture.origin + '/') || url.startsWith('data:'), url);
    }
    await assertNoViolations(page);
  },
);

test(
  'an ended view (upstream 404) stays loading, then fails after 10 seconds in view',
  { skip },
  async (context) => {
    // A widget service that answers 404 for every view, as for a view that ended.
    const directory = await mkdtemp(join(tmpdir(), 'companion-shell-404-'));
    const socketPath = join(directory, 'widgets.sock');
    const upstream = createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unknown widget view' }));
    });
    await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
    const fixture = await frameFixture({
      appDirectory,
      library: writeShellWidgets,
      widgetSocket: socketPath,
    });
    const browser = new TestBrowser();
    await browser.start();
    context.after(async () => {
      await browser.close();
      await fixture.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const { run } = await conversation(fixture, 'Ended fixture');
    await fixture.publishCounter(run);
    run.finish();
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Ended fixture');

    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'loading'`);
    const address = await frameSource(page, 'counter');
    await waitFor(() => documentLoads(page, address) === 1, 5000);
    assert.match(
      await page.evaluate<string>(`${panelExpression('counter')}.textContent`),
      /Loading the counter widget…/,
    );
    await screenshots(page, 'counter', 'loading');

    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'failed'`, 20_000);
    assert.match(
      await page.evaluate<string>(`${panelExpression('counter')}.textContent`),
      /The counter widget could not load\. Its page did not answer within 10 seconds\./,
    );
    assertTwoOrigins(fixture, page);
  },
);

test(
  'disconnected: greyed and paused, back with the same address, then a new address after a restart',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const { run } = await conversation(fixture, 'Reconnect widget');
    await fixture.publishCounter(run);
    run.finish();
    const later = await conversation(fixture, 'Opened offline');
    await fixture.publishWidget(later.run, 'probe', { label: 'Offline', height: 150 });
    later.run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'Reconnect widget');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
    const address = await frameSource(page, 'counter');
    assert.equal(documentLoads(page, address), 1);

    // The connection drops; the gateway (and the device's handles) stay.
    // The shell reconnects by itself after about a second.
    dropConnections(fixture);
    await page.waitFor(`${panelExpression('counter')}?.dataset.connected === 'false'`, 5000);
    const offline = await page.evaluate<Json>(`(() => {
      const panel = ${panelExpression('counter')};
      return {
        visible: panel.dataset.visible,
        classes: panel.className,
        text: panel.textContent,
        inert: panel.querySelector('.inline-widget-frame').inert,
        // The label is not inside the inert part: it stays readable.
        labelInert: panel.querySelector('.inline-widget-cover.offline').closest('[inert]') !== null,
      };
    })()`);
    assert.equal(offline.visible, 'false');
    assert.match(offline.classes, /disconnected/);
    assert.match(offline.text, /Disconnected · reconnecting…/);
    assert.equal(offline.inert, true);
    assert.equal(offline.labelInert, false);

    // Back with the same address: the same frame continues, not loaded again.
    await page.waitFor(`${panelExpression('counter')}?.dataset.connected === 'true'`, 15_000);
    assert.equal(await frameSource(page, 'counter'), address);
    assert.equal(await phase(page, 'counter'), 'shown');
    assert.equal(await page.evaluate(`${panelExpression('counter')}.dataset.visible`), 'true');
    assert.equal(documentLoads(page, address), 1);
    const polls = statePolls(page, address);
    await waitFor(() => statePolls(page, address) >= polls + 2, 5000);

    // Disconnected again, held there by stopping the gateway, for the screenshots.
    await fixture.gateway.close();
    await page.waitFor(`${panelExpression('counter')}?.dataset.connected === 'false'`, 5000);
    await screenshots(page, 'counter', 'disconnected');

    /** A new gateway on the same ports and state, with the frame origin. */
    async function restartGateway(): Promise<Gateway> {
      const replacement = new Gateway({
        host: '127.0.0.1',
        port: fixture.port,
        origins: [fixture.origin],
        stateDirectory: join(fixture.directory, 'remote-state'),
        controlSocket: fixture.desktop.socketPath,
        sessionsDirectory: join(fixture.directory, '.companion-sessions'),
        appDirectory,
        log: () => {},
        frames: {
          listen: { host: '127.0.0.1', port: fixture.framePort },
          origin: fixture.frameOrigin,
        },
      });
      await replacement.start();
      context.after(() => replacement.close());
      return replacement;
    }

    // The gateway restarts: its handles were in memory, so the shell gets a
    // new address for the same widget and loads it.
    const replacement = await restartGateway();

    await page.waitFor(
      `${panelExpression('counter')}?.querySelector('iframe') && ${panelExpression('counter')}.querySelector('iframe').src !== ${JSON.stringify(address)}`,
      20_000,
    );
    const renewed = await frameSource(page, 'counter');
    assert.match(renewed, new RegExp('^' + fixture.frameOrigin + '/f/[A-Za-z0-9_-]{43}/$'));
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
    assert.equal(documentLoads(page, renewed), 1);

    // A conversation opened while disconnected: its widget's frame is not
    // put into the page (nothing loads) until requests are admitted again.
    await replacement.close();
    await page.waitFor(`${panelExpression('counter')}?.dataset.connected === 'false'`, 5000);
    const requestsBefore = page.requests.length;
    await openConversation(page, 'Opened offline');
    await page.waitFor(`${panelExpression('probe')}`);
    const unloaded = await page.evaluate<Json>(`(() => {
      const panel = ${panelExpression('probe')};
      return {
        frame: Boolean(panel.querySelector('iframe')),
        placeholder: panel.querySelector('.inline-widget-placeholder')?.style.height,
        text: panel.textContent,
      };
    })()`);
    assert.deepEqual(
      { frame: unloaded.frame, placeholder: unloaded.placeholder },
      { frame: false, placeholder: '100px' },
    );
    assert.match(unloaded.text, /Disconnected · reconnecting…/);
    assert.deepEqual(
      page.requests.slice(requestsBefore).filter((url) => url.startsWith(fixture.frameOrigin)),
      [],
    );
    await restartGateway();
    await page.waitFor(`${panelExpression('probe')}?.dataset.phase === 'shown'`, 20_000);
    assert.equal(documentLoads(page, await frameSource(page, 'probe')), 1);
    await page.waitFor(`${frameHeight('probe')} === 174`);
    assertTwoOrigins(fixture, page);
  },
);

test(
  'messages, two widgets, a conversation switched and back, and a widget removed',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const first = await conversation(fixture, 'Two widgets');
    const counterId = await fixture.publishCounter(first.run);
    const probeId = await fixture.publishWidget(first.run, 'probe', {
      label: 'Probe',
      height: 200,
    });
    const second = await conversation(fixture, 'Plain conversation');
    second.run.emit(chatMessage('plain', 'assistant', 'Nothing to show here.'));
    second.run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'Two widgets');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
    await page.waitFor(`${panelExpression('probe')}?.dataset.phase === 'shown'`, 15_000);
    await page.waitFor(`${frameHeight('probe')} === 224`);
    const counter = await frameSource(page, 'counter');
    const probe = await frameSource(page, 'probe');
    const counterHeight = await page.evaluate<number>(frameHeight('counter'));
    assert.equal(counterHeight, 100);

    /** Post `message` (a page expression) to the shell from the counter's frame. */
    const fromCounter = (message: string) =>
      evaluateInFrame(page, counter, `parent.postMessage(${message}, '*')`);
    /** A valid height from the counter's frame, to know the earlier ones were handled. */
    async function settle(height: number): Promise<void> {
      await fromCounter(`{ type: 'geometry', height: ${height} }`);
      await page.waitFor(`${frameHeight('counter')} === ${height}`);
    }

    // Out of bounds: clamped. Only that panel changes.
    await fromCounter(`{ type: 'geometry', height: 5000 }`);
    await page.waitFor(`${frameHeight('counter')} === 420`);
    assert.equal(await page.evaluate(frameHeight('probe')), 224);
    await fromCounter(`{ type: 'geometry', height: -50 }`);
    await page.waitFor(`${frameHeight('counter')} === 100`);

    // Ignored: not a number, extra fields, another type, from the shell's own
    // window, from the widget's inner frame, an error after shown.
    await settle(150);
    await fromCounter(`{ type: 'geometry', height: NaN }`);
    await fromCounter(`{ type: 'geometry', height: '300' }`);
    await fromCounter(`{ type: 'geometry', height: 300, token: 'x' }`);
    await fromCounter(`{ type: 'resize', height: 300 }`);
    await fromCounter(`{ type: 'error', text: 'Late failure' }`);
    await page.evaluate(`window.postMessage({ type: 'geometry', height: 300 }, '*')`);
    await evaluateInFrame(
      page,
      counter,
      `top.postMessage({ type: 'geometry', height: 300 }, '*')`,
      true,
    );
    await evaluateInFrame(
      page,
      counter,
      `parent.postMessage({ type: 'geometry', height: 300 }, '*')`,
      true,
    );
    await evaluateInFrame(
      page,
      probe,
      `parent.postMessage({ type: 'geometry', height: 300 }, '*')`,
    );
    await page.waitFor(`${frameHeight('probe')} === 300`);
    await settle(160);
    assert.equal(await phase(page, 'counter'), 'shown');

    // A burst of 1,000 heights: the page applies at most one per 100 ms
    // (measured where they are applied), and the last one (410, outside the
    // burst's own 101–400) wins.
    await page.evaluate(`(() => {
      window.__heights = [];
      const frame = ${panelExpression('counter')}.querySelector('iframe');
      new MutationObserver(() => window.__heights.push({ height: frame.style.height, at: performance.now() })).observe(frame, { attributes: true, attributeFilter: ['style'] });
    })()`);
    await evaluateInFrame(
      page,
      counter,
      `(() => { for (let index = 0; index < 999; index++) { parent.postMessage({ type: 'geometry', height: 101 + (index % 300) }, '*'); } parent.postMessage({ type: 'geometry', height: 410 }, '*'); })()`,
    );
    await page.waitFor(`${frameHeight('counter')} === 410`);
    const applied = await page.evaluate<{ height: string; at: number }[]>(`window.__heights`);
    for (let index = 1; index < applied.length; index++) {
      // Timer granularity allows a few milliseconds early.
      assert.ok(applied[index].at - applied[index - 1].at >= 95, JSON.stringify(applied));
    }
    assert.equal(applied.at(-1)!.height, '410px');

    // Another conversation: both frames go, and nothing polls for them.
    await openConversation(page, 'Plain conversation');
    await page.waitFor(`document.querySelectorAll('.inline-widget').length === 0`);
    await drawn(page);
    const polls = await quiet(() => statePolls(page, counter) + statePolls(page, probe));
    assert.equal(await quiet(() => statePolls(page, counter) + statePolls(page, probe)), polls);

    // Back: both load again, the probe at the height it last had (300, the
    // last one it reported here), and both are shown again. The height the
    // probe's frame has when it is put into the page is recorded at once.
    await page.evaluate(`(() => {
      window.__firstProbeHeight = null;
      const observer = new MutationObserver(() => {
        const frame = ${panelExpression('probe')}?.querySelector('iframe');
        if (frame && window.__firstProbeHeight === null) {
          window.__firstProbeHeight = frame.style.height;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })()`);
    await openConversation(page, 'Two widgets');
    await page.waitFor(`window.__firstProbeHeight !== null`);
    assert.equal(await page.evaluate(`window.__firstProbeHeight`), '300px');
    await page.waitFor(`${panelExpression('probe')}?.dataset.phase === 'shown'`, 15_000);
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
    assert.equal(documentLoads(page, counter), 2);
    assert.equal(documentLoads(page, probe), 2);

    // The widget removed from its message: the listener replaces the row
    // without its attachment (as when a reopened conversation's widget
    // bundle is missing). The message is text, the frame gone.
    replaceWithoutWidget(fixture, first.id, 'widget:' + probeId, 'The probe was removed.');
    await page.waitFor(`!${panelExpression('probe')}`);
    await page.waitFor(
      `[...document.querySelectorAll('.message.assistant .bubble')].some((bubble) => bubble.textContent.includes('The probe was removed.'))`,
    );
    assert.equal(await phase(page, 'counter'), 'shown');
    assert.equal(counterId.length > 0, true);
    first.run.finish();
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
    assert.deepEqual(frameErrors(page), []);
  },
);

test(
  'visibility: scrolled out of view, behind the settings screen and the narrow Activity overlay',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const { run } = await conversation(fixture, 'Visibility fixture');
    run.emit(chatMessage('before', 'assistant', 'The widget is below.'));
    await fixture.publishCounter(run);
    for (let index = 0; index < 30; index++) {
      run.emit(
        chatMessage(
          'after-' + index,
          'assistant',
          `Later answer ${index}. ` + 'Words. '.repeat(40),
        ),
      );
    }
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'Visibility fixture');

    // At the live end the widget is far above: not visible.
    await page.waitFor(`${panelExpression('counter')}`);
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'false'`);

    // Scrolled into view (by the reader's wheel): it loads, is shown and polls.
    await wheelUntil(page, -400, panelInView('counter'));
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'true'`);
    const address = await frameSource(page, 'counter');
    let polls = statePolls(page, address);
    await waitFor(() => statePolls(page, address) >= polls + 2, 5000);

    // Scrolled out of view: told it is not visible, and it stops polling
    // (a poll already on its way may still arrive first).
    await wheelUntil(page, 400, panelOutOfView('counter'));
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'false'`);
    polls = await quiet(() => statePolls(page, address));
    assert.equal(await quiet(() => statePolls(page, address)), polls);

    // Back in view: polling resumes.
    await wheelUntil(page, -400, panelInView('counter'));
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'true'`);
    await waitFor(() => statePolls(page, address) >= polls + 2, 5000);

    // Behind the settings screen.
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.settings-layer')`);
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'false'`);
    await click(page, '.settings-toggle');
    await page.waitFor(`!document.querySelector('.settings-layer')`);
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'true'`);

    // A narrow window with the Activity column over the chat.
    await setWidth(page, 420);
    await wheelUntil(page, -200, panelInView('counter'));
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'true'`);
    await click(page, '.chat-bar .activity-toggle');
    await page.waitFor(`document.querySelector('.activity-column')`);
    await page.waitFor(`${panelExpression('counter')}.dataset.visible === 'false'`);
    assert.equal(await horizontalOverflow(page), 0);
    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'scrolling with the wheel over a widget leaves the live end and stays there',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const { run } = await conversation(fixture, 'Wheel fixture');
    for (let index = 0; index < 20; index++) {
      run.emit(
        chatMessage(
          'earlier-' + index,
          'assistant',
          `Earlier answer ${index}. ` + 'Words. '.repeat(30),
        ),
      );
    }
    await fixture.publishWidget(run, 'probe', { label: 'Under the pointer', height: 380 });
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await attachFrames(browser, page);
    await openConversation(page, 'Wheel fixture');
    await page.waitFor(`${panelExpression('probe')}?.dataset.phase === 'shown'`, 15_000);
    const transcript = `document.querySelector('.transcript')`;
    const atEnd = `(${transcript}.scrollTop + ${transcript}.clientHeight >= ${transcript}.scrollHeight - 4)`;
    await page.waitFor(atEnd);

    // The pointer over the widget's frame, which cannot scroll itself: the
    // wheel scrolls the transcript, and the view stays where the reader
    // took it (the chat page used to pull it back to the end).
    const point = await page.evaluate<{ x: number; y: number }>(`(() => {
      const box = ${panelExpression('probe')}.querySelector('iframe').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const before = await page.evaluate<number>(`${transcript}.scrollTop`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: -300,
    });
    await page.waitFor(`${transcript}.scrollTop < ${before - 100}`);
    const moved = await page.evaluate<number>(`${transcript}.scrollTop`);
    // The chat page pulled the view back within a frame or two before the
    // fix; the view now stays, and Jump to latest is offered.
    await drawn(page);
    await drawn(page);
    assert.equal(await page.evaluate<number>(`${transcript}.scrollTop`), moved);
    await page.waitFor(`document.querySelector('button.latest')`);
    await assertNoViolations(page);
  },
);

test(
  'a page opened before the frame origin was set up says to reload it',
  { skip },
  async (context) => {
    const { fixture, browser } = await frameSetup(context, { frames: false });
    const { run } = await conversation(fixture, 'Set up later');
    await fixture.publishCounter(run);
    run.finish();

    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Set up later');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'not-set-up'`);

    // The gateway restarts with a frame origin; the open page still has the
    // policy it was loaded with, which has no frame-src for it.
    await fixture.gateway.close();
    const replacement = new Gateway({
      host: '127.0.0.1',
      port: fixture.port,
      origins: [fixture.origin],
      stateDirectory: join(fixture.directory, 'remote-state'),
      controlSocket: fixture.desktop.socketPath,
      sessionsDirectory: join(fixture.directory, '.companion-sessions'),
      appDirectory,
      log: () => {},
      frames: {
        listen: { host: '127.0.0.1', port: fixture.framePort },
        origin: fixture.frameOrigin,
      },
    });
    await replacement.start();
    context.after(() => replacement.close());

    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'failed'`, 20_000);
    assert.match(
      await page.evaluate<string>(`${panelExpression('counter')}.textContent`),
      /The counter widget could not load\. This page was opened before widgets were set up for it\. Reload the page to show them\./,
    );

    // Reloaded, the page has the gateway's new policy and shows the widget.
    await page.navigate(`${fixture.origin}/`);
    await openConversation(page, 'Set up later');
    await page.waitFor(`${panelExpression('counter')}?.dataset.phase === 'shown'`, 15_000);
  },
);
