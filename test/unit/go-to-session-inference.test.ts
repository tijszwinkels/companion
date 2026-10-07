import assert from 'node:assert/strict';
import test from 'node:test';

import type { Activity } from '../../src/core/activity.ts';
import type { Intent, InteractionContext, UserSensorFrame } from '../../src/core/frame.ts';
import { UserSensorRouter, type Detector } from '../../src/core/router.ts';
import type { TranscriptionCleanupRecord } from '../../src/core/transcription-cleanup/record.ts';
import { TranscriptionCleanupSetting } from '../../src/core/transcription-cleanup/setting.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { frame, processor, signal, testDetector } from '../helpers.ts';

const interaction: InteractionContext = {
  agentNavigation: {
    clientId: 1,
    token: 'visible-page',
    orderRevision: 'unchanged',
    ids: Array.from({ length: 16 }, (_, index) => `session-${index + 1}`),
  },
  agentSessionId: '',
  agentComposerFocused: false,
  revision: 1,
};

/** A router whose detector always picks one intent, recording what it was offered. */
function setup(options: { answer?: string; cleanup?: boolean } = {}) {
  const selected: number[] = [];
  const outcomes: string[] = [];
  const offered: Intent[][] = [];
  const delivered: string[] = [];
  const records: TranscriptionCleanupRecord[] = [];
  const answer = options.answer ?? 'GO_TO_SESSION';

  const detector: Detector = testDetector({
    async detect(_frame, intents) {
      assert.equal(options.cleanup, undefined, 'Bare-name detection used while cleanup is on');
      offered.push([...intents]);
      return answer;
    },
  });
  detector.detectWithCleanup = async (_frame, intents) => {
    offered.push([...intents]);
    // json-cleanup-v1 answers a no-text intent with text null and no fallback.
    return answer === 'GO_TO_SESSION'
      ? { intent: answer, text: null, fallback: null }
      : { intent: answer, text: 'cleaned', fallback: null };
  };

  const activity: Activity = {
    selectSession: (_context, index) => {
      selected.push(index);
      return true;
    },
    outcome: (_id, outcome) => outcomes.push(outcome),
    transcriptionCleanup: (_id, record) => records.push(record),
  };
  const setting = new TranscriptionCleanupSetting();
  setting.set(options.cleanup === true);
  const router = new UserSensorRouter(
    {
      detector,
      cleaner: {
        id: 'test-cleaner',
        label: 'Test cleaner',
        dependencies: {},
        clean: async () => assert.fail('Navigation never cleans text'),
      },
    },
    () => {},
    activity,
    'router',
    setting,
  );
  processor('IGNORE').subscribe(router);
  processor('SEND_TEXT_TO_APPLICATION', async (input) => {
    delivered.push(input.utterance);
  }).subscribe(router);
  const navigation = new GoToSession(() => {}, false, activity);
  navigation.subscribe(router);

  // Null stands for a frame captured without any sidebar interaction state.
  async function route(utterance: string, context: InteractionContext | null = interaction) {
    const input: UserSensorFrame = { ...frame, utterance, interaction: context ?? undefined };
    return router.route(input, signal());
  }

  return { router, navigation, route, selected, outcomes, offered, delivered, records };
}

test('inferred navigation selects the one explicit number anywhere in the utterance', async () => {
  for (const [utterance, position] of [
    ["Hey, let's switch to session six", 6],
    ['switch to session 1', 1],
    ['Switch to Session One.', 1],
    ['Could you show session 9?', 9],
    ['SESSION NINE!', 9],
    ['jump to tab sixteen please', 16],
    ['Go back to 16…', 16],
    ['Hey go to session 2 and explain', 2],
    ['Please, go to session four', 4],
    ['let me see number 12', 12],
    ['switch to session one, of course', 1],
    ['go to tab one', 1],
    ['number one, please', 1],
    ['session 6, please', 6],
    ['Switch to session six.', 6],
    ['okay - switch to session six', 6],
  ] as const) {
    const run = setup();
    assert.equal(await run.route(utterance), 'GO_TO_SESSION', utterance);
    assert.deepEqual(run.selected, [position - 1], utterance);
    assert.deepEqual(run.outcomes, ['selected'], utterance);
  }
});

