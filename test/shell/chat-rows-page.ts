import { build } from 'esbuild';
import { join } from 'node:path';

import type { ChatRow } from '../../integrations/session-apps/chat/protocol.ts';
import { TestBrowser } from '../mobile/browser.ts';

/**
 * Draws the shared chat page (integrations/session-apps/chat/Chat.tsx) with a
 * fixed set of rows in headless Chromium and returns the HTML of its
 * transcript rows, or of its composer, for chat-heading.test.ts.
 *
 * The page is bundled from any checkout's chat directory (`chatDirectory`,
 * an absolute path), so the same rows can be drawn by the current Chat.tsx
 * and by an earlier one: the reference (fixtures/chat-rows-reference.txt)
 * was drawn with the base revision's Chat.tsx before `ChatRow.time` existed,
 * with
 *
 *   tsx test/shell/chat-rows-page.ts <base checkout>/integrations/session-apps/chat \
 *     > test/shell/fixtures/chat-rows-reference.txt
 *
 * and the composer's (fixtures/chat-composer-reference.txt) with the base
 * revision's Chat.tsx before `ChatStatus.classicView` existed, with
 *
 *   tsx test/shell/chat-rows-page.ts --composer <base checkout>/integrations/session-apps/chat \
 *     > test/shell/fixtures/chat-composer-reference.txt
 *
 * A stand-in host sends one full rows message and one status message, as
 * the Qt host and the browser bridge do after `ready()`; every other
 * request is ignored. Nothing is loaded from the network.
 */

const repository = join(import.meta.dirname, '..', '..');

/** Every kind of row and heading the page draws, without `time`. */
export const referenceRows: ChatRow[] = [
  row('u1', 'user', 'A plain question'),
  row('u2', 'user', 'A queued follow-up', { state: 'queued' }),
  row('u3', 'user', 'A message that was not sent', { state: 'error' }),
  row('u4', 'user', 'With a screenshot', { screenshot: true, screenshotAvailable: true }),
  row('u5', 'user', 'Screenshot unavailable', { screenshot: true }),
  row('u6', 'user', 'Screenshot not saved', { screenshot: true, screenshotNotSaved: true }),
  row('u7', 'user', 'Part of a long message', { fragmentLabel: ' · text 1–200 of 900' }),
  row('u8', 'user', 'From another conversation', {
    origin: { kind: 'agent', title: 'Route planner', sessionId: 's2', groupId: 'g1' },
  }),
  row('u9', 'user', 'From an external agent', {
    origin: { kind: 'external', title: 'Script', sessionId: '', groupId: '' },
  }),
  row('u10', 'user', 'From an application', {
    origin: {
      kind: 'application-message',
      title: 'planner · v2',
      receiptId: '0123456789abcdef',
      sessionId: '',
      groupId: '',
    },
  }),
  row('u11', 'user', 'Edits in the app', {
    origin: { kind: 'application-event', title: '', sessionId: '', groupId: '' },
  }),
  row('u12', 'user', 'A scheduled wake', {
    origin: { kind: 'scheduled-wake', title: 'Morning check', sessionId: '', groupId: '' },
  }),
  row('a1', 'assistant', 'An **answer** with `code`.'),
  row('a2', 'assistant', 'Still streaming', { state: 'running' }),
  row('a3', 'assistant', 'A failed answer', { state: 'error' }),
  row('a4', 'assistant', 'A fragment', { fragmentLabel: ' · text 201–400 of 900' }),
  row('a5', 'assistant', '', { state: 'running' }),
  row('n1', 'notice', 'A timer notice'),
  row('n2', 'notice', 'A failure notice', { state: 'error' }),
  row('w1', 'assistant', 'A widget row', { widget: { name: 'Planner' } }),
  row('t1', 'tool', '', { toolCount: 3, state: 'done' }),
  row('t2', 'tool', '', { toolName: 'bash', state: 'running' }),
  row('t3', 'tool', '', { toolCount: 1, state: 'error' }),
  row('t4', 'tool', '', { toolCount: 2, toolUnavailable: true }),
];

function row(key: string, kind: string, text: string, overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    key,
    id: key,
    kind,
    text,
    state: 'done',
    toolName: '',
    toolCount: 0,
    toolUnavailable: false,
    screenshot: false,
    screenshotAvailable: false,
    screenshotNotSaved: false,
    fragmentLabel: '',
    origin: null,
    widget: null,
    ...overrides,
  };
}

/** The page script: the chat page over a stand-in host that sends `rows`. */
async function pageScript(chatDirectory: string): Promise<string> {
  const entry = `
    import { render } from 'preact';
    import { Chat } from ${JSON.stringify(join(chatDirectory, 'Chat.tsx'))};
    import { ChatStore } from ${JSON.stringify(join(chatDirectory, 'store.ts'))};

    const rows = window.__chatRows;
    const listeners = [];
    const host = {
      message: { connect: (callback) => listeners.push(callback) },
      ready() {
        const status = {
          sessionId: 'session',
          title: 'Reference',
          sessionStatus: 'completed',
          online: true,
          running: false,
          canSend: true,
          maximumMessageLength: 4000,
          editLimit: 8000,
          draft: { text: '', cursor: 0, revision: 1, source: '', notice: '' },
          history: { hasOlder: false, pending: false, error: '', canRetry: false,
            changed: false, detached: false, atLatest: true },
          // A drawing of the composer may vary the status (drawComposers).
          ...window.__chatStatus,
        };
        const messages = [
          { type: 'rows', seq: 1, sessionId: 'session', full: true,
            order: rows.map((row) => row.key), changed: rows },
          { type: 'status', seq: 2, status },
        ];
        setTimeout(() => {
          for (const message of messages) {
            for (const listener of listeners) {
              listener(JSON.stringify(message));
            }
          }
        }, 0);
      },
    };
    // Every other request of the page is answered with nothing.
    const bridge = new Proxy(host, {
      get: (target, name) => (name in target ? target[name] : () => {}),
    });
    const store = new ChatStore();
    store.attach(bridge);
    render(<Chat store={store} />, document.getElementById('chat'));
  `;
  const result = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: repository },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    // A checkout without its own node_modules (an earlier revision's
    // worktree) uses this repository's.
    nodePaths: [join(repository, 'node_modules')],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/**
 * The transcript rows' HTML as the page draws `rows`, one row element per
 * line, with `chatDirectory`'s Chat.tsx.
 */
