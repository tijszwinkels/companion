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
  clickAt,
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
  type SocketLog,
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The directions (`before`, `after`) of the history pages requested since `from`. */
function pageRequests(sockets: SocketLog, from = 0): string[] {
  const directions: string[] = [];
  for (const sent of sockets.sent.slice(from)) {
    if (sent.type === 'request' && sent.action === 'agent-history-page') {
      directions.push(String(sent.direction));
    }
  }
  return directions;
}

/** The transcript's scroll position and box, in CSS pixels. */
interface TranscriptGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  top: number;
  left: number;
  right: number;
}

function transcriptGeometry(page: TestPage): Promise<TranscriptGeometry> {
  return page.evaluate<TranscriptGeometry>(`(() => {
    const transcript = document.querySelector('.transcript');
    const box = transcript.getBoundingClientRect();
    return {
      scrollTop: transcript.scrollTop,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
      top: box.top,
      left: box.left,
      right: box.right,
    };
  })()`);
}

/**
 * Drag the transcript's scroll bar thumb with the mouse so that the content
 * moves by about `distance` pixels (positive: toward the end), after holding
 * it pressed without moving for `holdMilliseconds`. The thumb is the chat's
 * 4 px handle at the transcript's right edge.
 */
async function dragScrollBar(page: TestPage, distance: number, holdMilliseconds = 0) {
  const box = await transcriptGeometry(page);
  const range = box.scrollHeight - box.clientHeight;
  const thumbLength = (box.clientHeight * box.clientHeight) / box.scrollHeight;
  const travel = box.clientHeight - thumbLength;
  const x = box.right - 2;
  const y = box.top + (box.scrollTop / range) * travel + thumbLength / 2;
  // Not past either end of the track (the drag stops there anyway).
  const thumbTop = (box.scrollTop / range) * travel;
  const thumbDistance = Math.max(
    -thumbTop - 8,
    Math.min(travel - thumbTop + 8, (distance * travel) / range),
  );
  const steps = Math.max(1, Math.ceil(Math.abs(thumbDistance) / 4));
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const pressed = { x, y, button: 'left', clickCount: 1 };
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pressed });
  await sleep(holdMilliseconds);
  for (let step = 1; step <= steps; step++) {
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y: y + (thumbDistance * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }
  const released = { x, y: y + thumbDistance, button: 'left', clickCount: 1 };
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...released });
}

/**
 * Pan the transcript with one finger so that the content moves by about
 * `distance` pixels (positive: toward the end). The browser reports such a
 * pan as pointerdown, pointercancel and then scroll events only. The finger
 * rests before it lifts, so no fling follows; it can also rest for
 * `holdMilliseconds` before it moves. Touch input is emulated for the pan
 * only, so mouse and keyboard input stay as they are.
 */
async function touchPan(page: TestPage, distance: number, holdMilliseconds = 0) {
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const box = await transcriptGeometry(page);
  const x = box.left + 40;
  const start = box.top + box.clientHeight / 2 + distance / 2;
  const steps = Math.max(1, Math.ceil(Math.abs(distance) / 20));
  await page.call('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: start }],
  });
  await sleep(holdMilliseconds);
  for (let step = 1; step <= steps; step++) {
    await page.call('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: start - (distance * step) / steps }],
    });
    await sleep(16);
  }
  await sleep(150);
  await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
}

