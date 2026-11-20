import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { UserSensorProcessor } from '../../src/core/frame.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { notAdmitted } from '../../src/capture-storage/policy.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { artifactPath } from '../../src/desktop/artifacts.ts';
import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  assertOwnOrigin,
  clickAt,
  desktopPage,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  requestActions,
  setup,
  skip,
  text,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * The Activity side of the browser shell (the README's "Activity"): the
 * column on the right of the chat, its ☰ buttons, the list's Activity entry,
 * the new-activity marker, listening, starting a conversation, and the
 * history entries' actions. The built shell in headless Chromium against the
 * real gateway and listener control socket, with synthetic Activity entries
 * and a synthetic agent backend, in temporary directories on loopback only.
 *
 * The rules' tables are checked in Node as well: activity-layout.test.ts
 * (width and shown state), activity-marker.test.ts (the marker against the
 * real Store, also across reconnects and runs) and activity-actions.test.ts
 * (which actions each entry offers).
 *
 * Set COMPANION_SHELL_SCREENSHOTS to a directory to also save screenshots
 * with the column hidden and shown at 420, 760, 1280 and 1600 px (never
 * committed).
 */

// ---- Helpers ----------------------------------------------------------------------

/** Requests the Activity side may send, besides slices 1 and 2's. */
const allowedActions = [
  'panel-state',
  'activity-history',
  'toggle-pause',
  'start-agent',
  'start-history-agent',
  'label-history',
  'delete-history',
  'close-agent',
];

async function assertCleanPage(fixture: Fixture, page: TestPage, sockets: SocketLog) {
  assertOwnOrigin(fixture, page, sockets);
  await assertNoViolations(page);
  for (const action of requestActions(sockets)) {
    assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
  }
  // The unscoped Stop is never sent (the Stop rule).
  assert.ok(!requestActions(sockets).includes('stop-agent'));
}

let nextFrameId = 1000;

/**
 * The listener heard `utterance` in the synthetic frame's application: a
 * finished Activity entry of this run with its screenshot saved (capture storage is on in the fixture), so it can be
 * labelled and a coding session can start from it.
 */
async function heard(
  fixture: Fixture,
  utterance: string,
  intent = 'IGNORE',
  outcome: 'ignored' | 'sent' | 'started' = 'ignored',
): Promise<void> {
  const activity = fixture.desktop.runtime.activity;
  const id = nextFrameId;
  nextFrameId++;
  const observed = { ...frame, id, utterance };
  activity.transcribed?.({
    ...observed,
    application: observed.screenshot.window,
    storage: activity.admitCapture?.(),
  });
  await activity.screenshotCaptured?.(id, observed.screenshot);
  activity.intentRecognized?.(id, intent);
  activity.outcome?.(id, outcome);
  activity.finished?.(id);
}

/** Register a few intents with the listener, so labels can name an actual intent. */
async function registerIntents(fixture: Fixture): Promise<void> {
  const runtime = fixture.desktop.runtime;
  const router = new UserSensorRouter(
    {
      detector: {
        id: 'test-detector',
        label: 'No detector (test)',
        dependencies: {},
        async detect() {
          throw Error('The test does not classify speech');
        },
      },
    },
    () => {},
    runtime.activity,
  );
  const intents: [string, string][] = [
    ['IGNORE', 'Ignore'],
    ['QUICK_QUESTION', 'Quick question'],
  ];
  for (const [name, label] of intents) {
    const processor: UserSensorProcessor = {
      id: name,
      label,
      dependencies: {},
      name,
      instruction: `Synthetic ${label}`,
      prefixes: [],
      async process() {},
      subscribe(target) {
        target.register(this);
      },
    };
    processor.subscribe(router);
  }
  await runtime.connectRouter(router);
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

type Box = { left: number; right: number; top: number; width: number; x: number; y: number };

/** The bounding box of the first element matching `selector`, with its centre. */
async function box(page: TestPage, selector: string): Promise<Box> {
  const found = await page.evaluate<Box | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, width: rect.width,
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    };
  })()`);
  assert.ok(found, `no element for ${selector}`);
  return found;
}

async function clickSelector(page: TestPage, selector: string): Promise<void> {
  await page.waitFor(
    `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled && document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-disabled') !== 'true'`,
  );
  await clickAt(page, await box(page, selector));
}

const keyCodes: Record<string, number> = {
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  Enter: 13,
  Tab: 9,
  ' ': 32,
};

