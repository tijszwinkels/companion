import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage, type AgentMessage } from '../../src/agents/types.ts';
import { notAdmitted } from '../../src/capture-storage/policy.ts';
import { syntheticWindowPng } from '../../integrations/shell/synthetic-window.ts';
import { frame, signal } from '../helpers.ts';
import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import {
  appDirectory,
  assertNoViolations,
  assertOwnOrigin,
  buttonExpression,
  click,
  clickAt,
  clickButton,
  horizontalOverflow,
  openConversation,
  pairedPage,
  requestActions,
  skip,
  text,
  type Fixture,
} from './page.ts';

/**
 * The browser shell's tool details, screenshot viewer and model picker in
 * headless Chromium, against the real gateway, the real listener control
 * socket and a synthetic agent backend, in temporary directories on
 * loopback only (integrations/shell/README.md: "Tool details",
 * "Screenshots", "Model picker"). The rules' full tables run in Node
 * (tool-details.test.ts, screenshot-viewer.test.ts, model-choice.test.ts);
 * these show the same rules end to end, plus the cases only a page has:
 * the three ways to close the viewer, focus, the image request's address,
 * a refusal shown, the settings screen, and the layout at 420 and 1600 px.
 *
 * Set COMPANION_SHELL_SCREENSHOTS to a directory to also save screenshots
 * (an open tool group, the screenshot viewer, the model picker open, at 420
 * and 1280 px).
 */

/** A synthetic window, kept as the conversation's screenshot. */
const windowFrame = {
  ...frame,
  screenshot: {
    ...frame.screenshot!,
    png: syntheticWindowPng(640, 400),
    width: 640,
    height: 400,
  },
};

async function setup(
  context: { after(callback: () => Promise<void>): void },
  options: Parameters<typeof remoteFixture>[0] = {},
) {
  const fixture = await remoteFixture({ appDirectory, ...options });
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser };
}

