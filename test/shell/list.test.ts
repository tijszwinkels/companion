import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  assertOwnOrigin,
  clickAt,
  clickButton,
  desktopPage,
  entryExpression,
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
 * The browser shell's conversation list and layout (second slice) in
 * headless Chromium against the real gateway, the real listener control
 * socket and a synthetic agent backend, in temporary directories on
 * loopback only. The rules and their case tables are in
 * integrations/shell/README.md ("Conversation list and layout"); the pure
 * parts are checked case by case in layout.test.ts and
 * reorder-gesture.test.ts, and this suite drives the same rules with real
 * pointer and key input.
 *
 * Every test also checks that nothing went to another origin and that the
 * page ran under the gateway's Content-Security-Policy without violations.
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

async function resize(page: TestPage, width: number, height = 800): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`document.documentElement.clientWidth === ${width}`);
}

type Box = { left: number; top: number; width: number; height: number; x: number; y: number };

/** The bounding box of the first element matching `selector`, with its centre. */
async function box(page: TestPage, selector: string): Promise<Box> {
  const found = await page.evaluate<Box | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    };
  })()`);
  assert.ok(found, `no element for ${selector}`);
  return found;
}

/** The centre of the list entry whose title contains `title`. */
async function entryPoint(page: TestPage, title: string): Promise<{ x: number; y: number }> {
  return page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = ${entryExpression(title)}.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

/** Titles of the list's entries, in the order shown. */
function shownOrder(page: TestPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `[...document.querySelectorAll('.conversation-entry .entry-select')].map((select) => select.title)`,
  );
}

/** One mouse event with the left button (`buttons` = 1 while held). */
async function mouse(
  page: TestPage,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: { x: number; y: number },
  held: boolean,
): Promise<void> {
  await page.call('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: type === 'mouseMoved' && !held ? 'none' : 'left',
    buttons: held ? 1 : 0,
    clickCount: 1,
  });
}

/** Press at `from`, move to `to` in steps with the button held (release is up to the caller). */
async function dragTo(
  page: TestPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await mouse(page, 'mouseMoved', from, false);
  await mouse(page, 'mousePressed', from, true);
  const steps = 6;
  for (let step = 1; step <= steps; step++) {
    const point = {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    };
    await mouse(page, 'mouseMoved', point, true);
  }
}

const keyCodes: Record<string, number> = {
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  Enter: 13,
  Escape: 27,
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

/** The move requests the page sent, from `from` on. */
function moves(sockets: SocketLog, from = 0): Record<string, unknown>[] {
  return sockets.sent
    .slice(from)
    .filter((sent) => sent.type === 'request' && sent.action === 'move-agent');
}

/** Requests the list may send, besides slice 1's. */
const allowedActions = [
  'panel-state',
  'move-agent',
  'close-agent',
  'reopen-agent',
  'send-agent',
  // The Store reads this run's Activity history for the Activity column.
  'activity-history',
];

async function assertCleanPage(fixture: Fixture, page: TestPage, sockets: SocketLog) {
  assertOwnOrigin(fixture, page, sockets);
  await assertNoViolations(page);
  for (const action of requestActions(sockets)) {
    assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
  }
}

/**
 * A page expression: the two remembered entries' values (`undefined` for an
 * entry never written), see integrations/shell/src/layout/stored-layout.ts.
 */
const storedLayout = `({
  listWidth: JSON.parse(localStorage.getItem('companion.shell.layout.listWidth'))?.value,
  listShown: JSON.parse(localStorage.getItem('companion.shell.layout.listShown'))?.value,
})`;
const listWidth = `(document.querySelector('.conversations')?.getBoundingClientRect().width ?? 0)`;

// ---- Layout -----------------------------------------------------------------------

test(
  'at 1280 px the divider gives the strip and the full list, ☰ hides it, and both survive a reload',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await start(fixture, '🗺️ Route planner');
    const second = await start(fixture, 'Login timeout');
    answer(first.run, 'a1', 'Adding walking times between stops.');
    answer(second.run, 'a2', 'Found it: the session cookie expires early.');

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Route planner');

    // Initial: the strip, shown next to the chat; nothing remembered yet.
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    assert.equal(await page.evaluate(listWidth), 78);
    const chatBox = await box(page, '.chat-column');
    assert.ok(chatBox.left >= 78, 'the chat is next to the list');
    // The strip: icon and number, a short name, no last line.
    assert.equal(
      await page.evaluate(`getComputedStyle(document.querySelector('.entry-last-line')).display`),
      'none',
    );
    assert.equal(await text(page, '.conversation-entry .entry-glyph'), '🗺️');
    assert.equal(await text(page, '.conversation-entry .entry-number'), '1');

    // Dragged under the snap point: still the strip, remembered on release.
    const divider = await box(page, '.list-divider');
    await dragTo(page, { x: divider.x, y: 300 }, { x: 100, y: 300 });
    await mouse(page, 'mouseReleased', { x: 100, y: 300 }, false);
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    // Only the width is written; the hidden state was never changed.
    assert.deepEqual(await page.evaluate(storedLayout), { listWidth: 78 });

    // A press on the divider that does not move changes nothing.
    await mouse(page, 'mouseMoved', { x: divider.x, y: 300 }, false);
    await mouse(page, 'mousePressed', { x: divider.x, y: 300 }, true);
    await mouse(page, 'mouseReleased', { x: divider.x, y: 300 }, false);
    await page.evaluate(`localStorage.removeItem('companion.shell.layout.listWidth')`);
    await mouse(page, 'mousePressed', { x: divider.x, y: 300 }, true);
    await mouse(page, 'mouseReleased', { x: divider.x, y: 300 }, false);
    assert.deepEqual(await page.evaluate(storedLayout), {});

    // Dragged over it: the full list with titles and last lines.
    await dragTo(page, { x: divider.x, y: 300 }, { x: 300, y: 300 });
    // While dragging the width follows the pointer and is not yet remembered.
    await page.waitFor(`document.querySelector('.conversations.full')`);
    assert.equal(await page.evaluate(listWidth), 300);
    assert.deepEqual(await page.evaluate(storedLayout), {}, 'nothing written while dragging');
    await mouse(page, 'mouseReleased', { x: 300, y: 300 }, false);
    await page.waitFor(`${storedLayout}?.listWidth === 300`);
    const fullText = await text(page, '.conversations');
    assert.match(fullText, /Route planner/);
    assert.match(fullText, /Adding walking times between stops\./);
    assert.match(fullText, /Found it: the session cookie expires early\./);
    assert.equal(
      await page.evaluate(`getComputedStyle(document.querySelector('.entry-last-line')).display`),
      'block',
    );

    // Beyond the maximum: 420 px.
    await dragTo(page, { x: 300, y: 300 }, { x: 700, y: 300 });
    await mouse(page, 'mouseReleased', { x: 700, y: 300 }, false);
    await page.waitFor(`${listWidth} === 420`);
    await page.waitFor(`${storedLayout}?.listWidth === 420`);

    // Reload: the full list at its width.
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await page.waitFor(`document.querySelector('.conversations.full')`);
    assert.equal(await page.evaluate(listWidth), 420);

    // ☰ hides the list and the divider; the chat uses the freed width (the
    // whole window: there is no maximum).
    await openConversation(page, 'Route planner');
    assert.equal(
      await page.evaluate(`document.querySelector('.list-toggle').getAttribute('aria-expanded')`),
      'true',
    );
    await clickAt(page, await box(page, '.list-toggle'));
    await page.waitFor(`!document.querySelector('.conversations')`);
    assert.equal(await page.evaluate(`document.querySelector('.list-divider')`), null);
    assert.equal(
      await page.evaluate(`document.querySelector('.list-toggle').getAttribute('aria-expanded')`),
      'false',
    );
    const freed = await box(page, '.chat-column');
    assert.equal(freed.width, 1280);
    assert.equal(freed.left, 0);
    assert.deepEqual(await page.evaluate(storedLayout), { listWidth: 420, listShown: false });

    // The hidden state survives a reload; ☰ shows the list at its width again.
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(`document.querySelector('.list-toggle')`, 8000);
    assert.equal(await page.evaluate(`document.querySelector('.conversations')`), null);
    // Clicked once connected: the connection banner above moves the bar until then.
    await page.waitFor(online, 8000);
    await clickAt(page, await box(page, '.list-toggle'));
    await page.waitFor(`${listWidth} === 420`);

    // A narrow window shows the strip without changing what is remembered.
    await resize(page, 420);
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    assert.equal(await page.evaluate(listWidth), 78);
    assert.equal(await horizontalOverflow(page), 0);
    await resize(page, 600);
    await page.waitFor(`${listWidth} === 279`);
    await resize(page, 1280);
    await page.waitFor(`${listWidth} === 420`);
    assert.equal((await page.evaluate<{ listWidth: number }>(storedLayout)).listWidth, 420);

    // A storage that refuses writes keeps the page's own values: 300 px,
    // then ☰ twice, is still 300 px.
    await page.evaluate(`Storage.prototype.setItem = () => {
      throw new DOMException('Synthetic full storage', 'QuotaExceededError');
    }`);
    const handle = await box(page, '.list-divider');
    await dragTo(page, { x: handle.x, y: 300 }, { x: 300, y: 300 });
    await mouse(page, 'mouseReleased', { x: 300, y: 300 }, false);
    await page.waitFor(`${listWidth} === 300`);
    await clickAt(page, await box(page, '.list-toggle'));
    await page.waitFor(`!document.querySelector('.conversations')`);
    await clickAt(page, await box(page, '.list-toggle'));
    await page.waitFor(`${listWidth} === 300`);
    assert.equal((await page.evaluate<{ listWidth: number }>(storedLayout)).listWidth, 420);

    await assertCleanPage(fixture, page, sockets);
  },
);

test('the divider and the list entries work from the keyboard', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const first = await start(fixture, 'First keyboard conversation');
  const second = await start(fixture, 'Second keyboard conversation');
  answer(first.run, 'a1', 'One.');
  answer(second.run, 'a2', 'Two.');
  const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
  await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`);

  // The divider: a focusable separator with an accessible name and value.
  const divider = await page.evaluate<Record<string, string | null>>(`(() => {
      const element = document.querySelector('.list-divider');
      return {
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        orientation: element.getAttribute('aria-orientation'),
        controls: element.getAttribute('aria-controls'),
        now: element.getAttribute('aria-valuenow'),
        min: element.getAttribute('aria-valuemin'),
        max: element.getAttribute('aria-valuemax'),
        tabIndex: String(element.tabIndex),
      };
    })()`);
  assert.deepEqual(divider, {
    role: 'separator',
    label: 'Conversation list width',
    orientation: 'vertical',
    controls: 'conversation-list',
    now: '78',
    min: '78',
    max: '420',
    tabIndex: '0',
  });

  // Rule 3: Right from the strip gives 150 px, then 20 px steps; Left back
  // under 150 px gives the strip; End and Home. Each is remembered.
  await page.evaluate(`document.querySelector('.list-divider').focus()`);
  const steps: { press: string; width: number }[] = [
    { press: 'ArrowRight', width: 150 },
    { press: 'ArrowRight', width: 170 },
    { press: 'ArrowLeft', width: 150 },
    { press: 'ArrowLeft', width: 78 },
    { press: 'End', width: 420 },
    { press: 'ArrowRight', width: 420 },
    { press: 'Home', width: 78 },
  ];
  for (const step of steps) {
    await key(page, step.press);
    await page.waitFor(`${listWidth} === ${step.width}`);
    assert.equal(
      await page.evaluate(`document.querySelector('.list-divider').getAttribute('aria-valuenow')`),
      String(step.width),
    );
    assert.equal(
      (await page.evaluate<{ listWidth: number }>(storedLayout)).listWidth,
      step.width,
      `${step.press} remembered`,
    );
  }

  // Each entry's last line is its accessible description, also in the strip.
  assert.equal(
    await page.evaluate(`(() => {
      const select = ${entryExpression('Second keyboard')}.querySelector('.entry-select');
      return document.getElementById(select.getAttribute('aria-describedby')).textContent;
    })()`),
    'Two.',
  );

  // Entries are buttons in tab order: Enter on one selects it.
  await page.evaluate(
    `${entryExpression('Second keyboard')}.querySelector('.entry-select').focus()`,
  );
  // (Its answer completed before the page loaded, so it is also unread:
  // the README's first-snapshot row.)
  assert.equal(
    await page.evaluate(`document.activeElement.getAttribute('aria-label')`),
    '2. Second keyboard conversation, new answer',
  );
  await key(page, 'Enter');
  await page.waitFor(
    `document.querySelector('.chat-bar-title')?.textContent === 'Second keyboard conversation'`,
  );
  assert.equal(
    await page.evaluate(
      `${entryExpression('Second keyboard')}.querySelector('.entry-select').getAttribute('aria-current')`,
    ),
    'page',
  );

  // Space on the other entry selects it too; Tab then reaches its ⋯ button
  // and next its close button, which is shown while focused, and Enter
  // closes it.
  await page.evaluate(
    `${entryExpression('First keyboard')}.querySelector('.entry-select').focus()`,
  );
  await key(page, ' ');
  await page.waitFor(
    `document.querySelector('.chat-bar-title')?.textContent === 'First keyboard conversation'`,
  );
  await page.evaluate(
    `${entryExpression('First keyboard')}.querySelector('.entry-select').focus()`,
  );
  await key(page, 'Tab');
  assert.equal(
    await page.evaluate(`document.activeElement.getAttribute('aria-label')`),
    'Actions for First keyboard conversation',
  );
  await key(page, 'Tab');
  assert.equal(
    await page.evaluate(`document.activeElement.getAttribute('aria-label')`),
    'Close First keyboard conversation',
  );
  // Shown while focused (after the rail's 140 ms fade).
  await page.waitFor(`getComputedStyle(document.activeElement).opacity === '1'`);
  await key(page, 'Enter');
  await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 1`);

  // Previous sessions by keyboard, and Reopen by keyboard.
  await page.evaluate(`document.querySelector('.previous-entry').focus()`);
  await key(page, 'Enter');
  await page.waitFor(`document.querySelector('.previous-session')`);
  await page.evaluate(`document.querySelector('.previous-session button').focus()`);
  await key(page, 'Enter');
  await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`, 8000);
  await page.waitFor(
    `document.querySelector('.chat-bar-title')?.textContent === 'First keyboard conversation'`,
  );

  await assertCleanPage(fixture, page, sockets);
});

