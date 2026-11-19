// companion_session_present: a conversation's agent asks the native panel to
// show that same conversation in its own window, or to return it.
//
// These tests drive the real turn lease, the real session tool service and the
// real desktop socket with a synthetic native panel client. No model, agent
// program or native window is involved; the native panel side is covered by
// the window/panel suites.

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

/** The one-time event a native panel receives for each admitted call. */
interface PresentMessage {
  type: 'agent-present';
  requestId: string;
  id: string;
  presentation: 'window' | 'sidebar';
  focus: boolean;
}

test('Pi and Claude Code offer the same caller-only companion_session_present tool', () => {
  const lease = {
    endpoint: 'http://127.0.0.1:1/session',
    token: 'a'.repeat(64),
    capabilities: ['session-present'],
  };
  const pi = sessionTools(lease.endpoint, lease.token, lease.capabilities).find(
    (tool) => tool.name === 'companion_session_present',
  );
  const claude = bridgeTools({ sessionTools: lease }).find(
    (tool) => tool.name === 'companion_session_present',
  );
  assert.ok(pi && claude);
  assert.deepEqual(claude.inputSchema, JSON.parse(JSON.stringify(pi.parameters)));
  assert.equal(claude.description, pi.description);
  assert.deepEqual(claude.promptGuidelines, pi.promptGuidelines);

  // Only presentation and focus: there is no way to name another conversation.
  const schema = claude.inputSchema as { properties: object; required: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['focus', 'presentation']);
  assert.deepEqual(schema.required, ['presentation']);

  // Without the announced capability, neither harness offers it.
  const without = { ...lease, capabilities: ['browser-open', 'self-wakes'] };
  assert.equal(
    sessionTools(without.endpoint, without.token, without.capabilities).some(
      (tool) => tool.name === 'companion_session_present',
    ),
    false,
  );
  assert.equal(
    bridgeTools({ sessionTools: without }).some(
      (tool) => tool.name === 'companion_session_present',
    ),
    false,
  );
});

/**
 * A requesting conversation whose turn stays open while the test calls its
 * tools, a second conversation, the real desktop runtime and (optionally) a
 * native pop-out panel connected before the requesting turn's lease.
 */
