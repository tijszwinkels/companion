import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentChoiceIntents, agentChoiceStates } from '../../src/agents/choice-intents.ts';
import registerChoices, { choiceTool } from '../../src/agents/choice-tool.ts';
import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage, type AgentBackend } from '../../src/agents/types.ts';
import type { Detector } from '../../src/core/router.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, processor, signal, testDetector } from '../helpers.ts';

type Run = {
  request: Parameters<AgentBackend['run']>[0];
  signal: AbortSignal;
  publish: NonNullable<Parameters<AgentBackend['run']>[3]>;
  emit: Parameters<AgentBackend['run']>[2];
  finish(): void;
};

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-choices-'));
  const runs: Run[] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'choices-fixture',
        label: 'Choices fixture',
        dependencies: {},
        async run(request, signal, emit, publish) {
          const done = deferred<void>();
          runs.push({ request, signal, publish: publish!, emit, finish: () => done.resolve() });
          await Promise.race([done.promise, stopped(signal)]);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const outcomes: string[] = [];
  const activity = {
    ...desktop.runtime.activity,
    outcome: (_id: number, outcome: string) => outcomes.push(outcome),
  };
  let detection: Detector['detect'] = async () => assert.fail('Unexpected inference');
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: (...args) => detection(...args) }) },
    () => {},
    activity,
  );
  processor('IGNORE').subscribe(router);
  new AgentChoiceIntents({ sessions }, () => {}, false, activity).subscribe(router);

  async function select(id: string, focused = false) {
    desktop.send({ action: 'panel-state', id, composerFocused: focused });
    assert.equal((await desktop.reply('panel-state')).type, 'result');
  }
  async function start(title = 'Question') {
    const count = runs.length;
    const id = sessions.start({ ...frame, utterance: title }, signal());
    await waitFor(() => runs.length > count);
    return { id, run: runs.at(-1)! };
  }
  async function complete(run: Run, options: unknown = ['[Tests] - Run the tests', 'No']) {
    run.publish(parseChoices(options));
    run.finish();
    await waitFor(() => sessions.interaction(run.request.id).agentAcceptsFollowUp);
  }
  function input(utterance: string) {
    return { ...frame, utterance, interaction: activity.interactionContext!() };
  }
  return {
    directory,
    sessions,
    desktop,
    activity,
    router,
    runs,
    outcomes,
    select,
    start,
    complete,
    input,
    detect: (fn: Detector['detect']) => {
      detection = fn;
    },
  };
}

test('native tool accepts both presentation forms, atomically validates labels, and clears explicitly', async () => {
  let registered: unknown;
  registerChoices({
    registerTool: (tool) => {
      registered = tool;
    },
  });
  assert.equal(registered, choiceTool);
  const result = await choiceTool.execute(
    'tool-1',
    {
      options: [
        '[Tests] - Run the tests',
        '[Yes]',
        'No',
        { label: ' Later ', description: ' Wait ' },
      ],
    },
    signal(),
  );
  assert.deepEqual(result.details.companionChoices, {
    version: 1,
    options: [
      { label: 'Tests', description: 'Run the tests' },
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
      { label: 'Later', description: 'Wait' },
    ],
  });
  for (const options of [
    null,
    [''],
    ['Yes', ' YES! '],
    new Array(9).fill('Yes'),
    [{ label: 'a', description: 3 }],
    ['[bad'],
    ['a'.repeat(61)],
    [{ label: 'a', description: 'b'.repeat(1001) }],
  ]) {
    await assert.rejects(choiceTool.execute('invalid', { options }, signal()));
  }
  assert.deepEqual(
    (await choiceTool.execute('clear', { options: [] }, signal())).details.companionChoices.options,
    [],
  );
  await assert.rejects(choiceTool.execute('cancel', { options: ['Yes'] }, AbortSignal.abort()));
});

// Opus 5.5 and Sonnet 5.5 sometimes drafted their whole answer in thinking
// right before calling companion_choices, then ended with a one-line "pick a
// choice" text. The user never sees thinking, so the answer was lost. In a
// synthetic Claude Code A/B, asking for the answer before the call made this
// much worse (28 of 40 turns); offering choices first and then asking for the
// answer as visible text lost none of 48. These checks keep that ordering.
test('choice guidance asks for the visible answer after the choices, never only in thinking', async () => {
  const guidance = [choiceTool.description, ...choiceTool.promptGuidelines].join('\n');

  assert.match(guidance, /offer the choices first/i);
  assert.match(guidance, /then write your complete answer as visible text/i);
  assert.doesNotMatch(guidance, /before (calling|offering)/i);

  const offered = await choiceTool.execute('tool-1', { options: ['Yes'] }, signal());
  const resultText = offered.content[0].text;

  assert.match(resultText, /^Choices offered\./);
  assert.match(resultText, /write your complete answer as visible text/i);
  assert.match(resultText, /never sees your thinking/i);
});

