/**
 * Pinned widgets in the browser shell, in headless Chromium, against the
 * frame fixture (test/frame-fixture.ts): a real gateway with a frame origin
 * on a second loopback port, a real listener and widget service, and
 * synthetic widgets whose reducers run in Node. See
 * integrations/shell/README.md, "Pinned widgets".
 *
 * Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { widgetTools } from '../../src/agents/widget-tools.ts';
import { frame, signal } from '../helpers.ts';
import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  clickAt,
  desktopPage,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  skip,
} from './page.ts';
import {
  attachFrames,
  evaluateInFrame,
  frameSetup,
  quiet,
  waitInFrame,
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

/** A page expression: the widget panel named `name` in the chat (not the pinned one). */
function chatPanel(name: string): string {
  return `[...document.querySelectorAll('.transcript .inline-widget')].find((panel) => panel.querySelector('.inline-widget-name')?.textContent === ${JSON.stringify(name)})`;
}

/** A page expression: the pinned widget's panel, or undefined. */
const pinnedPanel = `document.querySelector('#pinned-widget .pinned-widget')`;

/** A page expression: where the pinned widget is ('top', 'right' or ''). */
const pinnedPlace = `(document.querySelector('#pinned-widget')?.classList.contains('pinned-band') ? 'top' : document.querySelector('#pinned-widget')?.classList.contains('pinned-side') ? 'right' : '')`;

function place(page: TestPage): Promise<string> {
  return page.evaluate<string>(pinnedPlace);
}

/** Wait until the pinned widget is shown at `where` and its frame is shown. */
async function shownAt(page: TestPage, where: 'top' | 'right'): Promise<void> {
  await page.waitFor(`${pinnedPlace} === ${JSON.stringify(where)}`, 10_000);
  await page.waitFor(`${pinnedPanel}?.dataset.phase === 'shown'`, 15_000);
}

/** The pinned frame's address. */
function pinnedAddress(page: TestPage): Promise<string> {
  return page.evaluate<string>(`${pinnedPanel}?.querySelector('iframe')?.src ?? ''`);
}

async function setSize(page: TestPage, width: number, height: number): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`);
}

/** Press the button of the pinned panel (or `scope`) whose text is `label`. */
async function press(page: TestPage, label: string, scope = pinnedPanel): Promise<void> {
  const button = `[...(${scope}?.querySelectorAll('button') ?? [])].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
  await page.waitFor(`${button} && ${button}.getAttribute('aria-disabled') !== 'true'`, 10_000);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = ${button}.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
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

/** The listener's own (loopback, desktop) view address of the widget `widgetId`. */
function desktopViewUrl(fixture: ShellFrameFixture, conversationId: string, widgetId: string) {
  const session = fixture.sessions.snapshot().find((candidate) => candidate.id === conversationId);
  const candidates = [...(session?.messages ?? [])];
  if (session?.pinnedMessage) {
    candidates.push(session.pinnedMessage);
  }
  const message = candidates.find((candidate) => candidate.widget?.id === widgetId);
  assert.ok(message?.widget?.viewUrl, 'the listener has the widget');
  return message.widget.viewUrl;
}

/** The desktop pins or unpins a widget: its own `present` request (WidgetSurface.qml). */
async function presentOnDesktop(
  fixture: ShellFrameFixture,
  conversationId: string,
  widgetId: string,
  placement: 'pinned' | 'inline',
): Promise<void> {
  const viewUrl = desktopViewUrl(fixture, conversationId, widgetId);
  const response = await fetch(viewUrl + '/present', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presentation: { placement }, requestId: 'desktop-' + Math.random() }),
  });
  assert.equal(response.status, 200, await response.text());
}

/** The widget's placement as the listener has it. */
function listenerPlacement(fixture: ShellFrameFixture, conversationId: string): string {
  const session = fixture.sessions.snapshot().find((candidate) => candidate.id === conversationId);
  return session?.pinnedMessage ? 'pinned' : 'inline';
}

/**
 * A conversation with an answer and a counter widget, pinned or inline,
 * in a fresh paired page at `width` × `height`.
 */
async function pinnedSetup(
  context: { after(callback: () => Promise<void>): void },
  options: { placement: 'pinned' | 'inline'; width: number; height: number; title?: string },
) {
  const { fixture, browser } = await frameSetup(context);
  const title = options.title ?? 'Pinned fixture';
  const { id, run } = await conversation(fixture, title);
  run.emit(chatMessage('answer', 'assistant', 'Here is a counter.'));
  const widgetId = await fixture.publishCounter(run, { placement: options.placement });
  run.finish();

  const { page, browserContextId } = await pairedPage(
    fixture,
    browser,
    options.width,
    options.height,
  );
  await attachFrames(browser, page);
  await openConversation(page, title);
  return { fixture, browser, page, browserContextId, id, run, widgetId, title };
}

