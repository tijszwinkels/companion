// The browser shell against a Companion that runs without a desktop
// (`--headless`, see "Running without a desktop" in src/desktop/README.md):
// the built shell (integrations/shell/dist) in headless Chromium, served by
// the real gateway on loopback, in front of the real listener started with
// `src/cli.ts --headless`. Both run as child processes on a PATH with only
// node and flock; the agent is the synthetic Claude Code fixture.
//
// It plays the user's path once: pair, see listening paused and Resume
// refused with its reason, start a conversation by typing, follow up, Stop,
// close and reopen from Previous sessions.
//
// Requires `npm run shell:build` and /usr/lib/chromium/chromium.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TestBrowser } from '../mobile/browser.ts';
import { headlessMachine, interrupt, startHeadlessCompanion } from '../headless-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  click,
  clickButton,
  desktopPage,
  online,
  requestActions,
  skip,
  text,
} from './page.ts';

test(
  'without a desktop: pair, type a conversation, follow up, Stop, close and reopen',
  { skip },
  async (context) => {
    const machine = await headlessMachine(context);
    const companion = await startHeadlessCompanion(context, machine, { appDirectory });
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    // Pair through the page with a code from `companion-remote pair`.
    const { page, sockets } = await desktopPage(browser, 1280, 800);
    await page.navigate(`${companion.origin}/`);
    await page.waitFor(`document.querySelector('#code')`);
    await click(page, '#code');
    await page.type(await companion.pairingCode());
    await click(page, 'button[type=submit]');
    await page.waitFor(online, 8000);

    // Listening is shown as paused; Resume is refused with its reason.
    await click(page, '.activity-list-entry');
    await page.waitFor(`document.querySelector('.activity-listening-title')`);
    await page.waitFor(
      `document.querySelector('.activity-listening-title')?.textContent === 'Paused'`,
    );
    await page.waitFor(`!document.querySelector('.activity-mic').disabled`);
    await click(page, '.activity-mic');
    await page.waitFor(
      `[...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('runs without a desktop and has no microphone'))`,
    );
    assert.equal(await text(page, '.activity-listening-title'), 'Paused');

    // Start a conversation by typing; the synthetic Claude Code answers.
    await click(page, '#activity-start-text');
    await page.type('Plan the synthetic trip');
    await click(page, '.activity-start-button');
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Plan the synthetic trip')`,
      8000,
    );
    await page.waitFor(`document.querySelectorAll('.message.assistant').length === 1`, 8000);
    assert.match(await text(page, '.message.assistant'), /42/);
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Done'`, 8000);

    // A follow-up in the same conversation.
    await click(page, '.chat textarea');
    await page.type('And the way back?');
    await clickButton(page, 'Send');
    await page.waitFor(`document.querySelectorAll('.message.assistant').length === 2`, 8000);
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Done'`, 8000);

    // A turn that keeps streaming, stopped once its text is shown.
    await click(page, '.chat textarea');
    await page.type('stall');
    await clickButton(page, 'Send');
    await page.waitFor(
      `[...document.querySelectorAll('.message.assistant')].some((message) => message.textContent.includes('Partial'))`,
      8000,
    );
    await page.waitFor(`document.querySelector('.panel-action.stop:not([disabled])')`);
    await click(page, '.panel-action.stop');
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Stopped'`, 8000);

    // Close the conversation, then reopen it from Previous sessions.
    await clickButton(page, 'Close session');
    await page.waitFor(`document.querySelector('.conversation-none')`, 8000);
    await page.waitFor(
      `/1 saved conversation/.test(document.querySelector('.previous-entry')?.textContent ?? '')`,
    );
    await click(page, '.previous-entry');
    await page.waitFor(`document.querySelector('.previous-session button')`);
    assert.match(await text(page, '.previous-sessions'), /Plan the synthetic trip/);
    await click(page, '.previous-session button');
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Plan the synthetic trip')`,
      8000,
    );

    const actions = requestActions(sockets);
    for (const action of [
      'toggle-pause',
      'start-agent',
      'send-agent',
      'stop-agent-run',
      'close-agent',
      'reopen-agent',
    ]) {
      assert.ok(actions.includes(action), `${action} was sent`);
    }
    await assertNoViolations(page);

    // Both processes stop cleanly.
    assert.equal(await interrupt(companion.gateway), 0);
    assert.equal(await interrupt(companion.listener), 0);
  },
);