/** Press and release one key on the focused element. */
async function key(page: TestPage, name: string, shift = false): Promise<void> {
  const code = name === ' ' ? 'Space' : name;
  const base = {
    key: name,
    code,
    windowsVirtualKeyCode: keyCodes[name],
    modifiers: shift ? 8 : 0,
  };
  await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (name === 'Enter' || name === ' ') {
    await page.call('Input.dispatchKeyEvent', {
      type: 'char',
      ...base,
      text: name === ' ' ? ' ' : '\r',
    });
  }
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** The bar's ☰ for Activity (shown while the column is hidden). */
const barToggle = '.chat-bar .activity-toggle';
/** The column's own ☰ (hides it). */
const columnToggle = '.activity-header .activity-toggle';
const column = '#activity-column';
const listEntry = '.activity-list-entry';

/** A page expression: the history entry whose text is `utterance`. */
function entryExpression(utterance: string): string {
  return `[...document.querySelectorAll('.activity-entry')].find((item) => item.querySelector('.activity-utterance')?.textContent === ${JSON.stringify(utterance)})`;
}

/** The selector of a button inside the entry whose text is `utterance`, by its label. */
async function entryButton(page: TestPage, utterance: string, label: string): Promise<string> {
  // Mark the button so the generic helpers can find it by selector.
  await page.waitFor(entryExpression(utterance));
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-test-target]').forEach((element) => element.removeAttribute('data-test-target'));
    const button = [...${entryExpression(utterance)}.querySelectorAll('button')].find(
      (candidate) => candidate.textContent.trim() === ${JSON.stringify(label)} || candidate.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (button) button.setAttribute('data-test-target', '');
  })()`);
  return '[data-test-target]';
}

/** The utterances shown in the column, top to bottom. */
function shownUtterances(page: TestPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `[...document.querySelectorAll('.activity-utterance')].map((item) => item.textContent)`,
  );
}

/**
 * A page expression: the remembered Activity entries' values (`undefined`
 * for an entry never written), see integrations/shell/src/layout/stored-layout.ts.
 */
const storedActivity = `({
  activityWidth: JSON.parse(localStorage.getItem('companion.shell.layout.activityWidth'))?.value,
  activityShown: JSON.parse(localStorage.getItem('companion.shell.layout.activityShown'))?.value,
})`;
const columnWidth = `(document.querySelector('#activity-column')?.getBoundingClientRect().width ?? 0)`;

/** The bar's marker: the green dot on ☰ and the list entry's state. */
async function marker(page: TestPage): Promise<{ dot: boolean; label: string; summary: string }> {
  return page.evaluate(`({
    dot: Boolean(document.querySelector('.chat-bar .activity-toggle .activity-new')),
    label: document.querySelector('.chat-bar .activity-toggle')?.getAttribute('aria-label') ?? '',
    summary: document.querySelector('#activity-list-summary')?.textContent ?? '',
  })`);
}

// ---- History, the marker, showing and hiding -----------------------------------------

test(
  'history pages in and stays live; the marker is set while hidden and cleared by showing',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);

    // The gateway's policy is the one slices 1 and 2 run under (no source
    // change); the page must not need anything weaker.
    const response = await fetch(`${fixture.origin}/`);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

    fixture.sessions.start({ ...frame, utterance: 'Synthetic conversation' }, signal());
    await waitFor(() => fixture.runs.length === 1);

    // 53 entries before the page loads: the Store reads them in two pages of 50.
    for (let index = 1; index <= 53; index++) {
      await heard(fixture, `Synthetic utterance ${index}`);
    }

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Synthetic conversation');
    await waitFor(
      () => requestActions(sockets).filter((action) => action === 'activity-history').length >= 2,
    );

    // Hidden at first, the first reading sets no marker.
    assert.equal(await page.evaluate(`document.querySelector('${column}')`), null);
    assert.deepEqual(await marker(page), {
      dot: false,
      label: 'Show Activity',
      summary: 'Listening',
    });
    assert.equal(
      await page.evaluate(`document.querySelector('${listEntry}').getAttribute('aria-expanded')`),
      'false',
    );

    // Something new is heard while hidden: the dot and the count.
    await heard(fixture, 'New while hidden');
    await page.waitFor(`document.querySelector('${barToggle} .activity-new')`);
    assert.deepEqual(await marker(page), {
      dot: true,
      label: 'Show Activity, 1 new entry',
      summary: 'Listening · 1 new',
    });
    assert.ok(
      await page.evaluate(`document.querySelector('${listEntry}').classList.contains('unread')`),
    );

    // ☰ in the bar shows the column; the marker goes and focus moves to the
    // column's ☰.
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);
    assert.equal(
      await page.evaluate(`document.activeElement?.getAttribute('aria-label')`),
      'Hide Activity',
    );
    assert.equal(await page.evaluate(`document.querySelector('${barToggle}')`), null);
    assert.equal((await marker(page)).summary, 'Listening');
    await page.waitFor(`document.querySelectorAll('.activity-entry').length === 54`);
    const first = await shownUtterances(page);
    assert.equal(first[0], 'New while hidden', 'newest first');
    assert.equal(first[1], 'Synthetic utterance 53');
    assert.equal(first[53], 'Synthetic utterance 1');
    assert.match(await text(page, '.activity-history h3'), /54/);

    // Heard while shown: at the top, live; no marker after hiding.
    await heard(fixture, 'Heard while shown');
    await page.waitFor(
      `document.querySelector('.activity-utterance')?.textContent === 'Heard while shown'`,
    );
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    assert.equal(
      await page.evaluate(`document.activeElement?.classList.contains('activity-toggle')`),
      true,
      'focus back on the bar ☰',
    );
    assert.equal((await marker(page)).dot, false);

    // The list's Activity entry shows and hides the same column; the
    // conversation stays selected.
    await clickSelector(page, listEntry);
    await page.waitFor(`document.querySelector('${column}')`);
    assert.equal(
      await page.evaluate(`document.querySelector('${listEntry}').getAttribute('aria-expanded')`),
      'true',
    );
    assert.match(await text(page, '.chat-bar-title'), /Synthetic conversation/);
    await clickSelector(page, listEntry);
    await page.waitFor(`!document.querySelector('${column}')`);

    // The marker is cleared also when the list entry shows the column.
    await heard(fixture, 'Second new while hidden');
    await page.waitFor(`document.querySelector('${barToggle} .activity-new')`);
    await clickSelector(page, listEntry);
    await page.waitFor(`document.querySelector('${column}')`);
    assert.equal((await marker(page)).summary, 'Listening');
    assert.equal(
      await page.evaluate(`document.querySelector('${listEntry}').classList.contains('unread')`),
      false,
    );

    // A reload with the column shown: no marker from the first reading.
    await clickSelector(page, columnToggle);
    await heard(fixture, 'Unseen before the reload');
    await page.waitFor(`document.querySelector('${barToggle} .activity-new')`);
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await page.waitFor(`document.querySelector('${barToggle}')`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await marker(page)).dot, false, 'first reading after a reload');

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'width and shown state are remembered; the divider by pointer and keyboard; narrow and wide windows',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Layout conversation' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets, browserContextId } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Layout conversation');

    // Nothing remembered: hidden, 320 px when shown.
    assert.deepEqual(await page.evaluate(storedActivity), {});
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);
    assert.equal(await page.evaluate(columnWidth), 320);
    assert.deepEqual(await page.evaluate(storedActivity), { activityShown: true });

    // The divider: role, name, value.
    const divider = '.activity-divider';
    assert.deepEqual(
      await page.evaluate(`(() => {
        const element = document.querySelector('${divider}');
        return {
          role: element.getAttribute('role'),
          name: element.getAttribute('aria-label'),
          now: element.getAttribute('aria-valuenow'),
          min: element.getAttribute('aria-valuemin'),
          max: element.getAttribute('aria-valuemax'),
          controls: element.getAttribute('aria-controls'),
        };
      })()`),
      {
        role: 'separator',
        name: 'Activity width',
        now: '320',
        min: '240',
        max: '520',
        controls: 'activity-column',
      },
    );

    // A press without moving changes and writes nothing.
    const handle = await box(page, divider);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: 300 });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: handle.x,
      y: 300,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: handle.x,
      y: 300,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    assert.deepEqual(await page.evaluate(storedActivity), { activityShown: true });

    // Dragged to 400 px from the right edge: followed while dragging,
    // remembered on release.
    const drag = async (toX: number) => {
      const start = await box(page, divider);
      const before = (await page.evaluate<{ activityWidth?: number }>(storedActivity))
        .activityWidth;
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: 300 });
      await page.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: start.x,
        y: 300,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      for (let step = 1; step <= 4; step++) {
        const x = start.x + ((toX - start.x) * step) / 4;
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y: 300,
          button: 'left',
          buttons: 1,
        });
      }
      assert.equal(
        (await page.evaluate<{ activityWidth?: number }>(storedActivity)).activityWidth,
        before,
        'not remembered while dragging',
      );
      await page.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: toX,
        y: 300,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    };
    await drag(1280 - 400);
    await page.waitFor(`${columnWidth} === 400`);
    assert.deepEqual(await page.evaluate(storedActivity), {
      activityShown: true,
      activityWidth: 400,
    });

    // Beyond the maximum: 520 px. (Remembered values are then followed by
    // the keys.)
    await drag(200);
    await page.waitFor(`${columnWidth} === 520`);

    // Keyboard: Right narrows, Left widens, Home, End; each remembered.
    await page.evaluate(`document.querySelector('${divider}').focus()`);
    await key(page, 'ArrowRight');
    await page.waitFor(`${columnWidth} === 500`);
    await key(page, 'Home');
    await page.waitFor(`${columnWidth} === 240`);
    await key(page, 'ArrowLeft');
    await page.waitFor(`${columnWidth} === 260`);
    assert.equal(
      (await page.evaluate<{ activityWidth: number }>(storedActivity)).activityWidth,
      260,
    );
    await key(page, 'End');
    await page.waitFor(`${columnWidth} === 520`);
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await key(page, 'ArrowRight');
    await page.waitFor(`${columnWidth} === 320`);

    // Hidden with ☰, the width is kept; a reload restores both.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    assert.deepEqual(await page.evaluate(storedActivity), {
      activityShown: false,
      activityWidth: 320,
    });
    await clickSelector(page, barToggle);
    await page.waitFor(`${columnWidth} === 320`);
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await page.waitFor(`${columnWidth} === 320`);

    // A second tab of the same browser follows a change written by the first.
    const second = await (
      await import('./page.ts')
    ).desktopPage(browser, 1280, 800, browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);
    await second.page.waitFor(`${columnWidth} === 320`);
    await page.evaluate(`document.querySelector('${divider}').focus()`);
    await key(page, 'ArrowLeft');
    await page.waitFor(`${columnWidth} === 340`);
    await second.page.waitFor(`${columnWidth} === 340`);
    await clickSelector(second.page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await second.page.close();
    await clickSelector(page, barToggle);
    await openConversation(page, 'Layout conversation');

    // 1600 px: list, chat and column side by side; the chat column is
    // centred and at most 860 px wide.
    await resize(page, 1600);
    await page.waitFor(`${columnWidth} === 340`);
    const list = await box(page, '.conversations');
    const main = await box(page, '.workspace-main');
    const chat = await box(page, '.chat-column');
    const side = await box(page, column);
    assert.ok(list.right <= main.left + 1, 'list left of the chat');
    assert.ok(main.right <= side.left + 1, 'chat left of the column');
    assert.equal(Math.round(side.right), 1600);
    assert.ok(chat.width <= 860, `chat column ${chat.width} px`);
    const leftGap = chat.left - main.left;
    const rightGap = main.right - chat.right;
    assert.ok(Math.abs(leftGap - rightGap) <= 1, 'chat column centred');
    assert.equal(await horizontalOverflow(page), 0);

    // 700 px: the column gives way to keep the chat at 320 px.
    await resize(page, 700);
    await page.waitFor(`${columnWidth} === 300`);
    assert.equal(Math.round((await box(page, '.workspace-main')).width), 320);
    assert.equal(await horizontalOverflow(page), 0);

    // 420 px: over the chat, right of the list, no divider, no overflow;
    // the remembered width is unchanged.
    await resize(page, 420);
    await page.waitFor(`document.querySelector('${column}.overlay')`);
    assert.equal(await page.evaluate(`document.querySelector('${divider}')`), null);
    const over = await box(page, column);
    const strip = await box(page, '.conversations');
    assert.equal(Math.round(over.left), Math.round(strip.right) + 1);
    assert.equal(Math.round(over.right), 420);
    assert.equal(await horizontalOverflow(page), 0);
    assert.equal(
      (await page.evaluate<{ activityWidth: number }>(storedActivity)).activityWidth,
      340,
    );
    // Its ☰ hides it; the bar's ☰ shows it again.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}.overlay')`);
    await resize(page, 1280);
    await page.waitFor(`${columnWidth} === 340`);

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a storage that refuses writes keeps the page’s Activity layout',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await page.evaluate(
      `Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }`,
    );
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);
    await page.evaluate(`document.querySelector('.activity-divider').focus()`);
    await key(page, 'ArrowLeft');
    await page.waitFor(`${columnWidth} === 340`);
    assert.deepEqual(await page.evaluate(storedActivity), {});
    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Listening and starting a conversation ---------------------------------------------