export async function drawRows(
  browser: TestBrowser,
  chatDirectory: string,
  rows: ChatRow[],
): Promise<string> {
  return (await drawRowsWithTimes(browser, chatDirectory, rows)).html;
}

/**
 * Where each drawn row's message time is, in the DOM: `heading` when it is
 * the last element of the row's own heading (the `.heading` directly in the
 * row's `.panel`), `elsewhere` when there is one anywhere else (or more
 * than one), `none` without one.
 */
export type TimePlace = 'heading' | 'elsewhere' | 'none';

/** `drawRows`, and the place of each row's message time. */
export async function drawRowsWithTimes(
  browser: TestBrowser,
  chatDirectory: string,
  rows: ChatRow[],
): Promise<{ html: string; times: TimePlace[] }> {
  const script = await pageScript(chatDirectory);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    browser.call(method, params, String(sessionId));
  const evaluate = async (expression: string): Promise<unknown> => {
    const reply = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) {
      throw Error(`Evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 400)}`);
    }
    return reply.result.value;
  };

  try {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 2400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(`document.body.innerHTML = '<div id="chat"></div>';
      window.__chatRows = ${JSON.stringify(rows)};`);
    await evaluate(script);
    const drawn = (await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const place = (row) => {
        const times = row.querySelectorAll('.message-time');
        if (times.length === 0) {
          return 'none';
        }
        const heading = row.querySelector(':scope > .panel > .heading');
        if (times.length === 1 && heading && heading.lastElementChild === times[0]) {
          return 'heading';
        }
        return 'elsewhere';
      };
      const check = () => {
        const rows = document.querySelectorAll('.rows > .message');
        if (rows.length === window.__chatRows.length || Date.now() - started > 5000) {
          resolve({
            html: [...rows].map((element) => element.outerHTML).join('\\n'),
            times: [...rows].map(place),
          });
          return;
        }
        setTimeout(check, 20);
      };
      check();
    })`)) as { html: string; times: TimePlace[] };
    return { html: drawn.html + '\n', times: drawn.times };
  } finally {
    await browser.call('Target.closeTarget', { targetId });
  }
}

/**
 * Statuses whose composers (the editor and its action row) are drawn for
 * the reference of the optional `classicView` status field: each is merged
 * over the default status above, and none carries `classicView`.
 */
export const referenceComposerStatuses: Record<string, unknown>[] = [
  {},
  { running: true, sessionStatus: 'running' },
  { running: true, sessionStatus: 'running', stopRunId: 'run-1' },
  { online: false },
  { application: { name: 'Planner', version: 2 } },
  {
    recording: {
      available: true,
      here: false,
      state: 'idle',
      canRecord: true,
      busy: false,
      stopPending: false,
      canStop: false,
    },
  },
  { inputError: 'A notice below the editor.' },
];

/**
 * The composer's HTML (`.composer`, the editor with its action row) as the
 * page draws it for each status, one composer per line, with
 * `chatDirectory`'s Chat.tsx. The transcript has the reference rows.
 */
export async function drawComposers(
  browser: TestBrowser,
  chatDirectory: string,
  statuses: Record<string, unknown>[],
): Promise<string> {
  const script = await pageScript(chatDirectory);
  const drawn: string[] = [];
  for (const status of statuses) {
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const evaluate = async (expression: string): Promise<unknown> => {
      const reply = await browser.call(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        String(sessionId),
      );
      if (reply.exceptionDetails) {
        throw Error(`Evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 400)}`);
      }
      return reply.result.value;
    };

    try {
      await evaluate(`document.body.innerHTML = '<div id="chat"></div>';
        window.__chatRows = ${JSON.stringify(referenceRows)};
        window.__chatStatus = ${JSON.stringify(status)};`);
      await evaluate(script);
      // The composer is drawn once the status has arrived.
      const html = await evaluate(`new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
          const composer = document.querySelector('.composer');
          if ((composer && document.querySelector('.actions')) || Date.now() - started > 5000) {
            resolve(composer?.outerHTML ?? '');
            return;
          }
          setTimeout(check, 20);
        };
        check();
      })`);
      drawn.push(String(html).replaceAll('\n', '\\n'));
    } finally {
      await browser.call('Target.closeTarget', { targetId });
    }
  }
  return drawn.join('\n') + '\n';
}

// Writes a reference for the chat directory given on the command line: the
// rows (the default) or, with `--composer`, the composers.
if (process.argv[1] === import.meta.filename) {
  const composer = process.argv.includes('--composer');
  const chatDirectory = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  if (!chatDirectory) {
    console.error('Usage: tsx test/shell/chat-rows-page.ts [--composer] <chat directory>');
    process.exit(2);
  }
  const browser = new TestBrowser();
  await browser.start();
  try {
    if (composer) {
      process.stdout.write(await drawComposers(browser, chatDirectory, referenceComposerStatuses));
    } else {
      process.stdout.write(await drawRows(browser, chatDirectory, referenceRows));
    }
  } finally {
    await browser.close();
  }
}