test(
  'at 420 px strip and chat fit without overflow; at 1600 px the chat uses the main area’s whole width',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const conversation = await start(
      fixture,
      '🧪 A conversation with a long title that has to fit',
    );
    answer(
      conversation.run,
      'a1',
      'A long answer line that wraps inside the chat column instead of widening the page. '.repeat(
        4,
      ),
    );
    const { page, sockets } = await pairedPage(fixture, browser, 420, 800);
    await openConversation(page, 'A conversation with a long title');

    await page.waitFor(`document.querySelector('.conversations.strip')`);
    assert.equal(await page.evaluate(listWidth), 78);
    assert.equal(await horizontalOverflow(page), 0);
    const narrowChat = await box(page, '.chat-column');
    assert.ok(narrowChat.left >= 78 && narrowChat.left + narrowChat.width <= 420);
    // The bar's title is cut with an ellipsis rather than pushing the state out.
    const state = await box(page, '.chat-bar-state');
    assert.ok(state.left + state.width <= 420, 'the state stays visible');
    // A finished turn's duration follows `ready` (the Last turn duration
    // switch is on by default).
    assert.match(await text(page, '.chat-bar-state'), /^ready · last turn \d+:\d\d$/);

    for (const width of [760, 1280, 1600]) {
      await resize(page, width);
      assert.equal(await horizontalOverflow(page), 0, `overflow at ${width} px`);
    }
    // At 1600 px: the chat column is as wide as the main area (no 860 px
    // maximum), and the messages and the text box use its width (less the
    // column's 16 px padding; a message keeps its gutter opposite the
    // sender, chat/styles.css `.panel`).
    const main = await box(page, '.workspace-main');
    const column = await box(page, '.chat-column');
    assert.equal(main.width, 1600 - 79);
    assert.equal(column.width, main.width);
    assert.equal(column.x, main.x);
    const message = await box(page, '.message.assistant .panel');
    assert.ok(message.width > column.width - 32 - 40, `message ${message.width} px`);
    const editor = await box(page, '.composer textarea');
    assert.ok(editor.width >= column.width - 32 - 1, `text box ${editor.width} px`);

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Selection, drafts and markers ----------------------------------------------

test(
  'selecting a conversation shows it and keeps each conversation’s own unsent text',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await start(fixture, 'Draft conversation one');
    const second = await start(fixture, 'Draft conversation two');
    answer(first.run, 'a1', 'Answer one.');
    answer(second.run, 'a2', 'Answer two.');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);

    await openConversation(page, 'Draft conversation one');
    await page.waitFor(`document.querySelector('.transcript').textContent.includes('Answer one.')`);
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    await page.type('Unsent text for one');

    await openConversation(page, 'Draft conversation two');
    await page.waitFor(`document.querySelector('.transcript').textContent.includes('Answer two.')`);
    assert.equal(await page.evaluate(`document.querySelector('.chat textarea').value`), '');
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    await page.type('Unsent text for two');

    await openConversation(page, 'Draft conversation one');
    await page.waitFor(`document.querySelector('.chat textarea').value === 'Unsent text for one'`);
    assert.doesNotMatch(await text(page, '.transcript'), /Answer two\./);
    await openConversation(page, 'Draft conversation two');
    await page.waitFor(`document.querySelector('.chat textarea').value === 'Unsent text for two'`);

    // Nothing was sent.
    assert.deepEqual(
      requestActions(sockets).filter((action) => action === 'send-agent'),
      [],
    );
    await assertCleanPage(fixture, page, sockets);
  },
);

