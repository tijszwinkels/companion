import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import {
  addressedOutcome,
  conversationAddress,
  conversationOfFragment,
} from '../../integrations/shell/src/workspace/new-window.ts';
import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  click,
  desktopPage,
  online,
  openConversation,
  pairedPage,
  setup,
  skip,
  text,
  type Fixture,
} from './page.ts';

/**
 * A conversation in a new window (integrations/shell/README.md, "A
 * conversation in a new window"): the address and fragment rules in Node,
 * then the README table's rows in headless Chromium against the real
 * gateway and listener: ⧉ opening the address, a window on a conversation
 * that is open, one that was closed meanwhile and an unknown one, each
 * window keeping its own conversation, and a reload.
 */

test('the address names the conversation; a fragment names it back', () => {
  const page = { origin: 'http://127.0.0.1:8788', pathname: '/', search: '' };
  const id = '11111111-1111-4111-8111-111111111111';
  const address = conversationAddress(page, id);
  assert.equal(address, `http://127.0.0.1:8788/#conversation=${id}`);
  assert.equal(conversationOfFragment(new URL(address).hash), id);

  // Kept: the path and the query; an ID with reserved characters survives.
  assert.equal(
    conversationAddress(
      { origin: 'https://desk.example', pathname: '/shell/', search: '?a=1' },
      'a b#c',
    ),
    'https://desk.example/shell/?a=1#conversation=a%20b%23c',
  );
  assert.equal(conversationOfFragment('#conversation=a%20b%23c'), 'a b#c');

  // Anything else names nothing.
  for (const hash of [
    '',
    '#',
    '#conversation=',
    '#other=1',
    '#conversation',
    '#conversation=%E0%A4%A',
  ]) {
    assert.equal(conversationOfFragment(hash), '', hash);
  }
});

test('outcome for the first snapshot: open, closed meanwhile, unknown', () => {
  const state = {
    sessions: new Map([['open', {}]]),
    previous: [{ id: 'closed' }],
  };
  assert.equal(addressedOutcome('open', state), 'shown');
  assert.equal(addressedOutcome('closed', state), 'closed');
  assert.equal(addressedOutcome('other', state), 'unknown');
});

// ---- In the browser ----------------------------------------------------------------

/** Start a conversation whose title is `title`, answered (so it is saved when closed). */
async function answered(
  fixture: Fixture,
  title: string,
): Promise<{ id: string; run: SyntheticRun }> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) => candidate.request.prompt.text.includes(title));
  assert.ok(run, `no run for ${title}`);
  run.emit({ ...chatMessage(`${title}-answer`, 'assistant', 'Answered.'), state: 'done' });
  run.finish();
  return { id, run };
}

/** A page expression: the bar's title contains `title`. */
function barTitle(title: string): string {
  return `document.querySelector('.chat-bar-title')?.textContent.includes(${JSON.stringify(title)})`;
}

/** Another tab of the same browser (its storage and pairing), opened at `address`. */
async function tabAt(
  browser: Parameters<typeof desktopPage>[0],
  contextId: string,
  address: string,
): Promise<TestPage> {
  const { page } = await desktopPage(browser, 560, 860, contextId);
  await page.navigate(address);
  await page.waitFor(online, 8000);
  return page;
}

test(
  'a new window on a conversation: ⧉, open, closed meanwhile, unknown, its own selection, a reload',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = await answered(fixture, 'First conversation');
    const second = await answered(fixture, 'Second conversation');
    const closed = await answered(fixture, 'Closed conversation');
    const { page, browserContextId } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'First conversation');

    // ⧉ in the bar of a conversation opens this address with the fragment
    // in a new window.
    await browser.call('Target.setDiscoverTargets', { discover: true });
    const opened: string[] = [];
    browser.on((message) => {
      if (
        message.method === 'Target.targetCreated' ||
        message.method === 'Target.targetInfoChanged'
      ) {
        opened.push(String(message.params?.targetInfo?.url ?? ''));
      }
    });
    const expected = `${fixture.origin}/#conversation=${first.id}`;
    await click(page, '.chat-bar .new-window');
    await waitFor(() => opened.includes(expected));
    assert.equal(
      await page.evaluate(
        `document.querySelector('.chat-bar .new-window').getAttribute('aria-label')`,
      ),
      'Open this conversation in a new window',
    );

    // A window on the second conversation shows it; the main window keeps
    // its own, and switching there does not move the new one.
    const watching = await tabAt(
      browser,
      browserContextId,
      `${fixture.origin}/#conversation=${second.id}`,
    );
    await watching.waitFor(barTitle('Second conversation'));
    assert.equal(await page.evaluate(barTitle('First conversation')), true);
    // The main window in front (a background tab gets no input events).
    await page.call('Page.bringToFront');
    await openConversation(page, 'Second conversation');
    await openConversation(page, 'First conversation');
    assert.equal(await watching.evaluate(barTitle('Second conversation')), true);

    // Reloading that window shows the same conversation again.
    // (Page.reload: navigating to the same address with its fragment would
    // only scroll within the document.)
    await watching.evaluate(`window.__beforeReload = true`);
    await watching.call('Page.reload');
    await watching.waitFor(`window.__beforeReload === undefined`, 10_000);
    await watching.waitFor(online, 8000);
    await watching.waitFor(barTitle('Second conversation'));
    await assertNoViolations(watching);
    await watching.close();

    // Closed meanwhile: Previous sessions and the toast.
    await fixture.sessions.remove(closed.id);
    await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`);
    const late = await tabAt(
      browser,
      browserContextId,
      `${fixture.origin}/#conversation=${closed.id}`,
    );
    await late.waitFor(`document.querySelector('.previous-session')`);
    assert.equal(await text(late, '.chat-bar-title'), 'Previous sessions');
    await late.waitFor(`document.querySelector('.toast')`);
    assert.match(
      await text(late, '.toast'),
      /That conversation was closed meanwhile\. It is in Previous sessions\./,
    );
    await late.close();

    // Unknown: the empty view and the toast.
    const unknown = await tabAt(
      browser,
      browserContextId,
      `${fixture.origin}/#conversation=no-such-conversation`,
    );
    await unknown.waitFor(`document.querySelector('.toast')`);
    assert.match(await text(unknown, '.toast'), /That conversation is not open in Companion\./);
    assert.equal(await text(unknown, '.chat-bar-title'), 'Conversations');
    await unknown.close();

    // No ⧉ on Previous sessions, the empty view or the settings screen.
    await page.call('Page.bringToFront');
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.settings-screen')`);
    assert.equal(await page.evaluate(`document.querySelector('.new-window')`), null);
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.chat-bar .new-window')`);
    await click(page, '.previous-entry');
    await page.waitFor(`document.querySelector('.previous-session')`);
    assert.equal(await page.evaluate(`document.querySelector('.new-window')`), null);
    await assertNoViolations(page);
  },
);
