import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseChoices } from '../../src/agents/choices.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import { TestBrowser, chromiumPath, type TestPage } from './browser.ts';

/**
 * The built phone app in headless Chromium with phone emulation (touch,
 * mobile viewport, 3x density), against the real gateway and listener
 * control socket with a synthetic agent backend. Requires
 * `npm run mobile:build` and /usr/lib/chromium/chromium.
 *
 * Not covered here (documented limits): real iOS Safari/WebKit, the on-screen
 * keyboard, real safe-area insets, Tailscale, or a real phone network.
 */

const appDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'mobile', 'dist');

async function prerequisites(): Promise<string | undefined> {
  try {
    await access(join(appDirectory, 'index.html'));
  } catch {
    return 'phone app not built (npm run mobile:build)';
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

/** Pair through the real UI with a code from the device store. */
async function pairedPhone(fixture: Fixture, browser: TestBrowser, width = 390, height = 844) {
  const page = await browser.phone(width, height);
  await page.navigate(`${fixture.origin}/`);
  await page.waitFor(`document.querySelector('#code')`);

  const { code } = await fixture.devices.createPairingCode();
  await page.tap('#code');
  await page.type(code);
  await page.tap('button[type=submit]');
  await page.waitFor(`document.querySelector('.tabbar')`, 8000);
  return page;
}

function text(page: TestPage, selector: string): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
  );
}

/** Interactive elements that are smaller than a comfortable touch target. */
function smallTargets(page: TestPage, minimum: number): Promise<string[]> {
  return page.evaluate<
    string[]
  >(`[...document.querySelectorAll('button, input, textarea, [role=switch]')]
    .filter((element) => element.offsetParent !== null)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && (rect.height < ${minimum} || rect.width < ${minimum}))
    .map(({ element, rect }) => (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 40) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height))`);
}

function unnamedControls(page: TestPage): Promise<string[]> {
  return page.evaluate<
    string[]
  >(`[...document.querySelectorAll('button, [role=switch], input, textarea')]
    .filter((element) => element.offsetParent !== null)
    .filter((element) => {
      const label = element.getAttribute('aria-label') || element.textContent?.trim() ||
        (element.id && document.querySelector('label[for="' + element.id + '"]')?.textContent);
      return !label;
    })
    .map((element) => element.outerHTML.slice(0, 80))`);
}

function horizontalOverflow(page: TestPage): Promise<number> {
  return page.evaluate<number>(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  );
}

test('pairing, navigation and layout at phone sizes', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  fixture.sessions.start({ ...frame, utterance: 'Synthetic question with a screenshot' }, signal());
  await waitFor(() => fixture.runs.length === 1);

  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [430, 932],
  ]) {
    const page = await pairedPhone(fixture, browser, width, height);
    await page.waitFor(`document.querySelector('.conversation-card')`);

    for (const tab of [1, 2, 3]) {
      await page.tap(`.tabbar button:nth-child(${tab})`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok((await horizontalOverflow(page)) <= 0, `overflow at ${width}px, tab ${tab}`);
      assert.deepEqual(await unnamedControls(page), [], `unnamed controls, tab ${tab}`);
      assert.deepEqual(await smallTargets(page, 32), [], `small targets at ${width}px, tab ${tab}`);
    }

    await page.tap('.tabbar button:nth-child(1)');
    await page.tap('.conversation-card');
    await page.waitFor(`document.querySelector('#composer')`);
    assert.ok((await horizontalOverflow(page)) <= 0, `conversation overflow at ${width}px`);
    assert.deepEqual(await unnamedControls(page), []);

    // The viewport supports notches and keyboard-aware resizing.
    const viewport = await page.evaluate<string>(
      `document.querySelector('meta[name=viewport]').content`,
    );
    assert.match(viewport, /viewport-fit=cover/);
    assert.match(viewport, /interactive-widget=resizes-content/);

    assert.deepEqual(page.errors, []);
    const foreign = page.requests.filter(
      (url) => !url.startsWith(fixture.origin + '/') && !url.startsWith('blob:'),
    );
    assert.deepEqual(foreign, [], 'the app must not contact any other origin');
    await page.close();
  }
});

