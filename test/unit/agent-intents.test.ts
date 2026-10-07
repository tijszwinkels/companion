import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings, defaultQuickQuestionSettings } from '../../src/agents/settings.ts';
import { chatMessage, type AgentBackend } from '../../src/agents/types.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import type { InteractionContext, UserSensorFrame } from '../../src/core/frame.ts';
import { CloseAgentSession } from '../../src/processors/close-agent-session.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, signal, testDetector, testSensors } from '../helpers.ts';

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  respond?: AgentBackend['run'],
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-agent-intents-'));
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'intent-fixture',
        label: 'Intent fixture',
        dependencies: {},
        async run(request, signal, emit, publishChoices, renameSession) {
          requests.push(request);
          await respond?.(request, signal, emit, publishChoices, renameSession);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(
    async () => assert.fail('No keyboard or desktop command'),
    sessions,
  );
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = sessions.start(frame, signal());
  await sessions.idle();
  const activity = desktop.runtime.activity;
  const outcomes: string[] = [];
  const feedback = {
    ...activity,
    outcome: (_id: number, outcome: string) => outcomes.push(outcome),
  };
  const continuation = new ContinueOpenAgentConversation({ sessions }, () => {}, false, feedback);

  async function select(id: string, composerFocused: boolean) {
    desktop.send({ action: 'panel-state', id, composerFocused });
    assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');
  }

  return { sessions, requests, desktop, first, activity, feedback, continuation, outcomes, select };
}

for (const profile of ['coding', 'quickQuestion'] as const) {
  test(`unfocused inferred continuation preserves the ${profile} model profile, including reopened sessions`, async (context) => {
    const setup = await fixture(context);
    const id = setup.sessions.start(
      { ...frame, utterance: 'Selected conversation' },
      signal(),
      profile,
    );
    await setup.sessions.idle();
    const model =
      profile === 'coding' ? defaultAgentSettings.model : defaultQuickQuestionSettings.model;
    const router = new UserSensorRouter(
      {
        detector: testDetector({
          async detect(input, intents) {
            assert.equal(input.interaction!.agentConversation!.title, 'Selected conversation');
            assert.ok(intents.some((intent) => intent.name === setup.continuation.name));
            return setup.continuation.name;
          },
        }),
      },
      () => {},
    );
    new Ignore(() => {}).subscribe(router);
    setup.continuation.subscribe(router);

    for (const reopened of [false, true]) {
      if (reopened) {
        await setup.sessions.remove(id);
        await setup.sessions.reopen(id);
      }
      await setup.select(id, false);
      await router.route({ ...frame, interaction: setup.activity.interactionContext!() }, signal());
      await setup.sessions.idle();

      const request = setup.requests.at(-1)!;
      assert.equal(request.id, id);
      assert.equal(request.resume, true);
      assert.equal(request.settings.model, model);
      assert.equal(request.prompt.screenshot, undefined);
      assert.equal(
        setup.sessions.snapshot().find((session) => session.id === id)!.profile,
        profile,
      );
    }
  });
}

