import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal, testDetector } from '../helpers.ts';

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-agent-intents-'));
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'intent-fixture',
        label: 'Intent fixture',
        dependencies: {},
        async run(request) {
          requests.push(request);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(
    async () => assert.fail('No keyboard or desktop command'),
    sessions,
  );
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = sessions.start(frame, signal());
  await sessions.idle();
  const activity = desktop.runtime.activity;
  const outcomes: string[] = [];
  const feedback = {
    ...activity,
    outcome: (_id: number, outcome: string) => outcomes.push(outcome),
  };
  const continuation = new ContinueOpenAgentConversation({ sessions }, () => {}, false, feedback);

  async function select(id: string, composerFocused: boolean) {
    desktop.send({ action: 'panel-state', id, composerFocused });
    assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');
  }

  return { sessions, requests, desktop, first, activity, feedback, continuation, outcomes, select };
}

test('new coding agent and quick question both bypass inference with the uppercase intent', async (context) => {
  const setup = await fixture(context);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
  );
  new StartCodingAgentSession({ sessions: setup.sessions }, () => {}).subscribe(router);

  for (const prefix of ['new coding agent', 'QUICK QUESTION']) {
    assert.equal(
      await router.route({ ...frame, utterance: `${prefix}: Explain this screen.` }, signal()),
      'START_CODING_AGENT_SESSION',
    );
    await setup.sessions.idle();
    assert.equal(setup.requests.at(-1)?.prompt.text, 'Explain this screen.');
    assert.equal(setup.requests.at(-1)?.prompt.screenshot, frame.screenshot);
  }
  const count = setup.requests.length;
  await router.route({ ...frame, utterance: 'new coding agent' }, signal());
  assert.equal(setup.requests.length, count, 'Bare prefixes do not create empty sessions');
});

test('continuation is offered only for the focused composer and preserves the exact user prompt', async (context) => {
  const setup = await fixture(context);
  let offered = false;
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (_frame, intents) => {
          const entry = intents.find(
            (intent) => intent.name === 'CONTINUE_OPEN_AGENT_CONVERSATION',
          );
          offered = entry !== undefined;
          if (entry) {
            assert.equal(
              entry.instruction,
              'The user has  a coding agent session open and has the input field selected. Unless your context gives you strong reasons to think that the user has a different intention, select this intent.',
            );
            return entry.name;
          }
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  new Ignore(() => {}).subscribe(router);
  setup.continuation.subscribe(router);

  for (const [id, focused] of [
    [setup.first, false],
    ['', false],
    [setup.first, true],
    [setup.first, false],
  ] as const) {
    await setup.select(id, focused);
    await router.route({ ...frame, interaction: setup.activity.interactionContext!() }, signal());
    await setup.sessions.idle();
    assert.equal(offered, focused);
  }
  assert.equal(setup.requests.length, 2);
  assert.equal(setup.requests[1].id, setup.first);
  assert.equal(setup.requests[1].resume, true);
  assert.equal(setup.requests[1].prompt.screenshot, undefined);
});

test('message coding agent addresses an unfocused visible chat and never falls through without one', async (context) => {
  const setup = await fixture(context);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
    setup.feedback,
  );
  setup.continuation.subscribe(router);
  await setup.select(setup.first, false);
  const utterance = 'Message coding agent, explain that in more detail.';
  await router.route(
    { ...frame, utterance, interaction: setup.activity.interactionContext!() },
    signal(),
  );
  await setup.sessions.idle();
  assert.equal(setup.requests[1].id, setup.first);
  assert.equal(setup.requests[1].prompt.text, 'explain that in more detail.');
  assert.deepEqual(setup.outcomes, ['started']);

  await setup.select('', false);
  await router.route(
    { ...frame, utterance, interaction: setup.activity.interactionContext!() },
    signal(),
  );
  assert.equal(setup.requests.length, 2);
  assert.equal(setup.outcomes.at(-1), 'skipped');
  await router.route({ ...frame, utterance: 'message coding agent' }, signal());
  assert.equal(setup.requests.length, 2);
});

test('changing tabs or leaving and returning to a composer cannot redirect an in-flight continuation', async (context) => {
  const setup = await fixture(context);
  const second = setup.sessions.start({ ...frame, utterance: 'Other conversation' }, signal());
  await setup.sessions.idle();

  for (const change of ['tab', 'focus', 'close'] as const) {
    await setup.select(setup.first, true);
    const captured = setup.activity.interactionContext!();
    const router = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async () => {
            if (change === 'tab') {
              await setup.select(second, true);
            } else if (change === 'focus') {
              await setup.select(setup.first, false);
              await setup.select(setup.first, true);
            } else {
              await setup.sessions.remove(setup.first);
            }
            return 'CONTINUE_OPEN_AGENT_CONVERSATION';
          },
        }),
      },
      () => {},
    );
    new Ignore(() => {}).subscribe(router);
    setup.continuation.subscribe(router);
    await router.route({ ...frame, interaction: captured }, signal());
    assert.equal(setup.requests.length, 2);
    assert.equal(setup.outcomes.at(-1), 'skipped');
  }
});

test('preview and cancelled continuations never submit a follow-up', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, true);
  const input = { ...frame, interaction: setup.activity.interactionContext!() };
  const preview = new ContinueOpenAgentConversation(
    { sessions: setup.sessions },
    () => {},
    true,
    setup.feedback,
  );
  await preview.process(input, signal());
  assert.equal(setup.outcomes.at(-1), 'preview');
  await assert.rejects(setup.continuation.process(input, AbortSignal.abort()));
  assert.equal(setup.requests.length, 1);
});

test('panel reports validate targets, and composer changes retain the keyboard delivery guard', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, false);
  setup.activity.processing!(frame.id);
  await setup.select(setup.first, true);
  assert.equal(setup.activity.deliveryAllowed!(frame.id), false);
  const before = setup.activity.interactionContext!();
  setup.desktop.send({ action: 'panel-state', id: 'missing', composerFocused: true });
  assert.equal((await setup.desktop.reply('panel-state')).type, 'error');
  assert.deepEqual(setup.activity.interactionContext!(), before);
  setup.activity.finished!(frame.id);
});

test('disconnecting an old panel cannot clear its replacement, and losing the owner invalidates speech', async (context) => {
  const setup = await fixture(context);
  await setup.select(setup.first, true);
  const second = setup.sessions.start({ ...frame, utterance: 'Other session' }, signal());
  await setup.sessions.idle();
  const replacement = createConnection(setup.desktop.socketPath);
  context.after(() => {
    replacement.destroy();
  });
  replacement.on('data', () => {});
  await once(replacement, 'connect');
  replacement.write(
    JSON.stringify({ action: 'panel-state', id: second, composerFocused: true }) + '\n',
  );
  await waitFor(() => setup.activity.interactionContext!().agentSessionId === second);
  const captured = setup.activity.interactionContext!();

  setup.desktop.client.destroy();
  await once(setup.desktop.client, 'close');
  // Wait for the server-side close callback, not just the local socket close.
  // Its next report is ordered after it has processed the old disconnection.
  replacement.write(
    JSON.stringify({ action: 'panel-state', id: second, composerFocused: true }) + '\n',
  );
  await once(replacement, 'data');
  assert.deepEqual(setup.activity.interactionContext!(), captured);

  replacement.destroy();
  await waitFor(() => setup.activity.interactionContext!().agentSessionId === '');
  assert.equal(setup.activity.interactionCurrent!(captured), false);
});
