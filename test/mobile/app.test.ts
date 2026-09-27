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

async function setup(
  context: { after(callback: () => Promise<void>): void },
  options: Parameters<typeof remoteFixture>[0] = {},
) {
  const fixture = await remoteFixture({ ...options, appDirectory });
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
  await page.waitFor(`document.querySelector('.shell')`, 8000);
  await page.waitFor(`document.querySelector('.mic:not([disabled])')`, 8000);
  if (!(await page.evaluate(`Boolean(document.querySelector('.rail'))`))) {
    await page.tap('button[aria-label="Show sessions"]');
  }
  return page;
}

function text(page: TestPage, selector: string): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
  );
}

/** Allow half a CSS pixel for animated/fractional layout, never a whole undersized target. */
function smallTargets(page: TestPage, minimum: number): Promise<string[]> {
  return page.evaluate<
    string[]
  >(`[...document.querySelectorAll('button, input, textarea, summary, [role=switch]')]
    .filter((element) => element.offsetParent !== null)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && (rect.height < ${minimum - 0.5} || rect.width < ${minimum - 0.5}))
    .map(({ element, rect }) => (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 40) + ' ' + rect.width.toFixed(2) + 'x' + rect.height.toFixed(2))`);
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
    await page.waitFor(`document.querySelector('.session-tab')`);

    for (const selector of [
      '.rail-activity',
      '.rail-previous',
      'button[aria-label="Phone settings"]',
    ]) {
      await page.tap(selector);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok((await horizontalOverflow(page)) <= 0, `overflow at ${width}px, ${selector}`);
      assert.deepEqual(await unnamedControls(page), [], `unnamed controls, ${selector}`);
      assert.deepEqual(
        await smallTargets(page, 44),
        [],
        `small targets at ${width}px, ${selector}`,
      );
      if (selector.includes('Phone settings')) {
        await page.tap('.sheet button[aria-label="Close"]');
        await page.waitFor(`!document.querySelector('.sheet')`);
      }
    }

    await page.tap('.session-tab');
    await page.waitFor(`document.querySelector('#composer')`);
    assert.ok((await horizontalOverflow(page)) <= 0, `conversation overflow at ${width}px`);
    assert.deepEqual(await unnamedControls(page), []);
    assert.equal(
      await page.evaluate(
        `Boolean(document.querySelector('.controls-row .danger, .close-session'))`,
      ),
      false,
    );

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
    await page.tap('.session-tab');
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
    await page.waitFor(`document.querySelector('.action.stop')`);

    // A follow-up typed now is queued in the same conversation.
    await page.tap('#composer');
    await page.type('Also cover the edge case');
    await page.tap('.send');
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
    await page.waitFor(`document.querySelector('.action.stop')`);
    await page.tap('.action.stop');
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
  await page.tap('.session-tab');
  await page.waitFor(`document.querySelector('#composer')`);

  // Eight follow-ups may queue while the agent is busy; the ninth is refused.
  for (let index = 1; index <= 9; index++) {
    await page.tap('#composer');
    await page.type(`Follow-up ${index}`);
    await page.tap('.send');
    if (index < 9) {
      await page.waitFor(`document.querySelector('#composer').value === ''`);
    }
  }

  await page.waitFor(`document.querySelector('.input-section .input-error')`);
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
  await page.tap('.session-tab');
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
  await page.tap('.rail-activity');
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
    await page.tap('.rail-activity');
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
  await page.tap('#ask-text');
  await page.type('Private synthetic draft to remove');
  const [device] = await fixture.devices.devices();
  await fixture.devices.revoke(device.id);

  await page.waitFor(`document.querySelector('#code')`, 5000);
  assert.match(await text(page, '.pairing'), /removed on the computer/);
  assert.equal(
    await page.evaluate(`localStorage.getItem('companion.remote.device')`),
    null,
    'the revoked credential is forgotten',
  );
  assert.equal(await page.evaluate(`localStorage.getItem('companion.remote.drafts')`), null);
  assert.equal(
    await page.evaluate(`document.body.textContent.includes('Private synthetic draft to remove')`),
    false,
  );
});

