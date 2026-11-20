import { build } from 'esbuild';
import { join } from 'node:path';

import type { ChatRow } from '../../integrations/session-apps/chat/protocol.ts';
import { TestBrowser } from '../mobile/browser.ts';

/**
 * Draws the shared chat page (integrations/session-apps/chat/Chat.tsx) with a
 * fixed set of rows in headless Chromium and returns the HTML of its
 * transcript rows, for chat-heading.test.ts.
 *
 * The page is bundled from any checkout's chat directory (`chatDirectory`),
 * so the same rows can be drawn by the current Chat.tsx and by an earlier
 * one: the reference (fixtures/chat-rows-reference.txt) was drawn with the
 * base revision's Chat.tsx before `ChatRow.time` existed, with
 *
 *   tsx test/shell/chat-rows-page.ts <base checkout>/integrations/session-apps/chat \
 *     > test/shell/fixtures/chat-rows-reference.txt
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
    const html = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const rows = document.querySelectorAll('.rows > .message');
        if (rows.length === window.__chatRows.length || Date.now() - started > 5000) {
          resolve([...rows].map((element) => element.outerHTML).join('\\n'));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    })`);
    return String(html) + '\n';
  } finally {
    await browser.call('Target.closeTarget', { targetId });
  }
}

// Writes the reference for the chat directory given on the command line.
if (process.argv[1] === import.meta.filename) {
  const chatDirectory = process.argv[2];
  if (!chatDirectory) {
    console.error('Usage: tsx test/shell/chat-rows-page.ts <chat directory>');
    process.exit(2);
  }
  const browser = new TestBrowser();
  await browser.start();
  try {
    process.stdout.write(await drawRows(browser, chatDirectory, referenceRows));
  } finally {
    await browser.close();
  }
}