/** Click into the transcript (beside the rows' text) and press `key` there. */
async function pressKeyInTranscript(page: TestPage, key: 'PageDown' | 'PageUp' | 'End') {
  const codes = { PageUp: 33, PageDown: 34, End: 35 };
  const box = await transcriptGeometry(page);
  await clickAt(page, { x: box.left + 8, y: box.top + box.clientHeight / 2 });
  const event = { key, code: key, windowsVirtualKeyCode: codes[key] };
  await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
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

    // A finished Activity entry: the shell reads this run's Activity
    // history (for the Activity column), and nothing else for it while the
    // column is hidden.
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
    // A kept screenshot offers the viewer (details-browser.test.ts opens it).
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('View screenshot')})`), true);
    assert.match(await text(page, '.message.user .heading'), /screenshot attached/);
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
    // Only the actions this slice uses left the page: the selection report
    // and the reading of Activity history.
    const actions = requestActions(sockets);
    assert.ok(actions.includes('activity-history'), 'Activity history is read');
    for (const action of actions) {
      assert.ok(
        ['panel-state', 'activity-history'].includes(action),
        `unexpected request ${action}`,
      );
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

    // The classic view is not offered here: the page draws no Classic view
    // button (the bridge's status says so); Close session is still there.
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('Classic view')})`), false);

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
    // The reader drags the scroll bar to the end, holding it still for more
    // than a second first: their own scrolling, however slow, so the newer
    // page is requested.
    const sentBeforeHold = sockets.sent.length;
    await dragScrollBar(page, 100_000, 1200);
    await waitFor(() =>
      sockets.sent.slice(sentBeforeHold).some((sent) => sent.direction === 'after'),
    );
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
  "at the end of a detached snapshot page-made scrolls ask for nothing, the reader's scroll does",
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Wheel fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    for (let index = 0; index < 1050; index++) {
      // Long enough to wrap onto more lines in a narrower window.
      const text = 'History row ' + index + ' ' + 'with synthetic filler text '.repeat(6);
      fixture.runs[0].emit(chatMessage('wheel-' + index, 'assistant', text));
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

    // The reader is now at the very end of the detached snapshot with
    // nothing pending: exactly where their next scroll asks for the next
    // page. What the page or the browser scrolls itself never asks. Each row
    // says what happens and the request the paging rule allows for it (see
    // `pagingRuleExpects`): none for page-made scrolls, the next newer page
    // for the reader's own scroll within one viewport of the end.
    const middle = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const pointer = { x: middle.x, y: middle.y, button: 'left', clickCount: 1 };
    async function resize(width: number, height: number): Promise<void> {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    // Newer pages asked for from here on are held until the end.
    let releaseNewer = () => {};
    const newerHeld = new Promise<void>((resolve) => {
      releaseNewer = resolve;
    });
    fixture.sessions.historyPage = (async (request: Parameters<typeof historyPage>[0]) => {
      const reply = historyPage(request);
      if (request.direction === 'after') {
        await newerHeld;
      }
      return reply;
    }) as unknown as typeof historyPage;
    const steps: { name: string; act: () => Promise<void>; expected: number }[] = [
      {
        name: 'the reader wheels down at the very end, where nothing scrolls',
        act: () => wheel(page, 300),
        expected: 0,
      },
      {
        name: "narrower with the mouse held still in the transcript: rows grow taller and the page keeps the reader's row by scrolling toward the end",
        act: async () => {
          await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer });
          const before = (await transcriptGeometry(page)).scrollTop;
          await resize(420, 800);
          await sleep(600);
          assert.ok((await transcriptGeometry(page)).scrollTop > before, 'the page scrolled');
          await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pointer });
        },
        expected: 0,
      },
      {
        name: "wider again: the page keeps the reader's row by scrolling toward the start",
        act: () => resize(1280, 800),
        expected: 0,
      },
      {
        name: 'a much taller window: the browser pulls the view back to the end',
        act: async () => {
          await resize(1280, 1600);
          await sleep(300);
          const box = await transcriptGeometry(page);
          assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight, 'at the very end');
        },
        expected: 0,
      },
      {
        name: "in one frame the page puts the reader's row back and the reader scrolls up 1 pixel",
        act: () =>
          page.evaluate(`(() => {
            const transcript = document.querySelector('.transcript');
            // Away from the row, then the page's resize handling restores it
            // (its own scroll back to the end), then the reader's pixel: the
            // browser reports one scroll event for all three.
            transcript.scrollTop -= 50;
            window.dispatchEvent(new Event('resize'));
            transcript.scrollTop -= 1;
          })()`),
        expected: 1,
      },
    ];
    // The gateway waits for a held reply before it can close, so it is
    // released also when an assertion fails.
    try {
      const observed: string[] = [];
      const expected: string[] = [];
      for (const step of steps) {
        const before = newerRequests();
        await step.act();
        await sleep(600);
        observed.push(`${step.name}: ${newerRequests() - before}`);
        expected.push(`${step.name}: ${step.expected}`);
      }
      assert.deepEqual(observed, expected);

      // The page it asked for arrives (held until now): the reader's row stays.
      const readerRow = await page.evaluate<string>(`(() => {
        const edge = document.querySelector('.transcript').getBoundingClientRect().top;
        const row = [...document.querySelectorAll('.rows > .message')].find(
          (message) => message.getBoundingClientRect().bottom > edge + 1,
        );
        return row.textContent.match(/History row [0-9]+/)[0];
      })()`);
      releaseNewer();
      await page.waitFor(shows('History row 700'));
      await sleep(200);
      assert.ok(await page.evaluate<boolean>(inView(readerRow)), 'the reader stayed');
    } finally {
      releaseNewer();
    }
    await assertNoViolations(page);
  },
);