/** Saves a screenshot when COMPANION_SHELL_SCREENSHOTS names a directory. */
async function screenshot(page: TestPage, name: string): Promise<void> {
  const directory = process.env.COMPANION_SHELL_SCREENSHOTS;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.png`), await page.screenshot());
}

/** One tool call, emitted as the agent runs it and when it is done. */
function tool(id: string, name: string, input: string, output: string): AgentMessage {
  return { ...chatMessage(id, 'tool', output), toolName: name, input: input, state: 'done' };
}

/** The open tool group's status line. */
function toolStatus(page: TestPage): Promise<string> {
  return text(page, '.message.tool .tool-status');
}

/** Press a key with its code (Escape, Tab, Enter …) where the focus is. */
async function press(page: TestPage, key: string, code: number, shift = false): Promise<void> {
  const event = {
    key,
    code: key,
    windowsVirtualKeyCode: code,
    modifiers: shift ? 8 : 0,
  };
  await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  // Enter activates a button through its character, as a real key does.
  if (key === 'Enter') {
    await page.call('Input.dispatchKeyEvent', { type: 'char', ...event, text: '\r' });
  }
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

/** Start a conversation whose first turn made tool calls and is still running. */
async function toolConversation(fixture: Fixture): Promise<string> {
  const id = fixture.sessions.start(
    { ...frame, utterance: 'Tool fixture: fix the list test' },
    signal(),
  );
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  run.emit(tool('t1', 'read', '{"path":"src/list.ts"}', 'export const first = (x) => x[0];\n'));
  // Long enough for three pages of 8,192 characters.
  const log: string[] = [];
  for (let line = 1; line <= 700; line++) {
    log.push(`ok ${line} - synthetic check ${line}`);
  }
  run.emit(tool('t2', 'bash', '{"command":"npm test"}', log.join('\n') + '\n'));
  return id;
}

test(
  'a tool group opens in place, shows its calls page by page and closes again',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    await toolConversation(fixture);
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Tool fixture');

    // Closed: the heading only, nothing asked.
    await page.waitFor(`document.querySelector('.message.tool .tool-heading')`);
    await page.waitFor(
      `document.querySelector('.message.tool .tool-heading').textContent.includes('2 tool calls')`,
    );
    assert.equal(
      await page.evaluate(
        `document.querySelector('.message.tool .tool-heading').getAttribute('aria-expanded')`,
      ),
      'false',
    );
    assert.equal(requestActions(sockets).includes('agent-tool-page'), false);

    // Open: the first call with its name, input and output.
    await click(page, '.message.tool .tool-heading');
    await page.waitFor(`document.querySelector('.message.tool .tool-page')`);
    const first = await text(page, '.message.tool .tool-page');
    assert.match(first, /^read\n\n\{"path":"src\/list.ts"\}\n\nexport const first/);
    assert.match(await toolStatus(page), /^Tool 1 of 2 · characters 1–/);

    // The next call, then its next page, then back to the start.
    await clickButton(page, 'Next page');
    await page.waitFor(
      `document.querySelector('.message.tool .tool-status').textContent.startsWith('Tool 2 of 2 · characters 1–8192')`,
    );
    assert.match(await text(page, '.message.tool .tool-page'), /^bash\n\n\{"command":"npm test"\}/);
    await clickButton(page, 'Next page');
    await page.waitFor(
      `document.querySelector('.message.tool .tool-status').textContent.startsWith('Tool 2 of 2 · characters 8193–16384')`,
    );
    await clickButton(page, 'From start');
    await page.waitFor(
      `document.querySelector('.message.tool .tool-status').textContent.startsWith('Tool 1 of 2')`,
    );

    // More calls arrive while the turn runs: the page stays, newer output is offered.
    fixture.runs[0].emit(tool('t3', 'read', '{"path":"test/list.ts"}', 'it("works")\n'));
    await page.waitFor(
      `document.querySelector('.message.tool .tool-heading').textContent.includes('3 tool calls')`,
    );
    await page.waitFor(
      `document.querySelector('.message.tool .tool-status').textContent.startsWith('New tool output is available')`,
    );
    assert.match(first, /export const first/);
    await clickButton(page, 'Refresh page');
    await page.waitFor(
      `document.querySelector('.message.tool .tool-status').textContent.startsWith('Tool 1 of 3')`,
    );

    // Closed again: the details are gone.
    await click(page, '.message.tool .tool-heading');
    await page.waitFor(`!document.querySelector('.message.tool .tool-details')`);

    for (const action of requestActions(sockets)) {
      assert.ok(
        ['panel-state', 'activity-history', 'agent-tool-page'].includes(action),
        `unexpected request ${action}`,
      );
    }
    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'a kept screenshot opens over the page and closes by its button, Escape and a click outside',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);

    // The real policy is served unchanged: images only from this origin and blob:.
    const response = await fetch(`${fixture.origin}/`);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /img-src 'self' blob:/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

    const id = fixture.sessions.start(
      { ...windowFrame, utterance: 'Screenshot fixture: what is on screen?' },
      signal(),
    );
    // One without a kept screenshot (capture storage off when it was sent).
    fixture.sessions.start(
      {
        ...windowFrame,
        utterance: 'Unsaved fixture',
        storage: notAdmitted,
      },
      signal(),
    );
    await waitFor(() => fixture.runs.length === 2);
    await waitFor(() =>
      Boolean(
        fixture.sessions
          .snapshot()
          .find((session) => session.id === id)
          ?.messages.some((message) => typeof message.screenshotUrl === 'string'),
      ),
    );
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    const startUrl = await page.evaluate<string>(`location.href`);

    // Not kept: the existing text, no control.
    await openConversation(page, 'Unsaved fixture');
    await page.waitFor(`document.querySelector('.message.user .heading')`);
    assert.match(await text(page, '.message.user .heading'), /screenshot not saved/);
    assert.equal(await page.evaluate(`Boolean(${buttonExpression('View screenshot')})`), false);

    // Kept: the desktop's control.
    await openConversation(page, 'Screenshot fixture');
    await page.waitFor(`${buttonExpression('View screenshot')}`);
    assert.match(await text(page, '.message.user .heading'), /screenshot attached/);

    const opened = async () => {
      await clickButton(page, 'View screenshot');
      await page.waitFor(`document.querySelector('.screenshot-viewer img')?.complete`);
      await page.waitFor(`document.querySelector('.screenshot-viewer img').naturalWidth === 640`);
      // Scaled to fit inside the window.
      const box = await page.evaluate<{ width: number; height: number }>(`(() => {
        const rect = document.querySelector('.screenshot-viewer img').getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })()`);
      assert.ok(box.width <= 1280 && box.height <= 800, JSON.stringify(box));
      assert.equal(await page.evaluate(`document.querySelector('#app').inert`), true);
    };
    const closedWithFocusBack = async () => {
      await page.waitFor(`!document.querySelector('.screenshot-viewer')`);
      await page.waitFor(`document.activeElement?.textContent === 'View screenshot'`);
      assert.equal(await page.evaluate(`document.querySelector('#app').inert`), false);
    };

    // 1. The close button.
    await opened();
    const imageSource = await page.evaluate<string>(
      `document.querySelector('.screenshot-viewer img').src`,
    );
    assert.match(imageSource, /^blob:/);
    // Once shown, the image's address already leads nowhere: it cannot be
    // opened in another tab or kept beyond the viewer.
    assert.equal(
      await page.evaluate(`new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve('loaded');
        probe.onerror = () => resolve('gone');
        probe.src = ${JSON.stringify(imageSource)};
      })`),
      'gone',
    );
    // The image shown is still drawn.
    assert.equal(
      await page.evaluate(`document.querySelector('.screenshot-viewer img').naturalWidth`),
      640,
    );
    await screenshot(page, 'viewer-1280');
    await clickButton(page, '×');
    await closedWithFocusBack();

    // 2. Escape.
    await opened();
    await press(page, 'Escape', 27);
    await closedWithFocusBack();

    // 3. A click outside the image.
    await opened();
    await clickAt(page, { x: 20, y: 700 });
    await closedWithFocusBack();

    // The image was asked for by its bare route only, never with a token or
    // anything else in its address, and the page's own address is unchanged.
    const imageRequests = page.requests.filter((url) => url.includes('/api/screenshots/'));
    assert.equal(imageRequests.length, 3);
    for (const url of imageRequests) {
      assert.equal(url, `${fixture.origin}/api/screenshots/${id}`);
    }
    assert.equal(await page.evaluate<string>(`location.href`), startUrl);
    const stored = await page.evaluate<string>(
      `JSON.stringify(Object.keys(localStorage)) + JSON.stringify(Object.keys(sessionStorage))`,
    );
    assert.doesNotMatch(stored, /screenshot/i);

    // Removed since the message was drawn: the viewer says so, and the row
    // then has today's text without the control.
    const { rm } = await import('node:fs/promises');
    await rm(join(fixture.directory, '.companion-sessions', `${id}.png`));
    await clickButton(page, 'View screenshot');
    await page.waitFor(
      `document.querySelector('.screenshot-viewer [role=alert]')?.textContent.includes('no longer has')`,
    );
    await press(page, 'Escape', 27);
    await page.waitFor(`!document.querySelector('.screenshot-viewer')`);
    await page.waitFor(`!${buttonExpression('View screenshot')}`);
    assert.match(await text(page, '.message.user .heading'), /screenshot unavailable/);
    // Its opener is gone: focus goes to the page heading, not nowhere.
    await page.waitFor(`document.activeElement?.classList.contains('chat-bar-title')`);

    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'the model picker lists the listener’s models, a change reaches it, a change elsewhere shows',
  { skip },
  async (context) => {
    // Only the first catalogue read (the picker's list) has the ghost
    // model; the listener's later reads (its check of each choice) do not,
    // so choosing it is refused. The fourth read waits until released, so
    // the picker can be closed while that choice is on its way.
    let catalogueReads = 0;
    let releaseFourth = () => {};
    const fourth = new Promise<void>((resolve) => {
      releaseFourth = resolve;
    });
    const { fixture, browser } = await setup(context, {
      models: async () => {
        catalogueReads++;
        const models = ['local/qwen-synthetic', 'cloud/synthetic-large'];
        if (catalogueReads === 1) {
          models.push('ghost/model');
        }
        if (catalogueReads === 4) {
          await fourth;
        }
        return {
          models,
          pinned: ['local/qwen-synthetic'],
          thinkingLevels: {},
        };
      },
    });
    const id = fixture.sessions.start({ ...frame, utterance: 'Model fixture' }, signal());
    await waitFor(() => fixture.runs.length === 1);
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Model fixture');

    // In the bar, next to the conversation's state; nothing asked yet.
    await page.waitFor(`document.querySelector('.chat-bar-heading .model-button')`);
    assert.equal(requestActions(sockets).includes('agent-models'), false);

    // Opened by keyboard: focus the button, Enter.
    await page.evaluate(`document.querySelector('.model-button').focus()`);
    await press(page, 'Enter', 13);
    await page.waitFor(
      `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
    );
    await page.waitFor(`document.querySelectorAll('#model-picker option').length === 2`);
    assert.match(await text(page, '#model-picker'), /This session · next turn model/);
    await clickButton(page, 'Show all models');
    await page.waitFor(`document.querySelectorAll('#model-picker option').length === 4`);
    await screenshot(page, 'model-picker-1280');

    // A turn is running: the change is for the next turn, and accepted.
    // Chosen with the list focused, as by keyboard: it keeps the focus
    // while the change is on its way.
    const choose = (model: string) =>
      page.evaluate(`(() => {
        const select = document.querySelector('#model-picker select');
        select.focus();
        select.value = ${JSON.stringify(model)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    await choose('cloud/synthetic-large');
    await waitFor(
      () =>
        fixture.sessions.snapshot().find((session) => session.id === id)?.modelOverride ===
        'cloud/synthetic-large',
    );
    await page.waitFor(
      `document.querySelector('.model-button .model-name').textContent === 'cloud/synthetic-large'`,
    );

    // Refused by the listener: its words, and the conversation's model stays.
    await page.waitFor(
      `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
    );
    await choose('ghost/model');
    await page.waitFor(`document.querySelector('#model-picker [role=alert]')`);
    assert.match(await text(page, '#model-picker [role=alert]'), /available configured Pi model/);
    assert.equal(
      await page.evaluate(`document.querySelector('#model-picker select').value`),
      'cloud/synthetic-large',
    );

    // The list kept the focus through the change and its refusal.
    assert.equal(await page.evaluate(`document.activeElement.id`), 'model-select');
    // Escape closes it; focus returns to the button.
    await press(page, 'Escape', 27);
    await page.waitFor(`!document.querySelector('#model-picker')`);
    assert.equal(await page.evaluate(`document.activeElement.className`), 'model-button');

    // Closed while a choice is on its way: its refusal is still told (a toast).
    await press(page, 'Enter', 13);
    await page.waitFor(
      `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
    );
    await choose('ghost/model');
    await waitFor(() => catalogueReads === 4);
    await press(page, 'Escape', 27);
    await page.waitFor(`!document.querySelector('#model-picker')`);
    releaseFourth();
    await page.waitFor(
      `[...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('available configured Pi model'))`,
    );

    // Keyboard focus leaving the open picker (Tab past its last control) closes it.
    await press(page, 'Enter', 13);
    await page.waitFor(
      `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
    );
    await page.evaluate(
      `document.querySelector('[aria-label="Refresh available Pi models"]').focus()`,
    );
    await press(page, 'Tab', 9);
    await page.waitFor(`!document.querySelector('#model-picker')`);

    // Changed elsewhere (another client): shown here.
    await fixture.sessions.setModel(id, 'local/qwen-synthetic', signal());
    await page.waitFor(
      `document.querySelector('.model-button .model-name').textContent === 'local/qwen-synthetic'`,
    );

    // The settings screen open: its bar has no picker; back, it is there.
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.chat-bar-title').textContent === 'Settings'`);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.model-button'))`), false);
    await click(page, '.settings-toggle');
    await page.waitFor(`document.querySelector('.model-button')`);

    // No conversation shown (Previous sessions): no picker.
    await click(page, '.previous-entry');
    await page.waitFor(
      `document.querySelector('.chat-bar-title').textContent === 'Previous sessions'`,
    );
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.model-button'))`), false);

    for (const action of requestActions(sockets)) {
      assert.ok(
        ['panel-state', 'activity-history', 'agent-models', 'set-agent-model'].includes(action),
        `unexpected request ${action}`,
      );
    }
    assertOwnOrigin(fixture, page, sockets);
    await assertNoViolations(page);
  },
);