test('capture freezes the selected title and excerpts before screen capture and delayed ASR', async (context) => {
  let emitMessage: Parameters<AgentBackend['run']>[2] | undefined;
  let renameSession: Parameters<AgentBackend['run']>[4];
  const setup = await fixture(context, async (request, signal, emit, _publish, rename) => {
    rename?.('Captured title');
    if (!request.resume) {
      emit(chatMessage('opening', 'assistant', 'Opening answer'));
      return;
    }

    emitMessage = emit;
    renameSession = rename;
    emit({ ...chatMessage('partial', 'assistant', 'Partial answer'), state: 'running' });
    await stopped(signal);
  });
  await setup.select(setup.first, false);
  setup.sessions.followUp(setup.first, 'Before speech', signal());
  await waitFor(() => emitMessage !== undefined);
  setup.sessions.followUp(setup.first, 'Already queued', signal());

  const transcription = deferred<string>();
  const received: UserSensorFrame[] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect(input) {
          received.push(input);
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  new Ignore(() => {}).subscribe(router);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          // Even changes during screenshot capture must not rewrite the copied
          // conversation. The backend deliberately updates an existing bubble.
          renameSession!('Later title');
          emitMessage!({
            ...chatMessage('partial', 'assistant', 'Later answer'),
            state: 'running',
          });
          setup.sessions.followUp(setup.first, 'Queued later', signal());
          return frame.screenshot;
        },
        transcribe: async () => transcription.promise,
      }),
      router,
    },
    () => {},
    signal(),
    { interactionContext: setup.activity.interactionContext },
  );

  assert.equal(pipeline.submit(new Float32Array(16000)), true);
  assert.equal(received.length, 0);
  transcription.resolve('Can you explain that?');
  await pipeline.idle();

  assert.equal(pipeline.failures, 0);
  assert.equal(received.length, 1);
  const captured = received[0].interaction!;
  assert.deepEqual(captured.agentConversation, {
    title: 'Captured title',
    titleTruncated: false,
    totalMessages: 5,
    messages: [
      { position: 1, role: 'user', state: 'done', text: frame.utterance, truncated: false },
      { position: 2, role: 'assistant', state: 'done', text: 'Opening answer', truncated: false },
      {
        position: 4,
        role: 'assistant',
        state: 'running',
        text: 'Partial answer',
        truncated: false,
      },
      { position: 5, role: 'user', state: 'queued', text: 'Already queued', truncated: false },
    ],
  });
  assert.equal(setup.activity.interactionCurrent!(captured), true);
  const next = setup.activity.interactionContext!();
  assert.equal(next.agentConversation!.title, 'Later title');
  assert.equal(next.agentConversation!.totalMessages, 6);
  assert.equal(next.agentConversation!.messages.at(-1)!.text, 'Queued later');
});

test('retained or previous sessions and legacy composer focus do not supply conversation excerpts', async (context) => {
  const setup = await fixture(context);
  assert.equal(setup.activity.interactionContext!().agentConversation, undefined);
  setup.desktop.send({ action: 'composer-focus', id: setup.first });
  await setup.desktop.reply('composer-focus');
  assert.equal(setup.activity.interactionContext!().agentConversation, undefined);

  await setup.select(setup.first, false);
  assert.equal(
    setup.activity.interactionContext!().agentConversation!.messages[0].text,
    frame.utterance,
  );
  // Hidden panel, Activity and Previous sessions all report this empty ID.
  await setup.select('', false);
  assert.equal(setup.activity.interactionContext!().agentConversation, undefined);
  assert.equal(setup.sessions.has(setup.first), true);

  await setup.sessions.remove(setup.first);
  assert.equal(setup.sessions.conversationContext(setup.first), undefined);
  await setup.sessions.reopen(setup.first);
  assert.equal(setup.activity.interactionContext!().agentConversation, undefined);
  await setup.select(setup.first, false);
  assert.equal(
    setup.activity.interactionContext!().agentConversation!.messages[0].text,
    frame.utterance,
  );
});

test('new session and quick question bypass inference and choose their own model profiles', async (context) => {
  const setup = await fixture(context);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
  );
  new StartCodingAgentSession({ sessions: setup.sessions }, () => {}).subscribe(router);
  new QuickQuestion({ sessions: setup.sessions }, () => {}).subscribe(router);

  for (const [prefix, intent, model] of [
    ['new session', 'START_CODING_AGENT_SESSION', 'openai-codex/gpt-6-astra'],
    ['QUICK QUESTION', 'QUICK_QUESTION', 'pillar-vllm/qwen3.8-128k'],
  ]) {
    assert.equal(
      await router.route({ ...frame, utterance: `${prefix}: Explain this screen.` }, signal()),
      intent,
    );
    await setup.sessions.idle();
    assert.equal(setup.requests.at(-1)?.prompt.text, 'Explain this screen.');
    assert.equal(setup.requests.at(-1)?.prompt.screenshot, frame.screenshot);
    assert.equal(setup.requests.at(-1)?.settings.model, model);
  }
  const count = setup.requests.length;
  await router.route({ ...frame, utterance: 'new session' }, signal());
  await router.route({ ...frame, utterance: 'quick question' }, signal());
  assert.equal(setup.requests.length, count, 'Bare prefixes do not create empty sessions');
  assert.deepEqual(router.reservedPrefixes().toSorted(), ['new session', 'quick question']);
  assert.equal(
    router.intentStates().find((intent) => intent.name === 'QUICK_QUESTION')?.inferenceAvailable,
    false,
  );
  router.setEnabled('QUICK_QUESTION', false);
  await router.route({ ...frame, utterance: 'quick question Explain this' }, signal());
  assert.equal(setup.requests.length, count, 'A disabled local shortcut cannot fall back to Astra');
});

