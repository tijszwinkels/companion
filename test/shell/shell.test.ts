import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseChoices } from '../../src/agents/choices.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { waitFor } from '../remote-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  assertOwnOrigin,
  buttonExpression,
  click,
  clickButton,
  desktopPage,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  requestActions,
  setup,
  skip,
  text,
} from './page.ts';

/**
 * The built browser shell (integrations/shell/dist) in headless Chromium at
 * desktop sizes, against the real gateway and listener control socket with a
 * synthetic agent backend, in temporary directories on loopback only. The
 * conversation is the unchanged desktop chat page (Chat.tsx) driven by the
 * gateway bridge. Requires `npm run shell:build` and /usr/lib/chromium/chromium.
 *
 * Set COMPANION_SHELL_SCREENSHOTS to a directory to also save screenshots of
 * the synthetic conversation at 420 px and 1280 px width (never committed).
 *
 * Not covered here: Safari, Firefox and Windows browsers, Tailscale, a real
 * network, and the Qt host itself (test:window, session-apps-ui).
 */

/** Scroll the transcript with the mouse wheel (the chat follows only the reader's scrolling). */
async function wheel(page: TestPage, deltaY: number): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('.transcript').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await page.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY: deltaY,
  });
}

function transcriptText(page: TestPage): Promise<string> {
  return text(page, '.transcript');
}

/** A page expression: the transcript contains `fragment`. */
function shows(fragment: string): string {
  return `document.querySelector('.transcript').textContent.includes(${JSON.stringify(fragment)})`;
}

/** A page expression: a row whose text has `fragment` as a word is inside the viewport. */
function inView(fragment: string): string {
  return `(() => {
    const viewport = document.querySelector('.transcript').getBoundingClientRect();
    const pattern = new RegExp(${JSON.stringify(fragment)} + '(?![0-9])');
    return [...document.querySelectorAll('.rows > .message')].some((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom && pattern.test(row.textContent);
    });
  })()`;
}

function rowCount(page: TestPage): Promise<number> {
  return page.evaluate<number>(`document.querySelectorAll('.rows > .message').length`);
}

/** Wheel the transcript by `deltaY` until `expression` holds. */
async function scrollUntil(page: TestPage, deltaY: number, expression: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) {
      return;
    }
    await wheel(page, deltaY);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await page.waitFor(expression, 5000);
}

