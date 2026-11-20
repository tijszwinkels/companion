import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import type { UserSensorProcessor } from '../../src/core/frame.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { messageTimeText, zoneCalendar } from '../../integrations/shell/src/times/message-time.ts';
import { frame, signal } from '../helpers.ts';
import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { remoteFixture, waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  assertOwnOrigin,
  click,
  desktopPage,
  entryExpression,
  horizontalOverflow,
  online,
  openConversation,
  requestActions,
  skip,
  text,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * The settings screen, turn timers and message timestamps (integrations/
 * shell/README.md, "Settings, turn timers and message times") in headless
 * Chromium against the real gateway, the real listener control socket and a
 * synthetic agent backend, in temporary directories on loopback only.
 *
 * Clocks are controlled, never waited for: the listener's clock is the
 * fixture's `clock` option, and the page's `Date.now` is shifted by a script
 * installed before the page loads (`page.__shiftClock`). Moving both by the
 * same amount is time passing; moving one is a clock that differs. The
 * pure rules are checked case by case in times.test.ts and
 * listening-switches.test.ts.
 *
 * Every test also checks that nothing went to another origin and that the
 * page ran under the gateway's Content-Security-Policy without violations.
 */

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;

/** The time zone of the page in these tests (the listener runs in UTC here). */
const pageZone = 'Asia/Tokyo';

// ---- Helpers ----------------------------------------------------------------------

/**
 * The fixture with a listener clock the test moves (`listener.shift`), and
 * a browser.
 */
async function setupWithClock(context: { after(callback: () => Promise<void>): void }) {
  const listener = { shift: 0 };
  const fixture = await remoteFixture({
    appDirectory,
    clock: () => Date.now() + listener.shift,
  });
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser, listener };
}

/**
 * A paired page whose `Date.now` runs `browserAhead` ahead of the real
 * clock (`window.__shiftClock(ms)` moves it on), in `pageZone`.
 */