test('visible continuation uses the exact focused or unfocused instruction and agrees with the UI', async (context) => {
  const setup = await fixture(context);
  let offered = false;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (input, intents) => {
          const entry = intents.find(
            (intent) => intent.name === 'CONTINUE_OPEN_AGENT_CONVERSATION',
          );
          offered = entry !== undefined;
          if (entry) {
            assert.equal(
              entry.instruction,
              input.interaction?.agentComposerFocused
                ? 'The user has  a coding agent session open and has the input field selected. Unless your context gives you strong reasons to think that the user has a different intention, select this intent.'
                : "The user has a coding agent conversation selected in the open sidebar, but its input field is not selected. Choose this intent if the utterance is a follow-up, answer, correction, or request addressed to that conversation. Use the selected conversation's title and message excerpts together with the utterance and screenshot to judge this. The open sidebar alone is not a reason to choose this intent. Choose another intent if the utterance is intended for the active application, starts an independent request to the assistant, or is not addressed to the assistant.",
            );
            return entry.name;
          }
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  new Ignore(() => {}).subscribe(router);
  setup.continuation.subscribe(router);

  for (const [id, focused] of [
    [setup.first, false],
    ['', false],
    [setup.first, true],
    [setup.first, false],
  ] as const) {
    await setup.select(id, focused);
    const interaction = setup.activity.interactionContext!();
    assert.equal(router.intentStates({ interaction })[1].inferenceAvailable, Boolean(id));
    await router.route({ ...frame, interaction }, signal());
    await setup.sessions.idle();
    assert.equal(offered, Boolean(id));
  }
  assert.equal(setup.requests.length, 4);
  assert.equal(setup.requests[1].id, setup.first);
  assert.equal(setup.requests[1].resume, true);
  assert.equal(setup.requests[1].prompt.screenshot, undefined);
});

test('continue session addresses an unfocused visible chat and never falls through without one', async (context) => {
  const setup = await fixture(context);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
    setup.feedback,
  );
  setup.continuation.subscribe(router);
  await setup.select(setup.first, false);
  const utterance = 'Continue session, explain that in more detail.';
  await router.route(
    { ...frame, utterance, interaction: setup.activity.interactionContext!() },
    signal(),
  );
  await setup.sessions.idle();
  assert.equal(setup.requests[1].id, setup.first);
  assert.equal(setup.requests[1].prompt.text, 'explain that in more detail.');
  assert.deepEqual(setup.outcomes, ['started']);

  await setup.select('', false);
  await router.route(
    { ...frame, utterance, interaction: setup.activity.interactionContext!() },
    signal(),
  );
  assert.equal(setup.requests.length, 2);
  assert.equal(setup.outcomes.at(-1), 'skipped');
  await router.route({ ...frame, utterance: 'continue session' }, signal());
  assert.equal(setup.requests.length, 2);
});