test(
  'a conversation streams, queues follow-ups, offers choices and stops',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = fixture.sessions.start({ ...frame, utterance: 'Explain the fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);

    const page = await pairedPhone(fixture, browser);
    await page.tap('.conversation-card');
    await page.waitFor(`document.querySelector('#composer')`);

    // Screenshot attachment loads through the authenticated route.
    await page.waitFor(`document.querySelector('.screenshot-thumb img')`);

    // Streaming Markdown renders as formatted, escaped HTML.
    const run = fixture.runs[0];
    run.emit({
      ...chatMessage('a1', 'assistant', '**Bold** <img src=x onerror=alert(1)>'),
      state: 'running',
    });
    await page.waitFor(`document.querySelector('.message.assistant strong')`);
    assert.equal(
      await page.evaluate(`document.querySelectorAll('.message.assistant img').length`),
      0,
    );
    assert.match(await text(page, '.message.assistant .bubble'), /<img src=x/);

    // While running, the stop button is offered and works.
    await page.waitFor(`document.querySelector('.send.stop')`);

    // A follow-up typed now is queued in the same conversation.
    await page.tap('#composer');
    await page.type('Also cover the edge case');
    await page.tap('.send:not(.stop)');
    await page.waitFor(`document.querySelector('#composer').value === ''`);
    await page.waitFor(`document.querySelector('.message.user.queued')`);

    // The first turn finishes; the queued follow-up then runs as the next turn.
    // Choices belong to the latest turn, so the follow-up turn offers them.
    run.emit({ ...chatMessage('a1', 'assistant', 'Done.'), state: 'done' });
    run.finish();
    await waitFor(() => fixture.runs.length === 2);
    assert.match(fixture.runs[1].request.prompt.text, /Also cover the edge case/);
    fixture.runs[1].publish(parseChoices(['[Run tests] - Execute them', 'No']));
    fixture.runs[1].finish();
    await page.waitFor(`document.querySelector('.choice:not([disabled])')`, 5000);
    const before = fixture.runs.length;
    await page.tap('.choice');
    await waitFor(() => fixture.runs.length === before + 1, 5000);
    // The listener submits the option’s description as the next prompt.
    assert.match(fixture.runs.at(-1)!.request.prompt.text, /Execute them/);

    // Stop the running choice turn from the phone.
    await page.waitFor(`document.querySelector('.send.stop')`);
    await page.tap('.send.stop');
    await waitFor(
      () =>
        fixture.sessions.snapshot().find((session) => session.id === id)?.status === 'cancelled',
      5000,
    );
    assert.deepEqual(page.errors, []);
  },
);

test('a refused send keeps the draft and explains why', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  fixture.sessions.start({ ...frame, utterance: 'Busy conversation' }, signal());
  await waitFor(() => fixture.runs.length === 1);

  const page = await pairedPhone(fixture, browser);
  await page.tap('.conversation-card');
  await page.waitFor(`document.querySelector('#composer')`);

  // Eight follow-ups may queue while the agent is busy; the ninth is refused.
  for (let index = 1; index <= 9; index++) {
    await page.tap('#composer');
    await page.type(`Follow-up ${index}`);
    await page.tap('.send:not(.stop)');
    if (index < 9) {
      await page.waitFor(`document.querySelector('#composer').value === ''`);
    }
  }

  await page.waitFor(`document.querySelector('.composer-note.error')`);
  assert.equal(await page.evaluate(`document.querySelector('#composer').value`), 'Follow-up 9');
});

test('tool groups expand into paged details on demand', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  fixture.sessions.start({ ...frame, utterance: 'Use tools' }, signal());
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  run.emit({
    ...chatMessage('t1', 'tool', 'synthetic tool output'),
    toolName: 'read',
    input: '{"path":"fixture.txt"}',
  });

  const page = await pairedPhone(fixture, browser);
  await page.tap('.conversation-card');
  await page.waitFor(`document.querySelector('.tool-group > button')`);
  await page.tap('.tool-group > button');
  await page.waitFor(
    `document.querySelector('.tool-page pre')?.textContent.includes('synthetic tool output')`,
  );
  assert.match(await text(page, '.tool-page pre'), /fixture\.txt/);
});

