import { build } from 'esbuild';
import { join } from 'node:path';

import type { ChatStatus } from '../../integrations/session-apps/chat/protocol.ts';
import { TestBrowser } from '../mobile/browser.ts';

/**
 * Draws the shared chat page's text box area (the composer of
 * integrations/session-apps/chat/Chat.tsx) for a fixed set of statuses in
 * headless Chromium and returns its HTML, for chat-composer.test.ts.
 *
 * The page is bundled from any checkout's chat directory (`chatDirectory`),
 * so the same statuses can be drawn by the current Chat.tsx and by an
 * earlier one: the reference (fixtures/chat-composer-reference.txt) was
 * drawn with the base revision's Chat.tsx before `draft.clearable` existed,
 * with
 *
 *   tsx test/shell/chat-composer-page.ts <base checkout>/integrations/session-apps/chat \
 *     > test/shell/fixtures/chat-composer-reference.txt
 *
 * A stand-in host sends one empty rows message and the status, as the Qt
 * host and the browser bridge do after `ready()`; every other request is
 * ignored. Nothing is loaded from the network.
 */

const repository = join(import.meta.dirname, '..', '..');

/** A status with the fields every drawn case shares. */
function status(
  name: string,
  overrides: Partial<ChatStatus>,
): { name: string; status: ChatStatus } {
  return {
    name,
    status: {
      sessionId: 'session',
      title: 'Reference',
      sessionStatus: 'completed',
      online: true,
      running: false,
      canSend: true,
      maximumMessageLength: 4000,
      editLimit: 8000,
      draft: { text: '', cursor: 0, revision: 1, source: '', notice: '' },
      draftUnsaved: '',
      inputError: '',
      history: {
        hasOlder: false,
        pending: false,
        error: '',
        canRetry: false,
        changed: false,
        detached: false,
        atLatest: true,
      },
      ...overrides,
    },
  };
}

/** Every composer state the draft fields affect, without `clearable`. */
export const referenceStatuses: { name: string; status: ChatStatus }[] = [
  status('empty', {}),
  status('typed text', {
    draft: { text: 'Half a question', cursor: 15, revision: 2, source: '', notice: '' },
  }),
  status('agent draft', {
    draft: { text: 'Proposed text', cursor: 13, revision: 3, source: 'Planner', notice: '' },
  }),
  status('external agent draft', {
    draft: {
      text: 'From outside',
      cursor: 12,
      revision: 3,
      source: 'external (unverified) · Script',
      notice: '',
    },
  }),
  status('agent draft with a notice', {
    draft: {
      text: 'Proposed text',
      cursor: 13,
      revision: 3,
      source: 'Planner',
      notice: 'Recorded words were added.',
    },
  }),
  status('unsaved text', {
    draft: { text: 'Not saved yet', cursor: 13, revision: 4, source: '', notice: '' },
    draftUnsaved: 'Companion is not connected; your text is not saved yet.',
  }),
  status('unsaved agent draft', {
    draft: { text: 'Proposed text', cursor: 13, revision: 4, source: 'Planner', notice: '' },
    draftUnsaved: 'Your text is not saved: refused',
  }),
  status('running with a stop', {
    running: true,
    stopRunId: 'run-1',
    draft: { text: 'Follow-up', cursor: 9, revision: 5, source: 'Planner', notice: '' },
  }),
  status('recording', {
    recording: {
      available: true,
      here: true,
      state: 'recording',
      canRecord: false,
      busy: true,
      stopPending: false,
      canStop: true,
    },
    draft: { text: 'Words', cursor: 5, revision: 6, source: 'Planner', notice: '' },
  }),
  status('offline', {
    online: false,
    canSend: false,
    draft: { text: 'Offline text', cursor: 12, revision: 7, source: 'Planner', notice: '' },
  }),
];

/** The page script: the chat page over a stand-in host that sends `window.__chatStatus`. */
async function pageScript(chatDirectory: string): Promise<string> {
  const entry = `
    import { render } from 'preact';
    import { Chat } from ${JSON.stringify(join(chatDirectory, 'Chat.tsx'))};
    import { ChatStore } from ${JSON.stringify(join(chatDirectory, 'store.ts'))};

    const status = window.__chatStatus;
    const listeners = [];
    const host = {
      message: { connect: (callback) => listeners.push(callback) },
      ready() {
        const messages = [
          { type: 'rows', seq: 1, sessionId: 'session', full: true, order: [], changed: [] },
          { type: 'status', seq: 2, status },
        ];
        setTimeout(() => {
          for (const message of messages) {
            for (const listener of listeners) {
              listener(JSON.stringify(message));
            }
          }
          window.__statusSent = true;
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
 * The composer's HTML for each status, drawn by `chatDirectory`'s Chat.tsx:
 * one block per status, headed by its name.
 */
export async function drawComposers(
  browser: TestBrowser,
  chatDirectory: string,
  statuses: { name: string; status: ChatStatus }[],
): Promise<string> {
  const script = await pageScript(chatDirectory);
  let output = '';
  for (const { name, status } of statuses) {
    output += `## ${name}\n${await drawComposer(browser, script, status)}\n`;
  }
  return output;
}

async function drawComposer(browser: TestBrowser, script: string, status: ChatStatus) {
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
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(`document.body.innerHTML = '<div id="chat"></div>';
      window.__chatStatus = ${JSON.stringify(status)};`);
    await evaluate(script);
    // Drawn once the status arrived and the page rendered it (the editor
    // shows the draft's text).
    return (await evaluate(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const composer = document.querySelector('.composer');
        const area = composer && composer.querySelector('textarea');
        if (window.__statusSent && area && area.value === window.__chatStatus.draft.text) {
          requestAnimationFrame(() => resolve(composer.outerHTML));
          return;
        }
        if (Date.now() - started > 5000) {
          reject(Error('The composer was not drawn'));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    })`)) as string;
  } finally {
    await browser.call('Target.closeTarget', { targetId });
  }
}

// Writes the reference for the chat directory given on the command line.
if (process.argv[1] === import.meta.filename) {
  const chatDirectory = process.argv[2];
  if (!chatDirectory) {
    console.error('Usage: tsx test/shell/chat-composer-page.ts <chat directory>');
    process.exit(2);
  }
  const browser = new TestBrowser();
  await browser.start();
  try {
    process.stdout.write(await drawComposers(browser, chatDirectory, referenceStatuses));
  } finally {
    await browser.close();
  }
}