test('inferred navigation skips missing, multiple, ordinal, homophone and malformed numbers', async () => {
  for (const utterance of [
    'two ideas, switch to session six',
    'go to the sixth one',
    'session nein',
    'switch to session sex',
    'switch to session for',
    'switch to session to',
    'switch to the next session',
    'switch to that one',
    'go to the other one',
    'go to one of the sessions',
    'switch to session',
    'switch to session 0',
    'switch to session zero',
    'switch to session 17',
    'switch to session seventeen',
    'switch to session twenty',
    'switch to session sixty',
    'switch to session twenty one',
    'switch to session twenty-one',
    'switch to session 1.5',
    'switch to session -3',
    'switch to session −3',
    'switch to session 6th',
    'switch to session sixteenth',
    'switch to session first',
    'switch to session 06',
    'switch to session 100',
    'switch to session 1,000',
    'switch to session 6:30',
    'switch to session six or seven',
    'switch to session 3-4',
    'switch to session si',
    'switch to session sixes',
    'hundreds of tabs, go to session six',
    'switch to session six and a half',
    // Review round 1: malformed expressions never yield their valid suffix.
    'switch to session .6',
    'switch to session - 6',
    'switch to session -six',
    'switch to session +6',
    'switch to session 6.5',
    'version 2.0, switch to session six',
    // Review round 2: spoken signs and decimal markers are malformed too.
    'switch to session minus six',
    'switch to session minus 6',
    'switch to session negative 6',
    'switch to session plus six',
    'switch to session point six',
    'switch to session point 6',
    'switch to session dot six',
    // Review round 1: "one" without a navigation noun is ambiguous, not discarded.
    'switch to session one of six',
    'switch to the left one',
    'switch to one',
    'one more thing, switch to session six',
    'switch to session six, that one',
    // Review round 1: punctuation cannot hide a second number.
    'two,please switch to session six',
    'two.switch to session six',
    'session six,seven',
  ]) {
    const run = setup();
    assert.equal(await run.route(utterance), 'GO_TO_SESSION', utterance);
    assert.deepEqual(run.selected, [], utterance);
    assert.deepEqual(run.outcomes, ['skipped'], utterance);
  }
});

test('inferred navigation requires the number to exist in the captured order', async () => {
  const run = setup();
  const shortList: InteractionContext = {
    ...interaction,
    agentNavigation: { ...interaction.agentNavigation!, ids: ['first', 'second', 'third'] },
  };
  await run.route('switch to session four', shortList);
  await run.route('switch to session 3', shortList);
  assert.deepEqual(run.selected, [2]);
  assert.deepEqual(run.outcomes, ['skipped', 'selected']);

  // Stale clients may report more than the product limit; never go beyond 16.
  const oversized: InteractionContext = {
    ...interaction,
    agentNavigation: {
      ...interaction.agentNavigation!,
      ids: Array.from({ length: 20 }, (_, index) => `session-${index + 1}`),
    },
  };
  await run.route('switch to session 17', oversized);
  await run.route('switch to session eighteen', oversized);
  assert.deepEqual(run.selected, [2]);
});

test('inference is offered only with captured navigation and keeps the strict shortcut', async () => {
  const run = setup();
  await run.route('switch to session six');
  const intent = run.offered[0].find((candidate) => candidate.name === 'GO_TO_SESSION');
  assert.ok(intent?.instruction.includes('session number'));

  // No visible navigation: not offered to the model, so nothing can navigate.
  const hidden = setup({ answer: 'IGNORE' });
  await hidden.route('switch to session six', null);
  await hidden.route('switch to session six', {
    ...interaction,
    agentNavigation: { ...interaction.agentNavigation!, ids: [] },
  });
  assert.equal(hidden.offered.length, 2);
  for (const intents of hidden.offered) {
    assert.equal(
      intents.some((candidate) => candidate.name === 'GO_TO_SESSION'),
      false,
    );
  }
  await assert.rejects(
    setup().route('switch to session six', null),
    /Unregistered intent/,
    'A detector cannot pick an intent that was not offered',
  );

  // Suffixes the inferred scanner would accept never navigate through the prefix.
  const strict = setup({ answer: 'IGNORE' });
  for (const utterance of [
    'Go to session 2 and explain',
    'Go to session number six',
    'Go to session, please six',
    'Go to session the sixth one',
    'Go to session six please',
    'Go to session nein',
    'Go to session',
  ]) {
    assert.equal(await strict.route(utterance), 'GO_TO_SESSION', utterance);
  }
  assert.deepEqual(strict.offered, [], 'Prefix commands never reach inference');
  assert.deepEqual(strict.selected, []);
  assert.equal(strict.outcomes.length, 7);
  assert.ok(strict.outcomes.every((outcome) => outcome === 'skipped'));
  await strict.route('Go to session six!');
  assert.deepEqual(strict.selected, [5]);

  // Direct callers without a route get the strict shortcut parser.
  await strict.navigation.process(
    { ...frame, utterance: "let's switch to session six", interaction },
    signal(),
  );
  assert.deepEqual(strict.selected, [5]);
  assert.equal(strict.outcomes.at(-1), 'skipped');
});