for (const focused of [false, true]) {
  test(`stale continuation is rejected after tab, visibility or focus changes (focused=${focused})`, async (context) => {
    const setup = await fixture(context);
    const second = setup.sessions.start({ ...frame, utterance: 'Other conversation' }, signal());
    await setup.sessions.idle();

    for (const change of ['tab', 'tab-back', 'hide-back', 'focus', 'close'] as const) {
      await setup.select(setup.first, focused);
      const captured = setup.activity.interactionContext!();
      const router = new UserSensorRouter(
        {
          detector: testDetector({
            detect: async () => {
              if (change === 'tab' || change === 'tab-back') {
                await setup.select(second, focused);
                if (change === 'tab-back') {
                  await setup.select(setup.first, focused);
                }
              } else if (change === 'hide-back') {
                await setup.select('', false);
                await setup.select(setup.first, focused);
              } else if (change === 'focus') {
                await setup.select(setup.first, !focused);
                await setup.select(setup.first, focused);
              } else {
                await setup.sessions.remove(setup.first);
              }
              return 'CONTINUE_OPEN_AGENT_CONVERSATION';
            },
          }),
        },
        () => {},
      );
      new Ignore(() => {}).subscribe(router);
      setup.continuation.subscribe(router);
      await router.route({ ...frame, interaction: captured }, signal());
      assert.equal(setup.requests.length, 2);
      assert.equal(setup.outcomes.at(-1), 'skipped');
    }
  });
}

test('preview and cancelled continuations never submit a follow-up', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, true);
  const input = { ...frame, interaction: setup.activity.interactionContext!() };
  const preview = new ContinueOpenAgentConversation(
    { sessions: setup.sessions },
    () => {},
    true,
    setup.feedback,
  );
  await preview.process(input, signal());
  assert.equal(setup.outcomes.at(-1), 'preview');
  await assert.rejects(setup.continuation.process(input, AbortSignal.abort()));
  assert.equal(setup.requests.length, 1);
});

test('panel reports validate targets, and composer changes retain the keyboard delivery guard', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, false);
  setup.activity.processing!(frame.id);
  await setup.select(setup.first, true);
  assert.equal(setup.activity.deliveryAllowed!(frame.id), false);
  const before = setup.activity.interactionContext!();
  setup.desktop.send({ action: 'panel-state', id: 'missing', composerFocused: true });
  assert.equal((await setup.desktop.reply('panel-state')).type, 'error');
  assert.deepEqual(setup.activity.interactionContext!(), before);
  setup.activity.finished!(frame.id);
});

test('disconnecting an old panel cannot clear its replacement, and losing the owner invalidates speech', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, true);
  const second = setup.sessions.start({ ...frame, utterance: 'Other session' }, signal());
  await setup.sessions.idle();
  const replacement = createConnection(setup.desktop.socketPath);
  context.after(() => {
    replacement.destroy();
  });
  replacement.on('data', () => {});
  await once(replacement, 'connect');
  replacement.write(
    JSON.stringify({ action: 'panel-state', id: second, composerFocused: true }) + '\n',
  );
  await waitFor(() => setup.activity.interactionContext!().agentSessionId === second);
  const captured = setup.activity.interactionContext!();

  setup.desktop.client.destroy();
  await once(setup.desktop.client, 'close');
  // Wait for the server-side close callback, not just the local socket close.
  // Its next report is ordered after it has processed the old disconnection.
  replacement.write(
    JSON.stringify({ action: 'panel-state', id: second, composerFocused: true }) + '\n',
  );
  await once(replacement, 'data');
  assert.deepEqual(setup.activity.interactionContext!(), captured);

  replacement.destroy();
  await waitFor(() => setup.activity.interactionContext!().agentSessionId === '');
  assert.equal(setup.activity.interactionCurrent!(captured), false);
});