test(
  'a pinned widget sits at the top of a tall window and on the right of a wide one, and moves when the shape changes',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 900,
      height: 1000,
    });

    // Tall: a band above the chat, 25 % of the area below the bar.
    await shownAt(page, 'top');
    const band = await page.evaluate<Json>(`(() => {
      const band = document.querySelector('#pinned-widget').getBoundingClientRect();
      const body = document.querySelector('.main-body').getBoundingClientRect();
      const chat = document.querySelector('.chat-column').getBoundingClientRect();
      return { top: band.top, height: band.height, bodyTop: body.top, bodyHeight: body.height, chatTop: chat.top };
    })()`);
    assert.ok(Math.abs(band.top - band.bodyTop) < 1, JSON.stringify(band));
    assert.ok(
      Math.abs(band.height - Math.round(band.bodyHeight * 0.25)) <= 1,
      JSON.stringify(band),
    );
    assert.ok(band.chatTop >= band.top + band.height - 1, JSON.stringify(band));

    // Its message in the chat says it is pinned, without a second frame.
    await page.waitFor(`${chatPanel('counter')}?.dataset.phase === 'pinned'`);
    assert.equal(await page.evaluate(`document.querySelectorAll('iframe').length`), 1);

    // Wide: the right column, as wide as the Activity column would be.
    await setSize(page, 1280, 800);
    await shownAt(page, 'right');
    const side = await page.evaluate<Json>(`(() => {
      const column = document.querySelector('.side-column').getBoundingClientRect();
      const chat = document.querySelector('.chat-column').getBoundingClientRect();
      return { left: column.left, right: column.right, width: column.width, height: column.height, chatRight: chat.right };
    })()`);
    assert.equal(side.width, 320);
    assert.equal(side.right, 1280);
    assert.ok(side.chatRight <= side.left + 1, JSON.stringify(side));
    assert.equal(await page.evaluate(`document.querySelector('.band-edge')`), null);

    // Tall again: back at the top.
    await setSize(page, 900, 1000);
    await shownAt(page, 'top');

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

/** The size the widget service last recorded for the widget (what an agent sees). */
function recordedViewport(fixture: ShellFrameFixture, widgetId: string): Json | undefined {
  const service = (
    fixture.sessions as unknown as { widgets: { nativeViewports: Map<string, Json> } }
  ).widgets;
  return service.nativeViewports.get(widgetId);
}

/** The value of one of this browser's layout entries, or null. */
function storedEntry(page: TestPage, name: string): Promise<unknown> {
  return page.evaluate(
    `JSON.parse(localStorage.getItem('companion.shell.layout.${name}') ?? 'null')?.value ?? null`,
  );
}

async function reload(page: TestPage, origin: string, title: string): Promise<void> {
  await page.navigate(`${origin}/`);
  await page.waitFor(online, 8000);
  await openConversation(page, title);
}