test('exact choices select the captured conversation once, with description or label payload', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  const other = await setup.start('Other');
  await setup.complete(first.run);
  await setup.complete(other.run, ['Yes']);
  await setup.select(first.id);
  const captured = setup.input('  TESTS!  ');
  assert.equal(await setup.router.route(captured, signal()), 'CHOOSE_AGENT_OPTION_1');
  await waitFor(() => setup.runs.length === 3);
  assert.equal(setup.runs[2].request.id, first.id);
  assert.equal(setup.runs[2].request.prompt.text, 'Run the tests');
  assert.equal(setup.runs[2].request.resume, true);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
  assert.ok(setup.sessions.interaction(other.id).agentChoices);
  await setup.router.route(captured, signal());
  assert.equal(setup.outcomes.at(-1), 'skipped');
  assert.equal(setup.runs.length, 3);
  await setup.complete(setup.runs[2], ['Yes', 'No']);
  await setup.router.route(setup.input('No.'), signal());
  await waitFor(() => setup.runs.length === 4);
  assert.equal(setup.runs[3].request.prompt.text, 'No');
});

test('longer utterances use inference, natural selections are offered, and freeform still works', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.complete(first.run);
  await setup.select(first.id, true);
  new ContinueOpenAgentConversation(
    { sessions: setup.sessions },
    () => {},
    false,
    setup.activity,
  ).subscribe(setup.router);
  setup.detect(async (input, intents) => {
    assert.equal(input.utterance, 'Tests please, run them now');
    assert.ok(intents.some((intent) => intent.name === 'CONTINUE_OPEN_AGENT_CONVERSATION'));
    assert.match(
      intents.find((intent) => intent.name === 'CHOOSE_AGENT_OPTION_1')!.instruction,
      /Run the tests/,
    );
    return 'CHOOSE_AGENT_OPTION_1';
  });
  await setup.router.route(setup.input('Tests please, run them now'), signal());
  await waitFor(() => setup.runs.length === 2);
  await setup.complete(setup.runs[1]);
  setup.detect(async () => 'CONTINUE_OPEN_AGENT_CONVERSATION');
  await setup.router.route(setup.input('First explain how it works'), signal());
  await waitFor(() => setup.runs.length === 3);
  assert.equal(setup.runs[2].request.prompt.text, 'First explain how it works');
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
});

test('replacement, pending choices, clearing and late backend callbacks never revive stale options', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.select(first.id);
  first.run.publish(parseChoices(['Yes']));
  const pending = setup.input('Yes');
  assert.equal(agentChoiceStates(pending, [])[0].voiceAvailable, false);
  const dictated: string[] = [];
  processor('SEND_TEXT_TO_APPLICATION', async (input) => {
    dictated.push(input.utterance);
  }).subscribe(setup.router);
  setup.detect(async (_input, intents) => {
    assert.equal(
      intents.some((intent) => intent.name.startsWith('CHOOSE_AGENT_OPTION_')),
      false,
    );
    return 'SEND_TEXT_TO_APPLICATION';
  });
  await setup.router.route(pending, signal());
  assert.deepEqual(dictated, ['Yes']);
  const oldRevision = pending.interaction.agentChoices!.revision;
  first.run.publish(parseChoices(['Yes']));
  assert.notEqual(setup.input('Yes').interaction.agentChoices!.revision, oldRevision);
  first.run.publish([]);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
  await setup.complete(first.run, ['No']);
  await setup.router.route(pending, signal());
  assert.deepEqual(dictated, ['Yes', 'Yes']);
  assert.equal(
    setup.runs.length,
    1,
    'A previously unavailable label cannot become a selection later',
  );
  first.run.publish(parseChoices(['Late']));
  assert.equal(setup.sessions.interaction(first.id).agentChoices!.options[0].label, 'No');
  assert.throws(() => setup.sessions.selectChoice(first.id, oldRevision, 0, signal()), /expired/);
});