test(
  'pairs, lists open conversations and shows one under the gateway CSP',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);

    // The real policy is served, without inline allowances.
    const response = await fetch(`${fixture.origin}/`);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

    // A finished Activity entry: the shell has no Activity view and must not
    // request Activity history (the phone panel does).
    const activity = fixture.desktop.runtime.activity;
    const observed = { ...frame, id: 41, utterance: 'Synthetic Activity entry' };
    activity.transcribed?.({ ...observed, storage: activity.admitCapture?.() });
    activity.intentRecognized?.(observed.id, 'IGNORE');
    activity.outcome?.(observed.id, 'ignored');
    activity.finished?.(observed.id);

    fixture.sessions.start({ ...frame, utterance: 'First synthetic question' }, signal());
    fixture.sessions.start({ ...frame, utterance: 'Second synthetic question' }, signal());
    await waitFor(() => fixture.runs.length === 2);

    const { page, sockets } = await pairedPage(fixture, browser);
    await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 2`);
    assert.match(await text(page, '.conversations'), /First synthetic question/);
    assert.match(await text(page, '.conversations'), /Second synthetic question/);

    await openConversation(page, 'Second synthetic question');
    await page.waitFor(`document.querySelector('.message.user')`);
    assert.match(await transcriptText(page), /Second synthetic question/);
    assert.doesNotMatch(await transcriptText(page), /First synthetic question/);
    // The screenshot viewer is a later slice: no button that cannot work.
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('View screenshot')})`), false);
    assert.match(await text(page, '.message.user .heading'), /screenshot unavailable/);
    // Out of scope controls are hidden through the status fields.
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('Record')})`), false);
    assert.match(await text(page, '.chat-bar-title'), /Second synthetic question/);

    // Straight into the other conversation from the list.
    await openConversation(page, 'First synthetic question');
    await page.waitFor(
      `document.querySelector('.transcript').textContent.includes('First synthetic question')`,
    );

    // Both supported widths: nothing wider than the window.
    for (const width of [420, 1280]) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.waitFor(`document.documentElement.clientWidth === ${width}`);
      assert.equal(await horizontalOverflow(page), 0, `overflow at ${width} px`);
    }

    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
    // Only the actions this slice uses left the page.
    for (const action of requestActions(sockets)) {
      assert.ok(['panel-state'].includes(action), `unexpected request ${action}`);
    }
  },
);

test(
  'streams escaped Markdown, sends, queues, chooses, stops and closes',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = fixture.sessions.start({ ...frame, utterance: 'Explain the fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets } = await pairedPage(fixture, browser, 420, 800);
    await openConversation(page, 'Explain the fixture');

    // A streamed answer: Markdown formatting, agent HTML stays literal text.
    const run = fixture.runs[0];
    run.emit({
      ...chatMessage('a1', 'assistant', '**Bold** <img src=x onerror=alert(1)> and `code`'),
      state: 'running',
    });
    await page.waitFor(`document.querySelector('.message.assistant strong')`);
    assert.equal(
      await page.evaluate(`document.querySelectorAll('.message.assistant img').length`),
      0,
    );
    assert.match(await text(page, '.message.assistant .bubble'), /<img src=x onerror=alert\(1\)>/);
    run.emit({
      ...chatMessage('a1', 'assistant', '**Bold** text, then a list:\n\n- one\n- two'),
      state: 'running',
    });
    await page.waitFor(`document.querySelectorAll('.message.assistant li').length === 2`);
    // A tool group is one summary row.
    run.emit({
      ...chatMessage('t1', 'tool', 'output'),
      toolName: 'read',
      input: '{}',
      state: 'done',
    });
    await page.waitFor(`document.querySelector('.message.tool')`);
    assert.match(await text(page, '.message.tool'), /read|tool call/);

    // While the agent runs, a follow-up is queued in the same conversation.
    await page.waitFor(`${buttonExpression('Queue')}`);
    await click(page, '.chat textarea');
    await page.type('Also cover the edge case');
    await clickButton(page, 'Queue');
    await page.waitFor(`document.querySelector('.chat textarea').value === ''`);
    await page.waitFor(`document.querySelector('.message.user.queued')`);
    assert.match(await text(page, '.message.user.queued'), /Also cover the edge case/);

    // The first turn finishes; the queued follow-up then runs as the next turn.
    run.emit({ ...chatMessage('a1', 'assistant', 'Done.'), state: 'done' });
    run.finish();
    await waitFor(() => fixture.runs.length === 2);
    assert.match(fixture.runs[1].request.prompt.text, /Also cover the edge case/);

    // Choices of the latest turn are offered and one is chosen.
    fixture.runs[1].publish(parseChoices(['[Run tests] - Execute them', 'No']));
    fixture.runs[1].finish();
    await page.waitFor(`document.querySelector('.choice:not([disabled])')`, 5000);
    const before = fixture.runs.length;
    await click(page, '.choice');
    await waitFor(() => fixture.runs.length === before + 1, 5000);
    assert.match(fixture.runs.at(-1)!.request.prompt.text, /Execute them/);

    // Stop the running turn: the conversation names its run, so the page
    // shows the per-run Stop for it (see the Stop rule in the README).
    await page.waitFor(`document.querySelector('.panel-action.stop:not([disabled])')`);
    await click(page, '.panel-action.stop');
    await waitFor(
      () =>
        fixture.sessions.snapshot().find((session) => session.id === id)?.status === 'cancelled',
      5000,
    );
    await page.waitFor(`document.querySelector('.state').textContent === 'Stopped'`);

    // An ordinary send when idle.
    await click(page, '.chat textarea');
    await page.type('One more question');
    await clickButton(page, 'Send');
    await waitFor(() => fixture.runs.length === before + 2, 5000);
    assert.match(fixture.runs.at(-1)!.request.prompt.text, /One more question/);
    fixture.runs.at(-1)!.finish();
    await page.waitFor(`document.querySelector('.state').textContent === 'Done'`);

    // The classic view is not offered here: its button explains that.
    await clickButton(page, 'Classic view');
    await page.waitFor(
      `document.querySelector('.composer').textContent.includes('not available in the browser')`,
    );

    // Close the conversation: it leaves the listener and the list.
    await clickButton(page, 'Close session');
    await waitFor(() => !fixture.sessions.snapshot().some((session) => session.id === id), 5000);
    await page.waitFor(
      `document.querySelector('.conversation-none') && document.querySelector('.workspace-empty')`,
    );

    const actions = requestActions(sockets);
    for (const action of ['send-agent', 'choose-agent', 'close-agent']) {
      assert.ok(actions.includes(action), `${action} was sent`);
    }
    assert.equal(actions.filter((action) => action === 'stop-agent-run').length, 1);
    assert.equal(actions.includes('stop-agent'), false, 'never the unscoped Stop');
    assert.equal(actions.filter((action) => action === 'send-agent').length, 2);
    for (const action of actions) {
      assert.ok(
        ['panel-state', 'send-agent', 'choose-agent', 'stop-agent-run', 'close-agent'].includes(
          action,
        ),
        `unexpected request ${action}`,
      );
    }
    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'loads older history while scrolling up, continues newer below and returns to latest',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Paging fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const run = fixture.runs[0];
    // 1051 rows: the question and 1050 answers. The live window holds the
    // newest 200 (History row 850–1049); pages hold 200 rows each.
    // The run keeps going, so a new row can stream in at the end.
    for (let index = 0; index < 1050; index++) {
      run.emit(chatMessage('history-' + index, 'assistant', 'History row ' + index));
    }
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Paging fixture');
    await page.waitFor(shows('History row 1049'));
    assert.equal(await rowCount(page), 200);
    assert.doesNotMatch(await transcriptText(page), /History row 849\b/);

    // The explicit Load action adds the previous page above.
    await click(page, 'button[aria-label="Load earlier messages"]');
    await page.waitFor(shows('History row 849'));
    assert.equal(await rowCount(page), 400);
    assert.match(await transcriptText(page), /History row 650\b/);
    assert.doesNotMatch(await transcriptText(page), /History row 649\b/);

    // The reader scrolls up: older pages load until the first message. At
    // most three pages stay resident, so the newest rows give way and the
    // transcript becomes a detached snapshot with the jump button.
    await scrollUntil(page, -100_000, shows('Paging fixture'));
    await page.waitFor(`document.querySelector('button.latest')`);
    assert.ok((await rowCount(page)) <= 600);
    assert.doesNotMatch(await transcriptText(page), /History row 849\b/);

    // The reader gets to the end of the snapshot before the first newer page
    // arrives (a fast gesture or a slow gateway): when it arrives, the
    // reader stays where they are, the new rows continue below.
    const historyPage = fixture.sessions.historyPage.bind(fixture.sessions);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    fixture.sessions.historyPage = (async (request: Parameters<typeof historyPage>[0]) => {
      const reply = historyPage(request);
      if (holding && request.direction === 'after') {
        await held;
      }
      return reply;
    }) as unknown as typeof historyPage;
    // The reader holds the pointer pressed in the transcript (as when
    // dragging its scroll bar) and gets to the end only after more than a
    // second: still their own scrolling, so the newer page is requested.
    const sentBeforeHold = sockets.sent.length;
    const middle = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const pointer = { x: middle.x, y: middle.y, button: 'left', clickCount: 1 };
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await page.evaluate(`(() => {
      const transcript = document.querySelector('.transcript');
      transcript.scrollTop = transcript.scrollHeight;
    })()`);
    await waitFor(() =>
      sockets.sent.slice(sentBeforeHold).some((sent) => sent.direction === 'after'),
    );
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pointer });
    assert.ok(await page.evaluate<boolean>(inView('History row 598')));
    holding = false;
    release();
    await page.waitFor(shows('History row 700'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      await page.evaluate<boolean>(inView('History row 598')),
      'the reader stayed in place',
    );
    assert.equal(await page.evaluate<boolean>(inView('History row 700')), false);
    fixture.sessions.historyPage = historyPage;

    // Reading down in ordinary steps: newer pages load before the reader
    // reaches the end, the reader's place is kept, and the first newly
    // loaded row (History row 599) comes into view on the way. Two newer
    // pages, then the transcript continues into the live window.
    const sentBeforeNewer = sentBeforeHold;
    let sawFirstNewRow = false;
    for (let step = 0; step < 300; step++) {
      if (await page.evaluate<boolean>(inView('History row 599'))) {
        sawFirstNewRow = true;
      }
      if (await page.evaluate<boolean>(inView('History row 1049'))) {
        break;
      }
      await wheel(page, 500);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(await page.evaluate<boolean>(inView('History row 1049')), 'reached the live end');
    assert.ok(sawFirstNewRow, 'the first newly loaded row was shown, not skipped');
    assert.ok((await rowCount(page)) <= 600);
    const newer = sockets.sent
      .slice(sentBeforeNewer)
      .filter((sent) => sent.action === 'agent-history-page' && sent.direction === 'after');
    assert.equal(newer.length, 2, 'two newer pages were requested');

    // Back up into a detached snapshot, then Jump to latest from there: only
    // the live window again, and the view follows rows streaming in.
    await scrollUntil(page, -100_000, shows('Paging fixture'));
    await page.waitFor(`document.querySelector('button.latest')`);
    await click(page, 'button.latest');
    await page.waitFor(`document.querySelectorAll('.rows > .message').length === 200`);
    assert.match(await transcriptText(page), /History row 1049\b/);
    assert.doesNotMatch(await transcriptText(page), /History row 849\b/);
    run.emit(chatMessage('history-1050', 'assistant', 'History row 1050'));
    await page.waitFor(shows('History row 1050'));
    await page.waitFor(inView('History row 1050'));
    await page.waitFor(`!document.querySelector('button.latest')`);
    run.finish();

    for (const action of requestActions(sockets)) {
      assert.ok(['panel-state', 'agent-history-page'].includes(action), `unexpected ${action}`);
    }
    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'after a reconnect at the end of a detached snapshot a downward wheel loads the next page',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Wheel fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    for (let index = 0; index < 1050; index++) {
      fixture.runs[0].emit(chatMessage('wheel-' + index, 'assistant', 'History row ' + index));
    }
    fixture.runs[0].finish();
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Wheel fixture');
    await page.waitFor(shows('History row 1049'));
    // Up to the first message: a detached snapshot ending at History row 598.
    await scrollUntil(page, -100_000, shows('Wheel fixture'));
    await page.waitFor(`document.querySelector('button.latest')`);

    // The newer page is requested at the end but never answered before the
    // gateway stops: the browser forgets it and never replays it.
    const historyPage = fixture.sessions.historyPage.bind(fixture.sessions);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.sessions.historyPage = (async (request: Parameters<typeof historyPage>[0]) => {
      const reply = historyPage(request);
      if (request.direction === 'after') {
        await held;
      }
      return reply;
    }) as unknown as typeof historyPage;
    const newerRequests = () => sockets.sent.filter((sent) => sent.direction === 'after').length;
    await scrollUntil(page, 100_000, inView('History row 598'));
    await waitFor(() => newerRequests() === 1);
    fixture.sessions.historyPage = historyPage;
    await fixture.gateway.close();
    await page.waitFor(`document.querySelector('.connection-banner')`, 5000);
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
    await page.waitFor(`!document.querySelector('.connection-banner')`, 20_000);
    await page.waitFor(`document.querySelector('.state').textContent === 'Done'`);
    assert.equal(newerRequests(), 1, 'the lost request was not replayed');
    // The listener may now answer the old connection's request; nobody gets it.
    release();

    // Scrolling up near the end asks for nothing newer: the reader is
    // heading toward older rows.
    await wheel(page, -150);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(newerRequests(), 1, 'an upward scroll requested no newer page');
    // Within a second of that upward wheel, the page itself moves the
    // transcript back to the very end (as when it keeps the reader's row
    // after a resize). That is not the reader moving toward the end, so it
    // requests nothing either.
    await page.evaluate(`(() => {
      const transcript = document.querySelector('.transcript');
      transcript.scrollTop = transcript.scrollHeight;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(newerRequests(), 1);
    assert.ok(await page.evaluate<boolean>(inView('History row 598')));
    await wheel(page, 300);
    await waitFor(() => newerRequests() === 2, 5000);
    await page.waitFor(shows('History row 700'));
    assert.ok(await page.evaluate<boolean>(inView('History row 598')), 'the reader stayed');
    await assertNoViolations(page);
  },
);

