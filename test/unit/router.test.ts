import assert from 'node:assert/strict';
import test from 'node:test';

import { UserSensorRouter } from '../../src/core/router.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { frame, processor, signal } from '../helpers.ts';

test('subscriptions supply the detector prompt and dispatch the original frame to exactly one processor', async () => {
  const delivered: unknown[] = [];

  const router = new UserSensorRouter(
    {
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
  assert.throws(() => processor('bad name').subscribe(router), /uppercase/);
});

test('unknown names and cancellation never dispatch', async () => {
  const controller = new AbortController();
  const router = new UserSensorRouter({ detect: async () => 'UNKNOWN' }, () => {});
  processor('IGNORE', async () => assert.fail('Should not dispatch')).subscribe(router);

  await assert.rejects(router.route(frame, signal()), /Unregistered/);

  controller.abort();
  await assert.rejects(router.route(frame, controller.signal), /abort/i);
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
      detect: async () => {
        address = '0xdef';
        return send.name;
      },
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
    { file: 'wtype', args: ['--', '-k Return hello world'] },
  ]);
});

test('preview does not invoke desktop commands', async () => {
  await new SendTextToApplication(
    () => {},
    true,
    async () => assert.fail('Desktop command in preview'),
  ).process(frame, signal());
});
