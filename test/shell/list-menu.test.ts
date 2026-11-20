import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  assertOwnOrigin,
  buttonExpression,
  clickAt,
  desktopPage,
  entryExpression,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  requestActions,
  setup,
  skip,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * Moving a conversation by key (Alt+Shift+Up/Down) and by its ⋯ menu, and
 * the menu itself (integrations/shell/README.md, "Moving by key and by the
 * ⋯ menu"), in headless Chromium against the real gateway, the real
 * listener control socket and a synthetic agent backend, in temporary
 * directories on loopback only. The pure part of the same tables (which
 * request a step sends, the pending rule) is move-steps.test.ts.
 *
 * Nothing waits for a fixed time. A move is sent synchronously in the
 * key or click handler, so the page's own count of `move-agent` sends
 * (`window.__moveSends`, installed before the page loads) says at once
 * whether one went out. The same wrapper can hold sends back
 * (`window.__holdMoves`), which keeps a move pending for as long as a case
 * needs.
 *
 * Every test also checks that nothing went to another origin and that the
 * page ran under the gateway's Content-Security-Policy without violations.
 */

// ---- Helpers ----------------------------------------------------------------------

/** Start a conversation whose title is `title` and finish its turn. */
async function startAnswered(fixture: Fixture, title: string): Promise<string> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) => candidate.request.prompt.text.includes(title));
  assert.ok(run, `no run for ${title}`);
  answer(run, `answer-${title}`, `${title} answer.`);
  return id;
}

function answer(run: SyntheticRun, messageId: string, reply: string): void {
  run.emit({ ...chatMessage(messageId, 'assistant', reply), state: 'done' });
  run.finish();
}

/**
 * Installed before the page loads: counts the page's `move-agent` sends and
 * can hold them back until released.
 */
const moveRecorder = `(() => {
  window.__moveSends = [];
  window.__holdMoves = false;
  window.__heldMoves = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    let message = null;
    try {
      message = JSON.parse(data);
    } catch {}
    if (message && message.type === 'request' && message.action === 'move-agent') {
      window.__moveSends.push(message);
      if (window.__holdMoves) {
        window.__heldMoves.push(() => send.call(this, data));
        return;
      }
    }
    return send.call(this, data);
  };
  window.__releaseMoves = () => {
    window.__holdMoves = false;
    const held = window.__heldMoves;
    window.__heldMoves = [];
    for (const release of held) release();
  };
})();`;

/** A paired page at `width` with the move recorder installed. */
async function recordedPage(
  fixture: Fixture,
  browser: TestBrowser,
  width: number,
  height = 800,
): Promise<{ page: TestPage; sockets: SocketLog }> {
  const { page, sockets } = await desktopPage(browser, width, height);
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: moveRecorder });
  await page.navigate(`${fixture.origin}/`);
  await page.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  const codePoint = await center(page, `document.querySelector('#code')`);
  await clickAt(page, codePoint);
  await page.type(code);
  await clickAt(page, await center(page, `document.querySelector('button[type=submit]')`));
  await page.waitFor(online, 8000);
  return { page, sockets };
}

/** The moves the page has sent (or tried to send while held) so far. */
function moveSends(page: TestPage): Promise<Record<string, string>[]> {
  return page.evaluate(`window.__moveSends`);
}

async function center(page: TestPage, expression: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = ${expression};
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `no element for ${expression}`);
  return point;
}

/** Click the element `expression` with the mouse. */
async function clickElement(page: TestPage, expression: string): Promise<void> {
  await clickAt(page, await center(page, expression));
}

