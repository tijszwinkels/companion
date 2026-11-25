// The rule of "Running without a desktop" (src/desktop/README.md) as one table
// of cases.
//
// The process tests start the real listener (`src/cli.ts --headless`) and the
// real gateway (`src/remote/cli.ts serve`) as child processes, with a PATH
// that holds only `node` and `flock`: no compositor, screenshot, typing,
// sound or PipeWire program can be found. The agent is the synthetic Claude
// Code fixture (test/fixtures/claude-stream.mjs); no model is called. All
// state lives in a temporary HOME and XDG_RUNTIME_DIR; the gateway binds a
// free loopback port.
//
// The agent-tool cases (panel browser, pop-out windows) need a turn that
// holds its tool lease open, so they use the runtime in-process
// (desktopFixture) with `headless: true`, against the same rule.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';
import {
  desktopPrograms,
  headlessMachine,
  interrupt,
  listenerArguments,
  printed,
  startChild,
  startHeadlessCompanion,
  withoutDesktop,
} from '../headless-fixture.ts';
import { connectPhone, type PhoneClient } from '../remote-fixture.ts';

/** A plain control-socket client, as a local panel would connect. */
async function controlClient(path: string) {
  const socket = createConnection(path);
  await once(socket, 'connect');
  const messages: Array<Record<string, unknown>> = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });

  return {
    socket,
    messages,
    async request(request: Record<string, unknown>) {
      const requestId = randomUUID();
      socket.write(JSON.stringify({ ...request, requestId }) + '\n');
      const matches = (message: Record<string, unknown>) => message.requestId === requestId;
      await waitFor(() => messages.some(matches), 5000);
      return messages.find(matches)!;
    },
  };
}

/** One remote request through the gateway, answered with its reply. */
async function remote(phone: PhoneClient, request: Record<string, unknown>) {
  const requestId = randomUUID();
  phone.send({ requestId, ...request });
  return (await phone.reply(requestId, 10000)) as {
    type: string;
    result?: unknown;
    message?: string;
  };
}

test('--headless cannot be combined with options that need the desktop or speech', async (context) => {
  const machine = await headlessMachine(context);

  const conflicting = [
    ['--text', 'Synthetic words'],
    ['--wav', 'test/fixtures/speech.wav'],
    ['--device', 'synthetic'],
    ['--seconds', '1'],
    ['--preview'],
    ['--graph', 'json'],
    ['--paused'],
    ['--no-desktop'],
    ['--no-startup-capture'],
    ['--phone'],
  ];

  // Each refusal comes before anything is opened; they can run together.
  const results = await Promise.all(
    conflicting.map(async (options) => {
      const child = startChild(
        process.execPath,
        listenerArguments(machine.config, ['--headless', ...options]),
        machine.env,
      );
      const code = await child.exited;
      return { options, code, output: child.output() };
    }),
  );

  for (const { options, code, output } of results) {
    assert.equal(code, 1, options.join(' '));
    assert.match(output, new RegExp(`--headless cannot be combined with ${options[0]}`));
  }

  // Without a runtime directory the reason names it, not --no-desktop.
  const withoutRuntime = { ...machine.env };
  delete withoutRuntime.XDG_RUNTIME_DIR;
  const child = startChild(
    process.execPath,
    listenerArguments(machine.config, ['--headless']),
    withoutRuntime,
  );
  assert.equal(await child.exited, 1);
  assert.match(child.output(), /--headless needs XDG_RUNTIME_DIR/);
  assert.doesNotMatch(child.output(), /--no-desktop/);
});

