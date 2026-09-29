// companion_browser_open: an agent asks the native panel to show a web page.
//
// These tests drive the real turn lease, the real session tool service and the
// real desktop socket with a synthetic panel client. No model, agent program,
// browser or network page is involved; the native panel side is covered by
// test/window/browser-open-tool.test.ts.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bridgeTools } from '../../src/agents/claude/bridge-tools.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import type { ExternalCaller } from '../../src/agents/session-tools-service.ts';
import { desktopFixture, waitFor, type DesktopMessage } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

/** The one-time event a panel receives for each admitted call. */
interface BrowserOpenMessage {
  type: 'agent-browser-open';
  requestId: string;
  id: string;
  url: string;
}

test('Pi and Claude Code offer the same companion_browser_open tool', () => {
  const lease = { endpoint: 'http://127.0.0.1:1/session', token: 'a'.repeat(64) };
  const pi = sessionTools(lease.endpoint, lease.token).find(
    (tool) => tool.name === 'companion_browser_open',
  );
  const claude = bridgeTools({ sessionTools: lease }).find(
    (tool) => tool.name === 'companion_browser_open',
  );
  assert.ok(pi && claude);
  assert.deepEqual(claude.inputSchema, JSON.parse(JSON.stringify(pi.parameters)));
  assert.equal(claude.description, pi.description);
  assert.deepEqual(claude.promptGuidelines, pi.promptGuidelines);
  assert.deepEqual(Object.keys((claude.inputSchema as { properties: object }).properties), ['url']);

  // Without a session tool lease (e.g. no conversation), neither offers it.
  assert.equal(
    bridgeTools({}).some((tool) => tool.name === 'companion_browser_open'),
    false,
  );
});

/**
 * One requesting conversation whose turn stays open while the test calls its
 * tools, a second (other) conversation, and the real desktop runtime.
 */
async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-browser-tool-'));
  const extraSockets: Socket[] = [];
  let desktop: Awaited<ReturnType<typeof desktopFixture>> | undefined;
  let releaseTurn: () => void = () => {};

  // Registered at acquisition: runs even if a later setup step throws.
  context.after(async () => {
    releaseTurn();
    for (const socket of extraSockets) {
      socket.destroy();
    }
    await Promise.allSettled([desktop?.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let lease: { endpoint: string; token: string } | undefined;
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'browser-tool-fixture',
        label: 'Browser tool fixture',
        dependencies: {},
        async run(request) {
          if (request.prompt.text === 'Requester') {
            lease = request.sessionTools;
            await new Promise<void>((resolve) => {
              releaseTurn = resolve;
            });
          }
        },
      },
    },
    () => {},
    directory,
  );
  desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);

  const other = sessions.start({ ...frame, utterance: 'Other' }, signal());
  await sessions.idle();
  const requester = sessions.start({ ...frame, utterance: 'Requester' }, signal());
  await waitFor(() => lease !== undefined);

  const pi = sessionTools(lease!.endpoint, lease!.token).find(
    (tool) => tool.name === 'companion_browser_open',
  )!;
  const claude = bridgeTools({ sessionTools: lease! }).find(
    (tool) => tool.name === 'companion_browser_open',
  )!;

  return {
    desktop,
    sessions,
    requester,
    other,
    lease: lease!,
    claude,
    endTurn: () => releaseTurn(),
    /** Call the Pi tool; returns its details or `{error}`. */
    async open(url: unknown, callId: string = randomUUID()) {
      try {
        return (await pi.execute(callId, { url } as never)).details as Record<string, unknown>;
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    /** Remove and return the next browser-open event the panel received. */
    async nextEvent(): Promise<BrowserOpenMessage> {
      const matches = (message: DesktopMessage) => message.type === 'agent-browser-open';
      await waitFor(() => desktop!.messages.some(matches));
      const index = desktop!.messages.findIndex(matches);
      return desktop!.messages.splice(index, 1)[0] as unknown as BrowserOpenMessage;
    },
    events() {
      return desktop!.messages.filter((message) => message.type === 'agent-browser-open').length;
    },
    async connect() {
      const socket = createConnection(desktop!.socketPath);
      extraSockets.push(socket);
      await once(socket, 'connect');
      const received: string[] = [];
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => received.push(chunk));
      return {
        socket,
        received,
        send(request: object) {
          socket.write(JSON.stringify(request) + '\n');
        },
      };
    },
  };
}

