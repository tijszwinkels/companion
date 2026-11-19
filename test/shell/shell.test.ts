import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseChoices } from '../../src/agents/choices.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { frame, signal } from '../helpers.ts';
import { TestBrowser, TestPage, chromiumPath } from '../mobile/browser.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';

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

const appDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'shell', 'dist');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(appDirectory, 'index.html'));
  } catch {
    return 'browser shell not built (npm run shell:build)';
  }
  try {
    await access(chromiumPath);
  } catch {
    return 'Chromium not installed';
  }
  return undefined;
}

const skip = await prerequisites();

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

/** WebSocket traffic of one page, recorded through the DevTools protocol. */
interface SocketLog {
  /** Every WebSocket URL the page opened. */
  urls: string[];
  /** Every frame the page sent, parsed, in order. */
  sent: Record<string, unknown>[];
}

async function setup(context: { after(callback: () => Promise<void>): void }) {
  const fixture = await remoteFixture({ appDirectory });
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser };
}

/**
 * A fresh desktop page (own browser context, so its own storage and pairing)
 * that records WebSocket traffic and Content-Security-Policy violations.
 */
async function desktopPage(
  browser: TestBrowser,
  width: number,
  height = 800,
): Promise<{ page: TestPage; sockets: SocketLog }> {
  const { browserContextId } = await browser.call('Target.createBrowserContext');
  const { targetId } = await browser.call('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  const page = new TestPage(browser, targetId, sessionId);
  await page.call('Page.enable');
  await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Recorded by the page itself: violations would mean the shell needs a
  // weaker policy than the gateway serves.
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__violations.push(event.violatedDirective + ' ' + event.blockedURI);
      });`,
  });
  page.watchConsole();

  const sockets: SocketLog = { urls: [], sent: [] };
  browser.on((message) => {
    if (message.sessionId !== sessionId) {
      return;
    }
    if (message.method === 'Network.webSocketCreated') {
      sockets.urls.push(String(message.params.url));
    }
    if (message.method === 'Network.webSocketFrameSent') {
      try {
        sockets.sent.push(JSON.parse(String(message.params.response.payloadData)));
      } catch {
        sockets.sent.push({ unparsed: true });
      }
    }
  });
  return { page, sockets };
}

/** Click the centre of an element with the mouse, as a desktop user would. */
async function clickAt(page: TestPage, point: { x: number; y: number }): Promise<void> {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function click(page: TestPage, selector: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) {
    throw Error(`No element for ${selector}`);
  }
  await clickAt(page, point);
}

/** The enabled button whose text is exactly `label`, clicked with the mouse. */
async function clickButton(page: TestPage, label: string): Promise<void> {
  const expression = buttonExpression(label);
  await page.waitFor(`${expression} && !${expression}.disabled`);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const element = ${expression};
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
}

function buttonExpression(label: string): string {
  return `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
}

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

function text(page: TestPage, selector: string): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
  );
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

function horizontalOverflow(page: TestPage): Promise<number> {
  return page.evaluate<number>(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  );
}

/** Pair through the real UI with a code from the device store. */
async function pairedPage(fixture: Fixture, browser: TestBrowser, width = 1280, height = 800) {
  const { page, sockets } = await desktopPage(browser, width, height);
  await page.navigate(`${fixture.origin}/`);
  await page.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  await click(page, '#code');
  await page.type(code);
  await click(page, 'button[type=submit]');
  await page.waitFor(`document.querySelector('.connection-state.online')`, 8000);
  return { page, sockets };
}

/** Open the conversation titled (or containing) `title` from the list. */
async function openConversation(page: TestPage, title = ''): Promise<void> {
  await page.waitFor(
    `[...document.querySelectorAll('.conversation')].some((item) => item.textContent.includes(${JSON.stringify(title)}))`,
  );
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const item = [...document.querySelectorAll('.conversation')].find((entry) => entry.textContent.includes(${JSON.stringify(title)}));
    const rect = item.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickAt(page, point);
  await page.waitFor(`document.querySelector('.chat textarea')`);
}

/** No request and no socket went anywhere but the gateway's own origin. */
function assertOwnOrigin(fixture: Fixture, page: TestPage, sockets: SocketLog): void {
  for (const url of page.requests) {
    if (url === 'about:blank' || url.startsWith('data:')) {
      continue;
    }
    assert.ok(url.startsWith(fixture.origin + '/'), `request to another origin: ${url}`);
  }
  const socketOrigin = fixture.origin.replace(/^http/, 'ws') + '/';
  for (const url of sockets.urls) {
    assert.ok(url.startsWith(socketOrigin), `socket to another origin: ${url}`);
  }
}

async function assertNoViolations(page: TestPage): Promise<void> {
  assert.deepEqual(await page.evaluate(`window.__violations`), []);
  assert.deepEqual(page.errors, []);
}

