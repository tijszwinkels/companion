/**
 * Headless Chromium against the gateway's frame origin.
 *
 * A page served by the gateway origin embeds a widget's `frameUrl` exactly as
 * the browser shell will: `<iframe sandbox="allow-scripts allow-same-origin
 * allow-forms">`. The widget must render and its action must change the
 * saved state; the frame page must not reach the embedding page's
 * localStorage; a page on a third origin must not be able to embed the same
 * address; and no request may leave the two origins.
 *
 * Needs /usr/lib/chromium/chromium (skipped otherwise). Loopback only.
 */

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TestBrowser, chromiumPath, type TestPage } from '../mobile/browser.ts';
import { frameFixture } from '../frame-fixture.ts';

const embedHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Embed</title></head>
<body><iframe id="widget" sandbox="allow-scripts allow-same-origin allow-forms"
style="width:480px;height:280px"></iframe><script src="embed.js"></script></body></html>`;

// The gateway's CSP allows only its own scripts, so the page logic is a file.
// The frame address arrives in the fragment, which is never sent to a server.
const embedJs = `localStorage.setItem('device-token', 'synthetic-device-secret');
document.getElementById('widget').src = decodeURIComponent(location.hash.slice(1));`;

type Json = Record<string, any>;

/** Poll an asynchronous condition until it holds. */
async function waitFor(check: () => Promise<boolean>, milliseconds: number): Promise<void> {
  const until = Date.now() + milliseconds;
  while (!(await check())) {
    assert.ok(Date.now() < until, 'Timed out waiting in the browser');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every frame in the page, depth first, including nested ones. */
function frames(tree: Json): Json[] {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap((child: Json) => frames(child))];
}

/**
 * Evaluate in the frame whose URL starts with `prefix`. Same-site frames
 * share the page's target; out-of-process ones are attached targets whose
 * session we find by URL.
 */
async function evaluateIn(
  browser: TestBrowser,
  page: TestPage,
  attached: Map<string, string>,
  prefix: string,
  expression: string,
): Promise<unknown> {
  const sessions = [page.sessionId, ...attached.values()];
  for (const sessionId of sessions) {
    const { frameTree } = await browser.call('Page.getFrameTree', {}, sessionId);
    const match = frames(frameTree).find((frame) => String(frame.url).startsWith(prefix));
    if (!match) {
      continue;
    }
    const { executionContextId } = await browser.call(
      'Page.createIsolatedWorld',
      { frameId: match.id, worldName: 'frame-test' },
      sessionId,
    );
    const reply = await browser.call(
      'Runtime.evaluate',
      { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (reply.exceptionDetails) {
      return { exception: String(reply.exceptionDetails.exception?.description ?? '') };
    }
    return reply.result.value;
  }
  throw Error(`No frame starting with ${prefix}`);
}

/** Attach to out-of-process child frames of a page and remember their sessions. */
async function attachChildren(browser: TestBrowser, page: TestPage): Promise<Map<string, string>> {
  const attached = new Map<string, string>();
  browser.on((message) => {
    if (message.method === 'Target.attachedToTarget') {
      const child = message.params;
      attached.set(child.targetInfo.targetId, child.sessionId);
      void browser.call('Page.enable', {}, child.sessionId).catch(() => {});
      void browser.call('Network.enable', {}, child.sessionId).catch(() => {});
      void browser
        .call(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          child.sessionId,
        )
        .catch(() => {});
    }
    if (message.method === 'Network.requestWillBeSent' && message.sessionId !== page.sessionId) {
      page.requests.push(String(message.params.request.url));
    }
  });
  await page.call('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  return attached;
}

test('a gateway page embeds a widget frame that works but cannot reach the page', async (context) => {
  try {
    await access(chromiumPath);
  } catch {
    context.skip('Chromium is not installed');
    return;
  }

  const appDirectory = await mkdtemp(join(tmpdir(), 'companion-frame-embed-'));
  await writeFile(join(appDirectory, 'embed.html'), embedHtml);
  await writeFile(join(appDirectory, 'embed.js'), embedJs);
  const fixture = await frameFixture({ appDirectory });

  // A third origin that tries to embed the same address.
  const third = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(embedHtml.replace('<script src="embed.js"></script>', ''));
  });
  await new Promise<void>((resolve) => third.listen(0, '127.0.0.1', resolve));
  const thirdAddress = third.address();
  assert.ok(thirdAddress && typeof thirdAddress === 'object');
  const thirdOrigin = `http://127.0.0.1:${thirdAddress.port}`;

  const browser = new TestBrowser();
  context.after(async () => {
    await browser.close();
    await new Promise<void>((resolve) => third.close(() => resolve()));
    await fixture.close();
    await rm(appDirectory, { recursive: true, force: true });
  });
  await browser.start();

  // The phone side, as the shell will see it: a frame address per widget.
  const { run } = await fixture.conversation();
  const widgetId = await fixture.publishCounter(run);
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.[0]?.messages?.some((row: Json) => row.widget?.id === widgetId),
  );
  const frameUrl = snapshot.sessions[0].messages.find((row: Json) => row.widget).widget
    .frameUrl as string;
  assert.ok(frameUrl.startsWith(fixture.frameOrigin + '/f/'));

  // 1. Embedded by the gateway origin: the widget renders.
  const page = await browser.phone(480, 600);
  const attached = await attachChildren(browser, page);
  await page.navigate(`${fixture.origin}/embed.html#${encodeURIComponent(frameUrl)}`);

  // The widget's own code runs in host.js's inner opaque frame (about:srcdoc).
  // Wait for its button, then click it as a person would.
  let label: unknown;
  await waitFor(async () => {
    try {
      label = await evaluateIn(
        browser,
        page,
        attached,
        'about:srcdoc',
        `document.getElementById('increment')?.textContent ?? null`,
      );
    } catch {
      label = null;
    }
    return label === 'Clicks: 0';
  }, 10_000);

  await evaluateIn(
    browser,
    page,
    attached,
    'about:srcdoc',
    `document.getElementById('increment').click()`,
  );

  // 2. The action reached the listener and the frame shows the new state.
  await waitFor(async () => {
    const state = await fixture.frameRequest(frameUrl + 'state');
    const value = (await state.json()) as Json;
    return value.props?.count === 1;
  }, 10_000);
  await waitFor(async () => {
    const text = await evaluateIn(
      browser,
      page,
      attached,
      'about:srcdoc',
      `document.getElementById('increment')?.textContent ?? null`,
    ).catch(() => null);
    return text === 'Clicks: 1';
  }, 10_000);

  // 3. The frame page cannot read the embedding page's storage.
  assert.equal(
    await page.evaluate(`localStorage.getItem('device-token')`),
    'synthetic-device-secret',
  );
  assert.equal(
    await evaluateIn(browser, page, attached, frameUrl, `localStorage.getItem('device-token')`),
    null,
  );
  const parentStorage = (await evaluateIn(
    browser,
    page,
    attached,
    frameUrl,
    `(() => { try { return parent.localStorage.getItem('device-token'); } catch (error) { return 'blocked: ' + error.name; } })()`,
  )) as string;
  assert.equal(parentStorage, 'blocked: SecurityError');
  const apiFromFrame = (await evaluateIn(
    browser,
    page,
    attached,
    frameUrl,
    `fetch(${JSON.stringify(fixture.origin + '/api/apps')}).then((r) => 'status ' + r.status, (error) => 'blocked: ' + error.name)`,
  )) as string;
  assert.match(apiFromFrame, /^blocked|^status 401$/);

  // 4. No request left the two origins (data: scripts and the srcdoc are local).
  for (const url of page.requests) {
    assert.ok(
      url.startsWith(fixture.origin + '/') ||
        url.startsWith(fixture.frameOrigin + '/') ||
        url.startsWith('data:') ||
        url.startsWith('about:'),
      `unexpected request ${url}`,
    );
  }
  assert.ok(page.requests.some((url) => url.startsWith(frameUrl)));

  // 5. A page on another origin cannot embed the same address.
  // Chrome reports the frame-ancestors refusal in the embedding page's log.
  const foreign = await browser.phone(480, 600);
  const foreignAttached = await attachChildren(browser, foreign);
  const violations: string[] = [];
  browser.on((message) => {
    if (message.method === 'Log.entryAdded' && message.sessionId === foreign.sessionId) {
      violations.push(String(message.params.entry.text));
    }
  });
  await foreign.call('Log.enable');
  await foreign.navigate(`${thirdOrigin}/`);
  await foreign.evaluate(`document.getElementById('widget').src = ${JSON.stringify(frameUrl)}`);
  await waitFor(async () => violations.some((text) => text.includes('frame-ancestors')), 10_000);
  let embedded: unknown;
  try {
    embedded = await evaluateIn(
      browser,
      foreign,
      foreignAttached,
      frameUrl,
      `document.querySelector('script') ? 'loaded' : 'empty'`,
    );
  } catch {
    embedded = 'blocked';
  }
  assert.notEqual(embedded, 'loaded');
});
