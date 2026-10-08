import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { PiBackend } from '../../src/agents/pi-backend.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings, loadAgentSettings } from '../../src/agents/settings.ts';
import { PiTranscript } from '../../src/agents/pi-transcript.ts';
import type { AgentBackend, AgentMessage, SessionEvent } from '../../src/agents/types.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { frame, signal, testDetector } from '../helpers.ts';
import { desktopFixture, stopped, waitFor, windowReply } from '../desktop-fixture.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import type { AgentChoice } from '../../src/agents/choices.ts';

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

test('Pi loads the native choice extension and accepts only correlated successful results', async (context) => {
  const { directory, settings } = await fixture(context);
  const offered: (readonly AgentChoice[])[] = [];
  const backend = new PiBackend();
  const request = {
    id: 'choices',
    directory,
    settings,
    prompt: { text: 'choices' },
    resume: false,
  };
  await backend.run(
    request,
    signal(),
    () => {},
    (options) => offered.push(options),
  );
  assert.deepEqual(offered, [
    [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
    [{ label: 'Tests', description: 'Run the tests' }],
  ]);
  const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  assert.equal(
    captured.argv[captured.argv.indexOf('--extension') + 1],
    fileURLToPath(new URL('../../src/agents/choice-tool.ts', import.meta.url)),
  );

  const cleared: (readonly AgentChoice[])[] = [];
  await backend.run(
    { ...request, prompt: { text: 'choices clear' } },
    signal(),
    () => {},
    (options) => cleared.push(options),
  );
  assert.deepEqual(cleared.at(-1), []);
});

for (const failure of ['malformed', 'missing', 'version']) {
  test(`Pi preserves the answer when choice metadata is ${failure}`, async (context) => {
    const { directory, settings } = await fixture(context);
    const sessions = new AgentSessions({ pi: new PiBackend() }, () => {}, directory);
    context.after(() => sessions.close());
    const id = sessions.start({ ...frame, utterance: `choices ${failure}` }, signal());
    await sessions.idle();
    const view = sessions.snapshot().find((session) => session.id === id)!;
    assert.equal(view.status, 'completed');
    assert.equal(view.error, '');
    assert.equal(view.choices, undefined, 'An invalid replacement clears the old options');
    assert.equal(
      view.messages.filter((message) => message.kind === 'assistant').at(-1)?.text,
      '## Answer\n**42**',
    );
    assert.equal(view.messages.filter((message) => message.kind === 'notice').length, 1);
    assert.match(view.messages.find((message) => message.kind === 'notice')!.text, /choices/i);
  });
}

for (const variant of ['success', 'invalid', 'timeout', 'exit']) {
  test(`Pi native name ${variant}: session state is authoritative and cannot lose the answer`, async (context) => {
    const { directory } = await fixture(context);
    const sessions = new AgentSessions({ pi: new PiBackend() }, () => {}, directory);
    context.after(() => sessions.close());
    const utterance = `native-name ${variant}`;
    sessions.start({ ...frame, utterance }, signal());
    await sessions.idle();
    const view = sessions.snapshot()[0];
    assert.equal(view.status, 'completed');
    assert.equal(view.title, variant === 'invalid' ? utterance : '🐛 Login fix');
    assert.equal(view.messages.at(-1)?.text, '## Answer\n**42**');
    const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
    assert.ok(
      captured.argv.includes(
        fileURLToPath(new URL('../../src/agents/session-name-tool.ts', import.meta.url)),
      ),
    );
    assert.ok(
      captured.argv.includes(
        fileURLToPath(new URL('../../src/agents/live-state-owner-extension.ts', import.meta.url)),
      ),
      'every Companion Pi process marks its transcript as Companion-driven',
    );
    assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
  });
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

for (const ending of ['success', 'cancel'] as const) {
  test(`Pi ${ending} settles even when a detached descendant retains its output pipes`, async (context) => {
    const { directory, settings } = await fixture(context);
    const controller = new AbortController();
    let holderPid: number | undefined;
    let settled = false;
    let failure: unknown;

    const run = new PiBackend()
      .run(
        {
          id: 'pipe-holder',
          directory,
          settings,
          prompt: { text: `inherited-pipe ${ending}` },
          resume: false,
        },
        controller.signal,
        () => {},
      )
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });

    try {
      // Wait for the real child to create its descendant, not a guessed delay.
      const until = Date.now() + 3000;
      while (holderPid === undefined) {
        try {
          const candidate = Number(await readFile(join(directory, 'holder.pid'), 'utf8'));
          // A read can race the file's initial write. Never interpret an empty
          // file as PID 0, which would target the test runner's process group.
          if (Number.isInteger(candidate) && candidate > 1) {
            holderPid = candidate;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        if (holderPid === undefined) {
          assert.ok(Date.now() < until, 'Fixture did not create the pipe holder');
          await delay(10);
        }
      }

      if (ending === 'cancel') {
        controller.abort();
      }
      await waitFor(() => settled, 3000);
      assert.equal(
        failure instanceof Error ? failure.name : failure,
        ending === 'cancel' ? 'AbortError' : undefined,
      );
      const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
      assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
      process.kill(holderPid, 0); // The escaped process still owns its pipe ends.
    } finally {
      // The test owns the deliberately escaped process, including on failure.
      // Killing it also unblocks the old implementation, so regression failure
      // does not leave an orphan or hang the test runner.
      if (holderPid !== undefined) {
        process.kill(holderPid, 'SIGKILL');
      }
      controller.abort();
      await run;
    }
  });
}

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
  const sessions = new AgentSessions({ pi: backend }, () => {}, directory);
  context.after(() => sessions.close());
  const events: SessionEvent[] = [];
  sessions.subscribe((event) => events.push(event));
  const router = new UserSensorRouter(
    {
      detector: testDetector({ detect: async () => assert.fail('Prefix should bypass inference') }),
    },
    () => {},
  );
  new QuickQuestion({ sessions }, () => {}).subscribe(router);
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
  assert.equal(events.at(-3)?.type, 'agent-removed');
  assert.equal(events.at(-2)?.type, 'agent-history');
  assert.equal(events.at(-1)?.type, 'agent-order');
});

