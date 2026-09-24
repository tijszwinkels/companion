import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { outcomeSound, soundCues, soundSamples } from '../../src/desktop/sounds.ts';
import type { RunCommand } from '../../src/sensors/screen/capture.ts';
import { desktopFixture, stopped, waitFor, windowReply } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

test('actual application and agent acceptance play distinct cues; preview, rejection and mute do not', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-destination-sounds-'));
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'sound-fixture',
        label: 'Sound fixture',
        dependencies: {},
        async run(_request, inputSignal) {
          await stopped(inputSignal);
        },
      },
    },
    () => {},
    directory,
  );
  const played: string[] = [];
  const run: RunCommand = async (command, args) => {
    if (command === 'pw-play') {
      played.push(basename(args[0]));
      return Buffer.alloc(0);
    }
    if (command === 'hyprctl') return windowReply();
    assert.equal(command, 'wtype');
    return Buffer.alloc(0);
  };
  const desktop = await desktopFixture(run, sessions, { sounds: true });
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const activity = desktop.runtime.activity;
  const send = new SendTextToApplication(() => {}, false, run, activity);
  desktop.seed(1);
  await send.process({ ...frame, id: 1 }, signal());
  await waitFor(() => played.length === 1);
  assert.deepEqual(played, ['sent.wav']);

  const start = new StartCodingAgentSession({ sessions }, () => {}, false, activity);
  desktop.seed(2);
  await start.process({ ...frame, id: 2 }, signal());
  await waitFor(() => played.length === 2);
  const id = sessions.snapshot()[0].id;
  desktop.send({ action: 'panel-state', id, composerFocused: false });
  await desktop.reply('panel-state');
  const followUp = new ContinueOpenAgentConversation({ sessions }, () => {}, false, activity);
  desktop.seed(3);
  await followUp.process(
    { ...frame, id: 3, interaction: activity.interactionContext!() },
    signal(),
  );
  await waitFor(() => played.length === 3);
  assert.deepEqual(played, ['sent.wav', 'agent-started.wav', 'agent-sent.wav']);
  assert.equal(sessions.snapshot()[0].messages.at(-1)!.state, 'queued');

  desktop.seed(4);
  const quick = new QuickQuestion({ sessions }, () => {}, false, activity);
  await quick.process({ ...frame, id: 4 }, signal());
  await waitFor(() => played.length === 4);
  assert.equal(played[3], 'agent-started.wav', 'Quick questions are also new sessions');

  desktop.seed(5);
  await followUp.process({ ...frame, id: 5 }, signal());
  const preview = new StartCodingAgentSession({ sessions }, () => {}, true, activity);
  desktop.seed(6);
  await preview.process({ ...frame, id: 6 }, signal());
  assert.equal(played.length, 4);
  desktop.send({ action: 'toggle-sounds' });
  await desktop.reply('toggle-sounds');
  desktop.seed(7);
  await start.process({ ...frame, id: 7 }, signal());
  await desktop.runtime.close(); // Drain the playback queue before asserting silence.
  assert.equal(played.length, 4);
});

test('all destination cues differ and unsuccessful outcomes never use success feedback', () => {
  const destinationCues = ['sent', 'agent-sent', 'agent-started', 'agent-completed'] as const;
  for (let index = 0; index < destinationCues.length; index++) {
    for (const other of destinationCues.slice(index + 1)) {
      assert.notDeepEqual(soundSamples(destinationCues[index]), soundSamples(other));
    }
  }
  for (const outcome of [
    'skipped',
    'preview',
    'error',
    'cancelled',
    'interrupted',
    'closed',
  ] as const) {
    assert.equal(outcomeSound(outcome, 'agent-session'), undefined);
  }
  assert.ok(soundCues.includes('agent-sent'));
  assert.ok(soundCues.includes('agent-started'));
});
