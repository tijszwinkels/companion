/**
 * Speech follows the device that recorded it, in the browser shell
 * (integrations/shell/README.md, "Listen here", "Rule: spoken navigation"):
 * the built shell in headless Chromium with its fake audio device, the real
 * gateway and a real listener control socket with the real processors and
 * synthetic agent conversations (listen-page.ts).
 *
 * The fake microphone plays bursts in a loop; the test recogniser turns
 * each burst into the phrase the test "says" next (once), and every other
 * burst into a word the listener ignores. Every wait is for the state it
 * means; nothing waits a fixed time.
 *
 * Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { TestPage } from '../mobile/browser.ts';
import { frame, signal } from '../helpers.ts';
import { listeningPage, listenSetup, startListening, waitFor } from './listen-page.ts';
import { click, openConversation, skip } from './page.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';

const followUpText = 'please also add tests';

/** Press and release Enter on whatever has the focus, as a key already on its way. */
async function pressEnter(page: TestPage): Promise<void> {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.call('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** The title in the chat bar: the conversation this tab shows. */
function shownTitle(page: TestPage): Promise<string> {
  return page.evaluate<string>(`document.querySelector('.chat-bar-title')?.textContent ?? ''`);
}

test(
  'speech from a browser follows that tab: follow-up, go to session N while typing and under settings, a started conversation',
  { skip },
  async (context) => {
    // What the listener hears next from any microphone, once.
    let next = '';
    const { fixture, browser } = await listenSetup(context, {
      microphones: (fixture) => ({
        recognise: () => {
          const phrase = next || 'mm';
          next = '';
          return phrase;
        },
        detect: async (input) =>
          input.utterance === followUpText && input.interaction?.agentSessionId
            ? 'CONTINUE_OPEN_AGENT_CONVERSATION'
            : 'IGNORE',
        processors: (router, activity) => {
          const sessions = fixture.sessions;
          const log = () => {};
          new QuickQuestion({ sessions }, log, false, activity).subscribe(router);
          new GoToSession(log, false, activity).subscribe(router);
          new ContinueOpenAgentConversation({ sessions }, log, false, activity).subscribe(router);
        },
      }),
    });
    const { sessions, desktop } = fixture;

    /** "Say" a phrase: the next utterance is recognised as it. */
    async function say(phrase: string): Promise<void> {
      next = phrase;
      await waitFor(() => next === '', 15_000);
    }

    // Three conversations whose first turns have finished: X, Y, Z.
    const ids: string[] = [];
    for (const title of ['X conversation', 'Y conversation', 'Z conversation']) {
      ids.push(sessions.start({ ...frame, utterance: title }, signal()));
    }
    await waitFor(() => fixture.runs.length === 3);
    for (const run of fixture.runs) {
      run.finish();
    }
    await waitFor(() => sessions.snapshot().every((session) => session.status === 'completed'));
    const [x, y] = ids;

    // The desktop fixture shows X and owns voice navigation.
    desktop.send({
      action: 'panel-state',
      id: x,
      composerFocused: false,
      visible: true,
      navigationToken: 'desktop-1',
    });
    assert.equal((await desktop.reply('panel-state')).type, 'result');

    // Browser A (listening) shows Y; another device's tab shows X and does
    // not listen.
    const { page } = await listeningPage(fixture, browser);
    await openConversation(page, 'Y conversation');
    const other = await listeningPage(fixture, browser);
    await openConversation(other.page, 'X conversation');
    await startListening(page);

    // 1. A spoken follow-up goes to what A shows, not to the desktop's X.
    const followUps = (id: string) =>
      sessions
        .snapshot()
        .find((session) => session.id === id)!
        .messages.filter((message) => message.kind === 'user' && message.text === followUpText)
        .length;
    await say(followUpText);
    await waitFor(() => followUps(y) === 1, 15_000);
    assert.equal(followUps(x), 0);
    await page.waitFor(
      `document.querySelector('.chat')?.textContent.includes(${JSON.stringify(followUpText)})`,
    );

    // 2. "Go to session 3" while A's text box has the focus and holds unsent
    // text: A switches to Z, like a click; the desktop and the other device
    // do not. Z holds unsent text of its own, and Enter is pressed right
    // after the switch: nothing is sent in Z, and both texts are kept.
    await openConversation(page, 'Z conversation');
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    await page.type('z draft');
    await page.waitFor(`document.querySelector('.chat textarea').value === 'z draft'`);
    await openConversation(page, 'Y conversation');
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    await page.type('unsent words');
    await page.waitFor(`document.querySelector('.chat textarea').value === 'unsent words'`);
    await say('go to session 3');
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes('Z conversation')`,
      15_000,
    );
    await pressEnter(page);
    // After a spoken switch no text box has the focus (README "Rule: spoken
    // navigation"); Enter therefore sent nothing.
    assert.equal(
      (await page.evaluate<string>(`document.activeElement?.tagName ?? ''`)) === 'TEXTAREA',
      false,
      'the text box does not have the focus after a spoken switch',
    );
    await page.waitFor(`document.querySelector('.chat textarea').value === 'z draft'`);
    assert.deepEqual(
      desktop.messages.filter((message) => message.type === 'agent-select'),
      [],
      'the desktop fixture is not asked to select',
    );
    assert.match(await shownTitle(other.page), /X conversation/);

    // The unsent text stayed with Y: it is there on return. (First the
    // listener has this tab's report of Z, so the wait for Y below cannot
    // be met by the report from before the switch.)
    const remotes = (
      fixture.desktop.runtime as unknown as { remoteClients: Map<number, { selection: string }> }
    ).remoteClients;
    const shownBy = (id: string) => [...remotes.values()].some((remote) => remote.selection === id);
    await waitFor(() => shownBy(ids[2]) && !shownBy(y), 15_000);
    await openConversation(page, 'Y conversation');
    await page.waitFor(`document.querySelector('.chat textarea').value === 'unsent words'`);
    // Wait until the listener has this tab's later report (Y): a send of Z's
    // text, sent before it on the same connection, would have arrived first.
    await waitFor(() => shownBy(y), 15_000);
    const z = sessions.snapshot().find((session) => session.id === ids[2])!;
    assert.equal(
      z.messages.some((message) => message.kind === 'user' && message.text === 'z draft'),
      false,
      "Z's unsent text was not sent",
    );

    // 3. Under the settings screen A still has Y open: "go to session 1"
    // leaves the settings screen and shows X, as a click in the list does.
    await click(page, '.chat-bar .settings-toggle');
    await page.waitFor(`document.querySelector('.settings-screen') !== null`);
    await say('go to session 1');
    await page.waitFor(
      `document.querySelector('.settings-screen') === null && document.querySelector('.chat-bar-title')?.textContent.includes('X conversation')`,
      15_000,
    );

    // 4. A quick question from A starts a conversation shown in A only; the
    // desktop keeps X (it opens in the background there).
    await say('quick question what is new');
    await waitFor(() => sessions.snapshot().length === 4, 15_000);
    const started = sessions.snapshot().find((session) => !ids.includes(session.id))!;
    assert.equal(started.openInBackground, true);
    await page.waitFor(
      `document.querySelector('.chat-bar-title')?.textContent.includes(${JSON.stringify(started.title)})`,
      15_000,
    );
    assert.deepEqual(
      desktop.messages.filter((message) => message.type === 'agent-select'),
      [],
    );
    assert.match(await shownTitle(other.page), /X conversation/);
  },
);
