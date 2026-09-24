/** Intentionally fails in a subprocess to exercise real node:test teardown. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../external-session-fixture.ts';
import { deferred } from '../helpers.ts';

test('assertion failure with a held external-session turn', async (t) => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const f = await fixture(t, {
    async run() {
      entered.resolve();
      await gate.promise;
    },
    beforeClose: () => gate.resolve(),
  });
  await f.call('start', { text: 'Synthetic held turn' });
  await entered.promise;
  console.log(`EXTERNAL_FIXTURE_DIRECTORY=${f.directory}`);
  assert.fail('Intentional failure with a busy synthetic turn');
});