async function pairedClockPage(
  fixture: Fixture,
  browser: TestBrowser,
  width: number,
  browserAhead = 0,
  sharedContext = '',
): Promise<{ page: TestPage; sockets: SocketLog; browserContextId: string }> {
  const opened = await desktopPage(browser, width, 800, sharedContext);
  const { page } = opened;
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const realNow = Date.now.bind(Date);
      let shift = ${browserAhead};
      window.__shiftClock = (milliseconds) => { shift += milliseconds; };
      Date.now = () => realNow() + shift;
    })();`,
  });
  await page.call('Emulation.setTimezoneOverride', { timezoneId: pageZone });
  await page.navigate(`${fixture.origin}/`);
  if (!sharedContext) {
    await page.waitFor(`document.querySelector('#code')`);
    const { code } = await fixture.devices.createPairingCode();
    await click(page, '#code');
    await page.type(code);
    await click(page, 'button[type=submit]');
  }
  await page.waitFor(online, 8000);
  return opened;
}

/** Start a conversation whose title is `title`; its run stays open until finished. */
async function start(fixture: Fixture, title: string): Promise<{ id: string; run: SyntheticRun }> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) => candidate.request.prompt.text.includes(title));
  assert.ok(run, `no run for ${title}`);
  return { id, run };
}

function answer(run: SyntheticRun, messageId: string, reply: string): void {
  run.emit({ ...chatMessage(messageId, 'assistant', reply), state: 'done' });
  run.finish();
}

/** Move both clocks on: time passes. */
async function advance(
  listener: { shift: number },
  page: TestPage,
  milliseconds: number,
): Promise<void> {
  listener.shift += milliseconds;
  await page.evaluate(`window.__shiftClock(${milliseconds})`);
}

/** The text of the running time on a list entry, or null without one. */
function entryTimer(page: TestPage, title: string): Promise<string | null> {
  return page.evaluate<string | null>(
    `${entryExpression(title)}?.querySelector('.entry-timer')?.textContent ?? null`,
  );
}

/** A page expression: the bar's state text matches `pattern`. */
function barMatches(pattern: RegExp): string {
  return `${pattern}.test(document.querySelector('.chat-bar-state')?.textContent ?? '')`;
}

/** A page expression: an entry's running time matches `pattern`. */
function entryTimerMatches(title: string, pattern: RegExp): string {
  return `${pattern}.test(${entryExpression(title)}?.querySelector('.entry-timer')?.textContent ?? '')`;
}

const keyCodes: Record<string, number> = { Enter: 13, Tab: 9, ' ': 32, End: 35 };

async function key(page: TestPage, name: string, shift = false): Promise<void> {
  const code = name === ' ' ? 'Space' : name;
  const base = { key: name, code, windowsVirtualKeyCode: keyCodes[name], modifiers: shift ? 8 : 0 };
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

/** Press Tab until `expression` (an element) has focus. */
async function tabTo(page: TestPage, expression: string, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step++) {
    if (await page.evaluate<boolean>(`document.activeElement === (${expression})`)) {
      return;
    }
    await key(page, 'Tab');
  }
  throw Error(`Tab never reached ${expression}`);
}

/** Click the centre of the element `expression` with the mouse. */
async function clickElement(page: TestPage, expression: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const element = ${expression};
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.call('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
  }
}

const gear = `document.querySelector('.settings-toggle')`;
const settingsEntry = `document.querySelector('.settings-entry')`;
const settingsShown = `document.querySelector('.settings-screen') !== null`;

/** The switch whose accessible name (or title) is `name`. */
function switchExpression(name: string): string {
  return `[...document.querySelectorAll('.setting-switch')].find((element) =>
    (element.getAttribute('aria-label') ??
      document.getElementById(element.getAttribute('aria-labelledby'))?.textContent) === ${JSON.stringify(name)})`;
}

function switchChecked(page: TestPage, name: string): Promise<string | null> {
  return page.evaluate<string | null>(
    `${switchExpression(name)}?.getAttribute('aria-checked') ?? null`,
  );
}

/** The heading times of the transcript, in row order. */
function messageTimes(page: TestPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `[...document.querySelectorAll('.rows > .message')].map((row) => row.querySelector('.message-time')?.textContent ?? '')`,
  );
}

/** The Display entries this browser remembers. */
function storedDisplay(page: TestPage): Promise<Record<string, string | null>> {
  return page.evaluate(`(() => {
    const read = (name) => localStorage.getItem('companion.shell.display.' + name);
    return {
      turnTimers: read('turnTimers'),
      lastTurnDuration: read('lastTurnDuration'),
      messageTimestamps: read('messageTimestamps'),
    };
  })()`);
}

/**
 * The texts a message written at `createdAt` (listener clock) may show on
 * a page whose clock differs by `browserAhead`: the offset is only known up
 * to the delivery delay, so near a minute's end either minute is right.
 */
function expectedTimes(createdAt: number, browserAhead: number): string[] {
  const calendar = zoneCalendar(pageZone);
  const readerNow = Date.now() + browserAhead;
  const texts = new Set<string>();
  for (const error of [-2 * second, 0, 2 * second]) {
    texts.add(messageTimeText(createdAt, -browserAhead + error, readerNow, calendar));
  }
  return [...texts];
}

async function assertCleanPage(fixture: Fixture, page: TestPage, sockets: SocketLog) {
  assertOwnOrigin(fixture, page, sockets);
  await assertNoViolations(page);
  // Never the unscoped stop, whatever the page did.
  assert.equal(requestActions(sockets).includes('stop-agent'), false);
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

type Box = { left: number; top: number; width: number; height: number; right: number };

async function box(page: TestPage, selector: string): Promise<Box> {
  const found = await page.evaluate<Box | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right };
  })()`);
  assert.ok(found, `no element for ${selector}`);
  return found;
}