test(
  'each fixed place and Auto, after a reload; two tabs share the place; below 640 px always at the top',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser, page, browserContextId, title } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 1280,
      height: 800,
    });

    // Wide, Auto: at the right; the header offers ↑ Top and Unpin, no Auto.
    await shownAt(page, 'right');
    const offered = () =>
      page.evaluate<string[]>(
        `[...${pinnedPanel}.querySelectorAll('.inline-widget-actions button')].map((button) => button.textContent.trim())`,
      );
    assert.deepEqual(await offered(), ['↑ Top', 'Unpin']);

    // ↑ Top fixes the top for this browser, also after a reload.
    await press(page, '↑ Top');
    await shownAt(page, 'top');
    assert.equal(await storedEntry(page, 'pinnedPlace'), 'top');
    assert.deepEqual(await offered(), ['▾ Fold', '→ Right', 'Auto', 'Unpin']);
    await reload(page, fixture.origin, title);
    await shownAt(page, 'top');

    // Auto: by the shape again (wide: right).
    await press(page, 'Auto');
    await shownAt(page, 'right');
    assert.equal(await storedEntry(page, 'pinnedPlace'), 'auto');

    // A tall window: at the top; → Right fixes the right, also after a reload.
    await setSize(page, 900, 1000);
    await shownAt(page, 'top');
    await press(page, '→ Right');
    await shownAt(page, 'right');
    await reload(page, fixture.origin, title);
    await shownAt(page, 'right');

    // Below 640 px always at the top, without → Right; wider again: right.
    await setSize(page, 600, 1000);
    await shownAt(page, 'top');
    assert.deepEqual(await offered(), ['▾ Fold', 'Auto', 'Unpin']);
    assert.equal(await horizontalOverflow(page), 0);
    await setSize(page, 900, 1000);
    await shownAt(page, 'right');

    // A second tab of this browser follows each place the other fixes.
    const second = (await desktopPage(browser, 900, 1000, browserContextId)).page;
    await attachFrames(browser, second);
    await second.navigate(`${fixture.origin}/`);
    await second.waitFor(online, 8000);
    await openConversation(second, title);
    await shownAt(second, 'right');
    await press(second, '↑ Top');
    await shownAt(second, 'top');
    // The first tab, brought to the front (a hidden tab does not load lazy frames).
    await page.call('Page.bringToFront');
    await shownAt(page, 'top');
    await press(page, 'Auto');
    await shownAt(page, 'top');
    await second.call('Page.bringToFront');
    await second.waitFor(
      `![...${pinnedPanel}.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Auto')`,
    );
    assert.equal(await storedEntry(second, 'pinnedPlace'), 'auto');

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'on the right the Activity column sits below the widget; the divider sets the width of both',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 1600,
      height: 900,
    });
    await shownAt(page, 'right');

    // Alone, the widget has the whole column.
    const alone = await page.evaluate<Json>(`(() => {
      const column = document.querySelector('.side-column').getBoundingClientRect();
      const widget = document.querySelector('#pinned-widget').getBoundingClientRect();
      return { column: column.height, widget: widget.height };
    })()`);
    assert.ok(Math.abs(alone.column - alone.widget) < 1, JSON.stringify(alone));

    // Activity shown: below the widget in the same column, each half.
    const show = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.chat-bar .activity-toggle').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await clickAt(page, show);
    await page.waitFor(`document.querySelector('.side-column .activity-column')`);
    const shared = await page.evaluate<Json>(`(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return { column: box('.side-column'), widget: box('#pinned-widget'), activity: box('.activity-column') };
    })()`);
    assert.ok(Math.abs(shared.widget.top - shared.column.top) < 1, JSON.stringify(shared));
    assert.ok(Math.abs(shared.activity.top - shared.widget.bottom) < 1, JSON.stringify(shared));
    assert.ok(Math.abs(shared.activity.bottom - shared.column.bottom) < 1, JSON.stringify(shared));
    assert.ok(Math.abs(shared.widget.height - shared.activity.height) < 2, JSON.stringify(shared));
    assert.equal(shared.activity.width, shared.column.width);

    // The divider widens both.
    await page.evaluate(`document.querySelector('.activity-divider').focus()`);
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' });
    await page.waitFor(
      `document.querySelector('.side-column').getBoundingClientRect().width === 520`,
    );
    assert.equal(
      await page.evaluate(`document.querySelector('#pinned-widget').getBoundingClientRect().width`),
      520,
    );
    assert.equal(await horizontalOverflow(page), 0);

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  "Fold and the band's dragged height, each after a reload; the widget's own height until then",
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser } = await frameSetup(context);
    const title = 'Band fixture';
    const { run } = await conversation(fixture, title);
    run.emit(chatMessage('answer', 'assistant', 'Here is a counter.'));
    await fixture.publishCounter(run, { placement: 'pinned', heightPercent: 40 });
    run.finish();
    const { page } = await pairedPage(fixture, browser, 900, 1000);
    await attachFrames(browser, page);
    await openConversation(page, title);
    await shownAt(page, 'top');

    /** The band's height as a share of the area below the bar, in percent. */
    const share = () =>
      page.evaluate<number>(`(() => {
        const band = document.querySelector('#pinned-widget').getBoundingClientRect();
        const body = document.querySelector('.main-body').getBoundingClientRect();
        return Math.round(band.height / body.height * 100);
      })()`);

    // The widget asks for 40 %.
    assert.equal(await share(), 40);
    assert.equal(await storedEntry(page, 'pinnedHeight'), null);

    /** Drag the band's lower edge to `percent` of the area below the bar. */
    async function dragTo(percent: number): Promise<void> {
      const points = await page.evaluate<Json>(`(() => {
        const edge = document.querySelector('.band-edge').getBoundingClientRect();
        const body = document.querySelector('.main-body').getBoundingClientRect();
        return { x: edge.left + edge.width / 2, y: edge.top + edge.height / 2, target: body.top + body.height * ${percent} / 100 };
      })()`);
      const before = await storedEntry(page, 'pinnedHeight');
      const base = { x: points.x, button: 'left', clickCount: 1 };
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y });
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, y: points.y });
      for (const step of [0.5, 1]) {
        const y = points.y + (points.target - points.y) * step;
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: points.x,
          y,
          button: 'left',
          buttons: 1,
        });
      }
      // Nothing is remembered while dragging.
      assert.equal(await storedEntry(page, 'pinnedHeight'), before);
      await page.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...base,
        y: points.target,
      });
    }

    await dragTo(55);
    await page.waitFor(
      `${JSON.stringify(55)} === JSON.parse(localStorage.getItem('companion.shell.layout.pinnedHeight'))?.value`,
    );
    assert.equal(await share(), 55);
    // Beyond the bounds: 70 % and 10 % (the lower bound at least 80 px).
    await page.evaluate(`localStorage.removeItem('companion.shell.layout.pinnedHeight')`);
    await dragTo(95);
    await page.waitFor(
      `JSON.parse(localStorage.getItem('companion.shell.layout.pinnedHeight'))?.value === 70`,
    );
    assert.equal(await share(), 70);
    await dragTo(2);
    await page.waitFor(
      `JSON.parse(localStorage.getItem('companion.shell.layout.pinnedHeight'))?.value === 10`,
    );
    assert.equal(await share(), 10);

    // The keyboard: ArrowDown makes it taller by 5 %, remembered at once.
    await page.evaluate(`document.querySelector('.band-edge').focus()`);
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    await page.waitFor(
      `JSON.parse(localStorage.getItem('companion.shell.layout.pinnedHeight'))?.value === 15`,
    );
    assert.equal(await share(), 15);
    assert.equal(
      await page.evaluate(`document.querySelector('.band-edge').getAttribute('aria-valuenow')`),
      '15',
    );

    // After a reload: as dragged.
    await reload(page, fixture.origin, title);
    await shownAt(page, 'top');
    assert.equal(await share(), 15);

    // Fold: the band is its header; the frame stays loaded but is not visible.
    await press(page, '▾ Fold');
    await page.waitFor(`${pinnedPanel}.classList.contains('folded')`);
    const folded = await page.evaluate<Json>(`(() => {
      const band = document.querySelector('#pinned-widget').getBoundingClientRect();
      const header = document.querySelector('#pinned-widget .inline-widget-header').getBoundingClientRect();
      return { band: band.height, header: header.height, edge: Boolean(document.querySelector('.band-edge')), visible: ${pinnedPanel}.dataset.visible };
    })()`);
    assert.ok(Math.abs(folded.band - folded.header) <= 1, JSON.stringify(folded));
    assert.equal(folded.edge, false);
    assert.equal(folded.visible, 'false');
    assert.equal(await storedEntry(page, 'pinnedFolded'), true);
    const address = await pinnedAddress(page);
    const polls = await quiet(
      () => page.requests.filter((url) => url === address + 'state').length,
    );
    assert.equal(
      await quiet(() => page.requests.filter((url) => url === address + 'state').length),
      polls,
    );

    // After a reload: still folded; ▸ Show unfolds at its height.
    await reload(page, fixture.origin, title);
    await page.waitFor(`${pinnedPanel}?.classList.contains('folded')`, 10_000);
    await press(page, '▸ Show');
    await page.waitFor(`!${pinnedPanel}.classList.contains('folded')`);
    await page.waitFor(`${pinnedPanel}.dataset.visible === 'true'`, 10_000);
    assert.equal(await share(), 15);
    assert.equal(await storedEntry(page, 'pinnedFolded'), false);

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'Pin on an inline widget and Unpin; the same change made on the desktop and in another tab shows here',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, browser, page, browserContextId, id, widgetId, title } = await pinnedSetup(
      context,
      { placement: 'inline', width: 1280, height: 800 },
    );

    // Inline: its header has Pin, once the frame is shown.
    await page.waitFor(`${chatPanel('counter')}?.dataset.phase === 'shown'`, 15_000);
    assert.equal(await page.evaluate(`document.querySelector('#pinned-widget')`), null);
    await press(page, 'Pin', chatPanel('counter'));
    await waitFor(() => listenerPlacement(fixture, id) === 'pinned', 5000);
    await shownAt(page, 'right');
    await page.waitFor(`${chatPanel('counter')}?.dataset.phase === 'pinned'`);
    assert.equal(await page.evaluate(`document.querySelectorAll('iframe').length`), 1);

    // Unpin: back in the chat.
    await press(page, 'Unpin');
    await waitFor(() => listenerPlacement(fixture, id) === 'inline', 5000);
    await page.waitFor(`!document.querySelector('#pinned-widget')`);
    await page.waitFor(`${chatPanel('counter')}?.dataset.phase === 'shown'`, 15_000);

    // Pinned and unpinned on the desktop (its own present request).
    await presentOnDesktop(fixture, id, widgetId, 'pinned');
    await shownAt(page, 'right');
    await presentOnDesktop(fixture, id, widgetId, 'inline');
    await page.waitFor(`!document.querySelector('#pinned-widget')`);

    // Pinned in another tab of this browser.
    const second = (await desktopPage(browser, 1280, 800, browserContextId)).page;
    await attachFrames(browser, second);
    await second.navigate(`${fixture.origin}/`);
    await second.waitFor(online, 8000);
    await openConversation(second, title);
    await second.waitFor(`${chatPanel('counter')}?.dataset.phase === 'shown'`, 15_000);
    await press(second, 'Pin', chatPanel('counter'));
    await shownAt(second, 'right');
    await page.call('Page.bringToFront');
    await shownAt(page, 'right');

    // Another conversation: no pinned widget; back: shown again.
    const other = await conversation(fixture, 'Other fixture');
    other.run.emit(chatMessage('other-answer', 'assistant', 'Nothing pinned here.'));
    other.run.finish();
    await openConversation(page, 'Other fixture');
    await page.waitFor(`!document.querySelector('#pinned-widget')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('iframe').length`), 0);
    await openConversation(page, title);
    await shownAt(page, 'right');

    // An agent pins another widget of the conversation: it replaces the first.
    const next = fixture.runs.length;
    fixture.sessions.followUp(id, 'Another one', signal());
    await waitFor(() => fixture.runs.length === next + 1);
    const followUp = fixture.runs[next];
    await fixture.publishCounter(followUp, { placement: 'pinned' });
    followUp.finish();
    await page.waitFor(
      `document.querySelectorAll('.transcript .inline-widget[data-phase="shown"]').length === 1 && document.querySelectorAll('.transcript .inline-widget[data-phase="pinned"]').length === 1`,
      15_000,
    );
    await shownAt(page, 'right');
    assert.notEqual(desktopViewUrl(fixture, id, widgetId), '');

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'the pinned frame cannot reach the shell; the policy is unchanged; its real size is reported; 420, 1280 and 1600 px without overflow',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page, widgetId } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 1280,
      height: 800,
    });

    // The gateway's policy: its base plus exactly frame-src.
    const response = await fetch(`${fixture.origin}/`);
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src " +
        fixture.frameOrigin,
    );

    await shownAt(page, 'right');
    const address = await pinnedAddress(page);
    assert.match(address, new RegExp('^' + fixture.frameOrigin + '/f/[A-Za-z0-9_-]{43}/$'));
    const attributes = await page.evaluate<Json>(`(() => {
      const iframe = ${pinnedPanel}.querySelector('iframe');
      return { sandbox: iframe.getAttribute('sandbox'), referrer: iframe.getAttribute('referrerpolicy') };
    })()`);
    assert.equal(attributes.sandbox, 'allow-scripts allow-same-origin allow-forms');
    assert.equal(attributes.referrer, 'no-referrer');

    // No access to the shell's storage.
    await page.evaluate(`localStorage.setItem('shell-secret', 'synthetic-device-secret')`);
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

    // It works: an action changes its state.
    await waitInFrame(page, address, `document.getElementById('increment')`, true);
    await evaluateInFrame(page, address, `document.getElementById('increment').click()`, true);
    await waitInFrame(
      page,
      address,
      `document.getElementById('increment')?.textContent === 'Clicks: 1'`,
      true,
    );

    // The size it gets is recorded for agents (the desktop's viewport report).
    const frameBox = await page.evaluate<Json>(`(() => {
      const box = ${pinnedPanel}.querySelector('iframe').getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    })()`);
    await waitFor(
      () =>
        recordedViewport(fixture, widgetId)?.widthCssPixels === frameBox.width &&
        recordedViewport(fixture, widgetId)?.heightCssPixels === frameBox.height,
      5000,
    );
    assert.equal(recordedViewport(fixture, widgetId)?.textScale, 1);

    // A resize that changes its place reports the new size.
    await setSize(page, 800, 1000);
    await shownAt(page, 'top');
    const topBox = await page.evaluate<Json>(`(() => {
      const box = ${pinnedPanel}.querySelector('iframe').getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    })()`);
    await waitFor(
      () =>
        recordedViewport(fixture, widgetId)?.widthCssPixels === topBox.width &&
        recordedViewport(fixture, widgetId)?.heightCssPixels === topBox.height,
      5000,
    );

    for (const [width, height] of [
      [420, 800],
      [1280, 800],
      [1600, 900],
    ]) {
      await setSize(page, width, height);
      await page.waitFor(`${pinnedPanel}?.dataset.phase === 'shown'`, 15_000);
      assert.equal(await horizontalOverflow(page), 0, `overflow at ${width} px`);
      const inside = await page.evaluate<boolean>(`(() => {
        const box = document.querySelector('#pinned-widget').getBoundingClientRect();
        return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight;
      })()`);
      assert.ok(inside, `the pinned widget inside the window at ${width} px`);
    }

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'a pinned frame behind the narrow Activity column is not visible; the settings screen takes it away until it is left',
  { skip, timeout: 120_000 },
  async (context) => {
    const { fixture, page } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 420,
      height: 800,
    });
    await shownAt(page, 'top');
    await page.waitFor(`${pinnedPanel}.dataset.visible === 'true'`);

    // The Activity column over the chat (a narrow window) covers the band.
    const toggle = async (selector: string) => {
      const point = await page.evaluate<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await clickAt(page, point);
    };
    await toggle('.chat-bar .activity-toggle');
    await page.waitFor(`document.querySelector('.activity-column.overlay')`);
    await page.waitFor(`${pinnedPanel}.dataset.visible === 'false'`);
    const address = await pinnedAddress(page);
    const polls = () => page.requests.filter((url) => url === address + 'state').length;
    const paused = await quiet(polls);
    assert.equal(await quiet(polls), paused);
    await toggle('.activity-column .activity-toggle');
    await page.waitFor(`${pinnedPanel}.dataset.visible === 'true'`);
    await waitFor(() => polls() >= paused + 2, 5000);

    // The settings screen: no pinned widget; left by the gear, it loads again.
    await toggle('.chat-bar button[aria-label="Settings"]');
    await page.waitFor(`document.querySelector('.settings-layer')`);
    await page.waitFor(`!document.querySelector('#pinned-widget')`);
    await toggle('.chat-bar button[aria-label="Settings"]');
    await shownAt(page, 'top');

    assertTwoOrigins(fixture, page);
    await assertNoViolations(page);
  },
);