test('without a desktop: conversations work through the gateway, desktop abilities are refused with their reason', async (context) => {
  const machine = await headlessMachine(context);

  for (const program of desktopPrograms) {
    const lookup = startChild('/usr/bin/which', [program], machine.env);
    assert.notEqual(await lookup.exited, 0, `${program} must not be on the test PATH`);
  }

  // The listener and gateway, as the running Companion on a server starts them.
  const { listener, gateway, port, origin, pairingCode } = await startHeadlessCompanion(
    context,
    machine,
  );

  // Pair as a user would: a code from `companion-remote pair`, then the
  // browser's exchange for a device token.
  const paired = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ code: await pairingCode(), name: 'Synthetic browser' }),
  });
  assert.equal(paired.status, 200);
  const { token } = (await paired.json()) as { token: string };

  const phone = await connectPhone(`ws://127.0.0.1:${port}/api/socket`, token, origin);
  context.after(async () => {
    phone.socket.terminate();
  });

  // The honest state: listening paused, no sound, no media pause, no
  // microphone switch, no intent switches.
  const state = await phone.engine('state');
  assert.equal(state.ready, true);
  assert.equal(state.paused, true);
  assert.equal(state.soundsEnabled, false);
  assert.equal(state.microphones, undefined);
  assert.deepEqual(state.intents, []);

  // Desktop abilities, asked for by the paired browser.
  const remoteRefusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: 'toggle-pause' }, /has no microphone: listening stays off/],
    [{ action: 'toggle-sounds' }, /has no sound feedback/],
    [{ action: 'set-computer-microphone', enabled: true }, /has no microphone of its own/],
    [{ action: 'audio-start' }, /Listening here is not available/],
  ];
  for (const [request, reason] of remoteRefusals) {
    const reply = await remote(phone, request);
    assert.equal(reply.type, 'error', String(request.action));
    assert.match(String(reply.message), reason, String(request.action));
  }

  // The same abilities and the local-only ones, asked for by a local client.
  const local = await controlClient(machine.controlSocket);
  context.after(async () => {
    local.socket.destroy();
  });

  // Its first snapshot already says paused; no cleanup switch is offered.
  await waitFor(() => local.messages.some((message) => message.type === 'state'), 5000);
  const firstState = local.messages.find((message) => message.type === 'state')!;
  assert.equal(firstState.paused, true);
  assert.equal(firstState.transcriptionCleanup, null);

  const localRefusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: 'toggle-pause' }, /has no microphone: listening stays off/],
    [{ action: 'toggle-sounds' }, /has no sound feedback/],
    [{ action: 'set-computer-microphone', enabled: true }, /has no microphone of its own/],
    [{ action: 'start-recording', id: randomUUID(), draftLength: 0 }, /no microphone to record/],
    [{ action: 'stop-recording' }, /no microphone to record/],
    [{ action: 'recording-append-result', recordingId: 'x' }, /no microphone to record/],
    [{ action: 'paste', id: randomUUID(), target: '0x1' }, /cannot type into applications/],
    [
      { action: 'submit-utterance', text: 'Synthetic', target: '0x1' },
      /cannot type into applications/,
    ],
    [{ action: 'media-playback', playing: true }, /does not pause for media playback/],
  ];
  for (const [request, reason] of localRefusals) {
    const reply = await local.request(request);
    assert.equal(reply.type, 'error', String(request.action));
    assert.match(String(reply.message), new RegExp(withoutDesktop), String(request.action));
    assert.match(String(reply.message), reason, String(request.action));
  }

  // Nothing above changed the state.
  const after = await local.request({ action: 'toggle-sounds' });
  assert.equal(after.type, 'error');
  const latest = [...local.messages].reverse().find((message) => message.type === 'state');
  assert.equal(latest?.paused, true);
  assert.equal(latest?.soundsEnabled, false);
  assert.equal(latest?.mediaPauseAvailable, false);

  // A typed conversation, answered by the synthetic Claude Code.
  const started = await remote(phone, {
    action: 'start-agent',
    text: 'Plan the synthetic trip',
    profile: 'coding',
  });
  assert.equal(started.type, 'result');
  const id = (started.result as { id: string }).id;
  // Session events are incremental: a finished turn is `completed`, and the
  // history counts the user's messages and the agent's answers.
  const answered = (historyTotal: number) =>
    phone.engine(
      'agent-session',
      (event) =>
        event.session.id === id &&
        event.session.status === 'completed' &&
        event.session.history.total === historyTotal,
    );
  const first = await answered(2);
  assert.equal(first.session.harness, 'claude-code');
  await printed(listener, 'answer       ## Answer **42**');

  // A follow-up in the same conversation.
  const followUp = await remote(phone, { action: 'send-agent', id, text: 'And the way back?' });
  assert.equal(followUp.result, 'submitted');
  await answered(4);

  // Stop a turn that keeps running.
  phone.messages.length = 0;
  assert.equal((await remote(phone, { action: 'panel-state', id })).type, 'result');
  assert.equal((await remote(phone, { action: 'send-agent', id, text: 'stall' })).type, 'result');
  const running = await phone.engine(
    'remote-agent-actions',
    (event) => event.actions.sessionId === id && event.actions.stopRunId !== '',
  );
  // Stop once the agent streams, as a reader would: a Stop before Claude Code
  // has answered its settings leaves a startup deadline behind that keeps
  // the listener alive for a minute after Ctrl+C (an existing fault of the
  // Claude Code backend, recorded in the handoff, not this mode's).
  await phone.engine(
    'agent-session',
    (event) =>
      event.session.id === id &&
      event.session.messages.some((message: { text: string }) => message.text === 'Partial'),
  );
  const stoppedRun = await remote(phone, {
    action: 'stop-agent-run',
    id,
    runId: running.actions.stopRunId,
  });
  assert.equal(stoppedRun.result, 'stopped');
  const afterStop = await phone.engine(
    'agent-session',
    (event) => event.session.id === id && !['starting', 'running'].includes(event.session.status),
  );
  assert.equal(afterStop.session.status, 'cancelled');

  // Close, then reopen from Previous sessions. Earlier events are dropped,
  // so only the reopened conversation's own event can match.
  assert.match(String((await remote(phone, { action: 'close-agent', id })).result), /^closed/);
  await phone.engine('agent-removed', (event) => event.id === id);
  phone.messages.length = 0;
  assert.equal((await remote(phone, { action: 'reopen-agent', id })).result, 'reopened');
  await phone.engine('agent-restored', (event) => event.session.id === id);

  // Nothing in the listener's log is an error; it stops cleanly on SIGINT.
  assert.doesNotMatch(listener.output(), / error /);
  assert.equal(await interrupt(gateway), 0);
  local.socket.destroy();
  assert.equal(await interrupt(listener), 0);
  assert.match(listener.output(), /stopped\s+Capture and processing stopped/);
});