/** Saves a screenshot when COMPANION_SHELL_SCREENSHOTS names a directory. */
async function screenshot(page: TestPage, name: string): Promise<void> {
  const directory = process.env.COMPANION_SHELL_SCREENSHOTS;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.png`), await page.screenshot());
}

/**
 * Two conversations with running turns that started 2 hours and 5 minutes
 * ago on the listener's clock, and one finished turn; returns their runs.
 */
async function runningConversations(fixture: Fixture, listener: { shift: number }) {
  listener.shift = -2 * hour;
  const long = await start(fixture, '🧪 Long run');
  listener.shift = -5 * minute;
  const short = await start(fixture, '🐛 Short run');
  listener.shift = -90 * second;
  const done = await start(fixture, '🧾 Done run');
  listener.shift = -48 * second;
  answer(done.run, 'done-answer', 'Finished.');
  // The turn ends (and its duration is taken) on the shifted clock.
  await waitFor(() => {
    const session = fixture.sessions.snapshot().find((candidate) => candidate.id === done.id);
    return session?.lastTurnDurationMs !== undefined && session.turnStartedAt === undefined;
  }, 3000);
  listener.shift = 0;
  return { long, short, done };
}

// ---- Turn timers and message times ----------------------------------------------

test(
  'running turns count in the bar and the list, advance with the clock and end with the last duration',
  { skip },
  async (context) => {
    const { fixture, browser, listener } = await setupWithClock(context);

    // The gateway's policy is the one earlier slices run under; the page
    // must not need anything weaker.
    const response = await fetch(`${fixture.origin}/`);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

    const { long, short } = await runningConversations(fixture, listener);

    // This browser's clock is 5 minutes ahead of the listener's: the
    // offset from the state messages corrects it.
    const browserAhead = 5 * minute;
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280, browserAhead);

    // The strip: each running conversation has its own time under its name.
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    await page.waitFor(entryTimerMatches('Long run', /^2:00:0\d$/));
    await page.waitFor(entryTimerMatches('Short run', /^5:0\d$/));
    assert.equal(await entryTimer(page, 'Done run'), null);
    // Under the name: inside the entry's text, below the title.
    assert.equal(
      await page.evaluate(
        `${entryExpression('Long run')}.querySelector('.entry-text .entry-timer') !== null`,
      ),
      true,
    );

    // The bar of the shown conversation.
    await openConversation(page, 'Long run');
    await page.waitFor(barMatches(/^working · 2:00:0\d$/));
    await screenshot(page, 'timers-1280-strip');

    // Time passes (65 s on both clocks): every time advances, without the
    // page being drawn again: every change to the document while the times
    // advance is the text of a timer (recorded from the whole document).
    await page.evaluate(`(() => {
      window.__otherChanges = [];
      window.__timerChanges = 0;
      const inTimer = (node) => {
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return Boolean(element?.closest('.turn-timer, .entry-timer'));
      };
      window.__mutations = new MutationObserver((records) => {
        for (const record of records) {
          if (inTimer(record.target)) {
            window.__timerChanges++;
          } else {
            window.__otherChanges.push(record.type + ' ' + (record.target.className || record.target.nodeName));
          }
        }
      });
      window.__mutations.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
    })()`);
    await advance(listener, page, 65 * second);
    await page.waitFor(barMatches(/^working · 2:01:0\d$/), 3000);
    await page.waitFor(entryTimerMatches('Short run', /^6:0\d$/), 3000);
    await page.evaluate(`window.__mutations.disconnect()`);
    assert.ok((await page.evaluate<number>(`window.__timerChanges`)) >= 3);
    assert.deepEqual(await page.evaluate(`window.__otherChanges`), []);

    // The full list: the time right-aligned beside the title.
    await page.evaluate(`document.querySelector('.list-divider').focus()`);
    await key(page, 'End');
    await page.waitFor(`document.querySelector('.conversations.full')`);
    await page.waitFor(entryTimerMatches('Short run', /^6:0\d$/));
    const timerRight = await page.evaluate<number>(
      `${entryExpression('Short run')}.querySelector('.entry-timer').getBoundingClientRect().right`,
    );
    const entryRight = await page.evaluate<number>(
      `${entryExpression('Short run')}.getBoundingClientRect().right`,
    );
    assert.ok(entryRight - timerRight <= 12, `right-aligned: ${entryRight - timerRight} px`);
    assert.equal(
      await page.evaluate(
        `${entryExpression('Short run')}.querySelector('.entry-text .entry-timer') === null`,
      ),
      true,
    );
    await screenshot(page, 'timers-1280-full');

    // The messages show when they were written, in the reader's time zone
    // and clock.
    const session = fixture.sessions.snapshot().find((candidate) => candidate.id === long.id)!;
    const question = session.messages.find((message) => message.kind === 'user')!;
    assert.ok(typeof question.createdAt === 'number');
    await page.waitFor(`document.querySelector('.rows .message-time')`);
    const times = await messageTimes(page);
    assert.ok(
      expectedTimes(question.createdAt, browserAhead).includes(times[0]),
      `${times[0]} for ${new Date(question.createdAt).toISOString()}`,
    );

    // The turn ends: the time goes, the last turn's duration shows.
    answer(long.run, 'long-answer', 'Done after a long run.');
    await page.waitFor(barMatches(/^ready · last turn 2:01:0\d$/), 5000);
    await page.waitFor(`${entryExpression('Long run')}.querySelector('.entry-timer') === null`);
    // The other conversation counts on.
    assert.match((await entryTimer(page, 'Short run')) ?? '', /^6:\d\d$/);
    // The answer has a time too; every message row of this conversation has one.
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 2`);

    // The finished conversation shows its duration.
    await openConversation(page, 'Done run');
    await page.waitFor(barMatches(/^ready · last turn 0:4\d$/));

    short.run.finish();
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'offline the last known start is not counted; after the new snapshot it is again',
  { skip },
  async (context) => {
    const { fixture, browser, listener } = await setupWithClock(context);
    listener.shift = -3 * minute;
    const running = await start(fixture, '🧪 Counting run');
    listener.shift = 0;
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);
    await openConversation(page, 'Counting run');
    await page.waitFor(barMatches(/^working · 3:0\d$/));

    // The gateway stops: offline, the state is unknown; the bar says
    // `working…` and the list has no time.
    await fixture.gateway.close();
    await page.waitFor(`document.querySelector('.connection-banner')`, 5000);
    await page.waitFor(barMatches(/^working…$/));
    assert.equal(await entryTimer(page, 'Counting run'), null);

    // While offline the turn ends and a new one starts 30 s later.
    answer(running.run, 'first-answer', 'First answer.');
    await waitFor(() => fixture.sessions.snapshot()[0].turnStartedAt === undefined, 3000);
    const runsBefore = fixture.runs.length;
    fixture.sessions.followUp(running.id, 'And once more', signal());
    await waitFor(() => fixture.runs.length > runsBefore);

    const replacement = new Gateway({
      host: '127.0.0.1',
      port: fixture.port,
      origins: [fixture.origin],
      stateDirectory: join(fixture.directory, 'remote-state'),
      controlSocket: fixture.desktop.socketPath,
      sessionsDirectory: join(fixture.directory, '.companion-sessions'),
      appDirectory,
      log: () => {},
    });
    await replacement.start();
    context.after(() => replacement.close());

    // After the new snapshot the new turn is counted from its own start.
    await page.waitFor(`!document.querySelector('.connection-banner')`, 20_000);
    await page.waitFor(barMatches(/^working · 0:0\d$/), 5000);
    await page.waitFor(entryTimerMatches('Counting run', /^0:0\d$/));

    fixture.runs.at(-1)!.finish();
    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- The settings screen and the Display switches --------------------------------

