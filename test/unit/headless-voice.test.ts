// The voice rule without a desktop, intent model absent (the default):
// test/headless-voice-table.ts against the real listener and gateway.

import assert from 'node:assert/strict';
import test from 'node:test';

import { headlessVoiceWorld, remote } from '../headless-voice-fixture.ts';
import { pausedRow, runVoiceTable } from '../headless-voice-table.ts';

test('without a desktop and without an intent model, browsers listen by the rule', async (context) => {
  const world = await headlessVoiceWorld(context, { intentModel: false });

  // The state: listening, browsers may stream, no microphone of the computer.
  const state = await world.listeningTab.engine('state');
  assert.equal(state.paused, false);
  assert.deepEqual(state.microphones, {
    computer: false,
    computerAvailable: false,
    listening: [],
    streams: true,
  });
  const intents = (state.intents as { name: string }[]).map((intent) => intent.name);
  assert.ok(intents.includes('TYPING_WITHOUT_DESKTOP'));
  assert.ok(intents.includes('NO_CONVERSATION_SHOWN'));
  assert.ok(!intents.includes('SEND_TEXT_TO_APPLICATION'));
  assert.ok(!intents.includes('ENTER_TEXT_TO_APPLICATION'));

  // The computer's switch stays refused.
  const computer = await remote(world.listeningTab, {
    action: 'set-computer-microphone',
    enabled: true,
  });
  assert.equal(computer.type, 'error');
  assert.match(String(computer.message), /has no microphone of its own/);

  await runVoiceTable(world, 'absent');
  await pausedRow(world);

  // No error in the listener's log apart from the quick questions' turns,
  // which need Pi (not on this machine's PATH).
  const errors = world.companion.listener
    .output()
    .split('\n')
    .filter((line) => / error /.test(line) && !/spawn pi ENOENT|pi-backend|Pi /.test(line));
  assert.deepEqual(errors, []);
});