test(
  'pause and resume; start a coding conversation and a quick question, each selected',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Conversation shown before' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Conversation shown before');
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);

    // Listening, then Pause through the listener, then Resume.
    assert.equal(await text(page, '.activity-listening-title'), 'Listening');
    assert.equal(await text(page, '.activity-header .activity-pill'), 'listening');
    await clickSelector(page, 'button[aria-label="Pause listening"]');
    await waitFor(() => fixture.desktop.pause.paused);
    await page.waitFor(
      `document.querySelector('.activity-listening-title')?.textContent === 'Paused'`,
    );
    assert.match(await text(page, '.activity-listening'), /Microphone capture is paused/);
    assert.equal(await text(page, '#activity-list-summary'), 'Paused');
    await clickSelector(page, 'button[aria-label="Resume listening"]');
    await waitFor(() => !fixture.desktop.pause.paused);
    await page.waitFor(
      `document.querySelector('.activity-listening-title')?.textContent === 'Listening'`,
    );

    // Paused for media: the reason is shown.
    fixture.desktop.pause.setMediaPlaying(true);
    await page.waitFor(
      `document.querySelector('.activity-listening-title')?.textContent === 'Paused for media'`,
    );
    assert.match(await text(page, '.activity-listening'), /Listening resumes when playback stops/);
    fixture.desktop.pause.setMediaPlaying(false);
    await page.waitFor(
      `document.querySelector('.activity-listening-title')?.textContent === 'Listening'`,
    );

    // A coding conversation: Start is offered only with text.
    assert.equal(
      await page.evaluate(
        `document.querySelector('.activity-start-button').getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    );
    await clickSelector(page, '#activity-start-text');
    await page.type('Synthetic coding request from the browser');
    await clickSelector(page, '.activity-start-button');
    await waitFor(() => fixture.runs.length === 2);
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Synthetic coding request')`,
    );
    assert.equal(await page.evaluate(`document.querySelector('#activity-start-text').value`), '');
    assert.ok(
      await page.evaluate(
        `[...document.querySelectorAll('.conversation-entry .entry-select')].some((entry) => entry.title.includes('Synthetic coding request'))`,
      ),
    );
    const coding = fixture.runs[1];
    assert.match(coding.request.prompt.text, /Synthetic coding request/);

    // A quick question, chosen with the keyboard.
    await page.evaluate(`document.querySelector('#activity-start-text').focus()`);
    await page.type('Synthetic quick question');
    await page.evaluate(
      `[...document.querySelectorAll('.activity-choice-group button')].find((button) => button.textContent === 'Quick question').focus()`,
    );
    await key(page, 'Enter');
    await page.waitFor(
      `[...document.querySelectorAll('.activity-choice-group button')].find((button) => button.textContent === 'Quick question').getAttribute('aria-pressed') === 'true'`,
    );
    await page.evaluate(`document.querySelector('.activity-start-button').focus()`);
    await key(page, 'Enter');
    await waitFor(() => fixture.runs.length === 3);
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Synthetic quick question')`,
    );
    const sent = sockets.sent.filter(
      (message) => message.type === 'request' && message.action === 'start-agent',
    );
    assert.deepEqual(
      sent.map((message) => message.profile),
      ['coding', 'quickQuestion'],
    );

    // The chosen kind is kept while the column is hidden, like the text.
    await page.evaluate(`document.querySelector('#activity-start-text').focus()`);
    await page.type('Kept across hiding');
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('#activity-start-text')`);
    assert.equal(
      await page.evaluate(
        `[...document.querySelectorAll('.activity-choice-group button')].find((button) => button.getAttribute('aria-pressed') === 'true').textContent`,
      ),
      'Quick question',
    );
    assert.equal(
      await page.evaluate(`document.querySelector('#activity-start-text').value`),
      'Kept across hiding',
    );
    await clickSelector(page, '.activity-start-button');
    await waitFor(() => fixture.runs.length === 4);
    const third = sockets.sent.filter(
      (message) => message.type === 'request' && message.action === 'start-agent',
    )[2];
    assert.equal(third.profile, 'quickQuestion');
    assert.equal(third.text, 'Kept across hiding');

    // Offline the box keeps its text and Start is not offered.
    await page.evaluate(`document.querySelector('#activity-start-text').focus()`);
    await page.type('Kept while offline');
    await fixture.gateway.close();
    await page.waitFor(`!document.querySelector('.shell[data-connection="online"]')`, 8000);
    assert.equal(
      await page.evaluate(
        `document.querySelector('.activity-start-button').getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        `document.querySelector('button[aria-label="Pause listening"]').getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(`document.querySelector('#activity-start-text').value`),
      'Kept while offline',
    );

    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
    for (const action of requestActions(sockets)) {
      assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
    }
  },
);

// ---- History entries' actions ----------------------------------------------------------

test(
  'entries: copy, label correct and incorrect, new coding session, delete after confirming',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    await registerIntents(fixture);
    await heard(fixture, 'Synthetic entry to label');
    await heard(fixture, 'Synthetic entry to delete');
    await heard(fixture, 'Synthetic entry for a session', 'QUICK_QUESTION', 'started');

    const { page, sockets, browserContextId } = await pairedPage(fixture, browser, 1280, 800);
    await page.call('Browser.grantPermissions', {
      origin: fixture.origin,
      browserContextId,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelectorAll('.activity-entry').length === 3`);

    // What each entry shows: text, time, decision and outcome, application.
    const heading = await page.evaluate<string>(
      `${entryExpression('Synthetic entry for a session')}.querySelector('.activity-heading').textContent`,
    );
    assert.match(heading, /Quick question · Started a session/);
    assert.match(heading, /\d{2}:\d{2}/);
    assert.equal(
      await page.evaluate<string>(
        `${entryExpression('Synthetic entry for a session')}.querySelector('.activity-pill').textContent`,
      ),
      frame.screenshot.window.app,
    );
    assert.equal(
      await page.evaluate(
        `${entryExpression('Synthetic entry to label')}.querySelector('article').getAttribute('aria-label').startsWith('Heard at ')`,
      ),
      true,
    );

    // Copy.
    await clickSelector(page, await entryButton(page, 'Synthetic entry to label', 'Copy'));
    await page.waitFor(
      `${entryExpression('Synthetic entry to label')}.querySelector('.activity-feedback')?.textContent === 'Copied'`,
    );
    assert.equal(await page.evaluate(`navigator.clipboard.readText()`), 'Synthetic entry to label');

    // Label correct: shown once the listener reports it.
    await clickSelector(page, await entryButton(page, 'Synthetic entry to label', 'Correct'));
    await page.waitFor(
      `${entryExpression('Synthetic entry to label')}.querySelector('.activity-label')?.textContent === 'Labelled correct'`,
    );
    const correctButton = await entryButton(page, 'Synthetic entry to label', 'Correct');
    assert.equal(
      await page.evaluate(
        `document.querySelector('${correctButton}').getAttribute('aria-pressed')`,
      ),
      'true',
    );

    // Label incorrect, then the actual intent from the choice.
    await clickSelector(page, await entryButton(page, 'Synthetic entry to label', 'Incorrect'));
    await page.waitFor(
      `${entryExpression('Synthetic entry to label')}.querySelector('.activity-label')?.textContent === 'Labelled incorrect'`,
    );
    // The recognised intent (Ignore) is not offered: the listener refuses it.
    assert.deepEqual(
      await page.evaluate(
        `[...${entryExpression('Synthetic entry to label')}.querySelectorAll('.activity-choice button')].map((button) => button.getAttribute('aria-label'))`,
      ),
      ['Correct intent to Quick question'],
    );
    await clickSelector(
      page,
      await entryButton(page, 'Synthetic entry to label', 'Correct intent to Quick question'),
    );
    await page.waitFor(
      `${entryExpression('Synthetic entry to label')}.querySelector('.activity-label')?.textContent === 'Labelled incorrect → Quick question'`,
    );
    // The choice went away; focus is back on Incorrect.
    assert.equal(await page.evaluate(`document.activeElement?.textContent`), 'Incorrect');
    const labels = sockets.sent
      .filter((message) => message.type === 'request' && message.action === 'label-history')
      .map((message) => [message.correct, message.actualIntent ?? null]);
    assert.deepEqual(labels, [
      [true, null],
      [false, null],
      [false, 'QUICK_QUESTION'],
    ]);
    const stored = fixture.desktop.database
      .prepare('SELECT correct, actual_intent FROM intent_feedback ORDER BY rowid DESC LIMIT 1')
      .get() as { correct: number; actual_intent: string };
    assert.equal(stored.correct, 0);
    assert.equal(stored.actual_intent, 'QUICK_QUESTION');

    // New coding session from an entry: it appears in the list.
    const runsBefore = fixture.runs.length;
    await clickSelector(
      page,
      await entryButton(page, 'Synthetic entry for a session', 'New coding session'),
    );
    await waitFor(() => fixture.runs.length === runsBefore + 1);
    await page.waitFor(
      `[...document.querySelectorAll('.conversation-entry .entry-select')].some((entry) => entry.title.includes('Synthetic entry for a session'))`,
    );

    // Delete: × opens a confirmation (focus on Cancel); Cancel sends nothing.
    const deleteSelector = await entryButton(
      page,
      'Synthetic entry to delete',
      'Delete utterance, screenshot and audio',
    );
    await clickSelector(page, deleteSelector);
    await page.waitFor(`document.activeElement?.textContent === 'Cancel'`);
    await key(page, 'Enter');
    await page.waitFor(`!document.querySelector('.activity-confirm')`);
    assert.equal(
      await page.evaluate(`document.activeElement?.getAttribute('aria-label')`),
      'Delete utterance, screenshot and audio',
    );
    assert.ok(!requestActions(sockets).includes('delete-history'));
    await clickSelector(page, deleteSelector);
    // Confirmed with the keyboard: focus moves to the entry that takes its
    // place instead of being lost with it.
    await page.evaluate(
      `document.querySelector('${await entryButton(page, 'Synthetic entry to delete', 'Delete permanently')}').focus()`,
    );
    await key(page, 'Enter');
    await page.waitFor(`!${entryExpression('Synthetic entry to delete')}`);
    await page.waitFor(`document.activeElement?.closest('.activity-entry') !== null`);
    assert.equal(
      await page.evaluate(
        `document.activeElement.closest('.activity-entry').querySelector('.activity-utterance').textContent`,
      ),
      'Synthetic entry to label',
    );
    assert.equal(requestActions(sockets).filter((action) => action === 'delete-history').length, 1);
    assert.equal(
      fixture.desktop.database
        .prepare(
          "SELECT COUNT(*) AS count FROM utterances WHERE transcript = 'Synthetic entry to delete'",
        )
        .get()!.count,
      0,
    );

    // Offline: Copy stays, requests are not offered.
    await fixture.gateway.close();
    await page.waitFor(`!document.querySelector('.shell[data-connection="online"]')`, 8000);
    const offline = await page.evaluate<Record<string, boolean>>(`(() => {
      const entry = ${entryExpression('Synthetic entry to label')};
      const button = (label) => [...entry.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === label || candidate.getAttribute('aria-label') === label);
      return {
        copy: button('Copy').getAttribute('aria-disabled') === 'true',
        session: button('New coding session').getAttribute('aria-disabled') === 'true',
        correct: button('Correct').getAttribute('aria-disabled') === 'true',
        remove: button('Delete utterance, screenshot and audio').getAttribute('aria-disabled') === 'true',
      };
    })()`);
    assert.deepEqual(offline, { copy: false, session: true, correct: true, remove: true });

    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
    for (const action of requestActions(sockets)) {
      assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
    }
  },
);