test('shortcut and inference toggles are independent', async () => {
  const run = setup();
  const state = () =>
    run.router.intentStates({ interaction }).find((intent) => intent.name === 'GO_TO_SESSION')!;
  assert.equal(state().supportsInference, true);
  assert.equal(state().inferenceAvailable, true);
  assert.equal(state().prefixAvailable, true);
  assert.equal(
    run.router.intentStates({}).find((intent) => intent.name === 'GO_TO_SESSION')!
      .inferenceAvailable,
    false,
  );

  // Inference off: the shortcut still works, and inference no longer offers it.
  run.router.setEnabled('GO_TO_SESSION', false, 'inference');
  assert.equal(state().shortcutEnabled, true);
  await run.route('Go to session three');
  assert.deepEqual(run.selected, [2]);
  await assert.rejects(run.route('switch to session six'), /Unregistered intent/);
  assert.equal(
    run.offered.at(-1)!.some((intent) => intent.name === 'GO_TO_SESSION'),
    false,
  );

  // Shortcut off: the prefix is still consumed, while inference navigates.
  run.router.setEnabled('GO_TO_SESSION', true, 'inference');
  run.router.setEnabled('GO_TO_SESSION', false, 'shortcut');
  const offeredBefore = run.offered.length;
  await run.route('Go to session four');
  assert.equal(run.offered.length, offeredBefore, 'Disabled prefix is consumed, not inferred');
  assert.equal(run.outcomes.at(-1), 'skipped');
  await run.route("let's switch to session six");
  assert.deepEqual(run.selected, [2, 5]);
});

test('both cleanup modes navigate from the raw utterance without changing the contract', async () => {
  for (const cleanup of [false, true]) {
    const run = setup({ cleanup: cleanup || undefined });
    await run.route("Hey, let's switch to session six");
    await run.route('two ideas, switch to session six');
    await run.route('switch to session .6');
    await run.route('two,please switch to session six');
    await run.route('switch to session one of six');
    await run.route('switch to session minus six');
    await run.route('switch to session point 6');
    assert.deepEqual(run.selected, [5]);
    assert.deepEqual(run.outcomes, ['selected', ...Array(6).fill('skipped')]);
    assert.deepEqual(
      run.records,
      cleanup
        ? [...Array.from({ length: 7 }, () => ({ enabled: true, status: 'no-text' }))]
        : Array.from({ length: 7 }, () => ({ enabled: false })),
    );
  }
});

test('dictation with numbers routed elsewhere is never navigation', async () => {
  for (const cleanup of [false, true]) {
    const run = setup({ answer: 'SEND_TEXT_TO_APPLICATION', cleanup: cleanup || undefined });
    await run.route('Meeting moved to session six at 3');
    assert.deepEqual(run.selected, []);
    assert.deepEqual(run.delivered, [cleanup ? 'cleaned' : 'Meeting moved to session six at 3']);
  }
});

test('inferred preview reports the target without selecting it', async () => {
  const logs: string[] = [];
  const outcomes: string[] = [];
  const navigation = new GoToSession((_stage, detail) => logs.push(detail), true, {
    selectSession: () => assert.fail('Preview never selects'),
    outcome: (_id, outcome) => outcomes.push(outcome),
  });
  await navigation.process(
    { ...frame, utterance: "let's switch to session six", interaction },
    signal(),
    'inference',
  );
  assert.deepEqual(outcomes, ['preview']);
  assert.deepEqual(logs, ['Would select session 6']);
});
