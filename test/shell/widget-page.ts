/**
 * Helpers for the inline widget suites (inline-widgets.test.ts,
 * widget-host.test.ts): the built shell against the frame fixture
 * (test/frame-fixture.ts: a real gateway with a frame origin on a second
 * loopback port, a real widget service and synthetic widgets rendered in
 * Node), and evaluation inside a page's frames through the DevTools
 * protocol.
 *
 * The frame origin is another port of 127.0.0.1, so it is the same site as
 * the gateway: Chromium keeps its frames in the page's own process and
 * target, and they are reached through the page's frame tree.
 */

import { frameFixture } from '../frame-fixture.ts';
import { writeWidget } from '../frame-fixture.ts';
import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { appDirectory } from './page.ts';

type Json = Record<string, any>;

/**
 * More synthetic widgets for the shell's tests:
 * - `probe`: a block as tall as its `height` prop (its reported content
 *   height is that plus the frame's 24 px padding), showing whether widget
 *   code can see `RTCPeerConnection` and reach a fresh child window;
 * - `broken`: its mount throws, so its first state is never drawn.
 */
export async function writeShellWidgets(library: string): Promise<void> {
  await writeWidget(
    library,
    {
      name: 'probe',
      version: 1,
      description: 'A synthetic block of a given height for frame tests.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: 100, default: 'Probe' },
          height: { type: 'integer', minimum: 0, maximum: 5000, default: 50 },
        },
        required: [],
        additionalProperties: false,
      },
      actions: {},
      example: { label: 'Probe', height: 50 },
    } as { name: string },
    `
export function describe(props) {
  return props.label + ' (' + props.height + ' px)';
}
export function mount(root) {
  const block = document.createElement('div');
  block.id = 'probe';
  root.append(block);
  return {
    update(props) {
      block.style.height = props.height + 'px';
      let child = 'unreachable';
      try {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        child = typeof frame.contentWindow.RTCPeerConnection;
      } catch (error) {
        child = 'blocked ' + error.name;
      }
      block.dataset.webrtc = typeof window.RTCPeerConnection + ' ' + typeof window.webkitRTCPeerConnection + ' child ' + child;
      block.textContent = props.label;
    },
    dispose() {},
  };
}
`,
  );

  await writeWidget(
    library,
    {
      name: 'broken',
      version: 1,
      description: 'A synthetic widget that cannot draw its first state.',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string', maxLength: 100, default: 'Broken' } },
        required: [],
        additionalProperties: false,
      },
      actions: {},
      example: { label: 'Broken' },
    } as { name: string },
    `
export function describe(props) {
  return props.label;
}
export function mount() {
  throw Error('Synthetic mount failure');
}
`,
  );
}

/** The frame fixture serving the built shell, with the shell's test widgets. */
export async function shellFrameFixture(options: { frames?: boolean } = {}) {
  return frameFixture({ appDirectory, library: writeShellWidgets, frames: options.frames });
}

export type ShellFrameFixture = Awaited<ReturnType<typeof shellFrameFixture>>;

export async function frameSetup(
  context: { after(callback: () => Promise<void>): void },
  options: { frames?: boolean } = {},
) {
  const fixture = await shellFrameFixture(options);
  const browser = new TestBrowser();
  await browser.start();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { fixture, browser };
}

/** Every frame in a frame tree, depth first, with its parent's id. */
function flatten(tree: Json, parentId = ''): { id: string; url: string; parentId: string }[] {
  const own = { id: String(tree.frame.id), url: String(tree.frame.url), parentId };
  const children = (tree.childFrames ?? []).flatMap((child: Json) => flatten(child, own.id));
  return [own, ...children];
}

/**
 * The DevTools sessions of a page's out-of-process frames, by target id.
 * Chromium puts the frame origin's pages in their own process (they send
 * `Origin-Agent-Cluster`), so they are separate targets, attached here
 * automatically. Their requests are added to `page.requests`, so the
 * page's request log covers its frames too.
 */
interface AttachedFrames {
  browser: TestBrowser;
  /** Session ids of attached frame targets, by target id. */
  sessions: Map<string, string>;
  /** Uncaught exceptions in those frames. */
  errors: string[];
}

const attachedFrames = new WeakMap<TestPage, AttachedFrames>();

/** Uncaught exceptions in the page's attached frames (see attachFrames). */
export function frameErrors(page: TestPage): string[] {
  return attachedFrames.get(page)?.errors ?? [];
}