test(
  'the settings screen opens from the gear and the list, by mouse and keyboard, and leaves by choosing a conversation',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    const conversation = await start(fixture, '🗺️ Route planner');
    answer(conversation.run, 'a1', 'An answer.');
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);
    await openConversation(page, 'Route planner');

    // The gear, left of the Activity ☰.
    const gearBox = await box(page, '.settings-toggle');
    const activityBox = await box(page, '.activity-toggle');
    assert.ok(gearBox.right <= activityBox.left, 'the gear is left of the Activity ☰');
    assert.equal(await page.evaluate(`${gear}.getAttribute('aria-pressed')`), 'false');

    // By keyboard: Tab to the gear, Enter.
    await tabTo(page, gear);
    await key(page, 'Enter');
    await page.waitFor(settingsShown);
    assert.equal(await text(page, '.chat-bar-title'), 'Settings');
    assert.equal(await page.evaluate(`document.querySelector('.chat-bar-state')`), null);
    assert.equal(await page.evaluate(`${gear}.getAttribute('aria-pressed')`), 'true');
    assert.equal(await page.evaluate(`${settingsEntry}.getAttribute('aria-current')`), 'page');
    // The conversation underneath is not marked as shown meanwhile.
    assert.equal(
      await page.evaluate(`${entryExpression('Route planner')}.classList.contains('selected')`),
      false,
    );
    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll('.settings-heading')].map((heading) => heading.textContent)`,
      ),
      ['Display', 'Listening'],
    );
    // The switches have their names and one line each.
    for (const name of ['Turn timers', 'Last turn duration', 'Message timestamps']) {
      assert.equal(await switchChecked(page, name), 'true', name);
    }
    assert.equal(
      await page.evaluate(
        `document.getElementById(${switchExpression('Turn timers')}.getAttribute('aria-describedby')).textContent`,
      ),
      'How long each running turn has been going, in the chat header and on the conversation list.',
    );
    await screenshot(page, 'settings-1280');

    // Space on a focused switch switches it; Tab reaches each.
    await tabTo(page, switchExpression('Message timestamps'));
    await key(page, ' ');
    await page.waitFor(
      `${switchExpression('Message timestamps')}.getAttribute('aria-checked') === 'false'`,
    );
    await key(page, ' ');
    await page.waitFor(
      `${switchExpression('Message timestamps')}.getAttribute('aria-checked') === 'true'`,
    );

    // The gear again goes back to the conversation.
    await tabTo(page, gear, 60);
    await key(page, 'Enter');
    await page.waitFor(`!(${settingsShown})`);
    await page.waitFor(`document.querySelector('.chat textarea')`);
    assert.equal(await text(page, '.chat-bar-title'), '🗺️ Route planner');

    // The list's Settings entry, by keyboard; choosing the conversation
    // underneath (Enter on its entry) leaves.
    await tabTo(page, settingsEntry, 60);
    await key(page, 'Enter');
    await page.waitFor(settingsShown);
    await tabTo(page, `${entryExpression('Route planner')}.querySelector('.entry-select')`, 60);
    await key(page, 'Enter');
    await page.waitFor(`!(${settingsShown})`);
    await page.waitFor(`document.querySelector('.chat textarea')`);

    // By mouse: the Settings entry, then Previous sessions leaves too.
    await clickElement(page, settingsEntry);
    await page.waitFor(settingsShown);
    await clickElement(page, `document.querySelector('.previous-entry:not(.settings-entry)')`);
    await page.waitFor(`!(${settingsShown})`);
    assert.equal(await text(page, '.chat-bar-title'), 'Previous sessions');

    // Browser Back leaves it as well.
    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    await page.evaluate(`history.back()`);
    await page.waitFor(`!(${settingsShown})`);

    // While the Activity column is shown the gear is at the bar's right end.
    await clickElement(page, `document.querySelector('.activity-toggle')`);
    await page.waitFor(`document.querySelector('.activity-column')`);
    const bar = await box(page, '.chat-bar');
    const shownGear = await box(page, '.settings-toggle');
    assert.ok(bar.right - shownGear.right <= 20, 'the gear at the bar’s right end');

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'each Display switch hides its display at once, is remembered per entry and followed by another tab',
  { skip },
  async (context) => {
    const { fixture, browser, listener } = await setupWithClock(context);
    const { short } = await runningConversations(fixture, listener);
    const { page, sockets, browserContextId } = await pairedClockPage(fixture, browser, 1280);

    await openConversation(page, 'Done run');
    await page.waitFor(barMatches(/^ready · last turn 0:4\d$/));
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 2`);
    await page.waitFor(entryTimerMatches('Short run', /^5:0\d$/));
    assert.deepEqual(await storedDisplay(page), {
      turnTimers: null,
      lastTurnDuration: null,
      messageTimestamps: null,
    });

    // Message timestamps off: the times go at once (the chat stays shown
    // underneath the settings screen? No: the settings screen replaces it,
    // so check after going back).
    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    await clickElement(page, switchExpression('Message timestamps'));
    await clickElement(page, switchExpression('Last turn duration'));
    await clickElement(page, switchExpression('Turn timers'));
    await page.waitFor(
      `${switchExpression('Turn timers')}.getAttribute('aria-checked') === 'false'`,
    );
    // The list's timers went at once, while the settings screen is shown.
    assert.equal(await entryTimer(page, 'Short run'), null);
    assert.deepEqual(await storedDisplay(page), {
      turnTimers: '{"version":1,"value":false}',
      lastTurnDuration: '{"version":1,"value":false}',
      messageTimestamps: '{"version":1,"value":false}',
    });
    await screenshot(page, 'settings-off-1280');

    await clickElement(page, gear);
    await page.waitFor(`document.querySelector('.chat textarea')`);
    await page.waitFor(barMatches(/^ready$/));
    await page.waitFor(`document.querySelectorAll('.rows > .message').length >= 2`);
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 0`);
    await openConversation(page, 'Short run');
    await page.waitFor(barMatches(/^working…$/));
    await screenshot(page, 'switches-off-1280');

    // Reload: as remembered.
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await openConversation(page, 'Short run');
    await page.waitFor(barMatches(/^working…$/));
    assert.equal(await entryTimer(page, 'Short run'), null);
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 0`);

    // Another tab of this browser switches Turn timers on: this tab follows
    // that switch only.
    const second_ = await pairedClockPage(fixture, browser, 1280, 0, browserContextId);
    await clickElement(second_.page, gear);
    await second_.page.waitFor(settingsShown);
    await clickElement(second_.page, switchExpression('Turn timers'));
    await page.waitFor(barMatches(/^working · 5:\d\d$/), 3000);
    await page.waitFor(entryTimerMatches('Short run', /^5:\d\d$/));
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 0`);
    assert.equal((await storedDisplay(page)).messageTimestamps, '{"version":1,"value":false}');

    // And Message timestamps on: the rows get their times back.
    await clickElement(second_.page, switchExpression('Message timestamps'));
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 1`);
    await assertCleanPage(fixture, second_.page, second_.sockets);
    await second_.page.close();

    short.run.finish();
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a storage that refuses writes keeps the switches for this page',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    const conversation = await start(fixture, '🗺️ Route planner');
    answer(conversation.run, 'a1', 'An answer.');
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);
    await openConversation(page, 'Route planner');
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 2`);

    // From now on this page's storage refuses writes.
    await page.evaluate(
      `Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }`,
    );
    await clickElement(page, gear);
    await clickElement(page, switchExpression('Message timestamps'));
    await page.waitFor(
      `${switchExpression('Message timestamps')}.getAttribute('aria-checked') === 'false'`,
    );
    await clickElement(page, gear);
    await page.waitFor(`document.querySelectorAll('.rows > .message').length === 2`);
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 0`);
    assert.equal((await storedDisplay(page)).messageTimestamps, null);

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- The listener's own switches ----------------------------------------------------

