import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { chatMessage, type AgentBackend, type AgentSession } from '../../src/agents/types.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal, testDetector } from '../helpers.ts';

interface Turn {
  request: Parameters<AgentBackend['run']>[0];
  finish(): void;
  fail(error: Error): void;
}

/** Explicit turn gates exercise ordering without a live model or timing guesses. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-agent-queue-'));
  const turns: Turn[] = [];
  const active = new Set<string>();
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'queue-fixture',
        label: 'Queue fixture',
        dependencies: {},
        async run(request, signal, emit) {
          assert.equal(active.has(request.id), false, 'Never overlap turns in one conversation');
          active.add(request.id);
          let abort = () => {};
          try {
            await new Promise<void>((resolve, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
              turns.push({ request, finish: resolve, fail: reject });
            });
            emit(chatMessage('answer', 'assistant', `Answer to ${request.prompt.text}`));
          } finally {
            active.delete(request.id);
            signal.removeEventListener('abort', abort);
          }
        },
      },
    },
    () => {},
    directory,
  );
  context.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sessions,
    turns,
    directory,
    store: new SessionStore(join(directory, '.companion-sessions')),
  };
}

test('follow-ups during startup and inference run FIFO, and idle includes the whole queue', async (context) => {
  const { sessions, turns, store } = await fixture(context);
  const id = sessions.start(frame, signal());
  sessions.followUp(id, 'First follow-up', signal());
  await waitFor(() => turns.length === 1);
  const microphone = new AbortController();
  sessions.followUp(id, 'Second follow-up', microphone.signal);
  microphone.abort();
  assert.deepEqual(
    sessions.snapshot()[0].messages.map((message) => message.state),
    ['done', 'queued', 'queued'],
  );
  let idle = false;
  const finished = sessions.idle().then(() => {
    idle = true;
  });

  for (let index = 0; index < 3; index++) {
    assert.equal(idle, false);
    turns[index].finish();
    if (index < 2) {
      await waitFor(() => turns.length === index + 2);
    }
  }
  await finished;
  assert.deepEqual(
    turns.map(({ request }) => request.prompt.text),
    [frame.utterance, 'First follow-up', 'Second follow-up'],
  );
  assert.ok(turns.every(({ request }) => request.id === id));
  assert.deepEqual(
    turns.map(({ request }) => request.resume),
    [false, true, true],
  );
  assert.equal(turns[0].request.prompt.screenshot, frame.screenshot);
  assert.equal(turns[1].request.prompt.screenshot, undefined);
  assert.equal(turns[2].request.prompt.screenshot, undefined);
  const saved = await store.read(id);
  assert.ok(saved.messages.every((message) => message.state === 'done'));
  assert.equal(new Set(saved.messages.map((message) => message.id)).size, 6);
});

for (const action of ['stop', 'remove', 'close', 'failure'] as const) {
  test(`${action} discards waiting messages without replay on reopen`, async (context) => {
    const { sessions, turns, store } = await fixture(context);
    const id = sessions.start(frame, signal());
    await waitFor(() => turns.length === 1);
    sessions.followUp(id, 'Never run this after cancellation', signal());
    if (action === 'failure') {
      turns[0].fail(Error('Model failed'));
      await sessions.idle();
    } else if (action === 'close') {
      await sessions.close();
    } else {
      const stopping = sessions[action](id);
      assert.throws(() => sessions.followUp(id, 'Too late', signal()), /unavailable|stop/);
      await stopping;
    }
    assert.equal(turns.length, 1);
    const saved = await store.read(id);
    assert.equal(
      saved.messages.find((message) => message.text.startsWith('Never run'))?.state,
      'error',
    );
    if (action !== 'close') {
      if (action !== 'remove') {
        await sessions.remove(id);
      }
      await sessions.reopen(id);
      assert.equal(turns.length, 1, 'Reopening never restarts discarded work');
      sessions.followUp(id, 'An explicit new follow-up', signal());
      await waitFor(() => turns.length === 2);
      turns[1].finish();
      await sessions.idle();
    }
  });
}

test('queue admission is bounded, validates input, and leaves no rejected message behind', async (context) => {
  const { sessions } = await fixture(context);
  const id = sessions.start(frame, signal());
  assert.throws(() => sessions.followUp(id, ' ', signal()), /1–4000/);
  assert.throws(() => sessions.followUp(id, 'x'.repeat(4001), signal()), /1–4000/);
  assert.throws(() => sessions.followUp(id, 'Cancelled input', AbortSignal.abort()), /abort/i);
  for (let index = 0; index < 8; index++) {
    sessions.followUp(id, `Waiting ${index}`, signal());
  }
  assert.throws(() => sessions.followUp(id, 'Overflow', signal()), /8 queued/);
  assert.equal(sessions.snapshot()[0].messages.length, 9);
});

test('a queued turn waits for persistence and retains its slot at the four-agent limit', async (context) => {
  const { sessions, turns } = await fixture(context);
  const ids = Array.from({ length: 4 }, () => sessions.start(frame, signal()));
  await waitFor(() => turns.length === 4);
  const first = turns.find((turn) => turn.request.id === ids[0])!;
  const save = SessionStore.prototype.save;
  let releaseSave = () => {};
  let saving = false;
  context.mock.method(
    SessionStore.prototype,
    'save',
    async function (this: SessionStore, view: AgentSession) {
      if (view.id === ids[0] && view.status === 'completed' && !saving) {
        saving = true;
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
      }
      await save.call(this, view);
    },
  );
  context.after(() => releaseSave());
  first.finish();
  await waitFor(() => saving);
  sessions.followUp(ids[0], 'Accepted while saving', signal());
  assert.equal(turns.length, 4);
  assert.throws(() => sessions.start(frame, signal()), /Four questions/);
  releaseSave();
  await waitFor(() => turns.length === 5);
  assert.equal(turns[4].request.id, ids[0]);
  assert.equal(turns[4].request.prompt.text, 'Accepted while saving');
  for (const turn of turns) {
    turn.finish();
  }
  await sessions.idle();
});

test('a final history-write failure cannot start the next queued turn', async (context) => {
  const { sessions, turns, directory } = await fixture(context);
  const id = sessions.start(frame, signal());
  await waitFor(() => turns.length === 1);
  sessions.followUp(id, 'Do not continue after storage failure', signal());
  const path = join(directory, '.companion-sessions');
  await rename(path, path + '-saved');
  await writeFile(path, 'Not a directory');
  turns[0].finish();
  await sessions.idle();
  assert.equal(turns.length, 1);
  assert.equal(sessions.snapshot()[0].status, 'error');
  assert.equal(sessions.snapshot()[0].messages[1].state, 'error');
  assert.equal(sessions.snapshot()[0].completedTurnId, undefined);
});

for (const focused of [false, true]) {
  test(`classified speech and the message prefix queue to their captured conversation (focused=${focused})`, async (context) => {
    const { sessions, turns } = await fixture(context);
    const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
    context.after(() => desktop.close());
    const id = sessions.start(frame, signal());
    await waitFor(() => turns.length === 1);
    desktop.send({ action: 'panel-state', id, composerFocused: focused });
    await desktop.reply('panel-state');
    const activity = desktop.runtime.activity;
    assert.equal(activity.interactionContext!().agentAcceptsFollowUp, false);
    const router = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async (_frame, intents) => {
            assert.ok(intents.some((intent) => intent.name === 'CONTINUE_OPEN_AGENT_CONVERSATION'));
            return 'CONTINUE_OPEN_AGENT_CONVERSATION';
          },
        }),
      },
      () => {},
    );
    new ContinueOpenAgentConversation({ sessions }, () => {}, false, activity).subscribe(router);
    new Ignore(() => {}).subscribe(router);
    for (const utterance of ['Explain further', 'continue session: Then give an example']) {
      await router.route(
        { ...frame, utterance, interaction: activity.interactionContext!() },
        signal(),
      );
    }
    desktop.send({ action: 'send-agent', id, text: 'Typed follow-up' });
    assert.equal((await desktop.reply('send-agent')).result, 'submitted');
    assert.equal(turns.length, 1);
    // Once accepted, selecting Activity cannot redirect or cancel the queue.
    desktop.send({ action: 'panel-state', id: '', composerFocused: false });
    await desktop.reply('panel-state');
    for (let index = 0; index < 4; index++) {
      turns[index].finish();
      if (index < 3) {
        await waitFor(() => turns.length === index + 2);
      }
    }
    await sessions.idle();
    assert.deepEqual(
      turns.slice(1).map(({ request }) => request.prompt.text),
      ['Explain further', 'Then give an example', 'Typed follow-up'],
    );
    assert.ok(turns.every(({ request }) => request.id === id));
  });
}