test(
  'shows connection loss and recovers after a gateway restart without replaying requests',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = fixture.sessions.start({ ...frame, utterance: 'Reconnect fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    fixture.runs[0].finish();
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Reconnect fixture');
    await page.waitFor(`document.querySelector('.state').textContent === 'Done'`);

    // The listener admits the send, then the gateway stops before its answer
    // reaches the browser: the outcome is unknown to the page.
    const followUp = fixture.sessions.followUp.bind(fixture.sessions);
    let stopped: Promise<void> | undefined;
    fixture.sessions.followUp = ((...parameters: Parameters<typeof followUp>) => {
      const result = followUp(...parameters);
      stopped = fixture.gateway.close();
      return result;
    }) as typeof followUp;

    await click(page, '.chat textarea');
    await page.type('Sent once before the restart');
    await clickButton(page, 'Send');
    await waitFor(() => fixture.runs.length === 2, 5000);
    fixture.sessions.followUp = followUp;
    await stopped;
    fixture.runs[1].finish();

    await page.waitFor(`document.querySelector('.connection-banner')`, 5000);
    await page.waitFor(`document.querySelector('.state').textContent === 'Disconnected'`);
    // The unanswered send keeps its text and says to check before resending.
    await page.waitFor(
      `document.querySelector('.composer').textContent.includes('check the conversation before sending it again')`,
    );
    assert.equal(
      await page.evaluate(`document.querySelector('.chat textarea').value`),
      'Sent once before the restart',
    );
    // Nothing can be sent while disconnected.
    assert.equal(await page.evaluate(`${buttonExpression('Send')}.disabled`), true);
    const sentBefore = sockets.sent.length;

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

    await page.waitFor(`!document.querySelector('.connection-banner')`, 20_000);
    await page.waitFor(`document.querySelector('.state').textContent === 'Done'`);
    assert.equal(
      await page.evaluate(`document.querySelector('.chat textarea').value`),
      'Sent once before the restart',
    );
    // Only the selection report was sent again: no send was replayed, and
    // the listener has the message exactly once and started no other turn.
    assert.deepEqual(requestActions(sockets, sentBefore), ['panel-state']);
    assert.equal(requestActions(sockets).filter((action) => action === 'send-agent').length, 1);
    assert.equal(fixture.runs.length, 2);
    const session = fixture.sessions.snapshot().find((entry) => entry.id === id)!;
    const copies = session.messages.filter(
      (message) => message.text === 'Sent once before the restart',
    );
    assert.equal(copies.length, 1);
    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'a conversation reopened under the same ID while offline starts at its live end',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = fixture.sessions.start({ ...frame, utterance: 'Reopen fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    for (let index = 0; index < 80; index++) {
      fixture.runs[0].emit(chatMessage('reopen-' + index, 'assistant', 'Reopen row ' + index));
    }
    fixture.runs[0].finish();
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Reopen fixture');
    await page.waitFor(inView('Reopen row 79'));
    // The reader scrolls up, away from the end.
    await wheel(page, -3000);
    await page.waitFor(`document.querySelector('button.latest')`);

    // Closed and reopened elsewhere while this browser is offline: the same
    // ID in a new lifetime.
    await fixture.gateway.close();
    await page.waitFor(`document.querySelector('.connection-banner')`, 5000);
    await fixture.sessions.remove(id);
    await fixture.sessions.reopen(id, false);
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

    await page.waitFor(`!document.querySelector('.connection-banner')`, 20_000);
    await page.waitFor(inView('Reopen row 79'), 5000);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('button.latest'))`), false);
  },
);

test(
  'signing out forgets the drafts of this browser before the next pairing',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Sign-out fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    fixture.runs[0].finish();
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Sign-out fixture');
    await click(page, '.chat textarea');
    await page.type('Private synthetic draft');
    // Sign out is in the bar of the pages without a conversation.
    await click(page, '.previous-entry');
    await clickButton(page, 'Sign out');
    await page.waitFor(`document.querySelector('#code')`);

    const { code } = await fixture.devices.createPairingCode();
    await click(page, '#code');
    await page.type(code);
    await click(page, 'button[type=submit]');
    await page.waitFor(online, 8000);
    await openConversation(page, 'Sign-out fixture');
    assert.equal(await page.evaluate(`document.querySelector('.chat textarea').value`), '');
    assert.doesNotMatch(await text(page, '.chat'), /Private synthetic draft|only in this editor/);
    assert.equal(
      await page.evaluate(`JSON.stringify(localStorage).includes('Private synthetic draft')`),
      false,
    );
    await assertNoViolations(page);
  },
);

test(
  'another tab of the same browser is retired when this one signs out',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Two-tab fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    fixture.runs[0].finish();
    const first = await pairedPage(fixture, browser, 1280, 800);
    // A second tab in the same browser profile is paired through storage.
    const second = await desktopPage(browser, 1280, 800, first.browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);
    await openConversation(second.page, 'Two-tab fixture');
    await click(second.page, '.chat textarea');
    await second.page.type('Draft of the previous pairing');

    // Signing out in the first tab returns the second one to pairing too.
    // (Each tab is brought to the front before it is used: Chromium slows
    // the timers of background tabs.)
    await first.page.call('Page.bringToFront');
    await clickButton(first.page, 'Sign out');
    await first.page.waitFor(`document.querySelector('#code')`);
    await second.page.call('Page.bringToFront');
    await second.page.waitFor(`document.querySelector('#code')`, 8000);

    // Pair again in the first tab: neither tab offers the earlier draft.
    const { code } = await fixture.devices.createPairingCode();
    await first.page.call('Page.bringToFront');
    await click(first.page, '#code');
    await first.page.type(code);
    await click(first.page, 'button[type=submit]');
    await first.page.waitFor(online, 8000);
    await second.page.call('Page.bringToFront');
    await second.page.waitFor(online, 8000);
    for (const tab of [first.page, second.page]) {
      await tab.call('Page.bringToFront');
      await openConversation(tab, 'Two-tab fixture');
      assert.equal(await tab.evaluate(`document.querySelector('.chat textarea').value`), '');
      assert.equal(
        await tab.evaluate(
          `JSON.stringify(localStorage).includes('Draft of the previous pairing')`,
        ),
        false,
      );
    }
  },
);

test(
  'screenshots of synthetic conversations at 420, 760, 1280 and 1600 px, strip and full list',
  {
    skip:
      skip ??
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { fixture, browser } = await setup(context);
    // Synthetic conversations: one keeps working, the others answered.
    const titles = [
      '🗺️ Plan a two-day synthetic city trip',
      '🐛 Why does the list test fail?',
      '🧾 Invoice export',
      '📊 Sales dashboard',
      'Notification rules',
    ];
    for (const title of titles) {
      fixture.sessions.start({ ...frame, utterance: title }, signal());
    }
    await waitFor(() => fixture.runs.length === titles.length);
    const runFor = (fragment: string) =>
      fixture.runs.find((candidate) => candidate.request.prompt.text.includes(fragment))!;
    const run = runFor('list test');
    run.emit({
      ...chatMessage('t1', 'tool', 'export function first(items) {}'),
      toolName: 'read',
      input: '{}',
      state: 'done',
    });
    run.emit({
      ...chatMessage(
        'a1',
        'assistant',
        'The fixture returns `undefined` when the list is empty:\n\n```ts\nexport function first(items: string[]) {\n  return items[0];\n}\n```\n\nA guard in the caller fixes it. **Should I apply the change?**',
      ),
      state: 'done',
    });
    run.publish(parseChoices(['[Yes] - Apply the guard', '[No] - Leave it']));
    run.finish();
    const lastLines: Record<string, string> = {
      Invoice: 'The nightly export now writes one file per month.',
      Sales: 'Which chart should come first?',
      Notification: 'Quiet hours are respected for all channels.',
    };
    for (const [fragment, line] of Object.entries(lastLines)) {
      const answered = runFor(fragment);
      answered.emit({ ...chatMessage(`a-${fragment}`, 'assistant', line), state: 'done' });
      answered.finish();
    }

    const layouts = [
      { name: 'strip', listWidth: 78 },
      { name: 'list', listWidth: 290 },
    ];
    for (const layout of layouts) {
      for (const width of [420, 760, 1280, 1600]) {
        const { page } = await pairedPage(fixture, browser, width, 800);
        await page.evaluate(
          `localStorage.setItem('companion.shell.layout', JSON.stringify({ version: 1, listWidth: ${layout.listWidth}, listShown: true }))`,
        );
        await page.navigate(`${fixture.origin}/`);
        await page.waitFor(online, 8000);
        await page.waitFor(`document.querySelectorAll('.conversation-entry').length === 5`);
        await openConversation(page, 'Why does the list test fail?');
        await page.waitFor(`document.querySelector('.choice:not([disabled])')`, 5000);
        // One answer not seen yet: open the others once, except Sales dashboard.
        await openConversation(page, 'Invoice export');
        await openConversation(page, 'Notification rules');
        await openConversation(page, 'Why does the list test fail?');
        await page.waitFor(`document.querySelector('.choice:not([disabled])')`, 5000);
        await page.evaluate(`document.activeElement?.blur()`);
        await writeFile(
          join(directory, `shell-${layout.name}-${width}.png`),
          await page.screenshot(),
        );
        assert.equal(await horizontalOverflow(page), 0);
        await page.close();
      }
    }
  },
);
