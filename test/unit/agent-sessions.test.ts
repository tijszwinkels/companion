import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PiBackend } from '../../src/agents/pi-backend.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings, loadAgentSettings } from '../../src/agents/settings.ts';
import { PiTranscript } from '../../src/agents/pi-transcript.ts';
import type { AgentBackend, AgentMessage, SessionEvent } from '../../src/agents/types.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { frame, signal, testDetector } from '../helpers.ts';
import { desktopFixture, stopped, waitFor, windowReply } from '../desktop-fixture.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';

async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-agent-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fixture-pi');
  await copyFile(fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url)), executable);
  await chmod(executable, 0o700);
  const settings = { ...defaultAgentSettings, executable };
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(settings));
  return { directory, settings };
}

test('headless Pi receives the exact screenshot, streams tools/text, and waits through retries', async (context) => {
  const { directory, settings } = await fixture(context);
  const updates: AgentMessage[] = [];
  const started = Date.now();
  let firstText = 0;
  await new PiBackend().run(
    {
      id: 'test-session',
      directory,
      settings,
      prompt: { text: frame.utterance, screenshot: frame.screenshot },
      resume: false,
    },
    signal(),
    (message) => {
      updates.push(message);
      if (!firstText) {
        firstText = Date.now();
      }
    },
  );
  assert.ok(firstText >= started);
  assert.ok(Date.now() - firstText >= 100, 'text arrived before the run settled');
  const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  assert.ok(captured.argv.includes('--mode'));
  assert.ok(captured.argv.includes('rpc'));
  assert.ok(captured.argv.includes('medium'));
  assert.ok(captured.request.message.startsWith(frame.utterance));
  assert.deepEqual(Buffer.from(captured.request.images[0].data, 'base64'), frame.screenshot.png);
  assert.equal(updates[0].text, 'First 🙂\u2028line');
  assert.equal(updates.at(-1)?.text, '## Answer\n**42**');
  assert.equal(
    updates.filter((message) => message.kind === 'tool').at(-1)?.text,
    'complete tool output',
  );
  assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
});

test('cancellation persists a partial answer, requests abort, and reaps the child', async (context) => {
  const { directory, settings } = await fixture(context);
  const controller = new AbortController();
  const run = new PiBackend().run(
    { id: 'cancel', directory, settings, prompt: { text: 'stall' }, resume: false },
    controller.signal,
    () => controller.abort(),
  );
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(await readFile(join(directory, 'aborted'), 'utf8'), 'yes');
  const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
});

for (const [utterance, expected] of [
  ['reject', /fixture rejection/],
  ['exit', /exited before finishing/],
  ['error', /fixture model failure/],
  ['dialog', /interactive dialog/],
] as const) {
  test(`Pi ${utterance} becomes a visible failure`, async (context) => {
    const { directory, settings } = await fixture(context);
    await assert.rejects(
      new PiBackend().run(
        { id: 'failed', directory, settings, prompt: { text: utterance }, resume: false },
        signal(),
        () => {},
      ),
      expected,
    );
  });
}

test('question handoff frees the router, preserves screenshot, and can be stopped independently', async (context) => {
  const { directory } = await fixture(context);
  let received: Parameters<AgentBackend['run']>[0] | undefined;
  let agentSignal: AbortSignal | undefined;
  const backend: AgentBackend = {
    id: 'fake-agent',
    label: 'Fixture',
    dependencies: {},
    async run(request, signal, emit) {
      received = request;
      agentSignal = signal;
      emit({
        id: 'answer',
        kind: 'assistant',
        text: 'A partial answer',
        toolName: '',
        input: '',
        state: 'running',
        screenshot: false,
      });
      await stopped(signal);
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => sessions.close());
  const events: SessionEvent[] = [];
  sessions.subscribe((event) => events.push(event));
  const router = new UserSensorRouter(
    {
      detector: testDetector({ detect: async () => assert.fail('Prefix should bypass inference') }),
    },
    () => {},
  );
  new StartCodingAgentSession({ sessions }, () => {}).subscribe(router);
  const microphone = new AbortController();
  await router.route({ ...frame, utterance: 'quick question What is this?' }, microphone.signal);
  await waitFor(() => received !== undefined);
  assert.equal(received!.prompt.text, 'What is this?');
  assert.equal(received!.prompt.screenshot, frame.screenshot);
  microphone.abort();
  assert.equal(
    agentSignal!.aborted,
    false,
    'pausing the microphone must leave the accepted agent running',
  );
  const id = sessions.snapshot()[0].id;
  await sessions.stop(id);
  assert.equal(sessions.snapshot()[0].status, 'cancelled');
  assert.equal(sessions.snapshot()[0].messages.at(-1)?.state, 'error');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'agent-session' &&
        event.session.messages.some((message) => message.kind === 'assistant'),
    ),
  );
  await sessions.remove(id);
  assert.deepEqual(sessions.snapshot(), []);
  assert.equal(events.at(-1)?.type, 'agent-removed');
});

