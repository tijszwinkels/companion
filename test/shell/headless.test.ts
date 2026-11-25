// The browser shell against a Companion that runs without a desktop
// (`--headless`, see "Running without a desktop" in src/desktop/README.md):
// the built shell (integrations/shell/dist) in headless Chromium, served by
// the real gateway on loopback, in front of the real listener started with
// `src/cli.ts --headless`. Both run as child processes on a PATH with only
// node and flock; the agent is the synthetic Claude Code fixture.
//
// It plays the user's path once: pair, see Companion listening with no
// switch for the computer's microphone, Pause and Resume, start a
// conversation by typing, switch Listen here on and have the spoken words
// reach that conversation, follow up, Stop, close and reopen from Previous
// sessions.
//
// Listen here uses Chromium's fake audio device playing, in a loop, the
// first sentence of the public speech fixture (test/fixtures/speech.wav)
// followed by silence, through the real voice detector in the listener; the
// words are the test recogniser's (test/fixtures/asr-scripted.cjs): the
// phrase set before Listen here goes on, and nothing for the repetitions.
//
// Requires `npm run shell:build` and /usr/lib/chromium/chromium.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { TestBrowser } from '../mobile/browser.ts';
import { headlessMachine, interrupt, root, startHeadlessCompanion } from '../headless-fixture.ts';
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

/**
 * A WAV for the fake microphone: the fixture's first sentence (2 s) and
 * 2.5 s of silence. The fixture alone is continuous narration whose pauses
 * are too short to end an utterance, so in a loop it would never end.
 */
async function sentenceWav(path: string): Promise<void> {
  const fixture = await readFile(join(root, 'test/fixtures/speech.wav'));
  const dataAt = fixture.indexOf('data') + 8;
  const sentence = fixture.subarray(dataAt, dataAt + 64_000);
  const data = Buffer.concat([sentence, Buffer.alloc(80_000)]);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

test(
  'without a desktop: pair, type a conversation, follow up, Stop, close and reopen',
  { skip },
  async (context) => {
    const machine = await headlessMachine(context);
    const companion = await startHeadlessCompanion(context, machine, {
      appDirectory,
      allowMicrophone: true,
    });
    const wav = join(machine.directory, 'sentence.wav');
    await sentenceWav(wav);
    const browser = new TestBrowser([
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
    ]);
    await browser.start();
    context.after(() => browser.close());

    // Pair through the page with a code from `companion-remote pair`.
    const { page, sockets, browserContextId } = await desktopPage(browser, 1280, 800);
    await browser.call('Browser.setPermission', {
      permission: { name: 'microphone' },
      setting: 'granted',
      origin: companion.origin,
      browserContextId,
    });
    await page.navigate(`${companion.origin}/`);
    await page.waitFor(`document.querySelector('#code')`);
    await click(page, '#code');
    await page.type(await companion.pairingCode());
    await click(page, 'button[type=submit]');
    await page.waitFor(online, 8000);

    // Companion listens; this browser may listen, the computer has no
    // microphone switch. Pause and Resume work.
    const listeningTitle = (title: string) =>
      `document.querySelector('.activity-listening-title')?.textContent === '${title}'`;
    await click(page, '.activity-list-entry');
    await page.waitFor(listeningTitle('Listening'));
    await page.waitFor(`document.querySelector('#microphone-this-browser')`);
    assert.equal(
      await page.evaluate<boolean>(`document.querySelector('#microphone-computer') === null`),
      true,
    );
    await page.waitFor(`!document.querySelector('.activity-mic').disabled`);
    await click(page, '.activity-mic');
    await page.waitFor(listeningTitle('Paused'));
    await page.waitFor(`!document.querySelector('.activity-mic').disabled`);
    await click(page, '.activity-mic');
    await page.waitFor(listeningTitle('Listening'));

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

    // Listen here: the first sentence the browser hears is a message to the
    // conversation this tab shows (no intent model), and is answered.
    await machine.nextPhrase('Please also plan the way back');
    await page.waitFor(`document.querySelector('.activity-column')`);
    await page.waitFor(`!document.querySelector('#microphone-this-browser').disabled`);
    await click(page, '#microphone-this-browser');
    await page.waitFor(
      `document.querySelector('.microphone-row.this-browser')?.textContent.includes('Listening')`,
      8000,
    );
    await page.waitFor(
      `[...document.querySelectorAll('.message.user')].some((message) => message.textContent.includes('Please also plan the way back'))`,
      20_000,
    );
    await page.waitFor(`document.querySelectorAll('.message.assistant').length === 2`, 8000);
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Done'`, 8000);
    await click(page, '#microphone-this-browser');
    await page.waitFor(
      `!document.querySelector('.microphone-row.this-browser')?.textContent.includes('Listening')`,
      8000,
    );

    // A typed follow-up in the same conversation.
    await click(page, '.chat textarea');
    await page.type('And the way back?');
    await clickButton(page, 'Send');
    await page.waitFor(`document.querySelectorAll('.message.assistant').length === 3`, 8000);
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
      'audio-start',
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