test('a conversation opens a page only through a panel that has the browser, and reports its answer', async (context) => {
  const f = await fixture(context);
  const { desktop } = f;

  // No panel at all, then a panel without a browser (Quickshell, older UI).
  assert.match(String((await f.open('https://example.com/')).error), /\[offline\]$/);
  desktop.send({ action: 'panel-state', id: f.requester, composerFocused: false, draftHost: true });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');
  assert.match(
    String((await f.open('https://example.com/')).error),
    /no built-in browser.*\[unsupported\]$/,
  );
  assert.equal(f.events(), 0);

  desktop.send({
    action: 'panel-state',
    id: f.requester,
    composerFocused: false,
    draftHost: true,
    browserHost: true,
  });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');

  // Only the caller's own conversation, and the canonical address, travel.
  const pending = f.open('https://Example.COM/docs?q=1');
  const request = await f.nextEvent();
  assert.equal(request.id, f.requester);
  assert.equal(request.url, 'https://example.com/docs?q=1');
  assert.deepEqual(Object.keys(request).sort(), ['id', 'requestId', 'type', 'url']);

  // Another connection cannot answer for the panel that was asked.
  const stranger = await f.connect();
  stranger.send({
    action: 'agent-browser-open-result',
    requestId: request.requestId,
    outcome: 'loaded',
  });
  await waitFor(() => stranger.received.join('').includes('This browser request has expired'));

  desktop.send({
    action: 'agent-browser-open-result',
    requestId: request.requestId,
    outcome: 'loaded',
    reason: '',
    url: 'https://example.com/docs?q=1',
    title: 'Docs',
  });
  assert.equal((await desktop.reply('agent-browser-open-result')).result, 'browser-recorded');
  // Page text a panel might send (a title) is never forwarded to the agent.
  assert.deepEqual(await pending, {
    outcome: 'loaded',
    reason: '',
    url: 'https://example.com/docs?q=1',
  });

  // A late duplicate answer is refused rather than applied to a later call.
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: request.requestId,
    outcome: 'busy',
  });
  assert.match(
    String((await desktop.reply('agent-browser-open-result')).message),
    /This browser request has expired/,
  );

  // Confirmed refusals are errors with stable codes; the page did not change.
  // (The panel's own "unsupported" answer maps like the runtime's, above.)
  for (const [outcome, pattern] of [
    ['not-selected', /selected in the Companion panel.*\[not-selected\]$/],
    ['busy', /busy.*\[busy\]$/],
    ['refused', /refused this address.*\[refused\]$/],
  ] as const) {
    const attempt = f.open('https://example.com/' + outcome);
    const event = await f.nextEvent();
    desktop.send({ action: 'agent-browser-open-result', requestId: event.requestId, outcome });
    await desktop.reply('agent-browser-open-result');
    assert.match(String((await attempt).error), pattern);
  }
});

test('failed loads are reported truthfully and malformed panel answers are rejected', async (context) => {
  const f = await fixture(context);
  const { desktop } = f;
  desktop.send({
    action: 'panel-state',
    id: f.requester,
    composerFocused: false,
    draftHost: true,
    browserHost: true,
  });
  await desktop.reply('panel-state');

  // A hidden panel opens nothing and is not a success.
  const hiddenPanel = f.open('https://example.com/hidden');
  const hiddenEvent = await f.nextEvent();
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: hiddenEvent.requestId,
    outcome: 'panel-hidden',
    reason: 'The Companion panel is hidden.',
  });
  await desktop.reply('agent-browser-open-result');
  assert.match(String((await hiddenPanel).error), /could not see the page.*\[panel-hidden\]$/);

  // A page that failed to load is still a truthful report of what is shown.
  const failing = f.open('https://expired.example/');
  const failed = await f.nextEvent();
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: failed.requestId,
    outcome: 'load-failed',
    reason: 'Could not open expired.example: its security certificate is not valid.',
    url: 'https://expired.example/',
  });
  await desktop.reply('agent-browser-open-result');
  assert.equal((await failing).outcome, 'load-failed');

  // Malformed panel answers are rejected and leave the call pending.
  const malformed = f.open('https://example.com/malformed');
  const odd = await f.nextEvent();
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: odd.requestId,
    outcome: 'offline',
  });
  assert.match(
    String((await desktop.reply('agent-browser-open-result')).message),
    /Expected a browser request id and outcome/,
  );
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: odd.requestId,
    outcome: 'loading',
  });
  await desktop.reply('agent-browser-open-result');
  assert.equal((await malformed).outcome, 'loading');
});