test('sign out then pair again connects without a page reload', { skip }, async (context) => {
  const { fixture, browser } = await setup(context);
  const page = await pairedPhone(fixture, browser);
  await page.tap('#ask-text');
  await page.type('Synthetic draft before signing out');
  await page.tap('button[aria-label="Phone settings"]');
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out…').click()`,
  );
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out').click()`,
  );
  await page.waitFor(`document.querySelector('#code')`);
  assert.equal(await page.evaluate(`localStorage.getItem('companion.remote.drafts')`), null);
  const { code } = await fixture.devices.createPairingCode();
  await page.tap('#code');
  await page.type(code);
  await page.tap('button[type=submit]');
  await page.waitFor(`document.querySelector('.shell') && !document.querySelector('.banner')`);
  await page.waitFor(`document.querySelector('.rail-activity .activity-bars:not(.paused)')`);
  assert.equal(await page.evaluate(`document.querySelector('#ask-text').value`), '');
  await page.tap('.rail-activity');
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
    await page.waitFor(`document.querySelector('.session-tab')`);
    await page.tap('.session-tab');
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
    await page.tap('.send');
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

test(
  'foregrounding during a send preserves its reply and clears only the sent draft',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Foreground fixture' }, signal());
    const page = await pairedPhone(fixture, browser);
    await page.waitFor(`document.querySelector('.session-tab')`);
    await page.tap('.session-tab');
    await page.tap('#composer');
    await page.type('Send once while foregrounding');
    await page.evaluate(`(() => {
    document.querySelector('.send').click();
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
    await page.waitFor(`document.querySelector('#composer').value === ''`);
    assert.equal(
      fixture.sessions
        .snapshot()[0]
        .messages.filter((message) => message.text === 'Send once while foregrounding').length,
      1,
    );
    assert.equal(
      await page.evaluate(`Boolean(document.querySelector('.input-section .input-error'))`),
      false,
    );
    assert.deepEqual(page.errors, []);
  },
);

/** Hold only mutation replies, after the actual gateway/listener have admitted them. */
async function holdMutationReplies(page: TestPage, origin: string): Promise<void> {
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.heldReplies = [];
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = class extends OriginalWebSocket {
        addEventListener(type, callback, options) {
          if (type !== 'message') return super.addEventListener(type, callback, options);
          return super.addEventListener(type, (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'result' && ['send-agent', 'start-agent'].includes(message.action)) {
              window.heldReplies.push(() => callback.call(this, event));
            } else {
              callback.call(this, event);
            }
          }, options);
        }
      };
    `,
  });
  await page.navigate(origin);
  await page.waitFor(`document.querySelector('.rail-activity .activity-bars:not(.paused)')`);
}

async function replaceDraft(page: TestPage, selector: string, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

test(
  'a delayed send survives navigation without duplicates or clearing a newer draft',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Draft race fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const page = await pairedPhone(fixture, browser);
    await holdMutationReplies(page, fixture.origin);
    await page.tap('.session-tab');
    await replaceDraft(page, '#composer', 'Admit this exactly once');
    await page.tap('.send');
    await page.waitFor(`window.heldReplies.length === 1`);

    await page.tap('.rail-activity');
    await page.tap('.session-tab');
    assert.equal(await page.evaluate(`document.querySelector('.send').disabled`), true);
    await replaceDraft(page, '#composer', 'A newer unsent draft');
    await page.evaluate(`document.querySelector('.send').click()`);
    assert.equal(
      fixture.sessions
        .snapshot()[0]
        .messages.filter((message) => message.text === 'Admit this exactly once').length,
      1,
    );

    await page.evaluate(`window.heldReplies.shift()()`);
    await page.waitFor(`!document.querySelector('.send').disabled`);
    assert.equal(
      await page.evaluate(`document.querySelector('#composer').value`),
      'A newer unsent draft',
    );
    await page.tap('.rail-activity');
    await page.tap('.session-tab');
    assert.equal(
      await page.evaluate(`document.querySelector('#composer').value`),
      'A newer unsent draft',
    );
    assert.deepEqual(page.errors, []);
  },
);