test('choice availability follows global run capacity and rechecks it after inference', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.complete(first.run);
  await setup.select(first.id, true);
  await setup.desktop.runtime.connectRouter(setup.router);
  const waiting = [];
  for (let index = 0; index < 9; index++) {
    waiting.push(await setup.start(`Other ${index}`));
  }
  assert.equal(agentChoiceStates(setup.input(''), [])[0].available, true);
  setup.detect(async () => {
    waiting.push(await setup.start('Tenth concurrent run'));
    return 'CHOOSE_AGENT_OPTION_1';
  });
  await setup.router.route(setup.input('Please run the tests'), signal());
  assert.equal(setup.outcomes.at(-1), 'skipped');
  const unavailable = agentChoiceStates(setup.input(''), [])[0];
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.voiceAvailable, false);
  assert.match(unavailable.voiceReason, /10 questions/);
  await waitFor(() =>
    setup.desktop.messages.some(
      (message) => message.actions?.choices[0]?.voiceReason === unavailable.voiceReason,
    ),
  );
  assert.equal(setup.runs.length, 11);
  await setup.sessions.stop(waiting[0].id);
  assert.equal(agentChoiceStates(setup.input(''), [])[0].available, true);
  await waitFor(() => setup.desktop.messages.at(-1)?.actions?.choices[0]?.available === true);
  await setup.router.route(setup.input('Tests'), signal());
  await waitFor(() => setup.runs.length === 12);
  assert.equal(setup.runs.at(-1)!.request.id, first.id);
});

test('streamed text keeps choice actions stable, while a replacement publishes new identity', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.select(first.id, true);
  first.run.publish(parseChoices(['Yes']));
  const revision = setup.sessions.interaction(first.id).agentChoices!.revision;
  await waitFor(() =>
    setup.desktop.messages.some((message) => message.actions?.choices[0]?.revision === revision),
  );
  const before = setup.desktop.messages.filter(
    (message) => message.type === 'agent-actions',
  ).length;
  for (let index = 0; index < 3; index++) {
    const message = chatMessage('stream', 'assistant', `Token ${index}`);
    message.state = 'running';
    first.run.emit(message);
    await waitFor(() =>
      setup.desktop.messages.some((event) =>
        event.session?.messages.some((entry) => entry.text === message.text),
      ),
    );
  }
  assert.equal(
    setup.desktop.messages.filter((message) => message.type === 'agent-actions').length,
    before,
  );
  first.run.publish(parseChoices(['No']));
  const replacement = setup.sessions.interaction(first.id).agentChoices!.revision;
  await waitFor(() =>
    setup.desktop.messages.some((message) => message.actions?.choices[0]?.revision === replacement),
  );
});

test('long descriptions have bounded inference context but selection submits the full text', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  const description = ('Explain the change. ' + 'Useful detail. '.repeat(60)).trim();
  const options = Array.from({ length: 8 }, (_, index) => ({
    label: `Option ${index + 1}`,
    description,
  }));
  await setup.complete(first.run, options);
  await setup.select(first.id, true);
  setup.detect(async (_input, intents) => {
    const choices = intents.filter((intent) => intent.name.startsWith('CHOOSE_AGENT_OPTION_'));
    assert.equal(choices.length, 8);
    assert.ok(choices.reduce((length, intent) => length + intent.instruction.length, 0) < 3000);
    assert.match(choices[0].instruction, /Explain the change/);
    return 'CHOOSE_AGENT_OPTION_1';
  });
  await setup.router.route(setup.input('Explain it first'), signal());
  await waitFor(() => setup.runs.length === 2);
  assert.equal(setup.runs[1].request.prompt.text, description);
});

test('tab changes, hide/show, close/reopen, and freeform during inference invalidate captured choices', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  const other = await setup.start('Other');
  await setup.complete(first.run);
  await setup.complete(other.run);
  for (const change of ['tab', 'hide', 'freeform', 'close'] as const) {
    await setup.select(first.id);
    const captured = setup.input('Please take the first option');
    setup.detect(async () => {
      if (change === 'tab') {
        await setup.select(other.id);
        await setup.select(first.id);
      } else if (change === 'hide') {
        await setup.select('');
        await setup.select(first.id);
      } else if (change === 'freeform') {
        setup.sessions.followUp(first.id, 'A different question', signal());
        await waitFor(() => setup.runs.length === 3);
        await setup.complete(setup.runs[2]);
      } else {
        await setup.sessions.remove(first.id);
        await setup.sessions.reopen(first.id);
        await setup.select(first.id);
      }
      return 'CHOOSE_AGENT_OPTION_1';
    });
    await setup.router.route(captured, signal());
    assert.equal(setup.outcomes.at(-1), 'skipped');
  }
  assert.equal(setup.runs.length, 3);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
});