test('preview and pre-handoff cancellation never launch an agent', async (context) => {
  const { directory } = await fixture(context);
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'unused',
        label: 'Unused',
        dependencies: {},
        run: async () => assert.fail('Should not launch'),
      },
    },
    () => {},
    directory,
  );
  const outcomes: string[] = [];
  const processor = new StartCodingAgentSession({ sessions }, () => {}, true, {
    outcome: (_id, outcome) => outcomes.push(outcome),
  });
  await processor.process(frame, signal());
  assert.deepEqual(outcomes, ['preview']);
  assert.deepEqual(sessions.snapshot(), []);
  await assert.rejects(processor.process(frame, AbortSignal.abort()));
});

test('settings retain user edits and are re-read for the next question', async (context) => {
  const { directory } = await fixture(context);
  const path = join(directory, 'companion-agent.json');
  await writeFile(path, JSON.stringify({ ...defaultAgentSettings, thinking: 'low' }));
  assert.equal((await loadAgentSettings(directory)).thinking, 'low');
  await writeFile(path, JSON.stringify({ ...defaultAgentSettings, thinking: 'unsupported' }));
  await assert.rejects(loadAgentSettings(directory), /unsupported thinking/);
});

test('authoritative final text reconciles deltas, and a successful retry clears a failed turn', () => {
  const messages: AgentMessage[] = [];
  const transcript = new PiTranscript((message) => messages.push(message));
  transcript.receive({ type: 'message_start', message: { role: 'assistant' } });
  transcript.receive({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
  });
  transcript.receive({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'retry me',
      content: [{ type: 'text', text: 'corrected partial' }],
    },
  });
  assert.equal(messages.at(-1)?.text, 'corrected partial');
  assert.equal(transcript.failure, 'retry me');
  transcript.receive({ type: 'message_start', message: { role: 'assistant' } });
  transcript.receive({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'recovered' }],
    },
  });
  assert.equal(transcript.failure, '');
});

test('desktop clients receive question updates, snapshots, and independent stop/close controls', async (context) => {
  const { directory } = await fixture(context);
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'socket-fixture',
        label: 'Socket fixture',
        dependencies: {},
        async run(_request, signal, emit) {
          emit({
            id: 'answer',
            kind: 'assistant',
            text: 'Streaming answer',
            toolName: '',
            input: '',
            state: 'running',
            screenshot: false,
          });
          await stopped(signal);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => Buffer.from(''), sessions);
  context.after(() => desktop.close());
  const id = sessions.start(frame, signal());
  await waitFor(() =>
    desktop.messages.some(
      (message) =>
        message.type === 'agent-session' &&
        message.session?.messages.some((entry) => entry.kind === 'assistant'),
    ),
  );
  desktop.send({ action: 'toggle-pause' });
  assert.equal((await desktop.reply('toggle-pause')).result, 'paused');
  assert.equal(sessions.snapshot()[0].status, 'running');
  await waitFor(() =>
    desktop.messages.some(
      (message) =>
        message.type === 'state' &&
        message.sessions?.[0]?.messages.some((entry) => entry.text === 'Streaming answer'),
    ),
  );
  desktop.send({ action: 'stop-agent', id });
  assert.equal((await desktop.reply('stop-agent')).result, 'stopped');
  assert.equal(sessions.snapshot()[0].status, 'cancelled');
  desktop.send({ action: 'send-agent', id, text: 'A follow-up in the same tab' });
  assert.equal((await desktop.reply('send-agent')).result, 'submitted');
  await waitFor(() => sessions.snapshot()[0].status === 'running');
  assert.equal(
    sessions.snapshot()[0].messages.filter((message) => message.kind === 'user').length,
    2,
  );
  desktop.send({ action: 'close-agent', id });
  assert.equal((await desktop.reply('close-agent')).result, 'closed');
  await waitFor(() => desktop.messages.some((message) => message.type === 'agent-removed'));
  assert.deepEqual(sessions.snapshot(), []);
});

