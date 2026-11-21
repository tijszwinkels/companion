/**
 * integrations/widgets/host.js and the browser shell (integrations/shell/
 * README.md, "Inline widgets", the messages rule, rows about host.js).
 *
 * The widget documents come from the real routes of the frame fixture
 * (test/frame-fixture.ts): the loopback route the desktop uses and the
 * socket route behind the gateway's frame origin. A small test server on
 * another loopback port then serves each document framed by a test page, so
 * the test can watch what host.js does with its parent: on the loopback
 * route nothing (no listener, no message), on the socket route the embedded
 * mode (geometry to the parent, theme and visible from it, polling paused
 * while not visible). Every window's `message` listeners are counted by an
 * instrumentation script installed before any page script runs.
 *
 * Requires /usr/lib/chromium/chromium. Loopback only.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { frameFixture } from '../frame-fixture.ts';
import { waitFor } from '../remote-fixture.ts';
import { TestBrowser, TestPage } from '../mobile/browser.ts';
import { skip } from './page.ts';
import { attachFrames, evaluateInFrame, quiet, waitInFrame } from './widget-page.ts';

type Json = Record<string, any>;

/**
 * Installed in every document of the page before its own scripts: counts
 * `message` listeners added to its window (in the DOM, so an isolated world
 * can read it) and records messages that reach the window from another
 * window, with that window's role.
 */
const instrumentation = `(() => {
  const add = EventTarget.prototype.addEventListener;
  let count = 0;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (this === window && type === 'message') {
      count++;
      document.documentElement.dataset.messageListeners = String(count);
    }
    return add.call(this, type, listener, options);
  };
  window.__received = [];
  add.call(window, 'message', (event) => {
    const fromChild = [...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow === event.source);
    window.__received.push({ data: event.data, fromSelf: event.source === window, fromChild });
  });
})();`;