test('permanent shortcuts win collisions even when disabled; stop remains reserved', async (context) => {
  const setup = await fixture(context);
  let inserted = 0;
  setup.router.register({
    ...processor('INSERT', async () => {
      inserted++;
    }),
    prefixes: ['insert'],
    acceptsEmptyPrefix: true,
  });
  const first = await setup.start();
  await setup.complete(first.run, ['insert', '[insert hello] - Some other task', 'stop', 'Yes']);
  await setup.select(first.id);
  const states = agentChoiceStates(setup.input(''), setup.router.reservedPrefixes());
  assert.deepEqual(
    states.map((choice) => choice.voiceAvailable),
    [false, false, false, true],
  );
  assert.ok(states.every((choice) => choice.available));
  await setup.router.route(setup.input('insert hello'), signal());
  assert.equal(inserted, 1);
  setup.router.setEnabled('INSERT', false);
  await setup.router.route(setup.input('insert hello'), signal());
  assert.equal(inserted, 1);
  assert.equal(setup.runs.length, 1);
});

test('stop targets only the captured running agent and rejects an old run in the same tab', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  const other = await setup.start('Other');
  await setup.select(first.id);
  const captured = setup.input('STOP.');
  first.run.publish(parseChoices(['Yes']));
  assert.equal(await setup.router.route(captured, signal()), 'STOP_OPEN_AGENT');
  assert.equal(first.run.signal.aborted, true);
  assert.equal(other.run.signal.aborted, false);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
  setup.sessions.followUp(first.id, 'Next turn', signal());
  await waitFor(() => setup.runs.length === 3);
  await setup.router.route(captured, signal());
  assert.equal(setup.runs[2].signal.aborted, false);
  assert.equal(setup.outcomes.at(-1), 'skipped');
  const next = setup.input('stop');
  await setup.select(other.id);
  await setup.router.route(next, signal());
  assert.equal(setup.runs[2].signal.aborted, false);
  assert.equal(other.run.signal.aborted, false);
});

test('queued continuation expires choices without changing the current stop target', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.select(first.id, true);
  first.run.publish(parseChoices(['Yes']));
  const revision = setup.sessions.interaction(first.id).agentChoices!.revision;
  const oldStop = setup.input('stop');
  assert.throws(() => setup.sessions.selectChoice(first.id, revision, 0, signal()), /finishes/);
  assert.throws(() => setup.sessions.followUp(first.id, 'x'.repeat(8001), signal()), /1–8000/);
  assert.equal(setup.sessions.interaction(first.id).agentChoices!.revision, revision);

  new ContinueOpenAgentConversation(
    { sessions: setup.sessions },
    () => {},
    false,
    setup.activity,
  ).subscribe(setup.router);
  setup.detect(async () => 'CONTINUE_OPEN_AGENT_CONVERSATION');
  await setup.router.route(setup.input('A freeform continuation'), signal());
  assert.equal(setup.runs.length, 1);
  assert.equal(setup.sessions.interaction(first.id).agentRunId, oldStop.interaction.agentRunId);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
  first.run.publish(parseChoices(['An obsolete choice']));
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
  assert.throws(() => setup.sessions.selectChoice(first.id, revision, 0, signal()), /expired/);

  first.run.finish();
  await waitFor(() => setup.runs.length === 2);
  assert.equal(setup.runs[1].request.prompt.text, 'A freeform continuation');
  await setup.router.route(oldStop, signal());
  assert.equal(setup.outcomes.at(-1), 'skipped');
  assert.equal(setup.runs[1].signal.aborted, false);
  setup.sessions.followUp(first.id, 'Waiting behind the second turn', signal());
  await setup.router.route(setup.input('stop'), signal());
  assert.equal(setup.runs[1].signal.aborted, true);
  await setup.sessions.idle();
  assert.equal(setup.runs.length, 2);
  assert.equal(setup.sessions.snapshot()[0].messages.at(-1)!.state, 'error');
});