test(
  'screenshots of the pinned widget at 420, 1280 and 1600 px',
  {
    skip:
      skip ||
      (process.env.COMPANION_SHELL_SCREENSHOTS ? false : 'COMPANION_SHELL_SCREENSHOTS not set'),
    timeout: 120_000,
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { page } = await pinnedSetup(context, {
      placement: 'pinned',
      width: 1280,
      height: 800,
    });

    async function save(name: string, width: number, height: number): Promise<void> {
      await setSize(page, width, height);
      await page.waitFor(`${pinnedPanel}?.dataset.phase === 'shown'`, 15_000);
      await page.evaluate(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      );
      await writeFile(join(directory, `pinned-${name}-${width}.png`), await page.screenshot());
    }

    // At the top: 420 px (always), and 1280 px with the top fixed.
    await save('top', 420, 800);
    await setSize(page, 1280, 800);
    await shownAt(page, 'right');
    await press(page, '↑ Top');
    await shownAt(page, 'top');
    await save('top', 1280, 800);
    await save('top', 1600, 900);
    // Folded at the top.
    await press(page, '▾ Fold');
    await page.waitFor(`${pinnedPanel}.classList.contains('folded')`);
    await save('folded', 420, 800);
    await save('folded', 1280, 800);
    await press(page, '▸ Show');
    // On the right (Auto), alone and with Activity below.
    await press(page, 'Auto');
    await save('right', 1280, 800);
    await save('right', 1600, 900);
    const point = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.chat-bar .activity-toggle').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await clickAt(page, point);
    await page.waitFor(`document.querySelector('.side-column .activity-column')`);
    await save('right-activity', 1280, 800);
    await save('right-activity', 1600, 900);
  },
);