test(
  'a refused label shows the error and leaves the entry as the listener reports it',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const activity = fixture.desktop.runtime.activity;
    const id = 4242;
    const observed = { ...frame, id, utterance: 'Synthetic entry refused' };
    activity.transcribed?.({ ...observed, input: 'speech', storage: activity.admitCapture?.() });
    await activity.audioCaptured?.(id, new Float32Array(160).fill(0.1));
    await activity.screenshotCaptured?.(id, observed.screenshot);
    activity.intentRecognized?.(id, 'IGNORE');
    activity.outcome?.(id, 'ignored');
    activity.finished?.(id);
    const row = fixture.desktop.database
      .prepare('SELECT id, observed_at FROM utterances')
      .get() as { id: string; observed_at: number };

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await clickSelector(page, barToggle);
    const correct = await entryButton(page, 'Synthetic entry refused', 'Correct');
    await page.waitFor(
      `document.querySelector('${correct}').getAttribute('aria-disabled') !== 'true'`,
    );

    // The saved screenshot disappears after the entry was drawn: the click
    // still reaches the listener, which refuses the label.
    await rm(artifactPath(fixture.desktop.directory, row.id, row.observed_at, 'screenshots'));
    await clickAt(page, await box(page, correct));
    await page.waitFor(`document.querySelector('.toast.error')`);
    // The listener's correction arrives: labeling and a session are no
    // longer offered, and no label is shown.
    await page.waitFor(
      `document.querySelector('${correct}').getAttribute('aria-disabled') === 'true'`,
    );
    assert.equal(
      await page.evaluate(
        `${entryExpression('Synthetic entry refused')}.querySelector('.activity-label')`,
      ),
      null,
    );
    assert.equal(
      fixture.desktop.database.prepare('SELECT COUNT(*) AS count FROM intent_feedback').get()!
        .count,
      0,
    );
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'no delete control when the listener does not advertise deletion',
  { skip },
  async (context) => {
    const fixture = await remoteFixture({ appDirectory, preview: true });
    const { TestBrowser } = await import('../mobile/browser.ts');
    const browser = new TestBrowser();
    await browser.start();
    context.after(async () => {
      await browser.close();
      await fixture.close();
    });
    await heard(fixture, 'Synthetic entry in preview');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await clickSelector(page, barToggle);
    await page.waitFor(entryExpression('Synthetic entry in preview'));
    assert.equal(
      await page.evaluate(
        `${entryExpression('Synthetic entry in preview')}.querySelector('.activity-delete')`,
      ),
      null,
    );
    assert.match(await text(page, '.activity-listening'), /preview mode/);

    // A listener in preview mode would answer without starting anything:
    // neither a new conversation nor a session from an entry is offered,
    // and the typed text stays.
    const newSession = await entryButton(page, 'Synthetic entry in preview', 'New coding session');
    assert.equal(
      await page.evaluate(
        `document.querySelector('${newSession}').getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    );
    await clickSelector(page, '#activity-start-text');
    await page.type('Kept in preview mode');
    assert.equal(
      await page.evaluate(
        `document.querySelector('.activity-start-button').getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    );
    assert.match(
      await text(page, '.activity-start'),
      /Preview mode: Companion starts no conversations/,
    );
    await page.evaluate(`document.querySelector('.activity-start').requestSubmit()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await page.evaluate(`document.querySelector('#activity-start-text').value`),
      'Kept in preview mode',
    );
    assert.equal(fixture.runs.length, 0, 'no conversation started');
    assert.ok(!requestActions(sockets).includes('start-agent'));
    assert.ok(!requestActions(sockets).includes('start-history-agent'));
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'one request per entry at a time, also across hiding and showing; stale clicks send nothing',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    await heard(fixture, 'Synthetic entry A');
    await heard(fixture, 'Synthetic entry B');
    await heard(fixture, 'Synthetic entry deleted elsewhere');

    // Hold the listener's answer to New coding session until released.
    const runtime = fixture.desktop.runtime as unknown as {
      history: { recordedFrame(id: string): Promise<unknown> };
    };
    const recordedFrame = runtime.history.recordedFrame.bind(runtime.history);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.history.recordedFrame = async (id: string) => {
      await held;
      return recordedFrame(id);
    };

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelectorAll('.activity-entry').length === 3`);
    const sessionRequests = () =>
      requestActions(sockets).filter((action) => action === 'start-history-agent').length;
    // Unavailable buttons stay focusable, marked aria-disabled (ActionButton.tsx).
    const disabled = async (utterance: string, label: string) =>
      page.evaluate<boolean>(
        `document.querySelector('${await entryButton(page, utterance, label)}').getAttribute('aria-disabled') === 'true'`,
      );

    // A's request is on its way: A's requests are disabled, B's are not.
    await clickSelector(page, await entryButton(page, 'Synthetic entry A', 'New coding session'));
    await waitFor(() => sessionRequests() === 1);
    await page.waitFor(
      `document.querySelector('${await entryButton(page, 'Synthetic entry A', 'Correct')}').getAttribute('aria-disabled') === 'true'`,
    );
    assert.equal(await disabled('Synthetic entry A', 'New coding session'), true);
    assert.equal(await disabled('Synthetic entry A', 'Copy'), false);
    assert.equal(await disabled('Synthetic entry B', 'New coding session'), false);
    assert.equal(await disabled('Synthetic entry B', 'Correct'), false);

    // Hidden and shown again, A still awaits its answer: still disabled, and
    // a click on it sends nothing.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelectorAll('.activity-entry').length === 3`);
    assert.equal(await disabled('Synthetic entry A', 'New coding session'), true);
    await page.evaluate(
      `document.querySelector('${await entryButton(page, 'Synthetic entry A', 'New coding session')}').click()`,
    );
    assert.equal(sessionRequests(), 1);

    // B's own request goes out meanwhile.
    await clickSelector(page, await entryButton(page, 'Synthetic entry B', 'Correct'));
    await page.waitFor(
      `${entryExpression('Synthetic entry B')}.querySelector('.activity-label')?.textContent === 'Labelled correct'`,
    );

    // The answer arrives while the column is hidden: shown again, A is
    // offered again; one conversation was started.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    release();
    await waitFor(() => fixture.runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelectorAll('.activity-entry').length === 3`);
    await page.waitFor(
      `document.querySelector('${await entryButton(page, 'Synthetic entry A', 'New coding session')}').getAttribute('aria-disabled') !== 'true'`,
    );
    assert.equal(sessionRequests(), 1);

    // Stale clicks: buttons of an entry another client deletes. The page
    // keeps references to them; after the entry is gone their handlers run
    // on an old drawing and must send nothing.
    await page.evaluate(`(() => {
      const entry = ${entryExpression('Synthetic entry deleted elsewhere')};
      window.__stale = [...entry.querySelectorAll('button')];
    })()`);
    const { token } = await fixture.pair('Second synthetic client');
    const other = await fixture.phone(token);
    await other.engine('state');
    const row = fixture.desktop.database
      .prepare("SELECT id FROM utterances WHERE transcript = 'Synthetic entry deleted elsewhere'")
      .get() as { id: string };
    other.send({ requestId: 'delete-elsewhere', action: 'delete-history', id: row.id });
    const reply = await other.reply('delete-elsewhere');
    assert.equal(reply.type, 'result');
    await page.waitFor(`!${entryExpression('Synthetic entry deleted elsewhere')}`);
    const sentBefore = sockets.sent.length;
    await page.evaluate(`window.__stale.forEach((button) => button.click())`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const staleRequests = requestActions(sockets, sentBefore).filter(
      (action) => action !== 'panel-state',
    );
    assert.deepEqual(staleRequests, [], 'stale handlers send nothing');

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'in a narrow window the chat under the column is out of reach of the keyboard',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Narrow conversation' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets } = await pairedPage(fixture, browser, 420, 800);
    await openConversation(page, 'Narrow conversation');

    // Opened from the list's Activity entry: focus stays there; Tab moves
    // into the column and never into the covered chat.
    await clickSelector(page, listEntry);
    await page.waitFor(`document.querySelector('${column}.overlay')`);
    assert.equal(await page.evaluate(`document.querySelector('.workspace-main').inert`), true);
    await page.evaluate(`document.querySelector('${listEntry}').focus()`);
    const visited: string[] = [];
    for (let step = 0; step < 40; step++) {
      await key(page, 'Tab');
      const where = await page.evaluate<string>(`(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return 'body';
        if (element.closest('.workspace-main')) return 'chat';
        if (element.closest('#activity-column')) return 'column';
        if (element.closest('.conversations')) return 'list';
        return element.className || element.tagName;
      })()`);
      visited.push(where);
    }
    assert.ok(!visited.includes('chat'), `Tab reached the covered chat: ${visited.join(', ')}`);
    assert.ok(visited.includes('column'));

    // Focus in the chat when the column comes over it (a narrower window):
    // it moves to the column's ☰.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await resize(page, 1280);
    await clickSelector(page, barToggle);
    await page.waitFor(`document.querySelector('${column}:not(.overlay)')`);
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    await resize(page, 420);
    await page.waitFor(`document.querySelector('${column}.overlay')`);
    await page.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Hide Activity'`);

    // Hidden again, the chat is reachable.
    await clickSelector(page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    assert.equal(await page.evaluate(`document.querySelector('.workspace-main').inert`), false);
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'focus on a ☰ moves to the other ☰ when another tab shows or hides the column',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Two-tab conversation' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets, browserContextId } = await pairedPage(fixture, browser, 420, 800);
    await openConversation(page, 'Two-tab conversation');
    await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    const second = await desktopPage(browser, 420, 800, browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);

    // Focus on the bar's ☰ here; the other tab shows the column.
    await page.evaluate(`document.querySelector('${barToggle}').focus()`);
    await clickSelector(second.page, barToggle);
    await page.waitFor(`document.querySelector('${column}.overlay')`);
    await page.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Hide Activity'`);

    // And back: the other tab hides it; focus returns to the bar's ☰.
    await clickSelector(second.page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await page.waitFor(
      `document.activeElement?.classList.contains('activity-toggle') && document.activeElement.closest('.chat-bar') !== null`,
    );

    // Focus in the column's text box when the other tab hides the column:
    // it moves to the bar's ☰ too.
    await clickSelector(second.page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);
    await page.evaluate(`document.querySelector('#activity-start-text').focus()`);
    await clickSelector(second.page, columnToggle);
    await page.waitFor(`!document.querySelector('${column}')`);
    await page.waitFor(
      `document.activeElement?.classList.contains('activity-toggle') && document.activeElement.closest('.chat-bar') !== null`,
    );

    // Focus elsewhere (the list) is left where it is.
    await page.evaluate(`document.querySelector('${listEntry}').focus()`);
    await clickSelector(second.page, barToggle);
    await page.waitFor(`document.querySelector('${column}')`);
    assert.ok(
      await page.evaluate(`document.activeElement?.classList.contains('activity-list-entry')`),
    );
    await second.page.close();
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a stale Incorrect press does not erase an actual intent chosen elsewhere',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    await registerIntents(fixture);
    await heard(fixture, 'Synthetic entry labelled elsewhere');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await clickSelector(page, barToggle);
    const incorrect = await entryButton(page, 'Synthetic entry labelled elsewhere', 'Incorrect');
    await page.waitFor(
      `document.querySelector('${incorrect}').getAttribute('aria-disabled') !== 'true'`,
    );

    // Keep the press handler this button had while the entry was not
    // labelled. Preact keeps an element's handlers in its listener table
    // (`element.l`, key "click" + capture flag); a press that arrives
    // between the Store's update and the next drawing runs this handler.
    assert.equal(
      await page.evaluate(
        `typeof (window.__staleIncorrect = document.querySelector('${incorrect}').l?.clickfalse)`,
      ),
      'function',
      'Preact keeps its handlers in element.l',
    );

    // Another client labels it incorrect → Quick question.
    const { token } = await fixture.pair('Second synthetic client');
    const other = await fixture.phone(token);
    await other.engine('state');
    const row = fixture.desktop.database
      .prepare("SELECT id FROM utterances WHERE transcript = 'Synthetic entry labelled elsewhere'")
      .get() as { id: string };
    other.send({
      requestId: 'label-elsewhere',
      action: 'label-history',
      id: row.id,
      correct: false,
      actualIntent: 'QUICK_QUESTION',
    });
    assert.equal((await other.reply('label-elsewhere')).type, 'result');
    await page.waitFor(
      `${entryExpression('Synthetic entry labelled elsewhere')}.querySelector('.activity-label')?.textContent === 'Labelled incorrect → Quick question'`,
    );

    // The old handler runs: it decides by the entry as the Store has it now,
    // so it only opens the choice and sends nothing.
    const sentBefore = sockets.sent.length;
    await page.evaluate(`window.__staleIncorrect(new MouseEvent('click'))`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!requestActions(sockets, sentBefore).includes('label-history'));
    const stored = fixture.desktop.database
      .prepare('SELECT correct, actual_intent FROM intent_feedback WHERE id = ?')
      .get(row.id) as { correct: number; actual_intent: string };
    assert.deepEqual({ ...stored }, { correct: 0, actual_intent: 'QUICK_QUESTION' });
    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Keyboard and accessible names -----------------------------------------------------

test('keyboard operation and accessible names', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  await heard(fixture, 'Synthetic entry for the keyboard');
  fixture.sessions.start({ ...frame, utterance: 'Keyboard conversation' }, signal());
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  run.emit({ ...chatMessage('a1', 'assistant', 'Synthetic answer'), state: 'done' });
  run.finish();
  const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
  await openConversation(page, 'Keyboard conversation');

  // The bar's ☰: a button named for what it does, expanded state, controls.
  assert.deepEqual(
    await page.evaluate(`(() => {
      const button = document.querySelector('${barToggle}');
      return [button.tagName, button.getAttribute('aria-label'), button.getAttribute('aria-expanded'), button.getAttribute('aria-controls')];
    })()`),
    ['BUTTON', 'Show Activity', 'false', 'activity-column'],
  );
  // The list's Activity entry: named, described by the listening state.
  assert.deepEqual(
    await page.evaluate(`(() => {
      const button = document.querySelector('${listEntry}');
      return [button.getAttribute('aria-label'), document.getElementById(button.getAttribute('aria-describedby')).textContent];
    })()`),
    ['Show Activity', 'Listening'],
  );
  assert.equal(
    await page.evaluate(`document.querySelectorAll('#activity-list-summary').length`),
    1,
  );

  // Enter on the bar's ☰ shows the column, focus on its ☰; Space there hides it.
  await page.evaluate(`document.querySelector('${barToggle}').focus()`);
  await key(page, 'Enter');
  await page.waitFor(`document.querySelector('${column}')`);
  assert.equal(
    await page.evaluate(`document.activeElement?.getAttribute('aria-label')`),
    'Hide Activity',
  );
  assert.equal(
    await page.evaluate(`document.querySelector('${column}').getAttribute('aria-label')`),
    'Activity',
  );
  assert.equal(
    await page.evaluate(`document.querySelector('button[aria-label="Pause listening"]') !== null`),
    true,
  );
  assert.equal(
    await page.evaluate(`document.querySelector('label[for="activity-start-text"]').textContent`),
    'Message for a new conversation',
  );
  assert.equal(
    await page.evaluate(
      `document.querySelector('.activity-choice-group').getAttribute('aria-label')`,
    ),
    'Conversation type',
  );

  // Tab from the column's ☰ reaches the listening button, then the text box.
  await key(page, 'Tab');
  assert.equal(
    await page.evaluate(`document.activeElement?.getAttribute('aria-label')`),
    'Pause listening',
  );
  await key(page, 'Tab');
  assert.equal(await page.evaluate(`document.activeElement?.id`), 'activity-start-text');

  // Every button in the column has a name.
  const unnamed = await page.evaluate<number>(
    `[...document.querySelectorAll('#activity-column button')].filter((button) => !(button.getAttribute('aria-label') || button.textContent.trim())).length`,
  );
  assert.equal(unnamed, 0);

  // Correct by keyboard on an entry.
  await page.evaluate(
    `[...${entryExpression('Synthetic entry for the keyboard')}.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Correct').focus()`,
  );
  await key(page, ' ');
  await page.waitFor(
    `${entryExpression('Synthetic entry for the keyboard')}.querySelector('.activity-label')?.textContent === 'Labelled correct'`,
  );
  // Focus stayed on Correct while its request awaited the answer (the
  // button is marked unavailable then, not disabled, which would drop focus).
  assert.equal(await page.evaluate(`document.activeElement?.textContent`), 'Correct');

  // The same for Start: pressed with Enter, focus stays on it.
  await page.evaluate(`document.querySelector('#activity-start-text').focus()`);
  await page.type('Synthetic keyboard start');
  await page.evaluate(`document.querySelector('.activity-start-button').focus()`);
  await key(page, 'Enter');
  await waitFor(() => fixture.runs.length === 2);
  await page.waitFor(`document.querySelector('#activity-start-text').value === ''`);
  assert.ok(
    await page.evaluate(`document.activeElement?.classList.contains('activity-start-button')`),
  );

  // The list's Activity entry by keyboard hides the column; focus stays on it.
  await page.evaluate(`document.querySelector('${listEntry}').focus()`);
  await key(page, 'Enter');
  await page.waitFor(`!document.querySelector('${column}')`);
  assert.ok(
    await page.evaluate(`document.activeElement?.classList.contains('activity-list-entry')`),
  );

  await assertCleanPage(fixture, page, sockets);
});

// ---- Screenshots -----------------------------------------------------------------------

test(
  'screenshots with Activity hidden and shown at 420, 760, 1280 and 1600 px',
  {
    skip:
      skip ??
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { fixture, browser } = await setup(context);
    await registerIntents(fixture);

    const titles = ['🗺️ Plan a two-day synthetic city trip', '🐛 Why does the list test fail?'];
    for (const title of titles) {
      fixture.sessions.start({ ...frame, utterance: title }, signal());
    }
    await waitFor(() => fixture.runs.length === titles.length);
    for (const run of fixture.runs) {
      run.emit({
        ...chatMessage(`a-${run.request.prompt.text.length}`, 'assistant', 'A synthetic answer.'),
        state: 'done',
      });
      run.finish();
    }

    // Entries of different kinds.
    await heard(fixture, 'Please send the draft to Sam by Friday.', 'IGNORE', 'ignored');
    await heard(fixture, 'Quick question how long do eggs boil', 'QUICK_QUESTION', 'started');
    const activity = fixture.desktop.runtime.activity;
    activity.transcribed?.({
      ...frame,
      id: 9001,
      utterance: 'Heard while storage was off',
      storage: notAdmitted,
    });
    activity.intentRecognized?.(9001, 'IGNORE');
    activity.outcome?.(9001, 'ignored');
    activity.finished?.(9001);
    activity.transcribed?.({
      ...frame,
      id: 9002,
      utterance: '',
      source: 'audio-only',
      storage: activity.admitCapture?.(),
    });
    activity.outcome?.(9002, 'error');
    activity.finished?.(9002);
    fixture.desktop.pause.setMediaPlaying(true);

    for (const width of [420, 760, 1280, 1600]) {
      const { page } = await pairedPage(fixture, browser, width, 800);
      await openConversation(page, 'Why does the list test fail?');
      await page.evaluate(`document.activeElement?.blur()`);
      await heard(fixture, `Something new at ${width} px`, 'IGNORE', 'ignored');
      await page.waitFor(`document.querySelector('${barToggle} .activity-new')`);
      await writeFile(join(directory, `activity-hidden-${width}.png`), await page.screenshot());
      await clickSelector(page, barToggle);
      await page.waitFor(`document.querySelectorAll('.activity-entry').length >= 5`);
      await page.evaluate(`document.activeElement?.blur()`);
      await writeFile(join(directory, `activity-shown-${width}.png`), await page.screenshot());
      assert.equal(await horizontalOverflow(page), 0);
      await page.close();
    }
  },
);