test(
  'a delayed new-conversation reply preserves newer text and prevents a second start',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const page = await pairedPhone(fixture, browser);
    await holdMutationReplies(page, fixture.origin);
    await replaceDraft(page, '#ask-text', 'First synthetic question');
    await page.tap('.ask .action.primary');
    await page.waitFor(`window.heldReplies.length === 1`);
    await page.tap('.rail-previous');
    await page.tap('.rail-activity');
    assert.equal(
      await page.evaluate(`document.querySelector('.ask .action.primary').disabled`),
      true,
    );
    await replaceDraft(page, '#ask-text', 'A later unsent question');
    await page.tap('#ask-text');
    await page.evaluate(`window.heldReplies.shift()()`);
    await page.waitFor(`!document.querySelector('.ask .action.primary').disabled`);
    assert.equal(
      await page.evaluate(`document.querySelector('#ask-text').value`),
      'A later unsent question',
    );
    assert.equal(fixture.sessions.snapshot().length, 1);
    assert.equal(await page.evaluate(`document.activeElement.id`), 'ask-text');
    assert.deepEqual(page.errors, []);
  },
);

test(
  'desktop arrivals and delayed phone starts preserve the active composer and focus',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const original = fixture.sessions.start(
      { ...frame, utterance: 'Original conversation' },
      signal(),
    );
    await waitFor(() => fixture.runs.length === 1);
    const page = await pairedPhone(fixture, browser);
    await holdMutationReplies(page, fixture.origin);
    await replaceDraft(page, '#ask-text', 'Start a new conversation');
    await page.tap('.ask .action.primary');
    await page.waitFor(`window.heldReplies.length === 1`);
    await page.tap('.session-tab');
    await replaceDraft(page, '#composer', 'Keep typing in the original');
    await page.tap('#composer');
    await page.evaluate(`window.heldReplies.shift()()`);
    fixture.sessions.start({ ...frame, utterance: 'Desktop arrival' }, signal());
    await page.waitFor(`document.querySelectorAll('.session-tab').length === 3`);
    assert.equal(await page.evaluate(`document.activeElement.id`), 'composer');
    assert.equal(
      await page.evaluate(`document.querySelector('#composer').value`),
      'Keep typing in the original',
    );
    assert.equal(await page.evaluate(`history.state.companionPanel.selected`), original);
    assert.equal(await page.evaluate(`document.querySelectorAll('.session-tab.unread').length`), 2);
    assert.deepEqual(page.errors, []);
  },
);

test(
  'Activity deletion requires confirmation and cancel preserves the entry',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const runtime = fixture.desktop.runtime;
    const observed = { ...frame, id: 42, utterance: 'Disposable deletion fixture' };
    runtime.activity.transcribed?.(observed);
    runtime.activity.intentRecognized?.(observed.id, 'IGNORE');
    runtime.activity.outcome?.(observed.id, 'ignored');
    runtime.activity.finished?.(observed.id);
    const page = await pairedPhone(fixture, browser);
    await page.waitFor(`document.querySelector('.history-card')`);
    await page.tap('[aria-label="Delete utterance, screenshot and audio"]');
    await page.waitFor(`document.querySelector('.confirm-delete')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.history-card').length`), 1);
    assert.match(await text(page, '.sheet'), /cannot be undone/);
    await page.tap('.sheet-body .action:not(.danger)');
    await page.waitFor(
      `!document.querySelector('.sheet') && !document.querySelector('#app').inert`,
    );
    assert.equal(await page.evaluate(`document.querySelectorAll('.history-card').length`), 1);
    await page.tap('[aria-label="Delete utterance, screenshot and audio"]');
    await page.tap('.confirm-delete');
    await page.waitFor(
      `!document.querySelector('.history-card') && !document.querySelector('.sheet')`,
    );
    assert.equal(await page.evaluate(`document.querySelector('#app').inert`), false);
    assert.deepEqual(page.errors, []);
  },
);

