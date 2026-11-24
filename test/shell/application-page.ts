/**
 * Helpers for the session application suite (session-apps.test.ts): the
 * built shell against the frame fixture (test/frame-fixture.ts: a real
 * gateway with a frame origin on a second loopback port, a real listener
 * and widget service, synthetic bundles rendered in Node), with one more
 * synthetic application:
 *
 * - `chat-probe`: a note list that asks to read and send chat. Its page has
 *   a Read button (`api.chat.read()`, the frame origin's `chat-read`) and a
 *   Send button (`api.chat.prepareSend()` and `api.chat.send()`, then
 *   `api.chat.receipt()`: `chat-send` and `chat-receipt`), each writing its
 *   outcome into the page, and a text box to type into;
 * - `broken-app`: an application whose page cannot draw its first state
 *   (its mount throws), for the failed state.
 *
 * See integrations/shell/README.md, "Session applications".
 */

import { widgetTools } from '../../src/agents/widget-tools.ts';
import { frameFixture, writeWidget } from '../frame-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import { appDirectory } from './page.ts';
import { writeShellWidgets } from './widget-page.ts';

type Json = Record<string, any>;

/** The probe application's manifest (a note list that asks for chat access). */
export const chatProbeManifest = {
  name: 'chat-probe',
  version: 1,
  description: 'A synthetic application that reads and sends chat only when allowed.',
  application: { eventMode: 'next-input', capabilities: ['chat.read', 'chat.send'] },
  parameters: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        default: [],
      },
    },
    required: ['notes'],
    additionalProperties: false,
  },
  actions: {
    add_note: {
      description: 'Add a note.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['text'],
        additionalProperties: false,
      },
      returns: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  example: { notes: [] },
};

export const chatProbeModule = `
export function describe(state) {
  return 'Probe notes: ' + state.notes.length;
}
export const actions = {
  add_note(state, args) {
    state.notes.push(args.text);
    return { state, result: {} };
  },
};
export function mount(root, api) {
  const list = document.createElement('ul');
  list.id = 'notes';
  const input = document.createElement('input');
  input.id = 'note';
  const read = document.createElement('button');
  read.id = 'read';
  read.textContent = 'Read';
  const readResult = document.createElement('p');
  readResult.id = 'read-result';
  read.onclick = () => {
    readResult.textContent = 'reading';
    api.chat.read().then(
      (snapshot) => {
        readResult.textContent = 'read: ' + snapshot.messages.map((message) => message.text).join(' | ');
      },
      (error) => {
        readResult.textContent = 'refused: ' + error.message;
      },
    );
  };
  const send = document.createElement('button');
  send.id = 'send';
  send.textContent = 'Send';
  const sendResult = document.createElement('p');
  sendResult.id = 'send-result';
  send.onclick = async () => {
    sendResult.textContent = 'sending';
    let handle;
    try {
      handle = await api.chat.prepareSend();
    } catch (error) {
      sendResult.textContent = 'refused: ' + error.message;
      return;
    }
    try {
      await api.chat.send(handle, 'A message from the probe');
      const receipt = await api.chat.receipt(handle);
      sendResult.textContent = 'sent: ' + (receipt ? receipt.state : 'no receipt');
    } catch (error) {
      sendResult.textContent = 'send failed: ' + error.message;
    }
  };
  root.append(list, input, read, readResult, send, sendResult);
  return {
    update(state) { list.textContent = state.notes.join(', '); },
    dispose() {},
  };
}
`;

/** The frame fixture serving the built shell, with the shell's widgets and the probe. */
export async function applicationSetup(
  context: { after(callback: () => Promise<void>): void },
  options: { frames?: boolean } = {},
) {
  const fixture = await frameFixture({
    appDirectory,
    frames: options.frames,
    library: async (library) => {
      await writeShellWidgets(library);
      await writeWidget(library, chatProbeManifest, chatProbeModule);
      await writeWidget(
        library,
        {
          ...chatProbeManifest,
          name: 'broken-app',
          description: 'A synthetic application that cannot draw its first state.',
        } as { name: string },
        chatProbeModule.replace(
          'export function mount(root, api) {',
          "export function mount(root, api) {\n  throw Error('Synthetic mount failure');",
        ),
      );
    },
  });
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser };
}

export type ApplicationFixture = Awaited<ReturnType<typeof applicationSetup>>['fixture'];

/** Start a conversation titled `title` and return its id and run. */
export async function conversation(
  fixture: ApplicationFixture,
  title: string,
): Promise<{ id: string; run: SyntheticRun }> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length === before + 1);
  return { id, run: fixture.runs[before] };
}