test(
  'a scroll bar held still before dragging away from the live end still leaves it',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Held drag fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    // 401 rows: the live window holds History row 200–399, the previous
    // page the question and History row 0–199.
    for (let index = 0; index < 400; index++) {
      fixture.runs[0].emit(chatMessage('held-' + index, 'assistant', 'History row ' + index));
    }
    fixture.runs[0].finish();
    // Pages take 400 ms, so the drag is over before its page arrives (see
    // the paging rule table).
    const historyPage = fixture.sessions.historyPage.bind(fixture.sessions);
    fixture.sessions.historyPage = (async (request: Parameters<typeof historyPage>[0]) => {
      await sleep(400);
      return historyPage(request);
    }) as unknown as typeof historyPage;
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Held drag fixture');
    await page.waitFor(inView('History row 399'));
    const from = sockets.sent.length;

    // A scroll that is not the reader's (no input, as a layout change makes
    // it) keeps the page at the live end and asks for nothing.
    await page.evaluate(`document.querySelector('.transcript').scrollTop = 300`);
    await sleep(300);
    assert.ok(await page.evaluate<boolean>(inView('History row 399')), 'back at the live end');
    assert.deepEqual(pageRequests(sockets, from), []);

    // At the live end the reader presses the scroll bar, holds it still for
    // more than a second, then drags it to the top: their own scrolling, so
    // the view stays where they took it and the previous page is asked for.
    await dragScrollBar(page, -100_000, 1200);
    await waitFor(() => pageRequests(sockets, from).includes('before'), 5000);
    await page.waitFor(shows('History row 199'));
    assert.equal(await page.evaluate<boolean>(inView('History row 399')), false);
    assert.deepEqual(pageRequests(sockets, from), ['before']);

    // The same with a finger: back at the live end, it rests on the
    // transcript for more than a second, then pans toward older rows. The
    // browser cancels the pointer before the pan scrolls; the pan is still
    // the reader's and leaves the end.
    await click(page, 'button.latest');
    await page.waitFor(`!document.querySelector('button.latest')`);
    await page.waitFor(inView('History row 399'));
    await touchPan(page, -400, 1200);
    await sleep(500);
    assert.equal(await page.evaluate<boolean>(inView('History row 399')), false, 'left the end');
    assert.ok(await page.evaluate<boolean>(`Boolean(document.querySelector('button.latest'))`));

    // One gesture, the finger never lifted: it pans down to the live end,
    // rests there for more than a second, then pans back up. The pan back
    // is still the reader's and leaves the end again.
    await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const box = await transcriptGeometry(page);
    const x = box.left + 40;
    let y = box.top + box.clientHeight - 40;
    async function moveFinger(distance: number): Promise<void> {
      const steps = Math.ceil(Math.abs(distance) / 20);
      for (let step = 0; step < steps; step++) {
        y -= distance / steps;
        await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await sleep(16);
      }
    }
    const toEnd = box.scrollHeight - box.clientHeight - box.scrollTop;
    assert.ok(toEnd < box.clientHeight - 140, `near the end: ${toEnd}`);
    await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await moveFinger(toEnd + 100);
    await page.waitFor(inView('History row 399'));
    await sleep(1200);
    await moveFinger(-400);
    await sleep(500);
    const leftAgain = !(await page.evaluate<boolean>(inView('History row 399')));
    await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
    assert.ok(leftAgain, 'left the end after resting there mid-gesture');
    await assertNoViolations(page);
  },
);

