import assert from 'node:assert/strict';
import test from 'node:test';

import { UserSensorRouter } from '../../src/core/router.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { frame, processor, signal, testDetector } from '../helpers.ts';

test('subscriptions supply the detector prompt and dispatch the original frame to exactly one processor', async () => {
  const delivered: unknown[] = [];

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (input, intents) => {
          assert.equal(input, frame);
          assert.deepEqual(
            intents.map((i) => [i.name, i.instruction]),
            [
              ['IGNORE', 'Choose IGNORE'],
              ['CUSTOM', 'Choose CUSTOM'],
            ],
          );
          return 'CUSTOM';
        },
      }),
    },
    () => {},
  );

  processor('IGNORE', async () => {
    assert.fail('Wrong processor');
  }).subscribe(router);
  processor('CUSTOM', async (input) => {
    delivered.push(input);
  }).subscribe(router);

  assert.equal(await router.route(frame, signal()), 'CUSTOM');
  assert.deepEqual(delivered, [frame]);
  assert.throws(() => processor('CUSTOM').subscribe(router), /Duplicate/);
  assert.throws(() => processor('bad name').subscribe(router), /identifier/);
});

test('unknown names and cancellation never dispatch', async () => {
  const controller = new AbortController();
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'UNKNOWN' }) },
    () => {},
  );
  processor('IGNORE', async () => assert.fail('Should not dispatch')).subscribe(router);

  await assert.rejects(router.route(frame, signal()), /Unregistered/);

  controller.abort();
  await assert.rejects(router.route(frame, controller.signal), /abort/i);
});

test('a model cannot choose a dynamically unavailable processor, while its explicit prefix still works', async () => {
  let dispatched = 0;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (_frame, intents) => {
          assert.deepEqual(
            intents.map((intent) => intent.name),
            ['IGNORE'],
          );
          return 'CONDITIONAL';
        },
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  const conditional = {
    ...processor('CONDITIONAL', async () => {
      dispatched++;
    }),
    availableForInference: () => false,
    prefixes: ['explicit'],
  };
  conditional.subscribe(router);
  await assert.rejects(router.route(frame, signal()), /Unregistered intent/);
  assert.equal(dispatched, 0);
  await router.route({ ...frame, utterance: 'explicit payload' }, signal());
  assert.equal(dispatched, 1);
});

test('typing checks focus after inference, strips control keys, and treats text as a literal argument', async () => {
  const calls: { file: string; args: string[] }[] = [];
  let address = frame.screenshot.window.address;

  const send = new SendTextToApplication(
    () => {},
    false,
    async (file, args) => {
      calls.push({ file, args });
      return file === 'hyprctl'
        ? Buffer.from(
            JSON.stringify({
              address,
              class: 'editor',
              title: 'Document',
              at: [0, 0],
              size: [900, 600],
              mapped: true,
              hidden: false,
            }),
          )
        : Buffer.alloc(0);
    },
  );

  // The active window changes while inference runs, before the action is called.
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          address = '0xdef';
          return send.name;
        },
      }),
    },
    () => {},
  );
  send.subscribe(router);
  new Ignore(() => {}).subscribe(router);

  await router.route(frame, signal());
  assert.deepEqual(
    calls.map((c) => c.file),
    ['hyprctl'],
  );

  // With focus unchanged, text is literal and control characters become spaces.
  calls.length = 0;
  address = frame.screenshot.window.address;
  await send.process({ ...frame, utterance: '-k Return\nhello\tworld' }, signal());
  assert.deepEqual(calls, [
    { file: 'hyprctl', args: ['-j', 'activewindow'] },
    { file: 'wtype', args: ['-d', '1', '--', '-k Return hello world'] },
  ]);
});

test('preview does not invoke desktop commands', async () => {
  await new SendTextToApplication(
    () => {},
    true,
    async () => assert.fail('Desktop command in preview'),
  ).process(frame, signal());
});

test('feedback reports intent separately and confirms send only after successful keyboard delivery', async () => {
  const events: string[] = [];
  const activity = {
    intentRecognized: (_id: number, intent: string) => {
      events.push(intent);
    },
    outcome: (_id: number, outcome: string) => {
      events.push(outcome);
    },
  };
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'SEND_TEXT_TO_APPLICATION' }) },
    () => {},
    activity,
  );
  const send = new SendTextToApplication(
    () => {},
    false,
    async (file) => {
      if (file === 'hyprctl') {
        return Buffer.from(
          JSON.stringify({
            address: frame.screenshot.window.address,
            class: 'editor',
            title: 'Document',
            at: [0, 0],
            size: [600, 400],
            mapped: true,
            hidden: false,
          }),
        );
      }

      assert.deepEqual(events, ['SEND_TEXT_TO_APPLICATION']);
      return Buffer.alloc(0);
    },
    activity,
  );
  send.subscribe(router);
  new Ignore(() => {}, activity).subscribe(router);
  await router.route(frame, signal());
  assert.deepEqual(events, ['SEND_TEXT_TO_APPLICATION', 'sent']);

  events.length = 0;
  await new Ignore(() => {}, activity).process(frame);
  assert.deepEqual(events, ['ignored']);
});

test('manual recovery supersedes automatic delivery even while the final focus check is running', async () => {
  let recovered = false;
  const outcomes: string[] = [];
  const send = new SendTextToApplication(
    () => {},
    false,
    async (file) => {
      assert.equal(file, 'hyprctl', 'Superseded text must never reach wtype');
      recovered = true;
      return Buffer.from(
        JSON.stringify({
          address: frame.screenshot.window.address,
          class: 'editor',
          title: 'Document',
          at: [0, 0],
          size: [600, 400],
          mapped: true,
          hidden: false,
        }),
      );
    },
    {
      deliveryAllowed: () => !recovered,
      outcome: (_id, outcome) => {
        outcomes.push(outcome);
      },
    },
  );

  await send.process(frame, signal());
  assert.deepEqual(outcomes, ['skipped']);
});
