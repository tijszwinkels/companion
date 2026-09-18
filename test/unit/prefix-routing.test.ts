import assert from 'node:assert/strict';
import test from 'node:test';

import type { UserSensorFrame, UserSensorProcessor } from '../../src/core/frame.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { frame, processor, signal, testDetector } from '../helpers.ts';

function prefixProcessor(
  name: string,
  prefixes: string[],
  process: UserSensorProcessor['process'],
): UserSensorProcessor {
  return {
    id: name,
    label: name,
    dependencies: {},
    name,
    prefixes,
    process,

    subscribe(router) {
      router.register(this);
    },
  };
}

test('prefixes bypass inference and deliver a copy with only the command removed', async () => {
  const delivered: UserSensorFrame[] = [];
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix must bypass the LLM') }) },
    () => {},
  );

  // Prefix-only routing works without an IGNORE processor or a model prompt.
  prefixProcessor('INSERT', ['insert'], async (input) => {
    delivered.push(input);
  }).subscribe(router);

  const examples = [
    ['insert Hello world!', 'Hello world!'],
    ['  INSERT   Hello world!', 'Hello world!'],
    ['Insert, Hello world!', 'Hello world!'],
    ['Insert: Hello world!', 'Hello world!'],
    ['Insert. Hello world!', 'Hello world!'],
    ['insert .gitignore', '.gitignore'],
    ['insert "quoted text"', '"quoted text"'],
    ['insert enter hello', 'enter hello'],
    ['insert -k Return\nhello', '-k Return\nhello'],
  ];

  for (const [utterance, expected] of examples) {
    const input = { ...frame, utterance };
    assert.equal(await router.route(input, signal()), 'INSERT');

    const output = delivered.at(-1)!;
    assert.notEqual(output, input);
    assert.equal(input.utterance, utterance);
    assert.deepEqual(output, { ...input, utterance: expected });
    assert.equal(output.screenshot, input.screenshot);
  }

  assert.equal(delivered.length, examples.length);
});

test('bare prefixes are consumed without inference or an action', async () => {
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => assert.fail('Empty command must not fall back to inference'),
      }),
    },
    () => {},
  );
  prefixProcessor('ENTER', ['enter'], async () => assert.fail('No payload')).subscribe(router);

  for (const utterance of ['enter', ' ENTER ', 'Enter.', 'enter: ', 'enter\n\t']) {
    assert.equal(await router.route({ ...frame, utterance }, signal()), 'ENTER');
  }
});

test('whole-prefix matching leaves ordinary speech on the original LLM path', async () => {
  const delivered: UserSensorFrame[] = [];
  const classified: UserSensorFrame[] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (input, intents) => {
          classified.push(input);
          assert.deepEqual(intents, [{ name: 'IGNORE', instruction: 'Choose IGNORE' }]);
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE', async (input) => {
    delivered.push(input);
  }).subscribe(router);
  prefixProcessor('ENTER', ['enter'], async () => assert.fail('Wrong prefix')).subscribe(router);
  prefixProcessor('INSERT', ['insert'], async () => assert.fail('Wrong prefix')).subscribe(router);

  for (const utterance of ['entering town', 'insertion', 'enter.txt', 'please insert hello']) {
    const input = { ...frame, utterance };
    assert.equal(await router.route(input, signal()), 'IGNORE');
    assert.equal(classified.at(-1), input);
    assert.equal(delivered.at(-1), input);
  }
});

test('longest prefix wins regardless of registration order and aliases work', async () => {
  for (const specificFirst of [true, false]) {
    const router = new UserSensorRouter(
      { detector: testDetector({ detect: async () => assert.fail('Unexpected inference') }) },
      () => {},
    );
    const specific = prefixProcessor('CODE', [' INSERT CODE ', 'paste code'], async (input) => {
      assert.equal(input.utterance, 'hello');
    });
    const general = prefixProcessor('INSERT', ['insert'], async () => {
      assert.fail('Longer command should win');
    });

    const subscriptions = specificFirst ? [specific, general] : [general, specific];
    for (const subscription of subscriptions) {
      subscription.subscribe(router);
    }

    for (const utterance of ['insert code hello', 'Paste code hello']) {
      assert.equal(await router.route({ ...frame, utterance }, signal()), 'CODE');
    }
  }
});

test('invalid or conflicting registrations leave the registry unchanged', () => {
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  const noop = async () => {};
  prefixProcessor('INSERT', ['insert'], noop).subscribe(router);

  assert.throws(
    () => prefixProcessor('EMPTY', [], noop).subscribe(router),
    /instruction or a prefix/,
  );
  assert.throws(() => prefixProcessor('BLANK', ['  '], noop).subscribe(router), /blank/);
  assert.throws(() => router.register({ ...processor('BLANK'), instruction: ' ' }), /blank/);
  assert.throws(
    () => prefixProcessor('ALIAS', ['paste', 'PASTE'], noop).subscribe(router),
    /Duplicate/,
  );
  assert.throws(
    () => prefixProcessor('OTHER', ['paste', ' INSERT '], noop).subscribe(router),
    /Duplicate/,
  );

  // Neither the new name nor the earlier "paste" alias survived failed validation.
  prefixProcessor('OTHER', ['paste'], noop).subscribe(router);
});

test('the model sees dictation but never the prefix-only Enter command', async () => {
  const send = new SendTextToApplication(() => {}, true);
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (_input, intents) => {
          assert.deepEqual(intents, [
            { name: send.name, instruction: send.instruction },
            { name: 'IGNORE', instruction: new Ignore(() => {}).instruction },
          ]);
          return 'ENTER_TEXT_TO_APPLICATION';
        },
      }),
    },
    () => {},
  );
  send.subscribe(router);
  new EnterTextToApplication(
    () => {},
    false,
    async () => assert.fail('Must not submit'),
  ).subscribe(router);
  new Ignore(() => {}).subscribe(router);

  await assert.rejects(router.route(frame, signal()), /Unregistered intent/);
});

test('cancellation prevents both prefix dispatch and dispatch after inference', async () => {
  const controller = new AbortController();
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          controller.abort();
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE', async () => assert.fail('Cancelled inference')).subscribe(router);
  prefixProcessor('ENTER', ['enter'], async () => assert.fail('Cancelled command')).subscribe(
    router,
  );

  await assert.rejects(router.route(frame, controller.signal), /abort/i);
  await assert.rejects(
    router.route({ ...frame, utterance: 'enter hello' }, controller.signal),
    /abort/i,
  );
});
