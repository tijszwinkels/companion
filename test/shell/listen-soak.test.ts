/**
 * Background capture (design note, section 6; brief check 4): a page that
 * listens while another tab of the browser is in front keeps sending its
 * microphone in real time. One page listens with Chromium's fake audio
 * device, another tab is brought to the front (the listening page is then
 * `hidden`), and after COMPANION_LISTEN_SOAK_MINUTES minutes the pieces the
 * page sent are counted against the pieces expected for that time (ten a
 * second). The stream must not have ended, and utterances must still
 * arrive at the listener.
 *
 * Opt-in (it runs for as long as it says): set
 * COMPANION_LISTEN_SOAK_MINUTES, for example to 30. Its measurements are
 * printed, and written as JSON to COMPANION_LISTEN_SOAK_REPORT if set.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  listenerStreams,
  listeningPage,
  listenSetup,
  startListening,
  waitFor,
} from './listen-page.ts';
import { desktopPage, skip } from './page.ts';

const minutes = Number(process.env.COMPANION_LISTEN_SOAK_MINUTES ?? 0);

test(
  'a listening page in a background tab keeps sending in real time',
  {
    skip: skip || (minutes > 0 ? undefined : 'COMPANION_LISTEN_SOAK_MINUTES not set'),
    timeout: (minutes + 5) * 60_000,
  },
  async (context) => {
    const { fixture, microphones, browser } = await listenSetup(context);
    const { page, browserContextId } = await listeningPage(fixture, browser);
    await startListening(page);
    await waitFor(() => listenerStreams(microphones).length === 1);
    await page.waitFor(`window.__binarySent > 0`, 8000);

    // Another tab of the same browser window in front (it stays blank): the
    // listening page goes to the background.
    const front = await desktopPage(browser, 1280, 800, browserContextId);
    await browser.call('Target.activateTarget', { targetId: front.page.targetId });
    await page.waitFor(`document.visibilityState === 'hidden'`);

    const startedAt = Date.now();
    const sentAtStart = await page.evaluate<number>(`window.__binarySent`);
    const startsAtStart = await page.evaluate<number>(`window.__audioStarts`);
    const streamAtStart = microphones.browsers.list[0]?.id;
    const utterancesAtStart = microphones.dispatched.length;
    const hiddenChecks: string[] = [];
    let utterancesBeforeLastMinute = utterancesAtStart;

    // Wait out the run, checking once a minute that the page stays hidden.
    for (let minute = 1; minute <= minutes; minute++) {
      if (minute === minutes) {
        utterancesBeforeLastMinute = microphones.dispatched.length;
      }
      await delay(60_000);
      hiddenChecks.push(await page.evaluate<string>(`document.visibilityState`));
    }

    const elapsedMs = Date.now() - startedAt;
    const sent = (await page.evaluate<number>(`window.__binarySent`)) - sentAtStart;
    const expected = Math.round(elapsedMs / 100);
    const report = {
      minutes,
      elapsedMs,
      piecesSent: sent,
      piecesExpected: expected,
      ratio: Number((sent / expected).toFixed(4)),
      alwaysHidden: hiddenChecks.every((state) => state === 'hidden'),
      utterancesDuringRun: microphones.dispatched.length - utterancesAtStart,
      utterancesLastMinute: microphones.dispatched.length - utterancesBeforeLastMinute,
      streamOpenAtEnd: listenerStreams(microphones).length === 1,
      sameStreamThroughout:
        microphones.browsers.list[0]?.id === streamAtStart &&
        (await page.evaluate<number>(`window.__audioStarts`)) === startsAtStart,
      markStillOn: await page.evaluate<boolean>(
        `document.querySelector('.listen-mark.on') !== null`,
      ),
    };
    console.log(`Listen here soak: ${JSON.stringify(report)}`);
    if (process.env.COMPANION_LISTEN_SOAK_REPORT) {
      await writeFile(process.env.COMPANION_LISTEN_SOAK_REPORT, JSON.stringify(report, null, 2));
    }

    assert.ok(report.alwaysHidden, 'the page was in the background throughout');
    assert.ok(report.streamOpenAtEnd, 'a stream is open at the end');
    assert.ok(report.sameStreamThroughout, 'the stream never ended or restarted');
    assert.ok(report.markStillOn);
    assert.ok(report.utterancesLastMinute > 0, 'utterances still arrive in the last minute');
    // Real time within 1 %: a page that stops or slows in the background
    // would fall far below.
    assert.ok(Math.abs(report.ratio - 1) < 0.01, `sent ${sent} of ${expected} pieces`);
  },
);
