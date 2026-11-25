import assert from 'node:assert/strict';
import test from 'node:test';

import { frame, signal } from '../helpers.ts';
import type { TestPage } from '../mobile/browser.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import { TestBrowser } from '../mobile/browser.ts';
import {
  appDirectory,
  click,
  horizontalOverflow,
  openConversation,
  pairedPage,
  skip,
} from './page.ts';

/**
 * The closed model picker's text in headless Chromium (integrations/shell/
 * README.md, "Model picker", rule 9): the part of the name that tells the
 * models apart, in full at 1280 and 1600 px, shortened at 420 px but never
 * to a prefix alone; the full name in the button's title. The rule's table
 * of names runs in Node (model-choice.test.ts).
 */

/** The listener's models: two share the ending `qwen3-coder-30b`. */
const models = [
  'openai-codex/gpt-5.1-codex-max',
  'local/qwen3-coder-30b',
  'cloud/qwen3-coder-30b',
  'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

async function resize(page: TestPage, width: number): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`document.documentElement.clientWidth === ${width}`);
}

/** The closed button's parts as drawn: text and visible width of each. */
const drawnName = `(() => {
  const button = document.querySelector('.model-button');
  const part = (selector) => {
    const element = button.querySelector(selector);
    if (!element) return null;
    return {
      text: element.textContent,
      width: element.getBoundingClientRect().width,
      cut: element.scrollWidth > element.clientWidth,
    };
  };
  return { title: button.title, lead: part('.model-lead'), distinct: part('.model-distinct') };
})()`;

interface Drawn {
  title: string;
  lead: { text: string; width: number; cut: boolean } | null;
  distinct: { text: string; width: number; cut: boolean };
}

test(
  'the closed model picker names the distinct part: whole at 1280 and 1600 px, never a prefix alone at 420 px',
  { skip },
  async (context) => {
    const fixture = await remoteFixture({
      appDirectory,
      models: async () => ({ models, pinned: models, thinkingLevels: {} }),
    });
    const browser = new TestBrowser();
    await browser.start();
    context.after(async () => {
      await browser.close();
      await fixture.close();
    });

    // A conversation with a long title, so the bar is crowded.
    const title = 'A conversation whose title is long enough to crowd the bar above the chat';
    const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
    await waitFor(() => fixture.runs.length === 1);
    await fixture.sessions.setModel(id, 'openai-codex/gpt-5.1-codex-max', signal());
    const { page } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'A conversation whose title');
    await page.waitFor(
      `document.querySelector('.model-button .model-distinct')?.textContent === 'gpt-5.1-codex-max'`,
    );

    for (const width of [1600, 1280]) {
      await resize(page, width);
      const drawn = await page.evaluate<Drawn>(drawnName);
      assert.equal(drawn.lead, null, `${width} px`);
      assert.equal(drawn.distinct.text, 'gpt-5.1-codex-max', `${width} px`);
      assert.equal(drawn.distinct.cut, false, `${width} px: shown in full`);
      assert.match(drawn.title, /openai-codex\/gpt-5\.1-codex-max/);
      assert.equal(await horizontalOverflow(page), 0, `${width} px`);
    }

    await resize(page, 420);
    const narrow = await page.evaluate<Drawn>(drawnName);
    assert.equal(narrow.distinct.text, 'gpt-5.1-codex-max');
    assert.ok(narrow.distinct.width >= 40, `420 px: ${JSON.stringify(narrow)}`);
    assert.equal(await horizontalOverflow(page), 0, '420 px');

    // A model whose last part another model shares: once the catalogue is
    // read (the picker opened), the provider is kept, shortened first.
    await resize(page, 1280);
    await fixture.sessions.setModel(id, 'local/qwen3-coder-30b', signal());
    await page.waitFor(
      `document.querySelector('.model-button').title.includes('local/qwen3-coder-30b')`,
    );
    await click(page, '.model-button');
    await page.waitFor(`document.querySelectorAll('#model-picker option').length === 5`);
    await click(page, '.model-button');
    await page.waitFor(`!document.querySelector('#model-picker')`);
    await page.waitFor(
      `document.querySelector('.model-button .model-lead')?.textContent === 'local/'`,
    );
    for (const width of [1600, 1280]) {
      await resize(page, width);
      const drawn = await page.evaluate<Drawn>(drawnName);
      assert.equal(drawn.lead?.cut, false, `${width} px: the lead whole`);
      assert.equal(drawn.distinct.text, 'qwen3-coder-30b');
      assert.equal(drawn.distinct.cut, false, `${width} px: shown in full`);
    }
    await resize(page, 420);
    const shared = await page.evaluate<Drawn>(drawnName);
    // The lead gives up its room before the distinct part does.
    assert.ok(shared.distinct.width >= 40, `420 px: ${JSON.stringify(shared)}`);
    if (shared.distinct.cut) {
      assert.ok(shared.lead === null || shared.lead.width < 1, JSON.stringify(shared));
    }
    assert.equal(await horizontalOverflow(page), 0, '420 px');

    // A very long name: still whole at 1280 and 1600 px.
    await fixture.sessions.setModel(
      id,
      'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
      signal(),
    );
    for (const width of [1600, 1280]) {
      await resize(page, width);
      await page.waitFor(
        `document.querySelector('.model-button .model-distinct')?.textContent === 'global.anthropic.claude-haiku-4-5-20251001-v1:0'`,
      );
      const drawn = await page.evaluate<Drawn>(drawnName);
      assert.equal(drawn.distinct.cut, false, `${width} px: shown in full`);
      assert.equal(await horizontalOverflow(page), 0, `${width} px`);
    }
  },
);