test('addresses are checked before any panel is asked, and receipts prevent a second open', async (context) => {
  const f = await fixture(context);
  const { desktop } = f;
  desktop.send({
    action: 'panel-state',
    id: f.requester,
    composerFocused: false,
    draftHost: true,
    browserHost: true,
  });
  await desktop.reply('panel-state');

  for (const url of [
    'file:///etc/passwd',
    'http://example.com/',
    'companion-widget://view/document',
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:someone@example.com',
    'example.com',
    '/relative',
    'https://',
    'https://exa mple.com/',
    ' https://example.com/',
    'https://example.com/' + 'a'.repeat(2048),
    '',
    42,
    null,
  ]) {
    assert.match(
      String((await f.open(url)).error),
      /absolute https:\/\/ address.*\[invalid\]$/,
      String(url),
    );
  }
  assert.equal(f.events(), 0, 'no refused address reached the panel');

  // Loopback http is allowed, as in the panel browser itself.
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8080/app', 'http://[::1]:9/']) {
    const attempt = f.open(url);
    const event = await f.nextEvent();
    assert.equal(event.url, url);
    desktop.send({
      action: 'agent-browser-open-result',
      requestId: event.requestId,
      outcome: 'loaded',
    });
    await desktop.reply('agent-browser-open-result');
    assert.equal((await attempt).outcome, 'loaded');
  }

  // A repeated delivery of one tool call gets the original reply, and the
  // panel is asked only once. A new call may navigate again.
  const callId = randomUUID();
  const first = f.open('https://example.com/once', callId);
  const event = await f.nextEvent();
  const repeated = f.open('https://example.com/once', callId);
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: event.requestId,
    outcome: 'loaded',
  });
  await desktop.reply('agent-browser-open-result');
  assert.deepEqual(await repeated, await first);
  assert.equal(f.events(), 0);
  const again = f.open('https://example.com/once');
  const secondEvent = await f.nextEvent();
  assert.notEqual(secondEvent.requestId, event.requestId);
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: secondEvent.requestId,
    outcome: 'loaded',
  });
  await desktop.reply('agent-browser-open-result');
  assert.equal((await again).outcome, 'loaded');

  // The Claude Code bridge runs the same tool through the same lease.
  const viaClaude = f.claude.execute(randomUUID(), { url: 'https://example.com/claude' }, signal());
  const claudeEvent = await f.nextEvent();
  assert.equal(claudeEvent.id, f.requester);
  desktop.send({
    action: 'agent-browser-open-result',
    requestId: claudeEvent.requestId,
    outcome: 'loaded',
    title: 'Claude page',
  });
  await desktop.reply('agent-browser-open-result');
  assert.match(String(await viaClaude), /"outcome": "loaded"/);
  assert.doesNotMatch(String(await viaClaude), /Claude page/);

  // The turn's action budget (6) also bounds browser opens.
  assert.match(
    String((await f.open('https://example.com/budget')).error),
    /at most 6 session actions \[limit\]$/,
  );
});

test('disconnects, ended turns, reconnects, remote panels and external callers never open pages', async (context) => {
  const f = await fixture(context);
  const { desktop } = f;

  // A remote (phone) panel cannot offer a browser or answer for one.
  const phone = await f.connect();
  phone.send({ action: 'client-role', role: 'remote' });
  await waitFor(() => phone.received.join('').includes('role-recorded'));
  phone.send({ action: 'panel-state', id: f.requester, composerFocused: false, browserHost: true });
  await waitFor(() => phone.received.join('').includes('panel-recorded'));
  assert.match(String((await f.open('https://example.com/')).error), /\[offline\]$/);
  phone.send({ action: 'agent-browser-open-result', requestId: randomUUID(), outcome: 'loaded' });
  await waitFor(() => phone.received.join('').includes('only available on the desktop'));

  // Withdrawing the browser while a request waits leaves it unconfirmed.
  desktop.send({
    action: 'panel-state',
    id: f.requester,
    composerFocused: false,
    draftHost: true,
    browserHost: true,
  });
  await desktop.reply('panel-state');
  const withdrawn = f.open('https://example.com/withdrawn');
  await f.nextEvent();
  desktop.send({ action: 'panel-state', id: f.requester, composerFocused: false, draftHost: true });
  await desktop.reply('panel-state');
  assert.match(String((await withdrawn).error), /may or may not be showing.*\[unconfirmed\]$/);

  // A reconnecting panel receives snapshots, never an earlier request again.
  const panel = await f.connect();
  panel.send({
    action: 'panel-state',
    id: f.requester,
    composerFocused: false,
    draftHost: true,
    browserHost: true,
  });
  await waitFor(() => panel.received.join('').includes('panel-recorded'));
  assert.doesNotMatch(panel.received.join(''), /agent-browser-open|example\.com/);

  // The asked panel disconnecting before it answers is uncertain too.
  const uncertain = f.open('https://example.com/uncertain');
  await waitFor(() => panel.received.join('').includes('"agent-browser-open"'));
  panel.socket.destroy();
  assert.match(String((await uncertain).error), /\[unconfirmed\]$/);

  // External (CLI) callers have no conversation of their own.
  const controller = new AbortController();
  const caller: ExternalCaller = {
    kind: 'external',
    label: 'Test',
    requestId: randomUUID(),
    signal: controller.signal,
    delivered: new Set(),
  };
  const external = await f.sessions.sessionTools.external(caller, {
    method: 'browser-open',
    url: 'https://example.com/',
  });
  assert.equal(external.body.code, 'invalid');

  // After the calling turn ends, its lease cannot open anything.
  f.endTurn();
  await f.sessions.idle();
  assert.match(String((await f.open('https://example.com/late')).error), /\[expired\]$/);
});