/**
 * A conversation whose turn holds its tool lease open while the test calls
 * its tools, the runtime started headless, and a local client that claims to
 * be a panel with a browser and pop-out windows (so the tools would reach it
 * on a desktop).
 */
async function agentToolFixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-headless-tools-'));
  let desktop: Awaited<ReturnType<typeof desktopFixture>> | undefined;
  let releaseTurn: () => void = () => {};
  context.after(async () => {
    releaseTurn();
    await Promise.allSettled([desktop?.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let lease: { endpoint: string; token: string; capabilities?: readonly string[] } | undefined;
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'headless-tool-fixture',
        label: 'Headless tool fixture',
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
  desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions, {
    headless: true,
  });

  const other = sessions.start({ ...frame, utterance: 'Other' }, signal());
  await sessions.idle();
  desktop.send({
    action: 'panel-state',
    id: other,
    composerFocused: false,
    visible: true,
    draftHost: true,
    browserHost: true,
    popoutHost: true,
    rail: 'full',
    popouts: [],
  });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');

  sessions.start({ ...frame, utterance: 'Requester' }, signal());
  await waitFor(() => lease !== undefined);
  const tools = sessionTools(lease!.endpoint, lease!.token, lease!.capabilities);

  return {
    desktop,
    async call(name: string, parameters: Record<string, unknown>) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is offered`);
      try {
        await tool.execute(randomUUID(), parameters as never);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    },
  };
}

test('without a desktop an agent hears why the panel browser and pop-out windows are absent', async (context) => {
  const f = await agentToolFixture(context);

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'companion_browser_open',
      { url: 'https://example.com/' },
      /This Companion runs without a desktop; it has no panel browser\. \[unsupported\]$/,
    ],
    [
      'companion_session_present',
      { presentation: 'window' },
      /This Companion runs without a desktop; it has no conversation windows\. \[unsupported\]$/,
    ],
  ];
  for (const [name, parameters, reason] of cases) {
    assert.match(await f.call(name, parameters), reason, name);
  }

  // Neither request reached the panel.
  assert.ok(
    !f.desktop.messages.some(
      (message) => message.type === 'agent-browser-open' || message.type === 'agent-present',
    ),
  );
});

test('with a desktop the same runtime keeps Pause, Resume and sound feedback', async (context) => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'));
  context.after(() => desktop.close());

  desktop.send({ action: 'toggle-pause' });
  assert.equal((await desktop.reply('toggle-pause')).result, 'paused');
  desktop.send({ action: 'toggle-pause' });
  assert.equal((await desktop.reply('toggle-pause')).result, 'listening');
  desktop.send({ action: 'toggle-sounds' });
  assert.equal((await desktop.reply('toggle-sounds')).result, 'sounds-enabled');
});