/** Tap the element `expression` with a finger. */
async function tapElement(page: TestPage, expression: string): Promise<void> {
  const point = await center(page, expression);
  await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const keyCodes: Record<string, number> = {
  ArrowUp: 38,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  Enter: 13,
  Escape: 27,
  Tab: 9,
  ' ': 32,
};

/** Modifier bits of the DevTools protocol. */
const alt = 1;
const shift = 8;

/** Press and release one key on the focused element. */
async function key(page: TestPage, name: string, modifiers = 0): Promise<void> {
  const code = name === ' ' ? 'Space' : name;
  const base = { key: name, code, windowsVirtualKeyCode: keyCodes[name], modifiers };
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

/** Titles of the list's entries, in the order shown. */
function shownOrder(page: TestPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `[...document.querySelectorAll('.conversation-entry .entry-select')].map((select) => select.title)`,
  );
}

/** A page expression: the list shows exactly `titles`, in this order. */
function showsOrder(titles: string[]): string {
  return `JSON.stringify([...document.querySelectorAll('.conversation-entry .entry-select')].map((select) => select.title)) === ${JSON.stringify(JSON.stringify(titles))}`;
}

/** The listener's order as titles. */
function listenerOrder(fixture: Fixture, titlesById: Map<string, string>): string[] {
  return fixture.sessions.order().ids.map((id) => titlesById.get(id)!);
}

function selectOf(title: string): string {
  return `${entryExpression(title)}?.querySelector('.entry-select')`;
}

function menuButtonOf(title: string): string {
  return `${entryExpression(title)}?.querySelector('.entry-menu-button')`;
}

const openMenu = `document.querySelector('.entry-menu')`;

function menuItem(label: string): string {
  return `[...document.querySelectorAll('.entry-menu [role=menuitem]')].find((item) => item.textContent.trim() === ${JSON.stringify(label)})`;
}

/** A page expression: no move awaits its answer (the list is not busy). */
const noMovePending = `document.querySelector('.conversation-scroll')?.getAttribute('aria-busy') !== 'true'`;

/** A page expression: `expression` (an element) has focus. */
function focused(expression: string): string {
  return `(document.activeElement === (${expression}))`;
}

/** Wait until `expression` (an element) has focus; on timeout, say what has it. */
async function waitFocused(page: TestPage, expression: string): Promise<void> {
  try {
    await page.waitFor(focused(expression));
  } catch (error) {
    const has = await page.evaluate<string>(
      `document.activeElement ? document.activeElement.outerHTML.slice(0, 160) : 'nothing'`,
    );
    throw Error(`${(error as Error).message}\nFocus is on: ${has}`);
  }
}

/** Put the list in the strip or the full list (Home / End on the divider). */
async function appearance(page: TestPage, which: 'strip' | 'full'): Promise<void> {
  await page.evaluate(`document.querySelector('.list-divider').focus()`);
  await key(page, which === 'strip' ? 'Home' : 'End');
  await page.waitFor(`document.querySelector('.conversations.${which}')`);
}

/** Requests the list may send. */
const allowedActions = [
  'panel-state',
  'move-agent',
  'close-agent',
  'reopen-agent',
  'send-agent',
  'activity-history',
];

async function assertCleanPage(fixture: Fixture, page: TestPage, sockets: SocketLog) {
  assertOwnOrigin(fixture, page, sockets);
  await assertNoViolations(page);
  for (const action of requestActions(sockets)) {
    assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
  }
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

/** The open menu's box and the window's size. */
function menuInWindow(page: TestPage): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const box = document.querySelector('.entry-menu').getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  })()`);
}

// ---- Moving: the table ------------------------------------------------------------

test(
  'moving by key and by menu: first, middle and last × up and down, in the strip and the full list',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const titles = ['Alpha', 'Bravo', 'Charlie'];
    const titlesById = new Map<string, string>();
    for (const title of titles) {
      titlesById.set(await startAnswered(fixture, title), title);
    }
    const { page, sockets } = await recordedPage(fixture, browser, 1280);
    const second = await pairedPage(fixture, browser, 1280);
    await page.waitFor(showsOrder(titles));
    await openConversation(page, 'Alpha');

    // The browser has no classic view: the chat page draws no Classic view
    // button (its Close session is still there).
    await page.waitFor(buttonExpression('Close session'));
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('Classic view')})`), false);

    type Method = 'key' | 'menu';
    type Position = 'first' | 'middle' | 'last';
    const positions: Position[] = ['first', 'middle', 'last'];
    let cases = 0;
    for (const shown of ['strip', 'full'] as const) {
      await appearance(page, shown);
      for (const method of ['key', 'menu'] as Method[]) {
        for (const position of positions) {
          for (const direction of ['up', 'down'] as const) {
            cases++;
            const name = `${shown}, ${method}, ${position}, ${direction}`;
            const before = listenerOrder(fixture, titlesById);
            const index = positions.indexOf(position);
            const title = before[index];
            const revision = fixture.sessions.order().revision;
            const sendsBefore = (await moveSends(page)).length;
            const target = direction === 'up' ? index - 1 : index + 1;
            const atEnd = target < 0 || target >= before.length;

            if (method === 'key') {
              // With the entry focused: Alt+Shift+Up or Alt+Shift+Down.
              await page.evaluate(`${selectOf(title)}.focus()`);
              await key(page, direction === 'up' ? 'ArrowUp' : 'ArrowDown', alt | shift);
            } else {
              // Its ⋯ menu, by mouse: Move up or Move down.
              await clickElement(page, menuButtonOf(title));
              await page.waitFor(openMenu);
              const item = menuItem(direction === 'up' ? 'Move up' : 'Move down');
              assert.equal(
                await page.evaluate(`${item}.getAttribute('aria-disabled') === 'true'`),
                atEnd,
                `${name}: offered unless at the end`,
              );
              await clickElement(page, item);
            }

            // The control the reader used keeps focus: the entry's select
            // button for the keys, its ⋯ button for the menu (a choice
            // closes the menu; an unavailable one does nothing).
            const control = method === 'key' ? selectOf(title) : menuButtonOf(title);

            if (atEnd) {
              // Nothing is sent, the order stays, focus stays.
              assert.equal((await moveSends(page)).length, sendsBefore, `${name}: nothing sent`);
              if (method === 'menu') {
                // The unavailable item did nothing; Escape leaves the menu.
                assert.ok(await page.evaluate(`Boolean(${openMenu})`), `${name}: menu open`);
                await key(page, 'Escape');
                await page.waitFor(`!${openMenu}`);
              }
              assert.deepEqual(await shownOrder(page), before, name);
              await waitFocused(page, control);
              continue;
            }

            // One move, exactly as the drag sends it: the conversation, the
            // one it goes before and the current revision.
            const expected = [...before];
            expected.splice(index, 1);
            expected.splice(target, 0, title);
            await page.waitFor(showsOrder(expected), 5000);
            await page.waitFor(noMovePending, 5000);
            const sent = (await moveSends(page)).slice(sendsBefore);
            assert.equal(sent.length, 1, `${name}: one move`);
            assert.equal(sent[0].revision, revision, `${name}: the current revision`);
            const ids = [...titlesById.keys()];
            const idOf = (wanted: string) => ids.find((id) => titlesById.get(id) === wanted)!;
            assert.equal(sent[0].id, idOf(title));
            const beforeTitle = direction === 'up' ? before[index - 1] : (before[index + 2] ?? '');
            assert.equal(sent[0].beforeId, beforeTitle ? idOf(beforeTitle) : '', name);
            // At the listener and in a second page.
            assert.deepEqual(listenerOrder(fixture, titlesById), expected, name);
            await second.page.waitFor(showsOrder(expected), 5000);
            // Focus stays on the moved entry.
            await waitFocused(page, control);
            assert.equal(await page.evaluate(`Boolean(${openMenu})`), false);
          }
        }
      }
    }
    assert.equal(cases, 24);

    // Nothing else changed: the shown conversation is still Alpha.
    assert.match(
      await page.evaluate<string>(`document.querySelector('.chat-bar-title').textContent`),
      /Alpha/,
    );
    await assertCleanPage(fixture, page, sockets);
    await assertCleanPage(fixture, second.page, second.sockets);
  },
);