test('preview, cancelled speech and a disconnected owner cannot act on choices or stop', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.select(first.id);
  const preview = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('No inference') }) },
    () => {},
  );
  new AgentChoiceIntents({ sessions: setup.sessions }, () => {}, true, setup.activity).subscribe(
    preview,
  );
  await preview.route(setup.input('stop'), signal());
  assert.equal(first.run.signal.aborted, false);
  await setup.complete(first.run);
  const captured = setup.input('Tests');
  await preview.route(captured, signal());
  await assert.rejects(setup.router.route(captured, AbortSignal.abort()));
  setup.desktop.client.destroy();
  await waitFor(() => setup.activity.interactionContext!().agentSessionId === '');
  await setup.router.route(captured, signal());
  assert.equal(setup.runs.length, 1);
  assert.equal(setup.outcomes.at(-1), 'skipped');
});

test('ordered choice clicks preserve unchanged focus and invalidate dictation when the panel acquires focus', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.complete(first.run);
  await setup.select(first.id, true);

  // Service reports panel state immediately before every choice click. An
  // unchanged report must not create a false keyboard-delivery boundary.
  setup.activity.processing?.(frame.id);
  let choices = setup.sessions.interaction(first.id).agentChoices!;
  setup.desktop.send({
    action: 'panel-state',
    id: first.id,
    composerFocused: true,
    keyboardFocused: true,
  });
  setup.desktop.send({
    action: 'choose-agent',
    id: first.id,
    revision: choices.revision,
    index: 0,
  });
  assert.equal((await setup.desktop.reply('panel-state')).type, 'result');
  assert.equal((await setup.desktop.reply('choose-agent')).result, 'submitted');
  assert.equal(setup.activity.deliveryAllowed!(frame.id), true);
  await waitFor(() => setup.runs.length === 2);
  assert.equal(setup.runs[1].request.prompt.text, 'Run the tests');
  await setup.complete(setup.runs[1]);

  // Clicking the panel from an application really does change the keyboard
  // target. Keep Activity's insertion protection while accepting the click.
  await setup.select(first.id, false);
  setup.activity.processing?.(frame.id + 1);
  choices = setup.sessions.interaction(first.id).agentChoices!;
  setup.desktop.send({
    action: 'panel-state',
    id: first.id,
    composerFocused: false,
    keyboardFocused: true,
  });
  setup.desktop.send({
    action: 'choose-agent',
    id: first.id,
    revision: choices.revision,
    index: 1,
  });
  assert.equal((await setup.desktop.reply('panel-state')).type, 'result');
  assert.equal((await setup.desktop.reply('choose-agent')).result, 'submitted');
  assert.equal(setup.activity.deliveryAllowed!(frame.id + 1), false);
  await waitFor(() => setup.runs.length === 3);
  assert.equal(setup.runs[2].request.id, first.id);
  assert.equal(setup.runs[2].request.prompt.text, 'No');
});

test('socket selections validate ownership and revisions, consume once, and leave no durable choices', async (context) => {
  const setup = await fixture(context);
  const first = await setup.start();
  await setup.complete(first.run);
  await setup.select(first.id);
  await setup.desktop.runtime.connectRouter(setup.router);
  const choices = setup.sessions.interaction(first.id).agentChoices!;
  for (const request of [
    { revision: 'stale', index: 0 },
    { revision: choices.revision, index: -1 },
    { revision: choices.revision, index: 0.5 },
    { revision: choices.revision, index: 9 },
  ]) {
    setup.desktop.send({ action: 'choose-agent', id: first.id, ...request });
    assert.equal((await setup.desktop.reply('choose-agent')).type, 'error');
  }
  const request = { action: 'choose-agent', id: first.id, revision: choices.revision, index: 0 };
  await setup.select('');
  setup.desktop.send(request);
  assert.equal((await setup.desktop.reply('choose-agent')).type, 'error');
  await setup.select(first.id);
  setup.desktop.send(request);
  assert.equal((await setup.desktop.reply('choose-agent')).result, 'submitted');
  setup.desktop.send(request);
  assert.equal((await setup.desktop.reply('choose-agent')).type, 'error');
  await waitFor(() => setup.runs.length === 2);
  await setup.complete(setup.runs[1]);
  const saved = JSON.parse(
    await readFile(join(setup.directory, '.companion-sessions', `${first.id}.json`), 'utf8'),
  );
  assert.equal(saved.choices, undefined);
  assert.equal(saved.runId, undefined);
  await setup.sessions.remove(first.id);
  await setup.sessions.reopen(first.id);
  assert.equal(setup.sessions.interaction(first.id).agentChoices, undefined);
});