/** Register an intent with a spoken shortcut, so the listener offers both switches. */
async function registerIntent(fixture: Fixture): Promise<void> {
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
  const processor: UserSensorProcessor = {
    id: 'NOTE',
    label: 'Note',
    dependencies: {},
    name: 'NOTE',
    instruction: 'Synthetic note',
    prefixes: ['note'],
    async process() {},
    subscribe(target) {
      target.register(this);
    },
  };
  processor.subscribe(router);
  await runtime.connectRouter(router);
}

test(
  'the sound, intent and shortcut switches change the listener’s settings and follow changes made elsewhere',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    await registerIntent(fixture);
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);

    await clickElement(page, settingsEntry);
    await page.waitFor(settingsShown);
    await page.waitFor(`${switchExpression('Sound feedback')}`);
    assert.equal(await switchChecked(page, 'Sound feedback'), 'false');
    assert.equal(await switchChecked(page, 'Note intent'), 'true');
    assert.equal(await switchChecked(page, 'Note shortcut'), 'true');

    // Sound feedback on, from this page: the listener's setting changes.
    const sentBefore = sockets.sent.length;
    await clickElement(page, switchExpression('Sound feedback'));
    await page.waitFor(
      `${switchExpression('Sound feedback')}.getAttribute('aria-checked') === 'true'`,
    );
    assert.deepEqual(requestActions(sockets, sentBefore), ['toggle-sounds']);

    // The intent off: `set-intent-enabled` with its name, mode and value.
    const intentBefore = sockets.sent.length;
    await clickElement(page, switchExpression('Note intent'));
    await page.waitFor(
      `${switchExpression('Note intent')}.getAttribute('aria-checked') === 'false'`,
    );
    const intentRequest = sockets.sent
      .slice(intentBefore)
      .find((sent) => sent.action === 'set-intent-enabled');
    // The action's parameters are fields of the request frame.
    assert.deepEqual(
      { name: intentRequest?.name, mode: intentRequest?.mode, enabled: intentRequest?.enabled },
      { name: 'NOTE', mode: 'inference', enabled: false },
    );
    assert.equal(await switchChecked(page, 'Note shortcut'), 'true');

    // Keyboard: Space on the shortcut switch.
    await page.evaluate(`${switchExpression('Note shortcut')}.focus()`);
    await key(page, ' ');
    await page.waitFor(
      `${switchExpression('Note shortcut')}.getAttribute('aria-checked') === 'false'`,
    );
    // Focus stayed on the switch while its answer was on its way.
    assert.equal(
      await page.evaluate(`document.activeElement === ${switchExpression('Note shortcut')}`),
      true,
    );

    // Changed elsewhere (another paired client): this page follows.
    const { token } = await fixture.pair('Another client');
    const other = await fixture.phone(token);
    await other.engine('state');
    other.send({ requestId: 'sounds-elsewhere', action: 'toggle-sounds' });
    await other.reply('sounds-elsewhere');
    await page.waitFor(
      `${switchExpression('Sound feedback')}.getAttribute('aria-checked') === 'false'`,
    );
    other.send({
      requestId: 'intent-elsewhere',
      action: 'set-intent-enabled',
      name: 'NOTE',
      mode: 'inference',
      enabled: true,
    });
    await other.reply('intent-elsewhere');
    await page.waitFor(
      `${switchExpression('Note intent')}.getAttribute('aria-checked') === 'true'`,
    );

    // Offline: last known, unavailable, with a note; pressing sends nothing.
    await fixture.gateway.close();
    await page.waitFor(`document.querySelector('.connection-banner')`, 5000);
    await page.waitFor(
      `${switchExpression('Sound feedback')}.getAttribute('aria-disabled') === 'true'`,
    );
    assert.match(await text(page, '.settings-note'), /last reported/);
    const offlineBefore = sockets.sent.length;
    await clickElement(page, switchExpression('Note intent'));
    assert.deepEqual(requestActions(sockets, offlineBefore), []);
    assert.equal(await switchChecked(page, 'Note intent'), 'true');

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Layouts ------------------------------------------------------------------------

