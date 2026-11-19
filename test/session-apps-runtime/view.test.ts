/**
 * The application view in a real headless Chromium, through the same
 * capability URL and restricted host document a native view or pop-out loads.
 * The authored app runs in its sandboxed iframe and uses api.state,
 * api.query and api.call. The model is a test script (fixture.ts).
 * Requires Chromium and bwrap.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Chromium, type BrowserPage } from '../../src/widgets/chromium.ts';
import { frame, signal } from '../helpers.ts';
import { applicationFixture, eventually } from './fixture.ts';

/** Evaluate inside the current application iframe (an out-of-process target). */
async function inApp(browser: Chromium, expression: string): Promise<unknown> {
  const targets = (await browser.call('Target.getTargets')).targetInfos as {
    type: string;
    targetId: string;
  }[];
  const target = targets.find((entry) => entry.type === 'iframe');
  if (!target) {
    return undefined;
  }
  const attached = await browser.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const session = String(attached.sessionId);
  try {
    const reply = await browser.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session,
    );
    return (reply.result as { value?: unknown }).value;
  } finally {
    await browser.call('Target.detachFromTarget', { sessionId: session }).catch(() => {});
  }
}

async function waitInApp(browser: Chromium, expression: string, expected: unknown): Promise<void> {
  let value: unknown;
  for (let attempt = 0; attempt < 200; attempt++) {
    value = await inApp(browser, expression).catch(() => undefined);
    if (JSON.stringify(value) === JSON.stringify(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${expression} was ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
}

async function open(browser: Chromium, url: string): Promise<BrowserPage> {
  const page = await browser.page(
    (candidate) => candidate === url || candidate.startsWith(url + '/'),
  );
  await page.call('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 480,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.call('Page.navigate', { url });
  return page;
}

test('the authored view reads, subscribes, queries and acts; agent edits appear; replaced code reloads in place', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  const browser = new Chromium();
  context.after(() => browser.close());

  const id = sessions.start(frame, signal());
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'task-list',
      expectedVersion: 0,
      eventMode: 'next-input',
      initialState: {
        title: 'Release',
        tasks: [
          { id: 'a', text: 'Write notes', column: 'todo' },
          { id: 'b', text: 'Run tests', column: 'doing' },
        ],
      },
    });
  });
  await sessions.idle();
  const viewUrl = fixture.view(id).application!.viewUrl!;

  await open(browser, viewUrl);
  await waitInApp(browser, 'document.querySelectorAll("li").length', 2);
  await waitInApp(browser, 'document.querySelector("h1").textContent', 'Release');
  // The counter comes from api.query('summary'), triggered by api.state.subscribe.
  await waitInApp(browser, 'document.querySelector(".counter").textContent', '0 of 2 done');

  // A user click runs move_task through api.call → host → service.
  await inApp(browser, 'document.querySelector("li input[type=checkbox]").click()');
  await eventually(() => fixture.view(id).application!.revision === 2);
  await waitInApp(browser, 'document.querySelector(".counter").textContent', '1 of 2 done');
  assert.equal(fixture.view(id).application!.eventStatus!.undelivered, 1);

  // An agent edit while the view is open appears through the subscription.
  fixture.script(id, async (turn) => {
    // The person's message carried the pending view edit.
    assert.match(turn.text, /\[Companion application event\]/);
    await turn.tool('companion_app_call', { action: 'add_task', args: { text: 'Ship it' } });
    await turn.tool('companion_app_apply', { bundle: 'task-board', expectedVersion: 1 });
  });
  sessions.followUp(id, 'Add a ship task and switch to a board', signal());
  await sessions.idle();

  // The open view reloads itself with the new code; same URL, same tasks.
  await waitInApp(browser, 'document.querySelectorAll(".lane").length', 3);
  await waitInApp(
    browser,
    '[...document.querySelectorAll(".lane")].map((lane) => lane.querySelectorAll("li").length)',
    [1, 1, 1],
  );
  assert.equal(fixture.view(id).application!.viewUrl, viewUrl);

  // The board's own controls use its new action set (move right).
  await inApp(
    browser,
    'document.querySelector(".lane[data-column=todo] li button[aria-label=\\"Move to Doing\\"]").click()',
  );
  await waitInApp(
    browser,
    '[...document.querySelectorAll(".lane")].map((lane) => lane.querySelectorAll("li").length)',
    [0, 2, 1],
  );
  const state = await (await fetch(viewUrl + '/state')).json();
  assert.equal(state.version, 2);
  assert.equal(state.data.tasks.length, 3);
});

test('values the host cannot accept never leave the authored view’s request table busy', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  const browser = new Chromium();
  context.after(() => browser.close());
  await fixture.bundle(
    'request-probe',
    {
      version: 1,
      description: 'Exposes its api to the test',
      application: {},
      parameters: { type: 'object', properties: { count: { type: 'integer' } } },
      actions: {
        bump: {
          description: 'Add one',
          parameters: { type: 'object' },
          returns: { type: 'object' },
        },
      },
      queries: {},
      example: { count: 0 },
    },
    `export function describe(s){ return "count " + s.count; }
     export const actions = { bump(s){ s.count++; return { state: s }; } };
     export const queries = {};
     export function mount(root, api){ window.probeApi = api; return { update(){} }; }`,
  );
  const id = sessions.start(frame, signal());
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'request-probe', expectedVersion: 0 });
  });
  await sessions.idle();
  const viewUrl = fixture.view(id).application!.viewUrl!;
  await open(browser, viewUrl);
  await waitInApp(browser, 'typeof window.probeApi', 'object');

  // Nine cyclic (cloneable, non-JSON) calls and one uncloneable call.
  const outcome = await inApp(
    browser,
    `(async () => {
      const cyclic = {}; cyclic.self = cyclic;
      const refused = [];
      for (let index = 0; index < 9; index++) {
        refused.push(await window.probeApi.call('bump', cyclic).then(() => 'ok', (error) => error.message));
      }
      refused.push(await window.probeApi.call('bump', { f() {} }).then(() => 'ok', () => 'uncloneable'));
      const valid = await window.probeApi.call('bump', {});
      const read = await window.probeApi.state.read();
      return { refused, revision: valid.revision, count: read.data.count };
    })()`,
  );
  const result = outcome as { refused: string[]; revision: number; count: number };
  assert.equal(result.refused.length, 10);
  assert.ok(result.refused.slice(0, 9).every((message) => /Invalid widget action/.test(message)));
  assert.equal(result.refused[9], 'uncloneable');
  assert.equal(result.revision, 2);
  assert.equal(result.count, 1);
});