/** Requests (not auth or ping frames) the page sent, by action. */
function requestActions(sockets: SocketLog, from = 0): string[] {
  const actions: string[] = [];
  for (const sent of sockets.sent.slice(from)) {
    if (sent.type === 'request') {
      actions.push(String(sent.action));
    }
  }
  return actions;
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
    await page.waitFor(`document.querySelectorAll('.conversation').length === 2`);
    assert.match(await text(page, '.conversation-list'), /First synthetic question/);
    assert.match(await text(page, '.conversation-list'), /Second synthetic question/);

    await openConversation(page, 'Second synthetic question');
    await page.waitFor(`document.querySelector('.message.user')`);
    assert.match(await transcriptText(page), /Second synthetic question/);
    assert.doesNotMatch(await transcriptText(page), /First synthetic question/);
    // The screenshot viewer is a later slice: no button that cannot work.
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('View screenshot')})`), false);
    assert.match(await text(page, '.message.user .heading'), /screenshot unavailable/);
    // Out of scope controls are hidden through the status fields.
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('Record')})`), false);
    assert.match(await text(page, '.shell-title'), /Second synthetic question/);

    // Back to the list and into the other conversation.
    await click(page, 'button.back');
    await page.waitFor(`document.querySelectorAll('.conversation').length === 2`);
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

    // Stop the running turn (run-scoped Stop or the conversation's own).
    await page.waitFor(
      `${buttonExpression('Stop')} || document.querySelector('.panel-action.stop')`,
    );
    if (await page.evaluate(`Boolean(document.querySelector('.panel-action.stop'))`)) {
      await click(page, '.panel-action.stop');
    } else {
      await clickButton(page, 'Stop');
    }
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
    await page.waitFor(`document.querySelector('.list-empty')`);

    const actions = requestActions(sockets);
    for (const action of ['send-agent', 'choose-agent', 'close-agent']) {
      assert.ok(actions.includes(action), `${action} was sent`);
    }
    assert.ok(actions.includes('stop-agent-run') || actions.includes('stop-agent'));
    assert.equal(actions.filter((action) => action === 'send-agent').length, 2);
    for (const action of actions) {
      assert.ok(
        [
          'panel-state',
          'send-agent',
          'choose-agent',
          'stop-agent-run',
          'stop-agent',
          'close-agent',
        ].includes(action),
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
    for (let index = 0; index < 1050; index++) {
      run.emit(chatMessage('history-' + index, 'assistant', 'History row ' + index));
    }
    run.finish();
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

    // Reading down in ordinary steps: newer pages load before the reader
    // reaches the end, the reader's place is kept, and the first newly
    // loaded row (History row 599) comes into view on the way. Two newer
    // pages, then the transcript continues into the live window.
    const sentBeforeNewer = sockets.sent.length;
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

    // Jump to latest: only the live window again.
    await wheel(page, -2000);
    await page.waitFor(`document.querySelector('button.latest')`);
    await click(page, 'button.latest');
    await page.waitFor(`document.querySelectorAll('.rows > .message').length === 200`);
    assert.match(await transcriptText(page), /History row 1049\b/);
    assert.doesNotMatch(await transcriptText(page), /History row 849\b/);

    for (const action of requestActions(sockets)) {
      assert.ok(['panel-state', 'agent-history-page'].includes(action), `unexpected ${action}`);
    }
    assertOwnOrigin(fixture, page, sockets);
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
    await click(page, 'button.back');
    await clickButton(page, 'Sign out');
    await page.waitFor(`document.querySelector('#code')`);

    const { code } = await fixture.devices.createPairingCode();
    await click(page, '#code');
    await page.type(code);
    await click(page, 'button[type=submit]');
    await page.waitFor(`document.querySelector('.connection-state.online')`, 8000);
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
  'screenshots of a synthetic conversation at 420 px and 1280 px',
  {
    skip:
      skip ??
      (process.env.COMPANION_SHELL_SCREENSHOTS ? undefined : 'COMPANION_SHELL_SCREENSHOTS not set'),
  },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS!;
    await mkdir(directory, { recursive: true });
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Plan a two-day synthetic city trip' }, signal());
    fixture.sessions.start({ ...frame, utterance: 'Why does the list test fail?' }, signal());
    await waitFor(() => fixture.runs.length === 2);
    const run = fixture.runs[1];
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

    for (const width of [420, 1280]) {
      const { page } = await pairedPage(fixture, browser, width, 800);
      await page.waitFor(`document.querySelectorAll('.conversation').length === 2`);
      await writeFile(join(directory, `shell-list-${width}.png`), await page.screenshot());
      await openConversation(page, 'Why does the list test fail?');
      await page.waitFor(`document.querySelector('.choice:not([disabled])')`, 5000);
      await writeFile(join(directory, `shell-chat-${width}.png`), await page.screenshot());
      assert.equal(await horizontalOverflow(page), 0);
      await page.close();
    }
  },
);
