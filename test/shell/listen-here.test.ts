/**
 * Listen here end to end (integrations/shell/README.md, "Listen here"):
 * the built shell in headless Chromium with its fake audio device, the real
 * gateway and a real listener control socket with the test recogniser
 * (listen-page.ts). The rule tables themselves are tested against fakes in
 * listen-rules.test.ts; this suite checks that the real pieces behave so.
 *
 * Every wait is for the state it means. Requires `npm run shell:build` and
 * /usr/lib/chromium/chromium.
 *
 * Set COMPANION_SHELL_SCREENSHOTS to a directory to also save screenshots
 * of each state at 420 and 1280 px (never committed).
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { TestPage } from '../mobile/browser.ts';
import {
  browserRow,
  listenerStreams,
  listeningPage,
  listenSetup,
  liveTracks,
  showActivity,
  startListening,
  switchState,
  waitFor,
} from './listen-page.ts';
import {
  assertNoViolations,
  assertOwnOrigin,
  click,
  horizontalOverflow,
  requestActions,
  skip,
} from './page.ts';

const markOn = `document.querySelector('.listen-mark.on') !== null`;
const markWaiting = `document.querySelector('.listen-mark.waiting') !== null`;
const noMark = `document.querySelector('.listen-mark') === null`;

/** The bar's mark lies inside the window. */
async function markInside(page: TestPage): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const box = document.querySelector('.listen-mark').getBoundingClientRect();
    return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0;
  })()`);
}

test(
  'Listen here: a spoken sentence arrives as an utterance; mark, meter and title show; off ends the stream',
  { skip },
  async (context) => {
    const { fixture, microphones, browser } = await listenSetup(context);
    const { page, sockets } = await listeningPage(fixture, browser);
    await showActivity(page);
    assert.equal(await switchState(page), 'false', 'a page starts with Listen here off');
    assert.match(await browserRow(page), /This browser.*Off/);
    assert.equal(await liveTracks(page), 0);

    await startListening(page);
    assert.match(await page.evaluate<string>(`document.title`), /^● /);
    await waitFor(() => listenerStreams(microphones).length === 1);
    assert.deepEqual(listenerStreams(microphones), ['Browser']);

    // The level meter moves with the fake microphone's bursts, in the bar
    // and in the row.
    await page.waitFor(
      `Number(document.querySelector('.listen-mark .level-meter').dataset.level) > 0.05`,
      8000,
    );
    assert.match(await browserRow(page), /Listening/);

    // The listener heard speech from this browser and dispatched it, and
    // Activity names the browser's microphone on the entry.
    await waitFor(() => microphones.dispatched.length >= 1, 15_000);
    assert.match(microphones.dispatched[0].utterance, /^w\d/);
    await page.waitFor(
      `[...document.querySelectorAll('.activity-microphone')].some((element) => element.textContent === 'Browser')`,
      8000,
    );

    // Off: the stream ends at the listener, the microphone is released and
    // every sign goes.
    await click(page, '#microphone-this-browser');
    await page.waitFor(noMark);
    await waitFor(() => listenerStreams(microphones).length === 0);
    assert.equal(await liveTracks(page), 0);
    assert.doesNotMatch(await page.evaluate<string>(`document.title`), /●/);
    const actions = requestActions(sockets);
    assert.deepEqual(
      actions.filter((action) => action.startsWith('audio-')),
      ['audio-start', 'audio-stop'],
    );

    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'Pause and Resume, from this page and from the computer, stop and restart the stream',
  { skip },
  async (context) => {
    const { fixture, microphones, browser } = await listenSetup(context);
    const { page } = await listeningPage(fixture, browser);
    await startListening(page);
    await waitFor(() => listenerStreams(microphones).length === 1);

    // Pause here (the column's microphone button): one Pause for everything.
    await click(page, '.activity-mic');
    await page.waitFor(markWaiting);
    await waitFor(() => listenerStreams(microphones).length === 0);
    await page.waitFor(`window.__liveTracks() === 0`);
    assert.match(await browserRow(page), /Paused with everything else/);
    assert.equal(await switchState(page), 'true', 'the choice stays on while paused');
    assert.match(
      await page.evaluate<string>(`document.querySelector('.listen-mark').textContent`),
      /paused/,
    );

    await click(page, '.activity-mic');
    await page.waitFor(markOn);
    await waitFor(() => listenerStreams(microphones).length === 1);

    // Pause and Resume on the computer (any other panel).
    fixture.desktop.pause.toggle();
    await page.waitFor(markWaiting);
    await waitFor(() => listenerStreams(microphones).length === 0);
    fixture.desktop.pause.toggle();
    await page.waitFor(markOn);
    await waitFor(() => listenerStreams(microphones).length === 1);
    await assertNoViolations(page);
  },
);

test(
  'the computer’s switch turns its microphone off and on; the row follows',
  { skip },
  async (context) => {
    const { fixture, microphones, browser } = await listenSetup(context);
    const { page } = await listeningPage(fixture, browser);
    await showActivity(page);
    await waitFor(() => microphones.computerListening);
    await page.waitFor(
      `document.querySelector('#microphone-computer')?.getAttribute('aria-checked') === 'true'`,
    );
    await click(page, '#microphone-computer');
    await waitFor(() => microphones.computer.enabled === false);
    await page.waitFor(
      `document.querySelector('#microphone-computer').getAttribute('aria-checked') === 'false'`,
    );
    // Nothing hears now: the page says so.
    await page.waitFor(
      `document.querySelector('.listen-notice')?.textContent.includes('No microphone is on')`,
    );
    await click(page, '#microphone-computer');
    await waitFor(() => microphones.computer.enabled === true);
    await assertNoViolations(page);
  },
);

test('permission refused: the notice explains; no stream is started', { skip }, async (context) => {
  const { fixture, microphones, browser } = await listenSetup(context);
  const { page, sockets } = await listeningPage(fixture, browser, { permission: 'denied' });
  await showActivity(page);
  await click(page, '#microphone-this-browser');
  await page.waitFor(
    `document.querySelector('.listen-notice.bad')?.textContent.includes('Microphone not allowed')`,
  );
  assert.equal(await switchState(page), 'false');
  assert.match(await browserRow(page), /refused the microphone/);
  await page.waitFor(noMark);
  assert.ok(!requestActions(sockets).includes('audio-start'));
  assert.deepEqual(listenerStreams(microphones), []);
  // The computer's microphone is not affected.
  assert.equal(microphones.computer.enabled, true);
});

test(
  'a second tab of this browser takes over; the first says so and releases the microphone',
  { skip },
  async (context) => {
    const { fixture, microphones, browser } = await listenSetup(context);
    const first = await listeningPage(fixture, browser);
    await startListening(first.page);
    await waitFor(() => listenerStreams(microphones).length === 1);

    const second = await listeningPage(fixture, browser, { sharedContext: first.browserContextId });
    await startListening(second.page);

    await first.page.waitFor(
      `document.querySelector('.listen-notice')?.textContent.includes('Listening moved to another tab')`,
    );
    assert.equal(await switchState(first.page), 'false');
    await first.page.waitFor(noMark);
    await first.page.waitFor(`window.__liveTracks() === 0`);
    await waitFor(() => listenerStreams(microphones).length === 1);
    assert.equal(await liveTracks(second.page), 1);
    await second.page.waitFor(markOn);

    // The first tab never takes it back by itself.
    const startsBefore = await first.page.evaluate<number>(`window.__streams.length`);
    await waitFor(() => microphones.dispatched.length >= 1, 15_000);
    assert.equal(await first.page.evaluate<number>(`window.__streams.length`), startsBefore);
  },
);

test(
  '420 and 1600 px: the mark and the rows fit, with Activity hidden and shown',
  { skip },
  async (context) => {
    const { fixture, browser } = await listenSetup(context);
    for (const width of [420, 1600]) {
      const { page, sockets } = await listeningPage(fixture, browser, { width, height: 820 });
      await startListening(page);

      // With Activity shown (over the chat at 420 px).
      assert.equal(await horizontalOverflow(page), 0, `${width} px, Activity shown`);
      const rowsFit = await page.evaluate<boolean>(`(() => {
      const rows = document.querySelector('.microphone-rows');
      return rows.scrollWidth <= rows.clientWidth;
    })()`);
      assert.ok(rowsFit, `${width} px: the microphone rows do not overflow`);

      // With Activity hidden: the mark sits in the bar, inside the window.
      await click(page, '.activity-header .activity-toggle');
      await page.waitFor(`!document.querySelector('.activity-column')`);
      await page.waitFor(markOn);
      assert.ok(await markInside(page), `${width} px: the mark is inside the window`);
      assert.equal(await horizontalOverflow(page), 0, `${width} px, Activity hidden`);

      // Pressing the mark shows Activity.
      await click(page, '.listen-mark');
      await page.waitFor(`Boolean(document.querySelector('.activity-column'))`);

      await click(page, '#microphone-this-browser');
      await page.waitFor(noMark);
      assertOwnOrigin(fixture, page, sockets);
      await assertNoViolations(page);
      await page.close();
    }
  },
);

test(
  'the page may use the microphone only with the gateway’s --allow-microphone',
  { skip },
  async (context) => {
    // With the option: the gateway's own page may ask for the microphone.
    const allowed = await listenSetup(context);
    const withOption = await fetch(`${allowed.fixture.origin}/`);
    assert.equal(
      withOption.headers.get('permissions-policy'),
      'camera=(), microphone=(self), geolocation=()',
    );

    // Without it: the header refuses it, and the shell offers no switch.
    const refused = await listenSetup(context, { allowMicrophone: false });
    const withoutOption = await fetch(`${refused.fixture.origin}/`);
    assert.equal(
      withoutOption.headers.get('permissions-policy'),
      'camera=(), microphone=(), geolocation=()',
    );
    const { page } = await listeningPage(refused.fixture, refused.browser);
    await showActivity(page);
    assert.equal(await switchState(page), '');
    assert.match(await browserRow(page), /does not allow the microphone/);
    // The computer's switch is still there.
    assert.equal(
      await page.evaluate<boolean>(`Boolean(document.querySelector('#microphone-computer'))`),
      true,
    );
    await assertNoViolations(page);
  },
);

test(
  'screenshots of each Listen here state at 420 and 1280 px',
  {
    skip:
      skip ||
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { fixture, microphones, browser } = await listenSetup(context);
    const unavailable = await listenSetup(context, { allowMicrophone: false });

    async function save(page: TestPage, name: string) {
      await writeFile(join(directory, `listen-${name}.png`), await page.screenshot());
    }

    for (const width of [420, 1280]) {
      const height = width === 420 ? 860 : 800;
      const shot = (name: string) => `${name}-${width}`;

      // Not listening here.
      const { page, browserContextId } = await listeningPage(fixture, browser, { width, height });
      await showActivity(page);
      await save(page, shot('off'));

      // No microphone is on: the computer's is switched off too.
      await click(page, '#microphone-computer');
      await page.waitFor(
        `document.querySelector('.listen-notice')?.textContent.includes('No microphone is on')`,
      );
      await save(page, shot('no-microphone-on'));
      await click(page, '#microphone-computer');
      await waitFor(() => microphones.computer.enabled);

      // Asking permission (the browser's prompt is held open).
      await page.evaluate(`window.__holdPermission = true`);
      await click(page, '#microphone-this-browser');
      await page.waitFor(`document.querySelector('[data-listen="asking"]') !== null`);
      await save(page, shot('asking'));
      await click(page, '#microphone-this-browser');
      await page.evaluate(`window.__holdPermission = false`);

      // Listening here, and hearing speech.
      await startListening(page);
      await page.waitFor(
        `Number(document.querySelector('.listen-mark .level-meter').dataset.level) > 0.05`,
        8000,
      );
      await save(page, shot('listening'));
      await page.waitFor(`document.querySelector('.activity-listening.speaking') !== null`, 15_000);
      await save(page, shot('hearing'));
      await waitFor(() => microphones.dispatched.length >= 1, 15_000);
      await page.waitFor(`document.querySelector('.activity-microphone') !== null`, 8000);
      await save(page, shot('heard-entry'));

      // The mark in the bar with Activity hidden; and on the settings screen.
      await click(page, '.activity-header .activity-toggle');
      await page.waitFor(markOn);
      await save(page, shot('mark'));
      await click(page, '.settings-toggle');
      await page.waitFor(`document.querySelector('.settings-layer') !== null`);
      await save(page, shot('mark-settings'));
      await click(page, '.settings-toggle');
      await showActivity(page);

      // Paused.
      await click(page, '.activity-mic');
      await page.waitFor(markWaiting);
      await save(page, shot('paused'));
      await click(page, '.activity-mic');
      await page.waitFor(markOn);

      // Taken over by another tab.
      const second = await listeningPage(fixture, browser, {
        width,
        height,
        sharedContext: browserContextId,
      });
      await startListening(second.page);
      await page.waitFor(`document.querySelector('[data-listen="off"]') !== null`);
      await save(page, shot('moved'));
      await click(second.page, '#microphone-this-browser');
      await second.page.close();

      // Lost: the browser ended the microphone's track by itself.
      await startListening(page);
      await page.evaluate(
        `window.__streams.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended'))`,
      );
      await page.waitFor(
        `document.querySelector('.listen-notice')?.textContent.includes('No sound')`,
      );
      await save(page, shot('lost'));

      await page.close();

      // Permission refused.
      const refused = await listeningPage(fixture, browser, {
        width,
        height,
        permission: 'denied',
      });
      await showActivity(refused.page);
      await click(refused.page, '#microphone-this-browser');
      await refused.page.waitFor(`document.querySelector('.listen-notice.bad') !== null`);
      await save(refused.page, shot('refused'));
      await refused.page.close();

      // Not available (a gateway without --allow-microphone).
      const notAvailable = await listeningPage(unavailable.fixture, unavailable.browser, {
        width,
        height,
      });
      await showActivity(notAvailable.page);
      await save(notAvailable.page, shot('not-available'));
      await notAvailable.page.close();
    }
  },
);