test('activity shows this run and labels feedback', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const runtime = fixture.desktop.runtime;
  const observed = { ...frame, id: 41, utterance: 'Synthetic utterance for labels' };
  runtime.activity.transcribed?.(observed);
  runtime.activity.intentRecognized?.(observed.id, 'IGNORE');
  runtime.activity.outcome?.(observed.id, 'ignored');
  runtime.activity.finished?.(observed.id);

  const page = await pairedPhone(fixture, browser);
  await page.tap('.tabbar button:nth-child(2)');
  await page.waitFor(`document.querySelector('.history-card')`);
  assert.match(await text(page, '.history-card .utterance'), /Synthetic utterance for labels/);

  // Listening toggles through the engine (and is reflected back).
  await page.tap('.mic');
  await waitFor(() => fixture.desktop.pause.paused);
  await page.waitFor(`document.querySelector('.mic.paused')`);

  await page.tap('.history-card .chip');
  await page.waitFor(`document.querySelector('.pill.good')`);
});

test(
  'reconnects after the gateway returns, without replaying requests',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const page = await pairedPhone(fixture, browser);
    await page.tap('.tabbar button:nth-child(2)');
    await page.tap('.mic');
    await waitFor(() => fixture.desktop.pause.paused);

    await fixture.gateway.close();
    await page.waitFor(`document.querySelector('.banner')`);

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

    await page.waitFor(`!document.querySelector('.banner')`, 20_000);
    await page.waitFor(`document.querySelector('.mic.paused')`);
    // The earlier pause was not resent: listening is still paused.
    assert.equal(fixture.desktop.pause.paused, true);
  },
);

test('a revoked phone returns to pairing with an explanation', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const page = await pairedPhone(fixture, browser);
  const [device] = await fixture.devices.devices();
  await fixture.devices.revoke(device.id);

  await page.waitFor(`document.querySelector('#code')`, 5000);
  assert.match(await text(page, '.pairing'), /removed on the computer/);
  assert.equal(
    await page.evaluate(`localStorage.getItem('companion.remote.device')`),
    null,
    'the revoked credential is forgotten',
  );
});

test('sign out then pair again connects without a page reload', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const page = await pairedPhone(fixture, browser);
  await page.tap('.tabbar button:nth-child(3)');
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out…').click()`,
  );
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out').click()`,
  );
  await page.waitFor(`document.querySelector('#code')`);
  const { code } = await fixture.devices.createPairingCode();
  await page.tap('#code');
  await page.type(code);
  await page.tap('button[type=submit]');
  await page.waitFor(`document.querySelector('.tabbar') && !document.querySelector('.banner')`);
  await page.tap('.tabbar button:nth-child(2)');
  await page.tap('.mic');
  await waitFor(() => fixture.desktop.pause.paused);
  assert.deepEqual(page.errors, []);
});

test(
  'network loss retires an OPEN socket and reconnects with the draft intact',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Network fixture' }, signal());
    const page = await pairedPhone(fixture, browser);
    await page.waitFor(`document.querySelector('.conversation-card')`);
    await page.tap('.conversation-card');
    await page.tap('#composer');
    await page.type('Keep this unsent draft');

    // Reproduce browsers that report offline while WebSocket.readyState is
    // still OPEN. Synthetic browser events; no machine networking is changed.
    await page.evaluate(`window.dispatchEvent(new Event('offline'))`);
    await page.waitFor(`document.querySelector('.banner')?.textContent.includes('offline')`);
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);
    await page.waitFor(`!document.querySelector('.banner')`);
    assert.equal(
      await page.evaluate(`document.querySelector('#composer').value`),
      'Keep this unsent draft',
    );
    await page.tap('.send:not(.stop)');
    await page.waitFor(`document.querySelector('#composer').value === ''`);
    assert.equal(
      fixture.sessions
        .snapshot()[0]
        .messages.filter((message) => message.text === 'Keep this unsent draft').length,
      1,
    );
    assert.deepEqual(page.errors, []);
  },
);