/** Serves the fetched widget documents framed by test pages, and counts their state polls. */
async function documentServer(documents: { loopback: string; socket: string }, state: Json) {
  const polls = { loopback: 0, socket: 0 };
  // While set, state polls fail (503), as when the network is gone.
  const failing = { loopback: false, socket: false };
  // While set, state polls get no answer until `release()`, as on a slow
  // connection.
  const holding = { loopback: false, socket: false };
  // While set, widget actions fail (503) with the same text as the polls.
  const actionFailing = { loopback: false, socket: false };
  const actions = { loopback: 0, socket: 0 };
  // While set, state polls answer 404, as for a frame address that ended.
  const ended = { loopback: false, socket: false };
  const held: (() => void)[] = [];
  function release(): void {
    for (const answer of held.splice(0)) {
      answer();
    }
  }
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '';
    const route = path.startsWith('/loopback/') ? 'loopback' : 'socket';
    if (path === '/loopback/' || path === '/socket/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(documents[route]);
      return;
    }
    if (path === '/loopback/state' || path === '/socket/state') {
      polls[route]++;
      if (ended[route]) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (failing[route]) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic outage' }));
        return;
      }
      const answer = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(state));
      };
      if (holding[route]) {
        held.push(answer);
        return;
      }
      answer();
      return;
    }
    if (path === '/loopback/action' || path === '/socket/action') {
      actions[route]++;
      request.resume();
      if (actionFailing[route]) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic outage' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ count: 1 }));
      return;
    }
    if (path === '/frame-loopback.html' || path === '/frame-socket.html') {
      const source = path === '/frame-loopback.html' ? '/loopback/' : '/socket/';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html><body><iframe id="widget" src="${source}" style="width:480px;height:300px"></iframe></body></html>`,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    polls,
    failing,
    holding,
    held,
    actionFailing,
    actions,
    ended,
    release,
    server,
  };
}

/** A desktop page with the instrumentation in every document and its frames attached. */
async function instrumentedPage(browser: TestBrowser): Promise<TestPage> {
  const { browserContextId } = await browser.call('Target.createBrowserContext');
  const { targetId } = await browser.call('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  const page = new TestPage(browser, targetId, sessionId);
  await page.call('Page.enable');
  await page.call('Runtime.enable');
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  page.watchConsole();
  await attachFrames(browser, page);
  return page;
}

/** Wait until `count()` grew by at least `by`. */
async function grows(count: () => number, by: number, timeout = 5000): Promise<void> {
  const start = count();
  const until = Date.now() + timeout;
  while (count() < start + by) {
    assert.ok(Date.now() < until, `expected ${by} more within ${timeout} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'host.js stays passive on the loopback route and talks to the shell only when embedded from the socket route',
  { skip },
  async (context) => {
    const fixture = await frameFixture();
    const browser = new TestBrowser();
    await browser.start();
    let documents: Awaited<ReturnType<typeof documentServer>> | undefined;
    context.after(async () => {
      await browser.close();
      if (documents) {
        await new Promise<void>((resolve) => documents!.server.close(() => resolve()));
      }
      await fixture.close();
    });

    // A widget, with its loopback address (desktop) and its frame address
    // (what a paired browser receives).
    const { run } = await fixture.conversation();
    const widgetId = await fixture.publishCounter(run);
    const viewUrl = fixture.sessions
      .snapshot()[0]
      .messages.find((message) => message.widget?.id === widgetId)!.widget!.viewUrl!;
    const { token } = await fixture.pair();
    const phone = await fixture.phone(token);
    const snapshot = await phone.engine('state', (message) =>
      message.sessions?.[0]?.messages?.some((row: Json) => row.widget?.id === widgetId),
    );
    const frameUrl = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
      .frameUrl as string;

    const loopbackDocument = await (await fetch(viewUrl)).text();
    const socketDocument = await (await fixture.frameRequest(frameUrl)).text();
    const state = (await (await fixture.frameRequest(frameUrl + 'state')).json()) as Json;
    documents = await documentServer({ loopback: loopbackDocument, socket: socketDocument }, state);

    // 1. The loopback route at the top level, as the pop-out opens it: one
    // message listener (for its own widget frame), nothing posted to itself.
    const top = await instrumentedPage(browser);
    await top.navigate(viewUrl);
    await waitInFrame(top, viewUrl, `document.getElementById('increment')`, true);
    await grows(() => top.requests.filter((url) => url === viewUrl + '/state').length, 3);
    assert.equal(await top.evaluate(`document.documentElement.dataset.messageListeners`), '1');
    const toSelf = await top.evaluate<Json[]>(
      `window.__received.filter((entry) => entry.fromSelf)`,
    );
    assert.deepEqual(toSelf, []);
    assert.deepEqual(top.errors, []);

    // 2. A loopback document framed by another page: still one listener and
    // no message to the parent, after the widget drew its state and polled.
    const loopbackParent = await instrumentedPage(browser);
    await loopbackParent.navigate(`${documents.origin}/frame-loopback.html`);
    const loopbackFrame = `${documents.origin}/loopback/`;
    await waitInFrame(loopbackParent, loopbackFrame, `document.getElementById('increment')`, true);
    await grows(() => documents!.polls.loopback, 3);
    assert.equal(
      await evaluateInFrame(
        loopbackParent,
        loopbackFrame,
        `document.documentElement.dataset.messageListeners`,
      ),
      '1',
    );
    assert.deepEqual(
      await loopbackParent.evaluate(`window.__received.filter((entry) => entry.fromChild)`),
      [],
    );

    // 3. The socket-route document framed (the shell's case): a second
    // listener, for its parent, and the widget's height posted to the parent
    // once its first state was drawn.
    const shell = await instrumentedPage(browser);
    await shell.navigate(`${documents.origin}/frame-socket.html`);
    const socketFrame = `${documents.origin}/socket/`;
    await waitInFrame(shell, socketFrame, `document.getElementById('increment')`, true);
    await shell.waitFor(
      `window.__received.some((entry) => entry.fromChild && entry.data.type === 'geometry')`,
    );
    const fromFrame = await shell.evaluate<Json[]>(
      `window.__received.filter((entry) => entry.fromChild).map((entry) => entry.data)`,
    );
    for (const message of fromFrame) {
      assert.deepEqual(Object.keys(message), ['type', 'height']);
      assert.equal(message.type, 'geometry');
      assert.equal(typeof message.height, 'number');
    }
    assert.equal(
      await evaluateInFrame(
        shell,
        socketFrame,
        `document.documentElement.dataset.messageListeners`,
      ),
      '2',
    );

    // Embedded, it polls only once the shell said it is visible (this test
    // page never did); visible: true starts the polling, false stops it.
    const socketPolls = () => documents!.polls.socket;
    assert.equal(await quiet(socketPolls), 0);
    await shell.evaluate(
      `document.getElementById('widget').contentWindow.postMessage({ type: 'visible', visible: true }, '*')`,
    );
    await grows(socketPolls, 2);

    // A polling failure (the network went) shows in the frame's status line
    // and, embedded, goes once polling works again. On the loopback route
    // it stays, as before this change.
    const statusLine = `(document.querySelector('.error')?.textContent ?? '')`;
    documents.failing.socket = true;
    await waitInFrame(shell, socketFrame, `${statusLine} === 'Synthetic outage'`);
    // The next poll is slow: while it is on its way (over three polling
    // ticks) the line stays; only its answer clears it.
    documents.failing.socket = false;
    documents.holding.socket = true;
    await waitFor(() => documents!.held.length === 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(await evaluateInFrame(shell, socketFrame, statusLine), 'Synthetic outage');
    assert.equal(documents.held.length, 1);
    documents.holding.socket = false;
    documents.release();
    await waitInFrame(shell, socketFrame, `${statusLine} === ''`);

    // A polling failure, then an action failing with the same text before
    // any poll succeeded: the line is the action's now and stays when
    // polling works again. (Writes of the line are counted in the frame.)
    documents.failing.socket = true;
    await waitInFrame(shell, socketFrame, `${statusLine} === 'Synthetic outage'`);
    await evaluateInFrame(
      shell,
      socketFrame,
      `(() => {
        const line = document.querySelector('.error');
        line.dataset.writes = '0';
        new MutationObserver(() => {
          line.dataset.writes = String(Number(line.dataset.writes) + 1);
        }).observe(line, { childList: true });
      })()`,
    );
    documents.failing.socket = false;
    documents.holding.socket = true;
    documents.actionFailing.socket = true;
    await waitFor(() => documents!.held.length === 1, 5000);
    await evaluateInFrame(shell, socketFrame, `document.getElementById('increment').click()`, true);
    await waitFor(() => documents!.actions.socket === 1, 5000);
    await waitInFrame(
      shell,
      socketFrame,
      `Number(document.querySelector('.error').dataset.writes) >= 1`,
    );
    assert.equal(await evaluateInFrame(shell, socketFrame, statusLine), 'Synthetic outage');
    documents.holding.socket = false;
    documents.release();
    await grows(socketPolls, 3);
    assert.equal(await evaluateInFrame(shell, socketFrame, statusLine), 'Synthetic outage');
    documents.actionFailing.socket = false;
    documents.failing.loopback = true;
    await waitInFrame(loopbackParent, loopbackFrame, `${statusLine} === 'Synthetic outage'`);
    documents.failing.loopback = false;
    const loopbackPolls = () => documents!.polls.loopback;
    await grows(loopbackPolls, 3);
    assert.equal(
      await evaluateInFrame(loopbackParent, loopbackFrame, statusLine),
      'Synthetic outage',
    );

    await shell.evaluate(
      `document.getElementById('widget').contentWindow.postMessage({ type: 'visible', visible: false }, '*')`,
    );
    const paused = await quiet(socketPolls);

    // Malformed visibility messages change nothing.
    for (const message of [
      `{ type: 'visible', visible: 'yes' }`,
      `{ type: 'visible', visible: true, extra: 1 }`,
      `{ type: 'visible' }`,
      `'visible'`,
      `Object.assign([], { type: 'visible', visible: true })`,
    ]) {
      await shell.evaluate(
        `document.getElementById('widget').contentWindow.postMessage(${message}, '*')`,
      );
    }
    assert.equal(await quiet(socketPolls), paused);

    // From another window than the parent (the widget's own inner frame):
    // ignored too.
    await evaluateInFrame(
      shell,
      socketFrame,
      `parent.postMessage({ type: 'visible', visible: true }, '*')`,
      true,
    );
    assert.equal(await quiet(socketPolls), paused);

    await shell.evaluate(
      `document.getElementById('widget').contentWindow.postMessage({ type: 'visible', visible: true }, '*')`,
    );
    await grows(() => documents!.polls.socket, 2);

    // Theme: four #rrggbb colours and a scale within 0.4–6, exactly; the
    // widget's own frame then uses them. Anything else is ignored.
    const foreground = `getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()`;
    const post = (message: string) =>
      shell.evaluate(
        `document.getElementById('widget').contentWindow.postMessage(${message}, '*')`,
      );
    const theme = `{ foreground: '#112233', background: '#000000', accent: '#445566', muted: '#778899', scale: 1 }`;
    await post(`{ type: 'theme', theme: ${theme} }`);
    await waitInFrame(shell, socketFrame, `${foreground} === '#112233'`, true);
    // Every foreground the widget's frame uses from now on is recorded.
    await evaluateInFrame(
      shell,
      socketFrame,
      `(() => {
        const root = document.documentElement;
        root.dataset.foregrounds = '';
        new MutationObserver(() => {
          root.dataset.foregrounds += ${foreground} + ' ';
        }).observe(root, { attributes: true, attributeFilter: ['style'] });
      })()`,
      true,
    );
    for (const invalid of [
      `{ type: 'theme', theme: { ...${theme}, foreground: 'red' } }`,
      `{ type: 'theme', theme: { ...${theme}, foreground: '#ff0000', scale: 50 } }`,
      `{ type: 'theme', theme: { ...${theme}, foreground: '#ff0000', extra: 1 } }`,
      `{ type: 'theme', theme: { foreground: '#ff0000' } }`,
      `{ type: 'theme', theme: ${theme.replace('#112233', '#ff0000')}, token: 'x' }`,
    ]) {
      await post(invalid);
    }
    // A valid theme after the invalid ones shows they were handled in order.
    await post(`{ type: 'theme', theme: ${theme.replace('#112233', '#223344')} }`);
    await waitInFrame(shell, socketFrame, `${foreground} === '#223344'`, true);
    const seen = await evaluateInFrame<string>(
      shell,
      socketFrame,
      `document.documentElement.dataset.foregrounds`,
      true,
    );
    assert.ok(!seen.includes('#ff0000') && !seen.includes('red'), seen);
    assert.ok(seen.includes('#223344'), seen);

    // A frame address that ended (state answers 404): embedded, host.js
    // tells the shell with an `error`, so the shell shows its failed state;
    // on the loopback route nothing is posted to the parent.
    const fromChild = (page: TestPage) =>
      page.evaluate<Json[]>(
        `window.__received.filter((entry) => entry.fromChild).map((entry) => entry.data)`,
      );
    documents.ended.socket = true;
    await shell.waitFor(
      `window.__received.some((entry) => entry.fromChild && entry.data.type === 'error')`,
    );
    const ending = (await fromChild(shell)).find((message) => message.type === 'error')!;
    assert.deepEqual(Object.keys(ending), ['type', 'text']);
    assert.match(String(ending.text), /^Its address has ended/);
    documents.ended.loopback = true;
    await grows(() => documents!.polls.loopback, 3);
    assert.deepEqual(await fromChild(loopbackParent), []);
    assert.equal(
      await evaluateInFrame(
        loopbackParent,
        loopbackFrame,
        `document.querySelector('.error')?.textContent`,
      ),
      'Not found',
    );

    // Widget code cannot open WebRTC connections, on either route.
    for (const [page, address] of [
      [top, viewUrl],
      [shell, socketFrame],
    ] as const) {
      assert.equal(await mainWorldInWidget(page, address, `typeof RTCPeerConnection`), 'undefined');
      for (const name of ['webkitRTCPeerConnection', 'mozRTCPeerConnection', 'WebTransport']) {
        assert.equal(await mainWorldInWidget(page, address, `typeof ${name}`), 'undefined');
      }
      // Not redefinable by widget code either.
      assert.equal(
        await mainWorldInWidget(
          page,
          address,
          `(() => { try { Object.defineProperty(globalThis, 'RTCPeerConnection', { value: 1 }); } catch {} try { RTCPeerConnection = 1; } catch {} return typeof RTCPeerConnection; })()`,
        ),
        'undefined',
      );
    }
  },
);

/**
 * Evaluate in the main world of the widget's own srcdoc frame inside the
 * frame at `address`, where host.js's script removed WebRTC (an isolated
 * world has its own globals and would still see the constructors). The
 * sandboxed srcdoc frame runs in its own process, so it is the main frame
 * of its own target.
 */
function mainWorldInWidget(page: TestPage, address: string, expression: string) {
  return evaluateInFrame(page, address, expression, true, true);
}