test(
  'browser Back, modal focus and screenshot Escape retain the selected page',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Navigation fixture' }, signal());
    const page = await pairedPhone(fixture, browser);
    await page.tap('.session-tab');
    await page.waitFor(`document.activeElement.matches('[data-page-heading]')`);
    await page.evaluate(`history.back()`);
    await page.waitFor(`document.querySelector('#ask-text')`);
    assert.equal(
      await page.evaluate(`document.activeElement.matches('[data-page-heading]')`),
      true,
    );
    await page.evaluate(`history.forward()`);
    await page.waitFor(`document.querySelector('#composer')`);

    await page.tap('button[aria-label="Phone settings"]');
    await page.waitFor(`document.querySelector('.sheet')?.contains(document.activeElement)`);
    assert.equal(await page.evaluate(`document.querySelector('#app').inert`), true);
    for (let count = 0; count < 12; count++) {
      await page.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      assert.equal(
        await page.evaluate(`document.querySelector('.sheet').contains(document.activeElement)`),
        true,
      );
    }
    await page.evaluate(`history.back()`);
    await page.waitFor(`!document.querySelector('.sheet')`);
    assert.equal(
      await page.evaluate(`document.activeElement.getAttribute('aria-label')`),
      'Phone settings',
    );
    assert.equal(await page.evaluate(`document.querySelector('#app').inert`), false);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('#composer'))`), true);

    await page.waitFor(`document.querySelector('.screenshot-thumb img')`);
    await page.tap('.screenshot-thumb');
    await page.waitFor(`document.querySelector('.viewer')?.contains(document.activeElement)`);
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await page.waitFor(`!document.querySelector('.viewer')`);
    assert.equal(await page.evaluate(`document.activeElement.className`), 'screenshot-thumb');
    assert.equal(await page.evaluate(`document.querySelector('#app').inert`), false);
    assert.deepEqual(page.errors, []);
  },
);

test(
  'Claude conversations use the Claude catalogue and keep their creation-time effort',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context, {
      claudeBackend: async (_request, _signal, emit) => {
        emit(chatMessage('claude-answer', 'assistant', 'Synthetic Claude response'));
      },
    });
    const id = fixture.sessions.start(
      { ...frame, utterance: 'Claude UI fixture' },
      signal(),
      'coding',
      'claude-code',
    );
    await waitFor(() => fixture.sessions.snapshot()[0]?.status === 'completed');
    const page = await pairedPhone(fixture, browser);
    await page.tap('.session-tab');
    await page.tap('.model-disclosure > summary');
    await page.waitFor(`document.querySelector('.model-picker select.model:not([disabled])')`);
    assert.equal(
      await page.evaluate(`document.querySelectorAll('.model-picker select').length`),
      1,
    );
    assert.match(await text(page, '.model-picker'), /Effort · high · fixed/);
    assert.equal(
      await page.evaluate(
        `Boolean(document.querySelector('[aria-label="Refresh available Pi models"]'))`,
      ),
      false,
    );
    const listed = await page.evaluate<string[]>(
      `[...document.querySelectorAll('.model-picker option')].map(option => option.value)`,
    );
    assert.ok(listed.includes('claude-sonnet-5'));
    assert.ok(listed.every((model) => model.startsWith('claude-')));
    await page.evaluate(`(() => {
    const picker = document.querySelector('.model-picker select.model');
    picker.value = 'claude-sonnet-5';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
    await waitFor(
      () =>
        fixture.sessions.snapshot().find((session) => session.id === id)?.claudeCode?.model ===
        'claude-sonnet-5',
    );
    assert.equal(fixture.sessions.snapshot()[0].claudeCode?.effort, 'high');
    assert.deepEqual(page.errors, []);
  },
);

