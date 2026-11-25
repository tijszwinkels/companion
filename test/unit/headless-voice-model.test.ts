// The voice rule without a desktop, intent model present (`--intent-model`,
// a synthetic model on loopback): test/headless-voice-table.ts against the
// real listener and gateway.

import test from 'node:test';

import { headlessVoiceWorld } from '../headless-voice-fixture.ts';
import { pausedRow, runVoiceTable } from '../headless-voice-table.ts';

test('without a desktop and with an intent model, browsers listen by the rule', async (context) => {
  const world = await headlessVoiceWorld(context, { intentModel: true });
  await runVoiceTable(world, 'present');
  await pausedRow(world);
});