test('follow-ups reuse the conversation, omit a new screenshot, and preserve earlier answer IDs', async (context) => {
  const { directory } = await fixture(context);
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'resume-fixture',
        label: 'Resume fixture',
        dependencies: {},
        async run(request, _signal, emit) {
          requests.push(request);
          emit({
            id: 'same-backend-id',
            kind: 'assistant',
            text: `Answer ${requests.length}`,
            toolName: '',
            input: '',
            state: 'done',
            screenshot: false,
          });
        },
      },
    },
    () => {},
    directory,
  );
  const id = sessions.start(frame, signal());
  await sessions.idle();
  sessions.followUp(id, 'Explain that further', signal());
  await sessions.idle();
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].resume, false);
  assert.equal(requests[1].resume, true);
  assert.equal(requests[1].prompt.screenshot, undefined);
  const answers = sessions.snapshot()[0].messages.filter((message) => message.kind === 'assistant');
  assert.deepEqual(
    answers.map((message) => message.text),
    ['Answer 1', 'Answer 2'],
  );
  assert.notEqual(answers[0].id, answers[1].id);
  assert.throws(() => sessions.followUp(id, 'x'.repeat(4001), signal()), /1–4000/);
  await sessions.close();
});

test('Pi refuses to silently create an empty conversation for a follow-up', async (context) => {
  const { directory, settings } = await fixture(context);
  await assert.rejects(
    new PiBackend().run(
      {
        id: 'missing-conversation',
        directory,
        settings,
        prompt: { text: 'What did I ask before?' },
        resume: true,
      },
      signal(),
      () => {},
    ),
    /saved transcript is missing or empty/,
  );
});

test('composer focus changes block pending typing and suppress Enter even if activewindow is unchanged', async (context) => {
  const { directory } = await fixture(context);
  const sessions = new AgentSessions(
    { backend: { id: 'focus-fixture', label: 'Focus', dependencies: {}, run: async () => {} } },
    () => {},
    directory,
  );
  const id = sessions.start(frame, signal());
  await sessions.idle();
  const desktop = await desktopFixture(async () => Buffer.from(''), sessions);
  context.after(() => desktop.close());
  const activity = desktop.runtime.activity;
  activity.processing?.(frame.id);
  desktop.send({ action: 'composer-focus', id });
  await desktop.reply('composer-focus');
  assert.equal(activity.deliveryAllowed?.(frame.id), false);
  activity.finished?.(frame.id);

  activity.processing?.(frame.id);
  const typed: string[][] = [];
  const processor = new EnterTextToApplication(
    () => {},
    false,
    async (binary, args) => {
      if (binary === 'hyprctl') {
        return windowReply();
      }
      typed.push(args);
      desktop.send({ action: 'composer-focus', id: '' });
      await desktop.reply('composer-focus');
      return Buffer.from('');
    },
    activity,
  );
  await assert.rejects(processor.process(frame, signal()), (error: unknown) => {
    assert.match(String((error as Error).cause), /Focus changed after typing/);
    return true;
  });
  assert.equal(
    typed.length,
    1,
    'Only text was typed; Return must not reach the previous application',
  );
  activity.finished?.(frame.id);
});