test('close session stops a running conversation and queued turns, retaining it in Previous sessions', async (context) => {
  const setup = await fixture(context, async (request, signal) => {
    if (request.resume) {
      await stopped(signal);
    }
  });
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          assert.fail('Close must bypass inference');
        },
      }),
    },
    () => {},
    setup.feedback,
  );
  const close = new CloseAgentSession(
    { sessions: setup.sessions },
    () => {},
    false,
    setup.feedback,
  );
  close.subscribe(router);
  await setup.select(setup.first, false);
  setup.sessions.followUp(setup.first, 'Running follow-up', signal());
  await waitFor(() => setup.requests.length === 2);
  setup.sessions.followUp(setup.first, 'Queued follow-up', signal());
  const captured = setup.activity.interactionContext!();
  assert.equal(router.intentStates({ interaction: captured })[0].supportsInference, false);
  await router.route({ ...frame, utterance: 'Close session.', interaction: captured }, signal());
  assert.equal(setup.sessions.has(setup.first), false);
  assert.equal(setup.requests.length, 2, 'Closing cannot start the queued successor');
  assert.equal(setup.sessions.previousSnapshot()[0].id, setup.first);
  assert.deepEqual(setup.outcomes, ['closed']);
  await setup.sessions.reopen(setup.first);
  assert.equal(setup.sessions.has(setup.first), true);
  assert.equal(setup.requests.length, 2, 'Reopening does not launch a model');
});

test('close session rejects hidden/stale targets and extra text, honors preview and cancellation', async (context) => {
  const setup = await fixture(context);
  const close = new CloseAgentSession(
    { sessions: setup.sessions },
    () => {},
    false,
    setup.feedback,
  );
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          assert.fail('Invalid close commands must not fall through');
        },
      }),
    },
    () => {},
    setup.feedback,
  );
  close.subscribe(router);
  await setup.select(setup.first, true);
  const captured = setup.activity.interactionContext!();
  await setup.select('', false);
  await setup.select(setup.first, true);
  await router.route({ ...frame, utterance: 'close session', interaction: captured }, signal());
  assert.equal(
    setup.sessions.has(setup.first),
    true,
    'An A → hidden → A change invalidates capture',
  );
  for (const input of [
    { ...frame, utterance: 'close session' },
    {
      ...frame,
      utterance: 'close session and start another',
      interaction: setup.activity.interactionContext!(),
    },
  ]) {
    await router.route(input, signal());
    assert.equal(setup.sessions.has(setup.first), true);
  }
  const current = { ...frame, utterance: '', interaction: setup.activity.interactionContext!() };
  const preview = new CloseAgentSession(
    { sessions: setup.sessions },
    () => {},
    true,
    setup.feedback,
  );
  await preview.process(current, signal());
  assert.equal(setup.outcomes.at(-1), 'preview');
  await assert.rejects(close.process(current, AbortSignal.abort()));
  assert.equal(setup.sessions.has(setup.first), true);
});

