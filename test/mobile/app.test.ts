import assert from 'node:assert/strict';
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseChoices } from '../../src/agents/choices.ts';
import { chatMessage } from '../../src/agents/types.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { artifactPath } from '../../src/desktop/artifacts.ts';
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

test(
  'sixteen phone tabs stay reachable and a refused seventeenth keeps its draft',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context, {
      backend: async (_request, _signal, emit) => {
        emit({ ...chatMessage('answer', 'assistant', 'Completed fixture'), state: 'done' });
      },
    });
    for (let number = 1; number <= 16; number++) {
      const id = fixture.sessions.start({ ...frame, utterance: `Fixture ${number}` }, signal());
      await waitFor(() => fixture.sessions.interaction(id).agentAcceptsFollowUp);
    }

    for (const width of [320, 390]) {
      const page = await pairedPhone(fixture, browser, width, 568);
      await page.waitFor(`document.querySelectorAll('.session-tab').length === 16`);
      await page.tap('.session-tab:nth-child(16)');
      await page.waitFor(`document.querySelector('.session-tab:nth-child(16)[aria-current=page]')`);
      await page.waitFor(
        `document.querySelector('.message.user')?.textContent.includes('Fixture 16')`,
      );
      assert.ok((await horizontalOverflow(page)) <= 0, `sixteenth tab overflow at ${width}px`);

      await page.tap('.rail-activity');
      await page.tap('#ask-text');
      await page.type('Keep this seventeenth question');
      await page.tap('.ask .action.primary');
      await page.waitFor(
        `document.querySelector('.ask .input-error')?.textContent.includes('16 tabs maximum')`,
      );
      assert.equal(
        await page.evaluate(`document.querySelector('#ask-text').value`),
        'Keep this seventeenth question',
      );
      assert.equal(fixture.sessions.snapshot().length, 16);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  },
);

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
  // Labeling needs a saved capture: admit it like live input and save its PNG.
  runtime.activity.transcribed?.({ ...observed, storage: runtime.activity.admitCapture?.() });
  await runtime.activity.screenshotCaptured?.(observed.id, observed.screenshot);
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
  'with capture storage off the phone shows Not saved, disables labeling and cannot label',
  { skip },
  async (context) => {
    const captureStorage = new CaptureStoragePolicy();
    const { fixture, browser } = await setup(context, { captureStorage });
    const activity = fixture.desktop.runtime.activity;
    const observed = { ...frame, id: 42, utterance: 'Synthetic utterance while off' };
    activity.transcribed?.({ ...observed, storage: activity.admitCapture?.() });
    await activity.screenshotCaptured?.(observed.id, observed.screenshot);
    activity.intentRecognized?.(observed.id, 'IGNORE');
    activity.outcome?.(observed.id, 'ignored');
    activity.finished?.(observed.id);

    const page = await pairedPhone(fixture, browser);
    await page.tap('.rail-activity');
    await page.waitFor(`document.querySelector('.history-card .not-saved')`);
    assert.match(await text(page, '.history-card .not-saved'), /Not saved/);
    assert.match(await text(page, '.labeling-unavailable'), /Labeling requires capture storage/);
    for (const selector of ['.chip.label-correct', '.chip:not(.label-correct)']) {
      assert.equal(
        await page.evaluate(`document.querySelector('.history-card ${selector}').disabled`),
        true,
      );
    }
    // A screenshot-dependent session is not offered without the screenshot.
    assert.equal(
      await page.evaluate(
        `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
      ),
      true,
    );
    // Nothing was saved and no label exists for this row.
    const row = fixture.desktop.database
      .prepare(
        "SELECT id, capture_storage FROM utterances WHERE transcript = 'Synthetic utterance while off'",
      )
      .get()!;
    assert.equal(row.capture_storage, 'off');
    assert.equal(
      fixture.desktop.database.prepare('SELECT COUNT(*) AS count FROM intent_feedback').get()!
        .count,
      0,
    );
  },
);

test(
  'the phone shows partly saved entries and unsaved conversation screenshots honestly',
  { skip },
  async (context) => {
    const captureStorage = CaptureStoragePolicy.enabledForTesting();
    const { fixture, browser } = await setup(context, { captureStorage });
    const activity = fixture.desktop.runtime.activity;

    // Its WAV was published before an Off; its PNG was refused after it.
    activity.transcribed?.({
      ...frame,
      id: 43,
      utterance: 'Synthetic partly saved',
      input: 'speech',
      storage: activity.admitCapture?.(),
    });
    await activity.audioCaptured?.(43, new Float32Array(160).fill(0.1));
    await captureStorage.setEnabled(false);
    await activity.screenshotCaptured?.(43, frame.screenshot);
    activity.intentRecognized?.(43, 'IGNORE');
    activity.outcome?.(43, 'ignored');
    activity.finished?.(43);

    // A conversation started while off: the agent gets the image, no copy kept.
    fixture.sessions.start({ ...frame, utterance: 'Unsaved screen question' }, signal());

    await captureStorage.setEnabled(true);
    const page = await pairedPhone(fixture, browser);
    await page.tap('.rail-activity');
    await page.waitFor(`document.querySelector('.history-card .original-unavailable')`);
    assert.match(
      await text(page, '.history-card .original-unavailable'),
      /The original screenshot for this entry was not saved/,
    );
    assert.match(await text(page, '.labeling-unavailable'), /complete saved capture/);
    assert.equal(
      await page.evaluate(`document.querySelector('.history-card .chip.label-correct').disabled`),
      true,
    );
    assert.equal(
      await page.evaluate(
        `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
      ),
      true,
    );

    await page.tap('.session-tab');
    await page.waitFor(`document.querySelector('.screenshot-not-saved')`);
    assert.match(await text(page, '.screenshot-not-saved'), /Screenshot not saved/);
    assert.equal(await page.evaluate(`document.querySelector('.screenshot-thumb')`), null);
    assert.deepEqual(page.errors, []);
  },
);