// ---- Moving: pending, refused, one conversation, closed elsewhere ---------------------

test(
  'one move at a time; a refused move leaves the listener’s order; one conversation; closed while its menu is open',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    const titlesById = new Map<string, string>();
    for (const title of titles) {
      titlesById.set(await startAnswered(fixture, title), title);
    }
    const idOf = (wanted: string) =>
      [...titlesById.keys()].find((id) => titlesById.get(id) === wanted)!;
    const { page, sockets } = await recordedPage(fixture, browser, 1280);
    await page.waitFor(showsOrder(titles));
    await appearance(page, 'full');

    // A move while another is pending: held, so it stays pending. A second
    // key press sends nothing, and the menu offers no move meanwhile.
    await page.evaluate(`window.__holdMoves = true`);
    await page.evaluate(`${selectOf('Alpha')}.focus()`);
    await key(page, 'ArrowDown', alt | shift);
    assert.equal((await moveSends(page)).length, 1);
    await key(page, 'ArrowDown', alt | shift);
    await key(page, 'ArrowUp', alt | shift);
    assert.equal((await moveSends(page)).length, 1, 'nothing while one is pending');
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    assert.equal(
      await page.evaluate(`${menuItem('Move up')}.getAttribute('aria-disabled')`),
      'true',
    );
    assert.equal(
      await page.evaluate(`${menuItem('Move down')}.getAttribute('aria-disabled')`),
      'true',
    );
    await clickElement(page, menuItem('Move up'));
    assert.equal((await moveSends(page)).length, 1, 'the unavailable item sends nothing');
    await key(page, 'Escape');
    await page.waitFor(`!${openMenu}`);
    // Hiding and showing the list keeps the pending move: still busy, and
    // a key sends nothing.
    await clickElement(page, `document.querySelector('.list-toggle')`);
    await page.waitFor(`!document.querySelector('.conversations')`);
    await clickElement(page, `document.querySelector('.list-toggle')`);
    await page.waitFor(showsOrder(titles));
    assert.equal(
      await page.evaluate(
        `document.querySelector('.conversation-scroll').getAttribute('aria-busy')`,
      ),
      'true',
    );
    await page.evaluate(`${selectOf('Alpha')}.focus()`);
    await key(page, 'ArrowDown', alt | shift);
    assert.equal((await moveSends(page)).length, 1, 'nothing after hiding and showing');
    // Released: the one move arrives and the list follows the listener.
    assert.equal(
      await page.evaluate(
        `document.querySelector('.conversation-scroll').getAttribute('aria-busy')`,
      ),
      'true',
    );
    await page.evaluate(`window.__releaseMoves()`);
    await page.waitFor(showsOrder(['Bravo', 'Alpha', 'Charlie', 'Delta']), 5000);
    await page.waitFor(noMovePending, 5000);
    assert.equal((await moveSends(page)).length, 1);
    // Once it ended, the next move goes out.
    await page.evaluate(`${selectOf('Alpha')}.focus()`);
    await key(page, 'ArrowDown', alt | shift);
    await page.waitFor(showsOrder(['Bravo', 'Charlie', 'Alpha', 'Delta']), 5000);
    await page.waitFor(noMovePending, 5000);
    assert.equal((await moveSends(page)).length, 2);
    await waitFocused(page, selectOf('Alpha'));

    // Refused because the order changed elsewhere: the move is held while
    // another client moves Delta to the top, then reaches the listener with
    // the old revision. The list shows the listener's order, an error toast
    // says why, focus stays, and the next move works.
    await page.evaluate(`window.__holdMoves = true`);
    await page.evaluate(`${selectOf('Charlie')}.focus()`);
    await key(page, 'ArrowUp', alt | shift);
    assert.equal((await moveSends(page)).length, 3);
    const listener = fixture.sessions.order();
    fixture.sessions.move(idOf('Delta'), listener.ids[0], listener.revision);
    await page.waitFor(showsOrder(['Delta', 'Bravo', 'Charlie', 'Alpha']), 5000);
    await page.evaluate(`window.__releaseMoves()`);
    await page.waitFor(`document.querySelector('.toast.error')`, 5000);
    await page.waitFor(noMovePending, 5000);
    assert.match(
      await page.evaluate<string>(`document.querySelector('.toast.error').textContent`),
      /order changed/i,
    );
    assert.deepEqual(await shownOrder(page), ['Delta', 'Bravo', 'Charlie', 'Alpha']);
    assert.deepEqual(listenerOrder(fixture, titlesById), ['Delta', 'Bravo', 'Charlie', 'Alpha']);
    assert.ok(await page.evaluate<boolean>(focused(selectOf('Charlie'))));
    await key(page, 'ArrowUp', alt | shift);
    await page.waitFor(showsOrder(['Delta', 'Charlie', 'Bravo', 'Alpha']), 5000);
    await page.waitFor(noMovePending, 5000);
    assert.equal((await moveSends(page)).length, 4);

    // The entry closed elsewhere while its menu is open (focus in the menu):
    // the menu goes, focus goes to the entry now at its place.
    await clickElement(page, menuButtonOf('Charlie'));
    await waitFocused(page, menuItem('Move up'));
    await fixture.sessions.remove(idOf('Charlie'));
    await page.waitFor(showsOrder(['Delta', 'Bravo', 'Alpha']), 5000);
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, selectOf('Bravo'));
    // The last one, by keyboard: focus goes to the new last entry.
    await page.evaluate(`${menuButtonOf('Alpha')}.focus()`);
    await key(page, 'Enter');
    await page.waitFor(openMenu);
    await fixture.sessions.remove(idOf('Alpha'));
    await page.waitFor(showsOrder(['Delta', 'Bravo']), 5000);
    await waitFocused(page, selectOf('Bravo'));

    // One conversation: neither key nor menu moves it, focus stays.
    await fixture.sessions.remove(idOf('Delta'));
    await page.waitFor(showsOrder(['Bravo']), 5000);
    const sendsBefore = (await moveSends(page)).length;
    await page.evaluate(`${selectOf('Bravo')}.focus()`);
    await key(page, 'ArrowUp', alt | shift);
    await key(page, 'ArrowDown', alt | shift);
    assert.equal((await moveSends(page)).length, sendsBefore);
    assert.ok(await page.evaluate<boolean>(focused(selectOf('Bravo'))));
    await key(page, 'Tab');
    await waitFocused(page, menuButtonOf('Bravo'));
    await key(page, ' ');
    await page.waitFor(openMenu);
    for (const label of ['Move up', 'Move down']) {
      assert.equal(
        await page.evaluate(`${menuItem(label)}.getAttribute('aria-disabled')`),
        'true',
        label,
      );
    }
    assert.equal(
      await page.evaluate(`${menuItem('Close session')}.getAttribute('aria-disabled')`),
      null,
    );
    await key(page, 'Escape');
    await waitFocused(page, menuButtonOf('Bravo'));
    assert.equal((await moveSends(page)).length, sendsBefore);

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- The menu: the table ----------------------------------------------------------