test('go to session uses captured visible order and reserves invalid, disabled and stale commands', async (context) => {
  const setup = await fixture(context);
  // Cover the last real UI position, not just the parser with a mock target.
  for (let index = 1; index < 16; index++) {
    setup.sessions.start({ ...frame, utterance: `Session ${index + 1}` }, signal());
    await setup.sessions.idle();
  }
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          assert.fail('Navigation and invalid navigation must never become agent text');
        },
      }),
    },
    () => {},
    setup.feedback,
  );
  const navigation = new GoToSession(() => {}, false, setup.feedback);
  navigation.subscribe(router);
  setup.continuation.subscribe(router);

  async function visible(token: string, shown = true) {
    setup.desktop.send({
      action: 'panel-state',
      id: '',
      composerFocused: false,
      visible: shown,
      navigationToken: token,
    });
    await setup.desktop.reply('panel-state');
    return setup.activity.interactionContext!();
  }
  const captured = await visible('first-page');
  const numbers = [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
  ];
  for (let index = 0; index < 16; index++) {
    for (const number of [String(index + 1), numbers[index]]) {
      const targetId = captured.agentNavigation!.ids[index];
      const selectedBefore = setup.desktop.messages.filter(
        (message) => message.type === 'agent-select' && message.id === targetId,
      ).length;
      await router.route(
        { ...frame, utterance: `Go to session ${number}!`, interaction: captured },
        signal(),
      );
      assert.equal(setup.outcomes.at(-1), 'selected');
      await waitFor(
        () =>
          setup.desktop.messages.filter(
            (message) => message.type === 'agent-select' && message.id === targetId,
          ).length ===
          selectedBefore + 1,
      );
    }
  }
  for (const utterance of [
    'Go to session',
    'Go to session 0',
    'Go to session zero',
    'Go to session 17',
    'Go to session 20',
    'Go to session seventeen',
    'Go to session 21',
    'Go to session twenty one',
    'Go to session twenty-one',
    'Go to session 01',
    'Go to session 1st',
    'Go to session tenth',
    'Go to session first',
    'Go to session 2 and explain',
    'Go to session 1.5',
  ]) {
    await router.route({ ...frame, utterance, interaction: captured }, signal());
    assert.equal(setup.outcomes.at(-1), 'skipped', utterance);
  }
  router.setEnabled(navigation.name, false, 'shortcut');
  for (const utterance of ['Go to session 1', 'Go to session 16']) {
    await router.route({ ...frame, utterance, interaction: captured }, signal());
    assert.equal(setup.outcomes.at(-1), 'skipped');
  }
  router.setEnabled(navigation.name, true, 'shortcut');
  const order = setup.sessions.order();
  setup.sessions.move(order.ids[1], order.ids[0], order.revision);
  await router.route({ ...frame, utterance: 'Go to session two', interaction: captured }, signal());
  assert.equal(
    setup.outcomes.at(-1),
    'skipped',
    'Reordering must invalidate speech already captured',
  );
  const reordered = await visible('second-page');
  assert.equal(reordered.agentNavigation!.ids[0], order.ids[1]);
  await router.route(
    { ...frame, utterance: 'Go to session sixteen', interaction: reordered },
    signal(),
  );
  assert.equal(setup.outcomes.at(-1), 'selected');
  await visible('another-page');
  await router.route(
    { ...frame, utterance: 'Go to session sixteen', interaction: reordered },
    signal(),
  );
  assert.equal(setup.outcomes.at(-1), 'skipped', 'Changing pages invalidates captured navigation');
  const hidden = await visible('hidden', false);
  assert.equal(hidden.agentNavigation, undefined);
  await router.route({ ...frame, utterance: 'Go to session one', interaction: hidden }, signal());
  assert.equal(setup.outcomes.at(-1), 'skipped');
  const beforeClose = await visible('before-close');
  await setup.sessions.remove(beforeClose.agentNavigation!.ids[0]);
  await router.route(
    { ...frame, utterance: 'Go to session one', interaction: beforeClose },
    signal(),
  );
  assert.equal(setup.outcomes.at(-1), 'skipped');
  const shortList = await visible('short-list');
  await router.route(
    { ...frame, utterance: 'Go to session sixteen', interaction: shortList },
    signal(),
  );
  assert.equal(
    setup.outcomes.at(-1),
    'skipped',
    'Missing positions never select another conversation',
  );
});

test('go to session rejects positions above 16 even if a client reports extra IDs', async () => {
  const selectedIndexes: number[] = [];
  const outcomes: string[] = [];
  const navigation = {
    clientId: 1,
    token: 'visible-page',
    orderRevision: 'unchanged',
    ids: Array.from({ length: 20 }, (_, index) => `session-${index + 1}`),
  };
  const interaction = {
    agentNavigation: navigation,
    agentSessionId: '',
    agentComposerFocused: false,
    revision: 1,
  };
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect() {
          assert.fail('Explicit navigation must not invoke inference');
        },
      }),
    },
    () => {},
  );
  new GoToSession(() => {}, false, {
    selectSession: (_context, index) => {
      selectedIndexes.push(index);
      return true;
    },
    outcome: (_id, outcome) => outcomes.push(outcome),
  }).subscribe(router);

  for (const label of ['16', 'sixteen']) {
    await router.route({ ...frame, utterance: `Go to session ${label}!`, interaction }, signal());
    assert.equal(outcomes.at(-1), 'selected');
    assert.equal(selectedIndexes.at(-1), 15);
  }
  for (const label of ['17', 'seventeen', '18', 'eighteen', '19', 'nineteen', '20', 'twenty']) {
    await router.route({ ...frame, utterance: `Go to session ${label}!`, interaction }, signal());
    assert.equal(outcomes.at(-1), 'skipped');
  }
  assert.deepEqual(selectedIndexes, [15, 15]);
});