test('unread and working markers follow the README table', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  // Three conversations whose turns are still running: no completed turn,
  // so nothing is unread when the page loads; all three are working.
  const shown = await start(fixture, 'Shown conversation');
  const other = await start(fixture, 'Other conversation');
  const stopped = await start(fixture, 'Stopped conversation');
  const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
  await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 3`);

  const marks = (title: string) =>
    page.evaluate<{ unread: boolean; dot: boolean; working: boolean; label: string }>(`(() => {
        const entry = ${entryExpression(title)};
        return {
          unread: entry.classList.contains('unread'),
          dot: entry.querySelector('.entry-unread') !== null,
          working: entry.querySelector('.entry-working') !== null,
          label: entry.querySelector('.entry-select').getAttribute('aria-label'),
        };
      })()`);
  const working = (title: string) =>
    `${entryExpression(title)}.querySelector('.entry-working') !== null`;
  const unread = (title: string) => `${entryExpression(title)}.classList.contains('unread')`;

  for (const title of ['Shown conversation', 'Other conversation', 'Stopped conversation']) {
    const state = await marks(title);
    assert.equal(state.working, true, `${title} works`);
    assert.equal(state.unread, false, `${title} has nothing unseen`);
    assert.match(state.label, /, working$/);
  }

  // The bar counts the running turn (turn timers are on by default).
  await openConversation(page, 'Shown conversation');
  assert.match(await text(page, '.chat-bar-state'), /^working · \d+:\d\d$/);

  // A turn completes in the shown conversation with the page visible: not
  // unread; the ring and the running time go, the last turn's duration shows.
  answer(shown.run, 'a1', 'Shown answer.');
  await page.waitFor(`!(${working('Shown conversation')})`);
  await page.waitFor(
    `/^ready · last turn \\d+:\\d\\d$/.test(document.querySelector('.chat-bar-state').textContent)`,
  );
  assert.equal((await marks('Shown conversation')).unread, false);

  // A turn completes in a conversation that is not shown: unread (dot and
  // tint), and no longer working.
  answer(other.run, 'a2', 'Other answer.');
  await page.waitFor(unread('Other conversation'));
  const otherState = await marks('Other conversation');
  assert.deepEqual(
    { dot: otherState.dot, working: otherState.working, label: otherState.label },
    { dot: true, working: false, label: '2. Other conversation, new answer' },
  );

  // A stopped turn ends the working marker without an unread mark.
  await fixture.sessions.stop(stopped.id);
  await page.waitFor(`!(${working('Stopped conversation')})`);
  assert.equal((await marks('Stopped conversation')).unread, false);

  // A conversation started elsewhere arrives working, not unread: the
  // listener marks it only when a turn completes unseen.
  const arrived = await start(fixture, 'Arrived conversation');
  await page.waitFor(`Boolean(${entryExpression('Arrived conversation')})`);
  await page.waitFor(working('Arrived conversation'));
  assert.equal((await marks('Arrived conversation')).unread, false);
  // Its answer completes while another conversation is shown: unread.
  answer(arrived.run, 'a4', 'Arrived answer.');
  await page.waitFor(unread('Arrived conversation'));
  assert.equal((await marks('Arrived conversation')).working, false);

  // Selecting clears the mark; a new turn in it then shows the ring again.
  await openConversation(page, 'Other conversation');
  await page.waitFor(`!(${unread('Other conversation')})`);
  const runsBefore = fixture.runs.length;
  fixture.sessions.followUp(other.id, 'One more question', signal());
  await waitFor(() => fixture.runs.length > runsBefore);
  await page.waitFor(working('Other conversation'));
  await page.waitFor(
    `/^working · \\d+:\\d\\d$/.test(document.querySelector('.chat-bar-state').textContent)`,
  );
  const followUp = fixture.runs.at(-1)!;
  answer(followUp, 'a3', 'Follow-up answer.');
  await page.waitFor(`!(${working('Other conversation')})`);
  assert.equal((await marks('Other conversation')).unread, false);

  // Closing an unread conversation clears its mark with it.
  const arrivedId = await page.evaluate<string>(
    `${entryExpression('Arrived conversation')}.dataset.id`,
  );
  await fixture.sessions.remove(arrivedId);
  await page.waitFor(`!${entryExpression('Arrived conversation')}`);
  assert.equal(
    await page.evaluate(`document.querySelectorAll('.conversation-entry.unread').length`),
    0,
  );

  // Reopened elsewhere, it comes back with the listener's saved mark: its
  // answer is still unseen.
  await fixture.sessions.reopen(arrivedId, false);
  await page.waitFor(`Boolean(${entryExpression('Arrived conversation')})`);
  await page.waitFor(unread('Arrived conversation'));

  await assertCleanPage(fixture, page, sockets);
});

// ---- Close, Previous sessions, reopen --------------------------------------------

test(
  'closing removes a conversation to Previous sessions; reopening brings it back',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const kept = await start(fixture, 'Kept conversation');
    const closed = await start(fixture, 'Closed conversation');
    answer(kept.run, 'a1', 'Kept.');
    answer(closed.run, 'a2', 'Closed.');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Kept conversation');

    // Not hovered or focused, the × is invisible and takes no input: a tap
    // on that corner reaches the entry itself (touch has no hover).
    const hiddenClose = await page.evaluate<string>(`(() => {
      const rect = ${entryExpression('Closed conversation')}.querySelector('.entry-close').getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).className;
    })()`);
    assert.notEqual(hiddenClose, 'entry-close');

    // Hovering shows the ×; a click on it closes without selecting.
    const entry = await entryPoint(page, 'Closed conversation');
    await mouse(page, 'mouseMoved', entry, false);
    const close = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = ${entryExpression('Closed conversation')}.querySelector('.entry-close').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.waitFor(
      `getComputedStyle(${entryExpression('Closed conversation')}.querySelector('.entry-close')).opacity === '1'`,
    );
    await clickAt(page, close);
    await page.waitFor(`!${entryExpression('Closed conversation')}`);
    assert.equal(await text(page, '.chat-bar-title'), 'Kept conversation');
    assert.deepEqual(
      requestActions(sockets).filter((action) => action === 'close-agent'),
      ['close-agent'],
    );

    // Previous sessions lists it, with how many there are.
    assert.match(await text(page, '.previous-entry'), /1 saved conversation/);
    await clickAt(page, await box(page, '.previous-entry'));
    await page.waitFor(`document.querySelector('.previous-session')`);
    assert.equal(await text(page, '.chat-bar-title'), 'Previous sessions');
    assert.equal(
      await page.evaluate(`document.querySelector('.previous-entry').getAttribute('aria-current')`),
      'page',
    );
    assert.match(await text(page, '.previous-sessions'), /Closed conversation/);

    // One reopen at a time: while a (slow, then refused) reopen is in
    // flight every Reopen is disabled; once it settles all are enabled.
    await fixture.sessions.remove(kept.id);
    await page.waitFor(`document.querySelectorAll('.previous-session').length === 2`);
    const originalReopen = fixture.sessions.reopen.bind(fixture.sessions);
    let refuse: () => void = () => {};
    fixture.sessions.reopen = () =>
      new Promise<void>((_resolve, reject) => {
        refuse = () => reject(Error('Synthetic refusal'));
      });
    const reopenButtons = `[...document.querySelectorAll('.previous-session button')]`;
    await clickAt(page, await box(page, '.previous-session button'));
    await page.waitFor(`${reopenButtons}.every((button) => button.disabled)`);
    assert.match(await text(page, '.previous-sessions'), /Opening…/);
    refuse();
    await page.waitFor(`document.querySelector('.toast.error')`);
    await page.waitFor(`${reopenButtons}.every((button) => !button.disabled)`);
    assert.doesNotMatch(await text(page, '.previous-sessions'), /Opening…/);
    fixture.sessions.reopen = originalReopen;

    // Reopen: back in the list, and shown.
    await page.evaluate(
      `[...document.querySelectorAll('.previous-session')].find((row) => row.textContent.includes('Closed conversation')).querySelector('button').scrollIntoView()`,
    );
    await clickAt(
      page,
      await page.evaluate<{ x: number; y: number }>(`(() => {
        const button = [...document.querySelectorAll('.previous-session')].find((row) => row.textContent.includes('Closed conversation')).querySelector('button');
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`),
    );
    await page.waitFor(`Boolean(${entryExpression('Closed conversation')})`, 8000);
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent === 'Closed conversation'`,
    );
    await page.waitFor(`document.querySelector('.transcript')?.textContent.includes('Closed.')`);
    assert.deepEqual(fixture.sessions.order().ids, [closed.id]);

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Reordering by dragging ----------------------------------------------------------

test(
  'a completed drag sends one move with the captured revision; cancelled and refused drags change nothing',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    for (const title of titles) {
      const conversation = await start(fixture, title);
      answer(conversation.run, `answer-${title}`, `${title} answer.`);
    }
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 4`);
    await openConversation(page, 'Bravo');
    assert.deepEqual(await shownOrder(page), titles);
    // Near the top of the conversations, below the Activity entry above them.
    const topY =
      (await page.evaluate<number>(
        `document.querySelector('.conversation-scroll').getBoundingClientRect().top`,
      )) + 22;

    // Completed: Alpha dragged below Charlie (before Delta). One move naming
    // the revision captured at the press; the list then follows the
    // listener's order. The drag neither selects nor closes.
    const capturedRevision = fixture.sessions.order().revision;
    const sentBefore = sockets.sent.length;
    const alpha = await entryPoint(page, 'Alpha');
    const delta = await box(
      page,
      `.conversation-entry[data-id="${fixture.sessions.order().ids[3]}"]`,
    );
    await dragTo(page, alpha, { x: alpha.x, y: delta.top + 4 });
    await page.waitFor(`document.querySelector('.drop-marker')`);
    await mouse(page, 'mouseReleased', { x: alpha.x, y: delta.top + 4 }, false);
    await page.waitFor(
      `JSON.stringify(${JSON.stringify(['Bravo', 'Charlie', 'Alpha', 'Delta'])}) === JSON.stringify([...document.querySelectorAll('.conversation-entry .entry-select')].map((select) => select.title))`,
    );
    const sent = moves(sockets, sentBefore);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].revision, capturedRevision);
    assert.equal(sent[0].beforeId, fixture.sessions.order().ids[3]);
    assert.equal(await text(page, '.chat-bar-title'), 'Bravo');
    assert.equal(await page.evaluate(`document.querySelector('.drop-marker')`), null);

    // Escape during the drag: no move, and the release selects nothing.
    let before = sockets.sent.length;
    let start_ = await entryPoint(page, 'Charlie');
    await dragTo(page, start_, { x: start_.x, y: start_.y + 150 });
    await key(page, 'Escape');
    await page.waitFor(`!document.querySelector('.drop-marker')`);
    await mouse(page, 'mouseReleased', { x: start_.x, y: start_.y + 150 }, false);
    // The next genuine click still selects.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(moves(sockets, before), []);
    assert.equal(await text(page, '.chat-bar-title'), 'Bravo');
    assert.deepEqual(await shownOrder(page), ['Bravo', 'Charlie', 'Alpha', 'Delta']);

    // Released outside the list (over the chat): no move.
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    await dragTo(page, start_, { x: 640, y: 100 });
    await mouse(page, 'mouseReleased', { x: 640, y: 100 }, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(moves(sockets, before), []);
    assert.equal(await text(page, '.chat-bar-title'), 'Bravo');

    // A touch never starts a reorder: on a touchscreen the list scrolls.
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    await page.call('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: start_.x, y: start_.y }],
    });
    for (let step = 1; step <= 6; step++) {
      await page.call('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start_.x, y: start_.y - step * 25 }],
      });
    }
    await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await page.evaluate(`document.querySelector('.drop-marker')`), null);
    assert.deepEqual(moves(sockets, before), []);

    // Released over the divider, which overlaps the list's edge: outside, no move.
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    const divider = await box(page, '.list-divider');
    const listRight = await page.evaluate<number>(
      `document.querySelector('.conversation-scroll').getBoundingClientRect().right`,
    );
    const overDivider = { x: Math.min(listRight - 1, divider.left + divider.width - 1), y: topY };
    assert.ok(overDivider.x > divider.left && overDivider.x < listRight, 'a point in both boxes');
    await dragTo(page, start_, overDivider);
    await mouse(page, 'mouseReleased', overDivider, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(moves(sockets, before), []);

    // The order changes at the listener during the drag: the drag ends
    // without a move, and the list shows the listener's new order.
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    await dragTo(page, start_, { x: start_.x, y: topY });
    await page.waitFor(`document.querySelector('.drop-marker')`);
    const listenerOrder = fixture.sessions.order();
    fixture.sessions.move(listenerOrder.ids[1], listenerOrder.ids[0], listenerOrder.revision);
    await page.waitFor(`!document.querySelector('.drop-marker')`);
    await mouse(page, 'mouseReleased', { x: start_.x, y: topY }, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(moves(sockets, before), []);
    assert.deepEqual(await shownOrder(page), ['Charlie', 'Bravo', 'Alpha', 'Delta']);

    // A move the listener refuses: one request, and the list stays as the
    // listener has it, with an error toast.
    const originalMove = fixture.sessions.move.bind(fixture.sessions);
    fixture.sessions.move = () => {
      throw Error('Session order changed; try moving the tab again');
    };
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    await dragTo(page, start_, { x: start_.x, y: topY });
    await mouse(page, 'mouseReleased', { x: start_.x, y: topY }, false);
    await page.waitFor(`document.querySelector('.toast.error')`, 5000);
    assert.equal(moves(sockets, before).length, 1);
    assert.deepEqual(await shownOrder(page), ['Charlie', 'Bravo', 'Alpha', 'Delta']);
    fixture.sessions.move = originalMove;

    // Going offline during a drag ends it without a move.
    before = sockets.sent.length;
    start_ = await entryPoint(page, 'Delta');
    await dragTo(page, start_, { x: start_.x, y: topY });
    await page.waitFor(`document.querySelector('.drop-marker')`);
    // The gateway stops: the connection drops (the fixture closes the rest).
    void fixture.gateway.close();
    await page.waitFor(`document.querySelector('.connection-banner')`, 10_000);
    await page.waitFor(`!document.querySelector('.drop-marker')`);
    await mouse(page, 'mouseReleased', { x: start_.x, y: topY }, false);
    assert.deepEqual(moves(sockets, before), []);

    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a layout change in another tab is followed, so ☰ there keeps the width chosen here',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const conversation = await start(fixture, 'Two-tab layout');
    answer(conversation.run, 'a1', 'Answer.');
    const first = await pairedPage(fixture, browser, 1280, 800);
    const second = await desktopPage(browser, 1280, 800, first.browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);
    await second.page.waitFor(`${listWidth} === 78`);

    // Widen the list in the first tab (End on the divider: 420 px).
    await first.page.call('Page.bringToFront');
    await first.page.evaluate(`document.querySelector('.list-divider').focus()`);
    await key(first.page, 'End');
    await first.page.waitFor(`${storedLayout}?.listWidth === 420`);

    // The second tab follows; hiding the list there keeps that width.
    await second.page.call('Page.bringToFront');
    await second.page.waitFor(`${listWidth} === 420`);
    await clickAt(second.page, await box(second.page, '.list-toggle'));
    await second.page.waitFor(`${storedLayout}?.listShown === false`);
    assert.deepEqual(await second.page.evaluate(storedLayout), {
      listWidth: 420,
      listShown: false,
    });
    await first.page.call('Page.bringToFront');
    await first.page.waitFor(`!document.querySelector('.conversations')`);

    await assertCleanPage(fixture, first.page, first.sockets);
    await assertCleanPage(fixture, second.page, second.sockets);
  },
);
