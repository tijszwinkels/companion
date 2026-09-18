import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { desktopFixture, windowReply } from '../desktop-fixture.ts';
import { frame } from '../helpers.ts';

for (const delivery of ['automatic', 'recovery']) {
  test(`${delivery} typing can finish after five seconds without losing its delivery record`, async () => {
    const utterance = 'word '.repeat(400);
    const input = { ...frame, utterance };
    const run = async (file: string, args: string[], signal: AbortSignal) => {
      if (file === 'hyprctl') {
        return windowReply();
      }

      assert.equal(file, 'wtype');
      assert.deepEqual(args, ['-d', '1', '--', utterance]);

      // No keyboard input: simulate a long, paced write with real cancellation.
      // Both the old typeText limit and recovery's outer limit expired at 5 s.
      await delay(5200, undefined, { signal });
      return Buffer.alloc(0);
    };
    const fixture = await desktopFixture(run);

    try {
      fixture.runtime.activity.transcribed?.(input);

      if (delivery === 'automatic') {
        const processor = new SendTextToApplication(() => {}, false, run, fixture.runtime.activity);
        await processor.process(input, fixture.controller.signal);
      } else {
        const id = fixture.database.prepare('SELECT id FROM utterances').get()!.id;
        fixture.send({ action: 'paste', id, target: frame.screenshot.window.address });
        assert.equal((await fixture.reply('paste', 8000)).result, 'sent');
      }

      const table = delivery === 'automatic' ? 'utterances' : 'paste_events';
      const row = fixture.database
        .prepare(`SELECT outcome, delivery_started_at FROM ${table}`)
        .get();
      assert.equal(row?.outcome, 'sent');
      assert.equal(typeof row?.delivery_started_at, 'number');
    } finally {
      await fixture.close();
    }
  });
}