test(
  'a detached snapshot shorter than two viewports pages the way the reader scrolls',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Short snapshot fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    // 1051 rows: the live window holds History row 850–1049.
    for (let index = 0; index < 1050; index++) {
      fixture.runs[0].emit(chatMessage('short-' + index, 'assistant', 'History row ' + index));
    }
    fixture.runs[0].finish();
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Short snapshot fixture');
    await page.waitFor(shows('History row 1049'));

    // Four older pages by wheeling up at an ordinary size: History row
    // 50–649 resident, detached, older rows above and newer pages below.
    for (let loaded = 0; loaded < 4; loaded++) {
      const before = pageRequests(sockets).length;
      for (let attempt = 0; attempt < 60 && pageRequests(sockets).length === before; attempt++) {
        await wheel(page, -100_000);
        await sleep(150);
      }
      await page.waitFor(
        `!document.querySelector('.history-notice')?.textContent.includes('Loading')`,
      );
      await sleep(100);
    }
    assert.deepEqual(pageRequests(sockets), ['before', 'before', 'before', 'before']);
    await page.waitFor(`${shows('History row 50')} && !${shows('History row 650')}`);

    // Then the window grows so tall that the whole snapshot is shorter than
    // two viewports: everywhere in it both edges are within one viewport.
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 32_000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
    const box = await transcriptGeometry(page);
    assert.ok(box.scrollHeight > box.clientHeight, 'the snapshot still scrolls');
    assert.ok(box.scrollHeight < 2 * box.clientHeight, 'both edges are always near');
    assert.deepEqual(pageRequests(sockets).length, 4, 'growing the window asked for nothing');

    // Toward the end: the next newer page; toward the start: the previous one.
    let from = sockets.sent.length;
    await wheel(page, 200);
    await waitFor(() => pageRequests(sockets, from).length > 0, 5000);
    await sleep(300);
    assert.deepEqual(pageRequests(sockets, from), ['after']);
    await page.waitFor(shows('History row 650'));
    await page.waitFor(
      `!document.querySelector('.history-notice')?.textContent.includes('Loading')`,
    );

    await sleep(300);
    from = sockets.sent.length;
    await wheel(page, -200);
    await waitFor(() => pageRequests(sockets, from).length > 0, 5000);
    await sleep(300);
    assert.deepEqual(pageRequests(sockets, from), ['before']);
    await assertNoViolations(page);
  },
);

/**
 * The paging rule (integrations/shell/README.md, "The paging rule") as one table:
 *
 *   A scroll the reader makes that leaves the transcript within one viewport
 *   of an edge asks for the next page at that edge: the previous page near
 *   the top (while there are older pages), the next newer page near the end
 *   of a detached snapshot. Whatever moved it: wheel, keys, scroll bar or a
 *   finger. Not while a page is loading, not after a failure. Scrolls the
 *   page makes itself never ask.
 *
 * Every input method × where the reader's scroll leaves the transcript ×
 * the page state. The reader starts 1.6 viewports from the edge (or in the
 * middle) and moves about one viewport toward it. The expectation follows
 * from the rule alone (`pagingRuleExpects`); what is observed is the gateway
 * request the scroll caused and whether the transcript continued into the
 * live rows. Page-made scrolls are the next test's table.
 *
 * The conversation has 1601 rows: the question and Paging row 0–1599. The
 * live window holds Paging row 1400–1599; pages hold 200 rows, at most
 * three stay resident:
 * - live: the live window, the reader scrolled away from its end;
 * - detached with newer pages: five pages up, rows 400–999 resident; the
 *   next newer page (1000–1199) comes from the gateway;
 * - detached at the newest page: three pages up, rows 800–1399 resident;
 *   they end where the live window starts, so the next newer rows are the
 *   live window itself, joined without a gateway request.
 */
type PageState = 'live' | 'detached with newer pages' | 'detached at the newest page';
type ReaderPosition = 'near the top' | 'in the middle' | 'near the end';
type InputMethod = 'wheel' | 'keyboard' | 'scroll bar drag' | 'touch pan';

interface PagingOutcome {
  /** The history page the gateway was asked for, or null for none. */
  request: 'before' | 'after' | null;
  /** Whether the transcript continued into the live rows (no request needed). */
  joinedLive: boolean;
}

/** What the paging rule says a reader's scroll to `position` does in `state`. */
function pagingRuleExpects(state: PageState, position: ReaderPosition): PagingOutcome {
  // Every state here has older pages above it.
  if (position === 'near the top') {
    return { request: 'before', joinedLive: false };
  }
  if (position === 'near the end' && state === 'detached with newer pages') {
    return { request: 'after', joinedLive: false };
  }
  // The next newer rows are the live window: the bridge joins it locally.
  if (position === 'near the end' && state === 'detached at the newest page') {
    return { request: null, joinedLive: true };
  }
  // In the middle, and at the end of the live window, there is nothing to ask for.
  return { request: null, joinedLive: false };
}