test(
  'at 420 and 1600 px the settings screen and the timers fit; at 1600 px the chat uses its whole width',
  { skip },
  async (context) => {
    const { fixture, browser, listener } = await setupWithClock(context);
    const { short } = await runningConversations(fixture, listener);
    const { page, sockets } = await pairedClockPage(fixture, browser, 420);

    // 420 px: the strip, the bar's state with its time, no overflow.
    await openConversation(page, 'Short run');
    await page.waitFor(barMatches(/^working · 5:\d\d$/));
    await page.waitFor(entryTimerMatches('Short run', /^5:\d\d$/));
    assert.equal(await horizontalOverflow(page), 0);
    const state = await box(page, '.chat-bar-state');
    assert.ok(state.right <= 420, 'the state stays visible');
    await screenshot(page, 'timers-420');
    await openConversation(page, 'Done run');
    await page.waitFor(`document.querySelectorAll('.rows .message-time').length === 2`);
    assert.equal(await horizontalOverflow(page), 0);
    await screenshot(page, 'timestamps-420');
    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    assert.equal(await horizontalOverflow(page), 0);
    await screenshot(page, 'settings-420');
    await clickElement(page, switchExpression('Turn timers'));
    await clickElement(page, switchExpression('Last turn duration'));
    await clickElement(page, switchExpression('Message timestamps'));
    await screenshot(page, 'settings-off-420');
    await clickElement(page, gear);
    await page.waitFor(barMatches(/^ready$/));
    await screenshot(page, 'switches-off-420');
    for (const name of ['Turn timers', 'Last turn duration', 'Message timestamps']) {
      await clickElement(page, gear);
      await page.waitFor(settingsShown);
      await clickElement(page, switchExpression(name));
      await clickElement(page, gear);
    }

    // 1600 px: the chat area's whole width for the messages and the text box.
    await resize(page, 1600);
    await page.waitFor(barMatches(/^ready · last turn 0:4\d$/));
    assert.equal(await horizontalOverflow(page), 0);
    const main = await box(page, '.workspace-main');
    const column = await box(page, '.chat-column');
    assert.equal(column.width, main.width);
    const message = await box(page, '.message.assistant .panel');
    assert.ok(message.width > column.width - 32 - 40, `message ${message.width} px`);
    const editor = await box(page, '.composer');
    assert.ok(editor.width >= column.width - 32 - 1, `text box ${editor.width} px`);
    // The time is at the right end of the heading line.
    await page.waitFor(`document.querySelector('.message.assistant .heading .message-time')`);
    const heading = await box(page, '.message.assistant .heading');
    const time = await box(page, '.message.assistant .heading .message-time');
    assert.ok(heading.right - time.right < 80, 'right-aligned (left of Copy’s room)');
    assert.ok(time.left > heading.left + heading.width / 2);
    await screenshot(page, 'timestamps-1600');

    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    assert.equal(await horizontalOverflow(page), 0);
    assert.ok((await box(page, '.page-column')).width <= 860);

    short.run.finish();
    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- The settings screen over a conversation ---------------------------------------

test(
  'an answer completed behind the settings screen is marked unread; going back clears it',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    const first = await start(fixture, '🗺️ First conversation');
    const second_ = await start(fixture, '🐛 Second conversation');
    answer(second_.run, 'b1', 'Second answer.');
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);
    const unread = (title: string) => `${entryExpression(title)}.classList.contains('unread')`;

    // The first conversation is selected, then covered by Settings.
    await openConversation(page, 'Second conversation');
    await openConversation(page, 'First conversation');
    await clickElement(page, gear);
    await page.waitFor(settingsShown);

    // Its answer completes meanwhile: marked unread, with the toast.
    answer(first.run, 'a1', 'First answer.');
    await page.waitFor(unread('First conversation'));
    await page.waitFor(
      `[...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('answer ready'))`,
    );

    // Back with the gear: it is shown, and the mark goes.
    await clickElement(page, gear);
    await page.waitFor(`!(${unread('First conversation')})`);

    // Covered again; another answer; then the reader chooses the other
    // conversation: the first one's answer is still unseen.
    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    const runsBefore = fixture.runs.length;
    fixture.sessions.followUp(first.id, 'And one more', signal());
    await waitFor(() => fixture.runs.length > runsBefore);
    answer(fixture.runs.at(-1)!, 'a2', 'Second answer of the first.');
    await page.waitFor(unread('First conversation'));
    await openConversation(page, 'Second conversation');
    assert.equal(await page.evaluate(unread('First conversation')), true);
    await openConversation(page, 'First conversation');
    await page.waitFor(`!(${unread('First conversation')})`);

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'going to Settings and back keeps the reader’s place in the conversation without loading anything',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    const conversation = await start(fixture, '🧾 Long transcript');
    for (let index = 0; index < 40; index++) {
      conversation.run.emit({
        ...chatMessage(`paragraph-${index}`, 'assistant', `Paragraph ${index}. `.repeat(12)),
        state: 'done',
      });
    }
    conversation.run.finish();
    const { page, sockets } = await pairedClockPage(fixture, browser, 1280);
    await openConversation(page, 'Long transcript');
    await page.waitFor(`document.querySelectorAll('.rows > .message').length >= 40`);

    // The reader scrolls up with the wheel, away from the live end.
    const transcript = await box(page, '.transcript');
    for (let step = 0; step < 3; step++) {
      await page.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: transcript.left + transcript.width / 2,
        y: transcript.top + transcript.height / 2,
        deltaX: 0,
        deltaY: -400,
      });
    }
    await page.waitFor(
      `(() => { const t = document.querySelector('.transcript'); return t.scrollHeight - t.scrollTop - t.clientHeight > 600; })()`,
    );
    // Let any smooth scrolling come to rest: the same position over 300 ms.
    const before = await page.evaluate<number>(`new Promise((resolve) => {
      const transcript = document.querySelector('.transcript');
      let last = -1;
      const check = () => {
        if (transcript.scrollTop === last) {
          resolve(last);
          return;
        }
        last = transcript.scrollTop;
        setTimeout(check, 300);
      };
      check();
    })`);
    const sentBefore = sockets.sent.length;

    await clickElement(page, gear);
    await page.waitFor(settingsShown);
    // The chat is covered and inert meanwhile.
    assert.equal(await page.evaluate(`document.querySelector('.chat-column').inert`), true);
    await clickElement(page, gear);
    await page.waitFor(`!(${settingsShown})`);

    assert.equal(
      await page.evaluate<number>(`document.querySelector('.transcript').scrollTop`),
      before,
    );
    assert.equal(requestActions(sockets, sentBefore).includes('agent-history-page'), false);
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'in a narrow window the Settings entry hides the Activity column over the chat and the screen is reachable',
  { skip },
  async (context) => {
    const { fixture, browser } = await setupWithClock(context);
    const conversation = await start(fixture, '🗺️ Route planner');
    answer(conversation.run, 'a1', 'An answer.');
    const { page, sockets } = await pairedClockPage(fixture, browser, 420);
    await openConversation(page, 'Route planner');

    // Activity over the chat (the main area is inert).
    await clickElement(page, `document.querySelector('.activity-toggle')`);
    await page.waitFor(`document.querySelector('.activity-column')`);
    assert.equal(await page.evaluate(`document.querySelector('.workspace-main').inert`), true);

    // The list's Settings entry: Activity goes, the settings screen shows.
    await clickElement(page, settingsEntry);
    await page.waitFor(settingsShown);
    await page.waitFor(`!document.querySelector('.activity-column')`);
    assert.equal(await page.evaluate(`document.querySelector('.workspace-main').inert`), false);
    await tabTo(page, switchExpression('Turn timers'), 60);
    await key(page, ' ');
    await page.waitFor(
      `${switchExpression('Turn timers')}.getAttribute('aria-checked') === 'false'`,
    );
    assert.equal(await horizontalOverflow(page), 0);

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'at 375 px a long last duration goes under the title; the title and all bar buttons stay in the window',
  { skip },
  async (context) => {
    const { fixture, browser, listener } = await setupWithClock(context);
    listener.shift = -(hour + 2 * minute + 3 * second);
    const conversation = await start(fixture, '🧾 A conversation with a long title');
    listener.shift = 0;
    answer(conversation.run, 'a1', 'An answer after an hour.');
    const { page, sockets } = await pairedClockPage(fixture, browser, 375);
    await openConversation(page, 'A conversation with a long title');
    await page.waitFor(barMatches(/^ready · last turn 1:02:0\d$/));

    assert.equal(await horizontalOverflow(page), 0);
    const title = await box(page, '.chat-bar-title');
    const state = await box(page, '.chat-bar-state');
    assert.ok(title.width >= 64, `title ${title.width} px`);
    assert.ok(state.right <= 375, 'the state is in the window');
    assert.ok(state.top >= title.top + title.height - 1, 'the state is under the title');
    for (const selector of ['.list-toggle', '.settings-toggle', '.activity-toggle']) {
      const button = await box(page, selector);
      assert.ok(button.left >= 0 && button.right <= 375, `${selector} in the window`);
      assert.ok(button.width >= 33, `${selector} keeps its size`);
    }
    await screenshot(page, 'bar-375');

    await assertCleanPage(fixture, page, sockets);
  },
);