export async function attachFrames(browser: TestBrowser, page: TestPage): Promise<void> {
  const sessions = new Map<string, string>();
  const errors: string[] = [];
  attachedFrames.set(page, { browser, sessions, errors });
  const known = new Set<string>([page.sessionId]);
  browser.on((message) => {
    if (message.method === 'Target.attachedToTarget' && known.has(message.sessionId)) {
      const child = message.params;
      known.add(child.sessionId);
      sessions.set(child.targetInfo.targetId, child.sessionId);
      void browser.call('Page.enable', {}, child.sessionId).catch(() => {});
      void browser.call('Network.enable', {}, child.sessionId).catch(() => {});
      void browser.call('Runtime.enable', {}, child.sessionId).catch(() => {});
      void browser
        .call(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          child.sessionId,
        )
        .catch(() => {});
    }
    if (message.method === 'Target.detachedFromTarget' && known.has(message.sessionId)) {
      sessions.delete(message.params.targetId);
    }
    if (
      message.method === 'Network.requestWillBeSent' &&
      message.sessionId !== page.sessionId &&
      known.has(message.sessionId)
    ) {
      page.requests.push(String(message.params.request.url));
    }
    if (
      message.method === 'Runtime.exceptionThrown' &&
      message.sessionId !== page.sessionId &&
      known.has(message.sessionId)
    ) {
      errors.push(JSON.stringify(message.params.exceptionDetails).slice(0, 300));
    }
  });
  await page.call('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
}

/**
 * Evaluate in a frame of the page: the frame whose URL is `address` (the
 * widget page, host.js), or with `inner`, the widget's own srcdoc frame
 * inside it. Evaluated in an isolated world, which shares the frame's DOM
 * and window (not its global variables).
 */
export async function evaluateInFrame<T = unknown>(
  page: TestPage,
  address: string,
  expression: string,
  inner = false,
  mainWorld = false,
): Promise<T> {
  const attached = attachedFrames.get(page);
  if (!attached) {
    throw Error('attachFrames was not called for this page');
  }
  const browser = attached.browser;

  // Every frame of the page and of its attached frame targets. A target's
  // root frame names its parent frame in another process (`parentId`); the
  // widget's own sandboxed srcdoc frame is usually such a target too.
  const frames: { id: string; url: string; parentId: string; sessionId: string }[] = [];
  for (const sessionId of [page.sessionId, ...attached.sessions.values()]) {
    try {
      const { frameTree } = await browser.call('Page.getFrameTree', {}, sessionId);
      for (const frame of flatten(frameTree, String(frameTree.frame.parentId ?? ''))) {
        frames.push({ ...frame, sessionId });
      }
    } catch {
      // A target that went away meanwhile.
    }
  }

  const host = frames.find((frame) => frame.url === address);
  if (!host) {
    throw Error(`No frame at ${address}`);
  }
  let target = host;
  if (inner) {
    const child = frames.find(
      (frame) => frame.parentId === host.id && frame.url === 'about:srcdoc',
    );
    if (!child) {
      throw Error(`No widget frame inside ${address}`);
    }
    target = child;
  }

  // The page's own world (its global variables) is reachable only where the
  // frame is the main frame of its own target: there Runtime.evaluate
  // without a context uses it.
  if (mainWorld) {
    if (target.sessionId === page.sessionId || target.parentId === '') {
      throw Error('mainWorld needs an out-of-process frame');
    }
    const reply = await browser.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      target.sessionId,
    );
    if (reply.exceptionDetails) {
      throw Error(`Evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 400)}`);
    }
    return reply.result.value as T;
  }

  const { executionContextId } = await browser.call(
    'Page.createIsolatedWorld',
    { frameId: target.id, worldName: 'shell-widget-test' },
    target.sessionId,
  );
  const reply = await browser.call(
    'Runtime.evaluate',
    { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true },
    target.sessionId,
  );
  if (reply.exceptionDetails) {
    throw Error(`Evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 400)}`);
  }
  return reply.result.value as T;
}

/** Poll an expression inside a frame until it is truthy (frames may not exist yet). */
export async function waitInFrame(
  page: TestPage,
  address: string,
  expression: string,
  inner = false,
  timeout = 10_000,
): Promise<void> {
  const until = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < until) {
    try {
      if (await evaluateInFrame<boolean>(page, address, `Boolean(${expression})`, inner)) {
        return;
      }
    } catch (error) {
      // The frame is not there yet.
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Timed out waiting in ${address} for: ${expression} (${lastError})`);
}

/** A page expression: the panel of the widget named `name`, or undefined. */
export function panelExpression(name: string, index = 0): string {
  return `[...document.querySelectorAll('.inline-widget')].filter((panel) => panel.querySelector('.inline-widget-name')?.textContent === ${JSON.stringify(name)})[${index}]`;
}

/**
 * Wait until `count()` has not changed for `quietMilliseconds` (more than
 * three polling intervals of 400 ms), and return it: polling has stopped,
 * and any request that was already on its way has arrived. Fails when the
 * count keeps changing until `timeout`.
 */
export async function quiet(
  count: () => number,
  quietMilliseconds = 1500,
  timeout = 8000,
): Promise<number> {
  const until = Date.now() + timeout;
  let value = count();
  let since = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const now = count();
    if (now !== value) {
      value = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMilliseconds) {
      return value;
    }
    if (Date.now() >= until) {
      throw Error(`Still changing after ${timeout} ms`);
    }
  }
}