test(
  'the ⋯ menu opens by click, Enter and Space, and closes by Escape, a choice, a click outside, another menu and the strip',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const titles = ['Alpha', 'Bravo', 'Charlie'];
    const titlesById = new Map<string, string>();
    for (const title of titles) {
      titlesById.set(await startAnswered(fixture, title), title);
    }
    const { page, sockets } = await recordedPage(fixture, browser, 1280);
    await page.waitFor(showsOrder(titles));
    await openConversation(page, 'Alpha');
    await appearance(page, 'full');

    // Accessible names: the ⋯ button names its conversation and its popup.
    assert.deepEqual(
      await page.evaluate(`(() => {
        const button = ${menuButtonOf('Bravo')};
        return {
          name: button.getAttribute('aria-label'),
          popup: button.getAttribute('aria-haspopup'),
          expanded: button.getAttribute('aria-expanded'),
          tag: button.tagName,
        };
      })()`),
      { name: 'Actions for Bravo', popup: 'menu', expanded: 'false', tag: 'BUTTON' },
    );

    // Opened by click: focus on the first item; the menu named, its items
    // menu items; the button says it is expanded and which menu it controls.
    await clickElement(page, menuButtonOf('Bravo'));
    await waitFocused(page, menuItem('Move up'));
    assert.deepEqual(
      await page.evaluate(`(() => {
        const menu = document.querySelector('.entry-menu');
        const button = ${menuButtonOf('Bravo')};
        return {
          role: menu.getAttribute('role'),
          name: menu.getAttribute('aria-label'),
          items: [...menu.querySelectorAll('[role=menuitem]')].map((item) => item.textContent.trim()),
          expanded: button.getAttribute('aria-expanded'),
          controls: button.getAttribute('aria-controls') === menu.id,
        };
      })()`),
      {
        role: 'menu',
        name: 'Actions for Bravo',
        items: ['Move up', 'Move down', 'Close session'],
        expanded: 'true',
        controls: true,
      },
    );
    assert.ok(await menuInWindow(page));
    await screenshot(page, 'entry-menu-1280-full');

    // Keyboard inside: Down, Up (wrapping), Home and End move focus.
    await key(page, 'ArrowDown');
    await waitFocused(page, menuItem('Move down'));
    await key(page, 'End');
    await waitFocused(page, menuItem('Close session'));
    await key(page, 'ArrowDown');
    await waitFocused(page, menuItem('Move up'));
    await key(page, 'ArrowUp');
    await waitFocused(page, menuItem('Close session'));
    await key(page, 'Home');
    await waitFocused(page, menuItem('Move up'));

    // Closed by Escape: focus back on the ⋯ button.
    await key(page, 'Escape');
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, menuButtonOf('Bravo'));
    assert.equal(
      await page.evaluate(`${menuButtonOf('Bravo')}.getAttribute('aria-expanded')`),
      'false',
    );

    // Opened by Enter and by Space on the focused ⋯ button.
    await key(page, 'Enter');
    await waitFocused(page, menuItem('Move up'));
    await key(page, 'Escape');
    await waitFocused(page, menuButtonOf('Bravo'));
    await key(page, ' ');
    await waitFocused(page, menuItem('Move up'));

    // Closed by a choice, chosen by keyboard (Enter on Move down): focus on
    // the ⋯ button of the moved entry.
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    await page.waitFor(showsOrder(['Alpha', 'Charlie', 'Bravo']), 5000);
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, menuButtonOf('Bravo'));

    // Closed by a click outside on nothing focusable (the text of the
    // answer): focus returns to the ⋯ button.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await clickElement(page, `[...document.querySelectorAll('.rows .message')].at(-1)`);
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, menuButtonOf('Charlie'));

    // Closed by a click outside on a control: that control takes focus.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await clickElement(page, `document.querySelector('.chat textarea')`);
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, `document.querySelector('.chat textarea')`);

    // Tab leaves it: closed, focus on the next control after the ⋯ button.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await key(page, 'Tab');
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, `${entryExpression('Charlie')}.querySelector('.entry-close')`);

    // A press on the open menu's ⋯ released elsewhere (no click): focus is
    // on the ⋯ and the menu still open; Escape there closes it.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    const opener = await center(page, menuButtonOf('Charlie'));
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: opener.x, y: opener.y });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: opener.x,
      y: opener.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: opener.x + 300,
      y: opener.y + 200,
      button: 'left',
      buttons: 1,
    });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: opener.x + 300,
      y: opener.y + 200,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await waitFocused(page, menuButtonOf('Charlie'));
    assert.ok(await page.evaluate(`Boolean(${openMenu})`), 'still open');
    await key(page, 'Escape');
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, menuButtonOf('Charlie'));

    // A press outside can start a text selection: dragging across the
    // answer closes the menu and selects its text.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    // From the right end of the answer's text line, outside the menu, to
    // the start of its text.
    const line = await page.evaluate<{ from: number; to: number; y: number }>(`(() => {
      const panel = [...document.querySelectorAll('.rows .message')].at(-1).querySelector('.panel');
      const paragraph = panel.querySelector('.bubble p');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const text = range.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      return { from: box.right - 30, to: text.left + 1, y: text.top + text.height / 2 };
    })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: line.from, y: line.y });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: line.from,
      y: line.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await page.waitFor(`!${openMenu}`);
    for (let step = 1; step <= 6; step++) {
      await page.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: line.from + ((line.to - line.from) * step) / 6,
        y: line.y,
        button: 'left',
        buttons: 1,
      });
    }
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: line.to,
      y: line.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    assert.match(await page.evaluate<string>(`getSelection().toString()`), /answer\./);

    // Opening another entry's menu closes the first: one menu, the other's.
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await clickElement(page, menuButtonOf('Alpha'));
    await page.waitFor(
      `document.querySelectorAll('.entry-menu').length === 1 && document.querySelector('.entry-menu').getAttribute('aria-label') === 'Actions for Alpha'`,
    );
    assert.equal(
      await page.evaluate(`${menuButtonOf('Charlie')}.getAttribute('aria-expanded')`),
      'false',
    );
    await waitFocused(page, menuItem('Move up'));
    // Its ⋯ button again closes it.
    await clickElement(page, menuButtonOf('Alpha'));
    await page.waitFor(`!${openMenu}`);

    // The list becoming the strip closes it; focus that was in it goes to
    // the ⋯ button.
    await clickElement(page, menuButtonOf('Alpha'));
    await waitFocused(page, menuItem('Move up'));
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    await page.waitFor(`!${openMenu}`);
    await waitFocused(page, menuButtonOf('Alpha'));
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.querySelector('.conversations.full')`);

    // Close session from the menu: one close-agent; the conversation leaves
    // the list and focus goes to the entry at its place.
    const closesBefore = requestActions(sockets).filter((action) => action === 'close-agent');
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    assert.equal(
      await page.evaluate(`${menuItem('Close session')}.title`),
      'Close session · saved in Previous sessions',
    );
    await clickElement(page, menuItem('Close session'));
    await page.waitFor(showsOrder(['Alpha', 'Bravo']), 5000);
    assert.equal(
      requestActions(sockets).filter((action) => action === 'close-agent').length,
      closesBefore.length + 1,
    );
    await waitFocused(page, selectOf('Bravo'));
    // The drag and the × are still there.
    assert.ok(
      await page.evaluate(`Boolean(${entryExpression('Bravo')}.querySelector('.entry-close'))`),
    );
    // No move was sent by any of the menu's opening and closing.
    assert.equal((await moveSends(page)).length, 1);

    await assertCleanPage(fixture, page, sockets);
  },
);