test(
  'a Claude Code conversation lists the Claude models and keeps its effort',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context, {
      claudeBackend: async (_request, _signal, emit) => {
        emit(chatMessage('claude-answer', 'assistant', 'Synthetic Claude response'));
      },
    });
    const id = fixture.sessions.start(
      { ...frame, utterance: 'Claude fixture' },
      signal(),
      'coding',
      'claude-code',
    );
    await waitFor(() => fixture.sessions.snapshot()[0]?.status === 'completed');
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Claude fixture');
    await click(page, '.model-button');
    await page.waitFor(
      `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
    );
    assert.match(await text(page, '#model-picker'), /next turn Claude model/);
    assert.match(await text(page, '#model-picker'), /Effort · high · fixed/);
    const listed = await page.evaluate<string[]>(
      `[...document.querySelectorAll('#model-picker option')].map((option) => option.value)`,
    );
    assert.ok(listed.includes('claude-sonnet-5'), JSON.stringify(listed));
    assert.ok(
      listed.every((model) => model.startsWith('claude-')),
      JSON.stringify(listed),
    );
    await page.evaluate(`(() => {
      const select = document.querySelector('#model-picker select');
      select.value = 'claude-sonnet-5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(
      () =>
        fixture.sessions.snapshot().find((session) => session.id === id)?.claudeCode?.model ===
        'claude-sonnet-5',
    );
    await page.waitFor(
      `document.querySelector('.model-button .model-name').textContent === 'claude-sonnet-5'`,
    );
    assert.equal(fixture.sessions.snapshot()[0].claudeCode?.effort, 'high');
    await assertNoViolations(page);
  },
);