async function fixture(
  context: { after(callback: () => Promise<unknown>): void },
  options: { nativePanel: boolean } = { nativePanel: true },
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-present-tool-'));
  const extraSockets: Socket[] = [];
  let desktop: Awaited<ReturnType<typeof desktopFixture>> | undefined;
  let releaseTurn: () => void = () => {};
  let turns = 0;

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
  let lease: { endpoint: string; token: string; capabilities?: readonly string[] } | undefined;
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'present-tool-fixture',
        label: 'Present tool fixture',
        dependencies: {},
        async run(request) {
          turns++;
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

  if (options.nativePanel) {
    desktop.send({
      action: 'panel-state',
      id: other,
      composerFocused: false,
      visible: true,
      draftHost: true,
      popoutHost: true,
      rail: 'full',
      popouts: [],
    });
    assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');
  }

  const requester = sessions.start({ ...frame, utterance: 'Requester' }, signal());
  await waitFor(() => lease !== undefined);

  const pi = sessionTools(lease!.endpoint, lease!.token, lease!.capabilities).find(
    (tool) => tool.name === 'companion_session_present',
  );

  return {
    desktop,
    sessions,
    requester,
    other,
    lease: lease!,
    pi,
    turns: () => turns,
    endTurn: () => releaseTurn(),
    /** Call the Pi tool with raw arguments; returns its details or `{error}`. */
    async present(parameters: Record<string, unknown>, callId: string = randomUUID()) {
      try {
        return (await pi!.execute(callId, parameters as never)).details as Record<string, unknown>;
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    /** Remove and return the next presentation event the panel received. */
    async nextEvent(): Promise<PresentMessage> {
      const matches = (message: DesktopMessage) => message.type === 'agent-present';
      await waitFor(() => desktop!.messages.some(matches));
      const index = desktop!.messages.findIndex(matches);
      return desktop!.messages.splice(index, 1)[0] as unknown as PresentMessage;
    },
    events() {
      return desktop!.messages.filter((message) => message.type === 'agent-present').length;
    },
    async answer(fields: Record<string, unknown>) {
      desktop!.send({ action: 'agent-present-result', ...fields });
      return desktop!.reply('agent-present-result');
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

test('the tool is leased only while a native pop-out panel is connected', async (context) => {
  const withoutPanel = await fixture(context, { nativePanel: false });
  assert.deepEqual(withoutPanel.lease.capabilities, ['browser-open', 'self-wakes']);
  assert.equal(withoutPanel.pi, undefined);

  const withPanel = await fixture(context);
  assert.deepEqual(withPanel.lease.capabilities, ['browser-open', 'self-wakes', 'session-present']);
  assert.ok(withPanel.pi);
});

test('pop out and return the caller conversation through the native panel, without changing it', async (context) => {
  const f = await fixture(context);
  const before = f.sessions.snapshot();
  const turnsBefore = f.turns();

  // Pop out with focus requested; the panel saw focus actually granted.
  const shown = f.present({ presentation: 'window', focus: true });
  const request = await f.nextEvent();
  assert.deepEqual(Object.keys(request).sort(), [
    'focus',
    'id',
    'presentation',
    'requestId',
    'type',
  ]);
  assert.equal(request.id, f.requester);
  assert.equal(request.presentation, 'window');
  assert.equal(request.focus, true);
  assert.equal(
    (await f.answer({ requestId: request.requestId, outcome: 'shown', focused: true })).result,
    'present-recorded',
  );
  assert.deepEqual(await shown, { outcome: 'shown', focused: true, reason: '' });

  // Return without focus (the default); the panel reports what it observed.
  const returned = f.present({ presentation: 'sidebar' });
  const back = await f.nextEvent();
  assert.equal(back.presentation, 'sidebar');
  assert.equal(back.focus, false);
  await f.answer({
    requestId: back.requestId,
    outcome: 'returned',
    focused: false,
    reason: 'Activation was not granted.',
  });
  assert.deepEqual(await returned, {
    outcome: 'returned',
    focused: false,
    reason: 'Activation was not granted.',
  });

  // Same conversations, IDs, order and no new turn: only the view moved.
  const after = f.sessions.snapshot();
  assert.deepEqual(
    after.map((session) => session.id),
    before.map((session) => session.id),
  );
  assert.equal(f.turns(), turnsBefore);
});

test('the panel refusals are reported honestly and never as success', async (context) => {
  const f = await fixture(context);

  for (const outcome of ['unsupported', 'unavailable', 'conflict'] as const) {
    const pending = f.present({ presentation: 'window' });
    const request = await f.nextEvent();
    await f.answer({ requestId: request.requestId, outcome, reason: 'Fixture reason.' });
    const result = await pending;
    assert.match(String(result.error), new RegExp(`Fixture reason\\. \\[${outcome}\\]$`));
  }
});

test('malformed, mismatched, wrong-client and duplicate answers are refused', async (context) => {
  const f = await fixture(context);
  const pending = f.present({ presentation: 'window' });
  const request = await f.nextEvent();

  const refused = [
    // Listener-only outcomes cannot be claimed by a panel.
    { requestId: request.requestId, outcome: 'offline' },
    { requestId: request.requestId, outcome: 'unconfirmed' },
    // shown/returned must state the observed focus; refusals must not.
    { requestId: request.requestId, outcome: 'shown' },
    { requestId: request.requestId, outcome: 'conflict', focused: false },
    // A sidebar outcome does not answer a window request.
    { requestId: request.requestId, outcome: 'returned', focused: false },
    // Unknown fields, oversized reasons, unknown requests.
    { requestId: request.requestId, outcome: 'shown', focused: true, id: f.other },
    { requestId: request.requestId, outcome: 'conflict', reason: 'x'.repeat(301) },
    { requestId: randomUUID(), outcome: 'shown', focused: true },
  ];
  for (const fields of refused) {
    assert.equal((await f.answer(fields)).type, 'error', JSON.stringify(fields));
  }

  // Another connection cannot answer for the panel that was asked.
  const stranger = await f.connect();
  stranger.send({
    action: 'agent-present-result',
    requestId: request.requestId,
    outcome: 'shown',
    focused: true,
  });
  await waitFor(() => stranger.received.join('').includes('This presentation request has expired'));

  // The asked panel answers once; a repeated answer is refused.
  await f.answer({ requestId: request.requestId, outcome: 'shown', focused: false });
  assert.deepEqual(await pending, { outcome: 'shown', focused: false, reason: '' });
  assert.equal(
    (await f.answer({ requestId: request.requestId, outcome: 'shown', focused: false })).type,
    'error',
  );
});

test('an id argument or invalid presentation is refused before anything is sent', async (context) => {
  const f = await fixture(context);

  const injected = await f.present({ presentation: 'window', id: f.other });
  assert.match(String(injected.error), /always acts on your own conversation \[invalid\]$/);
  assert.match(String((await f.present({ presentation: 'tab' })).error), /\[invalid\]$/);
  assert.match(
    String((await f.present({ presentation: 'window', focus: 'yes' })).error),
    /\[invalid\]$/,
  );
  assert.equal(f.events(), 0);
});

test('a repeated call is answered once, and the per-turn action budget applies', async (context) => {
  const f = await fixture(context);
  const callId = randomUUID();

  const first = f.present({ presentation: 'window' }, callId);
  const request = await f.nextEvent();
  const repeated = f.present({ presentation: 'window' }, callId);
  await f.answer({ requestId: request.requestId, outcome: 'shown', focused: false });
  assert.deepEqual(await first, await repeated);
  assert.equal(f.events(), 0);

  // Five more admitted actions use up the budget of six; the seventh is refused.
  for (let index = 0; index < 5; index++) {
    const pending = f.present({ presentation: 'sidebar' });
    const next = await f.nextEvent();
    await f.answer({ requestId: next.requestId, outcome: 'returned', focused: false });
    await pending;
  }
  assert.match(String((await f.present({ presentation: 'window' })).error), /\[limit\]$/);
  assert.equal(f.events(), 0);
});

test('disconnects, withdrawal, ended turns and external callers never fake success', async (context) => {
  const f = await fixture(context);

  // Capability withdrawn after transmission: unconfirmed, never retargeted.
  let pending = f.present({ presentation: 'window' });
  await f.nextEvent();
  f.desktop.send({
    action: 'panel-state',
    id: f.other,
    composerFocused: false,
    visible: true,
    draftHost: true,
  });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  assert.match(String((await pending).error), /no longer offers pop-out windows.*\[unconfirmed\]$/);

  // A connected panel without pop-out windows: unsupported, nothing sent.
  assert.match(String((await f.present({ presentation: 'window' })).error), /\[unsupported\]$/);
  assert.equal(f.events(), 0);

  // A second native panel that disconnects after receiving the request.
  const panel = await f.connect();
  panel.send({
    action: 'panel-state',
    id: '',
    composerFocused: false,
    visible: true,
    draftHost: true,
    popoutHost: true,
    rail: 'full',
    popouts: [],
  });
  await waitFor(() => panel.received.join('').includes('panel-recorded'));
  pending = f.present({ presentation: 'window' });
  await waitFor(() => panel.received.join('').includes('"type":"agent-present"'));
  panel.socket.destroy();
  assert.match(String((await pending).error), /disconnected before answering.*\[unconfirmed\]$/);

  // A remote (phone) panel never receives the request.
  const phone = await f.connect();
  phone.send({ action: 'client-role', role: 'remote' });
  await waitFor(() => phone.received.join('').includes('role-recorded'));

  // External (CLI) callers have no conversation of their own.
  const caller: ExternalCaller = {
    kind: 'external',
    label: 'Test',
    requestId: randomUUID(),
    signal: new AbortController().signal,
    delivered: new Set(),
  };
  const external = await f.sessions.sessionTools.external(caller, {
    method: 'present',
    presentation: 'window',
  });
  assert.equal(external.body.code, 'invalid');

  // The turn ends while a request is outstanding: unconfirmed.
  f.desktop.send({
    action: 'panel-state',
    id: f.other,
    composerFocused: false,
    visible: true,
    draftHost: true,
    popoutHost: true,
    rail: 'full',
    popouts: [],
  });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  pending = f.present({ presentation: 'window' });
  await f.nextEvent();
  f.endTurn();
  const ended = await pending;
  assert.match(String(ended.error), /\[(unconfirmed|expired)\]$/);
  assert.equal(phone.received.join('').includes('agent-present'), false);

  // After the turn ends, its lease cannot present anything.
  await f.sessions.idle();
  assert.match(String((await f.present({ presentation: 'window' })).error), /\[expired\]$/);
});

test('no native panel at all is offline, and nothing is sent', async (context) => {
  const f = await fixture(context);
  // The panel that announced the capability goes away before the call.
  f.desktop.client.destroy();
  await once(f.desktop.client, 'close');
  // Give the server its own close callback before calling.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(String((await f.present({ presentation: 'window' })).error), /\[offline\]$/);
});