// ---- Touch, layout and screenshots ------------------------------------------------

test(
  'at 420 px the menu works by touch and fits; at 420 and 1600 px nothing overflows',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const titles = ['🧪 Alpha with a longer title', 'Bravo', 'Charlie'];
    const titlesById = new Map<string, string>();
    for (const title of titles) {
      titlesById.set(await startAnswered(fixture, title), title);
    }
    const { page, sockets } = await recordedPage(fixture, browser, 420, 800);
    await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 3`);
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    const shownTitles = await shownOrder(page);

    // A tap on ⋯ opens the menu, inside the window, without overflow.
    await tapElement(page, menuButtonOf('Bravo'));
    await page.waitFor(openMenu);
    assert.ok(await menuInWindow(page));
    assert.equal(await horizontalOverflow(page), 0);
    await screenshot(page, 'entry-menu-420-strip');

    // A tap on Move up moves it (one move), and the menu closes.
    await tapElement(page, menuItem('Move up'));
    const expected = [shownTitles[1], shownTitles[0], shownTitles[2]];
    await page.waitFor(showsOrder(expected), 5000);
    await page.waitFor(`!${openMenu}`);
    assert.equal((await moveSends(page)).length, 1);
    assert.deepEqual(listenerOrder(fixture, titlesById), expected);

    // A tap outside (on the chat's empty view) closes it, with no move.
    await tapElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await tapElement(page, `document.querySelector('.chat-bar-title')`);
    await page.waitFor(`!${openMenu}`);
    assert.equal((await moveSends(page)).length, 1);

    // A short window where the list scrolls: scrolled so that the open
    // menu's ⋯ leaves the window, the menu stays inside it.
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 360,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`innerHeight === 360`);
    await page.waitFor(
      `document.querySelector('.conversation-scroll').scrollHeight > document.querySelector('.conversation-scroll').clientHeight`,
    );
    const firstTitle = (await shownOrder(page))[0];
    await page.evaluate(`document.querySelector('.conversation-scroll').scrollTop = 0`);
    await tapElement(page, menuButtonOf(firstTitle));
    await page.waitFor(openMenu);
    await page.evaluate(
      `document.querySelector('.conversation-scroll').scrollTop = document.querySelector('.conversation-scroll').scrollHeight`,
    );
    await page.waitFor(
      `${menuButtonOf(firstTitle)}.getBoundingClientRect().bottom < 0 || ${menuButtonOf(firstTitle)}.getBoundingClientRect().bottom < document.querySelector('.conversation-scroll').getBoundingClientRect().top`,
    );
    await page.waitFor(`(() => {
      const box = document.querySelector('.entry-menu').getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    })()`);
    await key(page, 'Escape');
    await page.waitFor(`!${openMenu}`);
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`innerHeight === 800`);

    // A tap on the entry still selects it (the menu is a button of its own).
    await tapElement(page, selectOf('Charlie'));
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Charlie')`,
    );
    assert.equal(await page.evaluate(`Boolean(${openMenu})`), false);

    // The full list at 1280 px with its menu open, for the screenshots.
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.documentElement.clientWidth === 1280`);
    await clickElement(page, menuButtonOf('Charlie'));
    await page.waitFor(openMenu);
    await screenshot(page, 'entry-menu-1280-strip');
    await key(page, 'Escape');
    await appearance(page, 'full');
    await clickElement(page, menuButtonOf('Alpha'));
    await page.waitFor(openMenu);
    assert.ok(await menuInWindow(page));
    await screenshot(page, 'entry-menu-1280-full-emoji');
    await key(page, 'Escape');

    // 1600 px, full list, menu open: no overflow, the menu in the window.
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.documentElement.clientWidth === 1600`);
    await clickElement(page, menuButtonOf('Bravo'));
    await page.waitFor(openMenu);
    assert.equal(await horizontalOverflow(page), 0);
    assert.ok(await menuInWindow(page));
    await key(page, 'Escape');

    // 420 px with the full list remembered: shown as the strip (window
    // rule), the menu of the last entry inside the window.
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    const last = (await shownOrder(page)).at(-1)!;
    await tapElement(page, menuButtonOf(last));
    await page.waitFor(openMenu);
    assert.ok(await menuInWindow(page));
    assert.equal(await horizontalOverflow(page), 0);
    await screenshot(page, 'entry-menu-420-strip-last');

    await assertCleanPage(fixture, page, sockets);
  },
);
