import assert from 'node:assert/strict';
import test from 'node:test';

import { UserSensorRouter } from '../../src/core/router.ts';
import { DeliveryInterruptedError } from '../../src/core/delivery-error.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import type { RunCommand } from '../../src/sensors/screen/capture.ts';
import { frame, signal } from '../helpers.ts';

/** Fake desktop whose focus can change at the same boundaries as real commands. */
function desktop() {
  const calls: { file: string; args: string[] }[] = [];
  let address = frame.screenshot.window.address;

  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    if (file === 'hyprctl') {
      return Buffer.from(
        JSON.stringify({
          address,
          class: 'editor',
          title: 'Document',
          at: [0, 0],
          size: [900, 600],
          mapped: true,
          hidden: false,
        }),
      );
    }
    return Buffer.alloc(0);
  };

  return {
    calls,
    run,
    moveFocus() {
      address = '0xdef';
    },
  };
}

test('insert types literal payload only; enter types then checks focus and presses Return', async () => {
  for (const prefix of ['insert', 'enter']) {
    const screen = desktop();
    const router = new UserSensorRouter(
      { detect: async () => assert.fail('Shortcut must bypass inference') },
      () => {},
    );
    new SendTextToApplication(() => {}, false, screen.run).subscribe(router);
    new EnterTextToApplication(() => {}, false, screen.run).subscribe(router);

    await router.route({ ...frame, utterance: `${prefix} -k Return\nhello\tworld` }, signal());

    const expected = [
      { file: 'hyprctl', args: ['-j', 'activewindow'] },
      { file: 'wtype', args: ['--', '-k Return hello world'] },
    ];
    if (prefix === 'enter') {
      expected.push(
        { file: 'hyprctl', args: ['-j', 'activewindow'] },
        { file: 'wtype', args: ['-k', 'Return'] },
      );
    }
    assert.deepEqual(screen.calls, expected);
  }
});

test('Enter command skips all keyboard input when focus has already changed', async () => {
  const screen = desktop();
  screen.moveFocus();

  await new EnterTextToApplication(() => {}, false, screen.run).process(frame, signal());

  assert.deepEqual(screen.calls, [{ file: 'hyprctl', args: ['-j', 'activewindow'] }]);
});

test('Enter is suppressed when focus moves during typing', async () => {
  const screen = desktop();
  const run: RunCommand = async (file, args, signal) => {
    const result = await screen.run(file, args, signal);
    if (file === 'wtype') {
      screen.moveFocus();
    }
    return result;
  };

  await assert.rejects(
    new EnterTextToApplication(() => {}, false, run).process(frame, signal()),
    DeliveryInterruptedError,
  );

  assert.deepEqual(screen.calls, [
    { file: 'hyprctl', args: ['-j', 'activewindow'] },
    { file: 'wtype', args: ['--', frame.utterance] },
    { file: 'hyprctl', args: ['-j', 'activewindow'] },
  ]);
});

test('failed or cancelled typing cannot be followed by Enter', async () => {
  for (const failure of ['throw', 'abort']) {
    const screen = desktop();
    const controller = new AbortController();
    const run: RunCommand = async (file, args, signal) => {
      const result = await screen.run(file, args, signal);
      if (file === 'wtype') {
        if (failure === 'throw') {
          throw Error('Typing failed');
        }
        controller.abort();
      }
      return result;
    };

    await assert.rejects(
      new EnterTextToApplication(() => {}, false, run).process(frame, controller.signal),
      DeliveryInterruptedError,
    );
    assert.equal(screen.calls.length, 2);
  }
});

test('preview describes Enter without desktop access, and blank payloads do nothing', async () => {
  const messages: string[] = [];
  const enter = new EnterTextToApplication(
    (_stage, message) => messages.push(message),
    true,
    async () => assert.fail('Preview must not access the desktop'),
  );
  await enter.process(frame, signal());
  assert.deepEqual(messages, [`Text delivery preview: ${JSON.stringify(frame.utterance)} + Enter`]);

  const live = new EnterTextToApplication(
    () => {},
    false,
    async () => assert.fail('Empty payload must not access the desktop'),
  );
  await live.process({ ...frame, utterance: '\n\t\u0000' }, signal());
  await assert.rejects(live.process(frame, AbortSignal.abort()), /abort/i);
});