/**
 * Install (`expectedVersion` 0) or replace a conversation's application
 * through the agent's own tool, from a run's lease.
 */
export async function applyApplication(
  run: SyntheticRun,
  bundle: string,
  expectedVersion = 0,
): Promise<void> {
  const lease = run.request.widgets!;
  const apply = widgetTools(lease.endpoint, lease.token).find(
    (tool) => tool.name === 'companion_app_apply',
  )!;
  await apply.execute('apply-' + Math.random(), {
    bundle,
    expectedVersion,
    eventMode: 'next-input',
  });
}

/** The listener's own descriptor of a conversation's application. */
export function listenerApplication(fixture: ApplicationFixture, id: string): Json | undefined {
  const session = fixture.sessions.snapshot().find((candidate) => candidate.id === id);
  return session?.application as Json | undefined;
}

/** A page expression: the application's frame element, or null. */
export const applicationIframe = `document.querySelector('#application-pane iframe')`;

/** A page expression: the application's panel (its phase in `dataset.phase`). */
export const applicationPanel = `document.querySelector('#application-pane .application-frame')`;

/** The application frame's address (its `src`), or ''. */
export function applicationAddress(page: TestPage): Promise<string> {
  return page.evaluate<string>(`${applicationIframe}?.src ?? ''`);
}

/** Resize the page's viewport and wait until the page sees the new size. */
export async function setSize(page: TestPage, width: number, height: number): Promise<void> {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`);
}

/**
 * A page expression: what is drawn. `layout` is 'split', 'switch' or '' (no
 * application); `app` and `chat` whether each is shown (not concealed).
 */
export const drawn = `(() => {
  const body = document.querySelector('.conversation-body');
  let layout = '';
  if (body?.classList.contains('application-split')) layout = 'split';
  if (body?.classList.contains('application-switch')) layout = 'switch';
  const pane = document.querySelector('#application-pane');
  const chat = document.querySelector('#application-chat');
  return {
    layout,
    app: Boolean(pane) && !pane.inert,
    chat: Boolean(chat) && !chat.inert,
  };
})()`;

/**
 * The desktop shows the conversation `id` and changes one of its
 * application's permissions, as its native controls do (a second
 * connection, besides the browser's). Returns the listener's answer.
 */
export async function desktopChange(
  fixture: ApplicationFixture,
  id: string,
  permission: 'read' | 'send',
  allowed: boolean,
): Promise<Json> {
  fixture.desktop.send({ action: 'panel-state', id, composerFocused: false, visible: true });
  await fixture.desktop.reply('panel-state');
  const application = listenerApplication(fixture, id)!;
  fixture.desktop.send({
    action: `set-application-chat-${permission}`,
    id,
    applicationId: application.id,
    version: application.version,
    revision: application.chatAccess.revision,
    allowed,
  });
  return (await fixture.desktop.reply(`set-application-chat-${permission}`)) as Json;
}

/** Close every WebSocket of the gateway: the browser loses its connection and reconnects. */
export function dropConnections(fixture: ApplicationFixture): void {
  const sockets = (
    fixture.gateway as unknown as { sockets: { clients: Set<{ terminate(): void }> } }
  ).sockets;
  for (const socket of sockets.clients) {
    socket.terminate();
  }
}

/**
 * Start an application action that waits in the renderer, so the
 * application's queue (actions and permission changes share it) waits
 * behind it until the returned function lets it finish. As in
 * test/app-consent-fixture.ts.
 */
export async function holdApplicationQueue(
  fixture: ApplicationFixture,
  id: string,
): Promise<() => Promise<void>> {
  const renderer = (
    fixture.sessions as unknown as {
      widgets: { renderer: { reduce: (...args: unknown[]) => Promise<unknown> } };
    }
  ).widgets.renderer;
  const nodeReduce = renderer.reduce;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  renderer.reduce = async (...args: unknown[]) => {
    // Only the first call waits; the renderer is itself again for later ones.
    renderer.reduce = nodeReduce;
    entered();
    await released;
    return nodeReduce(...args);
  };

  const application = listenerApplication(fixture, id)!;
  const action = fetch(application.viewUrl + '/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_note',
      args: { text: 'Held' },
      version: application.version,
      requestId: 'hold-' + Math.random().toString(36).slice(2),
    }),
  });
  await enteredPromise;

  return async () => {
    release();
    await action;
  };
}