for (const width of [420, 1280, 1600]) {
  test(
    `at ${width} px an open tool group, the model picker and the viewer fit without overflow`,
    { skip },
    async (context) => {
      const { fixture, browser } = await setup(context);
      await toolConversation(fixture);
      fixture.sessions.start({ ...windowFrame, utterance: 'Layout screenshot fixture' }, signal());
      await waitFor(() => fixture.runs.length === 2);
      const { page } = await pairedPage(fixture, browser, width, 800);

      await openConversation(page, 'Tool fixture');
      await click(page, '.message.tool .tool-heading');
      await clickButton(page, 'Next page');
      await page.waitFor(
        `document.querySelector('.message.tool .tool-status')?.textContent.startsWith('Tool 2 of 2')`,
      );
      assert.equal(await horizontalOverflow(page), 0);
      const transcriptOverflow = await page.evaluate<number>(`(() => {
        const transcript = document.querySelector('.transcript');
        return transcript.scrollWidth - transcript.clientWidth;
      })()`);
      assert.equal(transcriptOverflow, 0);
      // The group's heading and status at the top, for the screenshot.
      await page.evaluate(
        `document.querySelector('.message.tool').scrollIntoView({ block: 'start' })`,
      );
      await screenshot(page, `tool-group-${width}`);

      await click(page, '.model-button');
      await page.waitFor(
        `document.querySelector('#model-picker select:not([disabled]):not([aria-disabled="true"])')`,
      );
      assert.equal(await horizontalOverflow(page), 0);
      const panel = await page.evaluate<{ left: number; right: number }>(`(() => {
        const rect = document.querySelector('#model-picker').getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      })()`);
      assert.ok(panel.left >= 0 && panel.right <= width, JSON.stringify(panel));
      await screenshot(page, `model-picker-${width}`);
      await press(page, 'Escape', 27);
      await page.waitFor(`!document.querySelector('#model-picker')`);

      await openConversation(page, 'Layout screenshot fixture');
      await clickButton(page, 'View screenshot');
      await page.waitFor(`document.querySelector('.screenshot-viewer img')?.naturalWidth === 640`);
      assert.equal(await horizontalOverflow(page), 0);
      const image = await page.evaluate<{ left: number; right: number; bottom: number }>(`(() => {
        const rect = document.querySelector('.screenshot-viewer img').getBoundingClientRect();
        return { left: rect.left, right: rect.right, bottom: rect.bottom };
      })()`);
      assert.ok(
        image.left >= 0 && image.right <= width && image.bottom <= 800,
        JSON.stringify(image),
      );
      await screenshot(page, `viewer-${width}`);
      await assertNoViolations(page);
    },
  );
}