test('preview and pre-handoff cancellation never launch an agent', async (context) => {
  const { directory } = await fixture(context);
  const sessions = new AgentSessions(
    {
      pi: {
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
      pi: {
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
  assert.equal(sessions.previousSnapshot()[0].id, id);
  desktop.send({ action: 'toggle-pause' });
  await desktop.reply('toggle-pause');
  await waitFor(() => desktop.messages.some((message) => message.previousSessions?.[0]?.id === id));
  const snapshot = desktop.messages.find((message) => message.previousSessions?.[0]?.id === id)!;
  assert.deepEqual(snapshot.sessions, []);
  assert.equal('messages' in snapshot.previousSessions![0], false);
  desktop.send({ action: 'reopen-agent', id });
  assert.equal((await desktop.reply('reopen-agent')).result, 'reopened');
  assert.equal(sessions.snapshot()[0].id, id);
  assert.equal(
    sessions.snapshot()[0].messages.filter((message) => message.kind === 'user').length,
    2,
  );
  await waitFor(() => desktop.messages.some((message) => message.type === 'agent-restored'));
  desktop.send({ action: 'reopen-agent', id: 'missing' });
  assert.equal((await desktop.reply('reopen-agent')).type, 'error');
});

test('follow-ups reuse the conversation, omit a new screenshot, and preserve earlier answer IDs', async (context) => {
  const { directory } = await fixture(context);
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      pi: {
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
    { pi: { id: 'focus-fixture', label: 'Focus', dependencies: {}, run: async () => {} } },
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

test('model switching accepts Pi disabling unsupported reasoning but rejects other thinking drift', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new PiBackend();
  await backend.run(
    {
      id: 'non-reasoning',
      directory,
      settings: { ...settings, model: 'configured/non-reasoning', thinking: 'medium' },
      prompt: { text: 'Synthetic answer' },
      resume: false,
    },
    signal(),
    () => {},
  );
  const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  assert.equal(captured.request.message, 'Synthetic answer');
  await rm(join(directory, 'request.json'));
  await assert.rejects(
    backend.run(
      {
        id: 'wrong-thinking',
        directory,
        settings: { ...settings, model: 'configured/wrong-thinking', thinking: 'medium' },
        prompt: { text: 'Must not send' },
        resume: false,
      },
      signal(),
      () => {},
    ),
    /expected configured\/wrong-thinking \(medium\)/,
  );
  await assert.rejects(readFile(join(directory, 'request.json')), { code: 'ENOENT' });
});

test('model switching accepts Pi clamping inherited off upward and unsupported high effort downward', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new PiBackend();
  for (const [model, thinking] of [
    ['requires-thinking', 'off'],
    ['requires-thinking', 'max'],
    ['limited-thinking', 'max'],
  ] as const) {
    await backend.run(
      {
        id: model,
        directory,
        settings: { ...settings, model: `configured/${model}`, thinking },
        prompt: { text: 'Synthetic answer' },
        resume: false,
      },
      signal(),
      () => {},
    );
    const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
    assert.equal(captured.request.message, 'Synthetic answer');
    assert.equal(captured.argv[captured.argv.indexOf('--thinking') + 1], thinking);
    await rm(join(directory, 'request.json'));
  }
});