test(
  'rail actions reorder, close and reopen while closed drafts are pruned',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const first = fixture.sessions.start({ ...frame, utterance: 'First rail fixture' }, signal());
    const second = fixture.sessions.start({ ...frame, utterance: 'Second rail fixture' }, signal());
    await waitFor(() => fixture.runs.length === 2);
    const page = await pairedPhone(fixture, browser);
    await page.tap('.session-tab');
    await replaceDraft(page, '#composer', 'Remove this draft on close');
    await page.evaluate(
      `document.querySelector('.session-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`,
    );
    await page.waitFor(`document.querySelector('.sheet')`);
    // A target measured at the beginning of the opening animation must still
    // hit Move down at its end. A sliding sheet previously hit Close instead.
    const targetMotion = await page.evaluate<number>(`(() => {
      const sheet = document.querySelector('.sheet');
      const target = document.querySelector('.menu-list button:nth-child(2)');
      const animation = sheet.getAnimations()[0];
      if (!animation) {
        throw Error('Expected the menu opening animation');
      }
      animation.pause();
      animation.currentTime = 0;
      const first = target.getBoundingClientRect();
      animation.currentTime = animation.effect.getTiming().duration;
      const last = target.getBoundingClientRect();
      animation.finish();
      return Math.max(Math.abs(first.x - last.x), Math.abs(first.y - last.y));
    })()`);
    assert.ok(targetMotion <= 0.5, `menu target moved ${targetMotion}px while opening`);
    await page.tap('.menu-list button:nth-child(2)');
    await waitFor(() => fixture.sessions.order().ids[0] === second);
    await page.waitFor(
      `!document.querySelector('.sheet') && history.state.companionPanel.modals.length === 0`,
    );
    await page.evaluate(
      `document.querySelector('.session-tab:nth-child(2)').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`,
    );
    await page.waitFor(`document.querySelector('.sheet')`);
    await page.tap('.menu-list .danger');
    await waitFor(() => !fixture.sessions.has(first));
    await page.waitFor(`document.querySelector('#ask-text')`);
    await page.waitFor(
      `!document.querySelector('.modal-layer') && !document.querySelector('#app').inert && history.state.companionPanel.modals.length === 0`,
    );
    assert.equal(
      await page.evaluate(
        `JSON.parse(localStorage.getItem('companion.remote.drafts') || '{}')[${JSON.stringify(first)}]`,
      ),
      undefined,
    );
    await page.tap('.rail-previous');
    await page.waitFor(`document.querySelector('.previous-row')`);
    await page.tap('.previous-row button');
    await page.waitFor(`document.querySelector('#composer')`);
    assert.equal(await page.evaluate(`document.querySelector('#composer').value`), '');
    assert.equal(fixture.sessions.has(first), true);
    assert.deepEqual(page.errors, []);
  },
);

test(
  'a short viewport keeps the transcript, composer and model controls reachable',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Short viewport fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    for (const [width, height] of [
      [320, 568],
      [390, 560],
      [360, 640],
      [390, 400],
    ]) {
      const page = await pairedPhone(fixture, browser, width, height);
      await page.tap('.session-tab');
      await page.waitFor(`document.querySelector('.message-area')`);
      assert.ok(
        (await page.evaluate<number>(
          `document.querySelector('.message-area').getBoundingClientRect().height`,
        )) >= (height > 540 ? 200 : 140),
        `transcript too small at ${width}×${height}`,
      );
      await page.tap('#composer');
      await page.type('A short-viewport follow-up');
      await page.tap('.send');
      await page.waitFor(`document.querySelector('#composer').value === ''`);
      await page.tap('.model-disclosure > summary');
      await page.tap('[aria-label="Refresh available Pi models"]');
      const visible = await page.evaluate<boolean>(`(() => {
    const rect = document.querySelector('[aria-label="Refresh available Pi models"]').getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })()`);
      assert.ok(visible);
      assert.ok((await horizontalOverflow(page)) <= 0);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  },
);