for (const loss of ['missing screenshot', 'corrupt audio'] as const) {
  test(
    `the phone updates a saved Activity entry after later ${loss}`,
    { skip },
    async (context) => {
      const { fixture, browser } = await setup(context);
      const activity = fixture.desktop.runtime.activity;
      activity.transcribed?.({ ...frame, input: 'speech', storage: activity.admitCapture?.() });
      await activity.audioCaptured?.(frame.id, new Float32Array(160).fill(0.1));
      await activity.screenshotCaptured?.(frame.id, frame.screenshot);
      activity.intentRecognized?.(frame.id, 'IGNORE');
      activity.outcome?.(frame.id, 'ignored');
      activity.finished?.(frame.id);
      const entry = fixture.desktop.database
        .prepare('SELECT id, observed_at FROM utterances')
        .get() as { id: string; observed_at: number };

      const page = await pairedPhone(fixture, browser);
      await page.tap('.rail-activity');
      await page.waitFor(
        `document.querySelector('.history-card .chip.label-correct:not([disabled])')`,
      );
      const path = artifactPath(
        fixture.desktop.directory,
        entry.id,
        entry.observed_at,
        loss === 'missing screenshot' ? 'screenshots' : 'audio',
      );
      if (loss === 'missing screenshot') {
        await rm(path);
      } else {
        await writeFile(path, Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'));
      }
      // The stale phone action reaches the real backend refusal. Its ordered
      // availability event corrects the visible card without a manual reload.
      await page.tap('.history-card .chip.label-correct');
      await page.waitFor(`document.querySelector('.history-card .original-unavailable')`);
      await page.waitFor(`document.querySelector('.history-card .chip.label-correct').disabled`);
      assert.match(await text(page, '.history-card .original-unavailable'), /unavailable/);
      const screenshotMissing = loss === 'missing screenshot';
      assert.equal(
        await page.evaluate(
          `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
        ),
        screenshotMissing,
      );
      assert.equal(
        fixture.desktop.database.prepare('SELECT COUNT(*) AS n FROM intent_feedback').get()!.n,
        0,
      );

      // Reconnect hydrates current eligibility rather than the saved flags.
      await page.navigate(`${fixture.origin}/`);
      await page.waitFor(`document.querySelector('.shell')`);
      if (!(await page.evaluate(`Boolean(document.querySelector('.rail'))`))) {
        await page.tap('button[aria-label="Show sessions"]');
      }
      await page.waitFor(`document.querySelector('.rail-activity')`);
      await page.tap('.rail-activity');
      await page.waitFor(`document.querySelector('.history-card .original-unavailable')`);
      assert.equal(
        await page.evaluate(`document.querySelector('.history-card .chip.label-correct').disabled`),
        true,
      );
      assert.equal(
        await page.evaluate(
          `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
        ),
        screenshotMissing,
      );
      assert.deepEqual(page.errors, []);
    },
  );
}

test(
  'Activity explains audio-only and recovered records without offering an empty question',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const activity = fixture.desktop.runtime.activity;
    activity.transcribed?.({ ...frame, id: 91, utterance: '', source: 'audio-only' });
    activity.outcome?.(91, 'error');
    activity.finished?.(91);
    const page = await pairedPhone(fixture, browser);
    await page.waitFor(`document.querySelector('.transcript-source')`);
    assert.match(await text(page, '.transcript-source'), /Audio only.*nothing was sent/);
    assert.equal(
      await page.evaluate(
        `document.querySelector('.history-card .actions button:nth-child(1)').disabled`,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
      ),
      true,
    );

    activity.transcribed?.({
      ...frame,
      id: 92,
      utterance: 'Earlier supplied words',
      source: 'earlier-attempt',
      // Admitted while storage is on, with its screenshot saved, so a coding
      // session can start from it.
      storage: activity.admitCapture?.(),
    });
    await activity.screenshotCaptured?.(92, frame.screenshot);
    activity.outcome?.(92, 'error');
    activity.finished?.(92);
    await page.waitFor(`document.querySelectorAll('.history-card').length === 2`);
    assert.match(await text(page, '.history-card:first-child .transcript-source'), /earlier part/);
    assert.equal(
      await page.evaluate(
        `document.querySelector('.history-card .actions button:nth-child(2)').disabled`,
      ),
      false,
    );
    assert.deepEqual(page.errors, []);
  },
);

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
  'conversation fills browser viewport space below the short-screen breakpoint',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    fixture.sessions.start({ ...frame, utterance: 'Composer spacing fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    fixture.runs[0].finish();
    const page = await pairedPhone(fixture, browser);
    await page.tap('.session-tab');
    await page.waitFor(`document.querySelector('#composer')`);
    await page.tap('#composer');
    await page.type('Keep this draft through viewport changes');

    // Safari's toolbars can put a tall phone below the 700px CSS breakpoint.
    // Resize the same page to cover toolbar/rotation and keyboard-sized layouts,
    // including restoration after shrinking. This is not native iOS keyboard emulation.
    for (const [width, height, bottomInset] of [
      [390, 664, 0],
      [390, 700, 0],
      [390, 701, 0],
      [320, 568, 0],
      [390, 664, 34],
      [390, 400, 0],
      [844, 390, 21],
      [390, 844, 34],
      [390, 664, 0],
    ]) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await page.call('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: bottomInset } });
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`);

      const metrics = await page.evaluate<{
        blank: number;
        bottomInset: number;
        draft: string;
      }>(`(() => {
        const page = document.querySelector('.conversation-page');
        const footer = document.querySelector('.model-disclosure');
        page.scrollTop = 0;
        return {
          blank: page.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom,
          bottomInset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')),
          draft: document.querySelector('#composer').value,
        };
      })()`);
      assert.ok(metrics.blank <= 0.5, `unused space at ${width}×${height}: ${metrics.blank}px`);
      assert.equal(metrics.bottomInset, bottomInset);
      assert.equal(metrics.draft, 'Keep this draft through viewport changes');

      // The collapsed footer must stay above the home indicator too, not just
      // the picker inside the expanded details. Include its padding when scrolling.
      await page.evaluate(
        `document.querySelector('.model-disclosure').scrollIntoView({ block: 'end' })`,
      );
      const summaryBottom = await page.evaluate<number>(
        `document.querySelector('.model-disclosure > summary').getBoundingClientRect().bottom`,
      );
      assert.ok(
        summaryBottom <= height - bottomInset + 0.5,
        `collapsed footer overlaps the ${bottomInset}px inset at ${width}×${height}`,
      );

      // On a keyboard-sized viewport, scrolling must still reach the footer.
      // Enlarging again must not leave stale root/page scroll or a blank tail.
      await page.tap('.model-disclosure > summary');
      await page.tap('[aria-label="Refresh available Pi models"]');
      const visible = await page.evaluate<boolean>(`(() => {
        const rect = document.querySelector('[aria-label="Refresh available Pi models"]').getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'));
        return rect.top >= 0 && rect.bottom <= innerHeight - inset;
      })()`);
      assert.ok(visible, `model controls unreachable at ${width}×${height}`);
      const footerPadding = await page.evaluate<number>(`(() => {
        const footer = document.querySelector('.model-disclosure');
        const picker = document.querySelector('.model-picker');
        return parseFloat(getComputedStyle(footer).paddingBottom) +
          parseFloat(getComputedStyle(picker).paddingBottom);
      })()`);
      assert.equal(footerPadding, bottomInset + 10, 'apply the inset once plus picker spacing');
      await page.tap('.model-disclosure > summary');
      assert.ok((await horizontalOverflow(page)) <= 0);
    }
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
