import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chromiumPath, TestBrowser } from '../mobile/browser.ts';
import { drawComposers, referenceStatuses } from './chat-composer-page.ts';

/**
 * The shared chat page's one change for listener drafts (`draft.clearable`,
 * integrations/shell/README.md, "Changes to the shared chat page"):
 *
 * - without the field the page draws exactly what it drew before the change:
 *   every composer state the draft fields affect (typed text, an agent's
 *   note with and without a notice, unsaved text, running, recording,
 *   offline), drawn by the current Chat.tsx, equals
 *   fixtures/chat-composer-reference.txt, drawn by the base revision's
 *   Chat.tsx (see chat-composer-page.ts). The Qt host never sends the
 *   field, so its output is unchanged;
 * - with it, the agent's note ends with one Clear link wherever the note is
 *   shown and the editor accepts input, and nothing else changes; never
 *   while the editor holds input the host does not have (Clear would
 *   release its only copy).
 */

const chatDirectory = join(import.meta.dirname, '..', '..', 'integrations', 'session-apps', 'chat');
const referencePath = join(import.meta.dirname, 'fixtures', 'chat-composer-reference.txt');

let skip: string | undefined;
try {
  await access(chromiumPath);
} catch {
  skip = 'Chromium not installed';
}

const clearLink = '<button class="link">Clear</button>';

test(
  'the chat page draws the text box area exactly as before without draft.clearable',
  { skip },
  async (context) => {
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    const reference = await readFile(referencePath, 'utf8');
    assert.equal(await drawComposers(browser, chatDirectory, referenceStatuses), reference);

    // `clearable: false` is no Clear link.
    const notClearable = referenceStatuses.map(({ name, status }) => ({
      name,
      status: { ...status, draft: { ...status.draft!, clearable: false } },
    }));
    assert.equal(await drawComposers(browser, chatDirectory, notClearable), reference);
  },
);

test(
  "with draft.clearable the agent's note ends with Clear and nothing else changes",
  { skip },
  async (context) => {
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    const reference = await readFile(referencePath, 'utf8');
    const clearable = referenceStatuses.map(({ name, status }) => ({
      name,
      status: { ...status, draft: { ...status.draft!, clearable: true } },
    }));
    const drawn = await drawComposers(browser, chatDirectory, clearable);

    assert.equal(drawn.split(clearLink).join(''), reference);

    // Where it appears: inside the note, as its last element, for every
    // agent draft whose editor accepts input (not while words are recorded).
    const blocks = drawn.split(/^## /m).filter(Boolean);
    assert.equal(blocks.length, referenceStatuses.length);
    for (let index = 0; index < blocks.length; index++) {
      const { name, status } = referenceStatuses[index];
      const expected = status.draft!.source !== '' && status.recording?.busy !== true;
      const block = blocks[index];
      if (!expected) {
        assert.equal(block.includes(clearLink), false, `${name}: no Clear`);
        continue;
      }
      assert.ok(
        block.includes(`— review before sending${clearLink}</div>`),
        `${name}: Clear ends the note: ${block.slice(0, 400)}`,
      );
      assert.equal(block.split(clearLink).length, 2, `${name}: one Clear`);
    }
  },
);

test(
  'with draft.clearable no Clear while the editor holds input only it has',
  { skip },
  async (context) => {
    const browser = new TestBrowser();
    await browser.start();
    context.after(() => browser.close());

    const agentDrafts = referenceStatuses
      .filter(({ status }) => status.draft!.source !== '')
      .map(({ name, status }) => ({
        name,
        status: { ...status, draft: { ...status.draft!, clearable: true } },
      }));
    const drawn = await drawComposers(browser, chatDirectory, agentDrafts, 'x'.repeat(40));
    assert.equal(drawn.includes(clearLink), false);
    assert.ok(drawn.includes('Drafted by agent · Planner — review before sending</div>'));
  },
);