const pageStates: PageState[] = [
  'live',
  'detached with newer pages',
  'detached at the newest page',
];
const readerPositions: ReaderPosition[] = ['near the top', 'in the middle', 'near the end'];
const inputMethods: InputMethod[] = ['wheel', 'keyboard', 'scroll bar drag', 'touch pan'];

/** A page expression: a row whose text has `fragment` as a word is in the transcript. */
function hasRow(fragment: string): string {
  return `[...document.querySelectorAll('.rows > .message')].some((row) => new RegExp(${JSON.stringify(fragment)} + '(?![0-9])').test(row.textContent))`;
}

test(
  'paging rule table: every input method, reader position and page state',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Paging table fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    for (let index = 0; index < 1600; index++) {
      fixture.runs[0].emit(chatMessage('table-' + index, 'assistant', 'Paging row ' + index));
    }
    fixture.runs[0].finish();
    // Pages take 400 ms, as over a real network, so that each input's own
    // scrolling (a key's smooth scrolling, a drag) is over before its page
    // arrives and one input is one scroll gesture. With instant pages a
    // scroll bar drag that goes on toward the top after the page arrived
    // moves the view up again and, by the rule, asks for the next page.
    const historyPage = fixture.sessions.historyPage.bind(fixture.sessions);
    fixture.sessions.historyPage = (async (request: Parameters<typeof historyPage>[0]) => {
      await sleep(400);
      return historyPage(request);
    }) as unknown as typeof historyPage;
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Paging table fixture');
    await page.waitFor(hasRow('Paging row 1599'));

    const loading = `document.querySelector('.history-notice')?.textContent.includes('Loading')`;

    /** Back to the live window, then away from its end (by the reader's wheel). */
    async function showLive(): Promise<void> {
      if (await page.evaluate<boolean>(`Boolean(document.querySelector('button.latest'))`)) {
        await click(page, 'button.latest');
      }
      await page.waitFor(`document.querySelectorAll('.rows > .message').length === 200`);
      await page.waitFor(`!(${loading})`);
      await wheel(page, -300);
      await page.waitFor(`Boolean(document.querySelector('button.latest'))`);
      // The wheel's own scrolling may still be under way.
      await sleep(500);
    }

    /** Older pages loaded by the reader wheeling up to the top, one at a time. */
    async function loadOlderPages(count: number): Promise<void> {
      for (let loaded = 0; loaded < count; loaded++) {
        const before = pageRequests(sockets).length;
        for (let attempt = 0; attempt < 60 && pageRequests(sockets).length === before; attempt++) {
          await wheel(page, -100_000);
          await sleep(150);
        }
        assert.equal(pageRequests(sockets).length, before + 1, 'an older page was requested');
        // Shown while the page takes its 400 ms, then gone when it arrived.
        await page.waitFor(loading, 5000);
        await page.waitFor(`!(${loading})`, 10_000);
      }
    }

    /** A page expression: the page shows `state` (checked before every case). */
    function stateExpression(state: PageState): string {
      let expression = '';
      if (state === 'live') {
        expression = `${hasRow('Paging row 1599')} && !${hasRow('Paging row 1199')}`;
      } else if (state === 'detached with newer pages') {
        expression = `${hasRow('Paging row 999')} && !${hasRow('Paging row 1000')} && !${hasRow('Paging row 0')}`;
      } else {
        expression = `${hasRow('Paging row 1399')} && !${hasRow('Paging row 1400')} && !${hasRow('Paging row 799')}`;
      }
      return `Boolean(${expression}) && !(${loading})`;
    }

    async function enter(state: PageState): Promise<void> {
      if (state === 'live') {
        await showLive();
      } else if (!(await page.evaluate<boolean>(stateExpression(state)))) {
        await showLive();
        await loadOlderPages(state === 'detached with newer pages' ? 5 : 3);
      }
      // Rows reach the page up to 30 ms after the status that ended loading.
      await page.waitFor(stateExpression(state), 3000);
    }

    /** Put the reader where one viewport's move reaches `position` (no page is asked for there). */
    async function placeReader(position: ReaderPosition): Promise<number> {
      const box = await transcriptGeometry(page);
      const range = box.scrollHeight - box.clientHeight;
      let top = range / 2;
      let direction = 1;
      if (position === 'near the top') {
        top = 1.6 * box.clientHeight;
        direction = -1;
      } else if (position === 'near the end') {
        top = range - 1.6 * box.clientHeight;
      }
      await page.evaluate(`document.querySelector('.transcript').scrollTop = ${top}`);
      // Longer than any window in which the reader's earlier input could count.
      await sleep(1100);
      const placed = (await transcriptGeometry(page)).scrollTop;
      assert.ok(Math.abs(placed - top) <= 2, `the reader was placed ${position}`);
      return direction * box.clientHeight;
    }

    async function move(input: InputMethod, distance: number): Promise<void> {
      if (input === 'wheel') {
        await wheel(page, distance);
      } else if (input === 'keyboard') {
        await pressKeyInTranscript(page, distance > 0 ? 'PageDown' : 'PageUp');
      } else if (input === 'scroll bar drag') {
        await dragScrollBar(page, distance);
      } else {
        await touchPan(page, distance * 0.9);
      }
    }

    /** One outcome as a table cell, e.g. "after" or "none + joins live". */
    function describe(request: string | null, joinedLive: boolean): string {
      let text = request ?? 'none';
      if (joinedLive) {
        text += ' + joins live';
      }
      return text;
    }

    const rows: string[] = [];
    const failures: string[] = [];
    for (const state of pageStates) {
      for (const position of readerPositions) {
        for (const input of inputMethods) {
          const name = `${input} | ${position} | ${state}`;
          const expected = pagingRuleExpects(state, position);
          await enter(state);
          const distance = await placeReader(position);
          const startTop = (await transcriptGeometry(page)).scrollTop;
          const liveBefore = await page.evaluate<boolean>(hasRow('Paging row 1400'));
          const from = sockets.sent.length;

          await move(input, distance);
          await sleep(1200);
          await page.waitFor(`!(${loading})`, 10_000);

          const requested = pageRequests(sockets, from);
          const joinedLive =
            !liveBefore && (await page.evaluate<boolean>(hasRow('Paging row 1400')));
          // The input must really have scrolled. (Near the top an older page
          // arriving moves the scroll position back down by its height, so
          // the position says nothing there; the request does.)
          const endTop = (await transcriptGeometry(page)).scrollTop;
          const scrolled = position === 'near the top' || Math.abs(endTop - startTop) > 100;

          const observedText = describe(requested.join(',') || null, joinedLive);
          const expectedText = describe(expected.request, expected.joinedLive);
          const row = `${name} | expected ${expectedText} | observed ${observedText}`;
          rows.push(row);
          if (observedText !== expectedText || !scrolled) {
            failures.push(scrolled ? row : `${row} (the input did not scroll)`);
          }
        }
      }
    }
    context.diagnostic('\n' + rows.join('\n'));
    assert.deepEqual(failures, []);
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

/**
 * Wait for `expression` in a tab that reloads itself meanwhile (the second
 * tab below reloads when the stored pairing changes): a check that lands
 * while the tab navigates is retried instead of failing the wait.
 */
async function waitThroughReload(page: TestPage, expression: string, timeout: number) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      await page.waitFor(expression, Math.max(1, until - Date.now()));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const navigated =
        message.includes('Inspected target navigated or closed') ||
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context');
      if (!navigated) {
        throw error;
      }
    }
  }
  throw Error(`Timed out waiting for: ${expression}`);
}

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
    await waitThroughReload(second.page, `document.querySelector('#code')`, 8000);

    // Pair again in the first tab: neither tab offers the earlier draft.
    const { code } = await fixture.devices.createPairingCode();
    await first.page.call('Page.bringToFront');
    await click(first.page, '#code');
    await first.page.type(code);
    await click(first.page, 'button[type=submit]');
    await first.page.waitFor(online, 8000);
    await second.page.call('Page.bringToFront');
    await waitThroughReload(second.page, online, 8000);
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
          `localStorage.setItem('companion.shell.layout.listWidth', JSON.stringify({ version: 1, value: ${layout.listWidth} }))`,
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