test('inferred navigation keeps the captured order, owner and visibility safeguards', async (context) => {
  const setup = await fixture(context);
  for (let index = 1; index < 6; index++) {
    setup.sessions.start({ ...frame, utterance: `Session ${index + 1}` }, signal());
    await setup.sessions.idle();
  }
  const offered: string[][] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        async detect(_input, intents) {
          offered.push(intents.map((intent) => intent.name));
          return intents.some((intent) => intent.name === 'GO_TO_SESSION')
            ? 'GO_TO_SESSION'
            : 'IGNORE';
        },
      }),
    },
    () => {},
    setup.feedback,
  );
  new Ignore(() => {}).subscribe(router);
  new GoToSession(() => {}, false, setup.feedback).subscribe(router);

  async function visible(token: string, shown = true) {
    setup.desktop.send({
      action: 'panel-state',
      id: '',
      composerFocused: false,
      visible: shown,
      navigationToken: token,
    });
    await setup.desktop.reply('panel-state');
    return setup.activity.interactionContext!();
  }
  const selections = (id: string) =>
    setup.desktop.messages.filter((message) => message.type === 'agent-select' && message.id === id)
      .length;
  const route = (utterance: string, interaction: InteractionContext) =>
    router.route({ ...frame, utterance, interaction }, signal());

  const captured = await visible('first-page');
  const sixth = captured.agentNavigation!.ids[5];
  await route("Hey, let's switch to session six", captured);
  assert.equal(setup.outcomes.at(-1), 'selected');
  await waitFor(() => selections(sixth) === 1);

  await route('switch to session seven', captured);
  assert.equal(setup.outcomes.at(-1), 'skipped', 'Missing positions never select another one');

  const order = setup.sessions.order();
  setup.sessions.move(order.ids[1], order.ids[0], order.revision);
  await route('switch to session two', captured);
  assert.equal(setup.outcomes.at(-1), 'skipped', 'Reordering invalidates captured speech');

  const reordered = await visible('second-page');
  await visible('another-page');
  await route('switch to session six', reordered);
  assert.equal(setup.outcomes.at(-1), 'skipped', 'Changing pages invalidates captured speech');

  const beforeClose = await visible('before-close');
  await setup.sessions.remove(beforeClose.agentNavigation!.ids[0]);
  await route('switch to session one', beforeClose);
  assert.equal(setup.outcomes.at(-1), 'skipped');

  const hidden = await visible('hidden', false);
  await route('switch to session one', hidden);
  assert.equal(offered.at(-1)!.includes('GO_TO_SESSION'), false, 'Hidden panels are not offered');
  assert.equal(selections(sixth), 1);
});

test('navigation is delivered only to the captured UI connection and disconnect invalidates it', async (context) => {
  const setup = await fixture(context);
  const observer = createConnection(setup.desktop.socketPath);
  context.after(async () => {
    observer.destroy();
  });
  let observed = '';
  observer.on('data', (chunk) => {
    observed += chunk.toString();
  });
  await once(observer, 'connect');
  setup.desktop.send({
    action: 'panel-state',
    id: setup.first,
    composerFocused: false,
    visible: true,
    navigationToken: 'owner',
  });
  await setup.desktop.reply('panel-state');
  const captured = setup.activity.interactionContext!();
  assert.equal(setup.activity.selectSession!(captured, 0), true);
  await waitFor(() => setup.desktop.messages.some((message) => message.type === 'agent-select'));
  assert.equal(observed.includes('agent-select'), false);
  setup.desktop.client.destroy();
  await waitFor(() => setup.activity.interactionContext!().agentNavigation === undefined);
  assert.equal(setup.activity.selectSession!(captured, 0), false);
});
