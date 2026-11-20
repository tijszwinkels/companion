import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeBackend } from '../../src/agents/claude/claude-backend.ts';
import type { HistoryPage } from '../../src/agents/history-pages.ts';
import { PiBackend } from '../../src/agents/pi-backend.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import {
  chatMessage,
  type AgentHarness,
  type AgentMessage,
  type AgentSession,
  type SessionEvent,
} from '../../src/agents/types.ts';
import { desktopFixture, stopped, waitFor } from '../desktop-fixture.ts';
import { callTool, harnessFixture } from '../harness-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { remoteFixture } from '../remote-fixture.ts';

/**
 * Turn times (`turnStartedAt`, `lastTurnDurationMs`), message creation times
 * (`createdAt`) and the listener's clock (`listenerTime`). Every test uses an
 * injected clock, temporary stores and scripted agent backends, or the real
 * backends driven by the scripted Pi and Claude Code executables. No real
 * agent, provider or personal data is involved.
 */

/** A conversation configuration in which Claude Code is available. */
const configuration = {
  ...defaultAgentSettings,
  claudeCode: { executable: '/opt/claude-fixture', model: 'claude-sonnet-5', effort: 'medium' },
};

const harnesses: AgentHarness[] = ['pi', 'claude-code'];

/** A wall clock that only moves when the test advances it (milliseconds). */
function fakeClock() {
  const clock = {
    current: 1_800_000_000_000,
    now: () => clock.current,
    advance(milliseconds: number): number {
      clock.current += milliseconds;
      return clock.current;
    },
  };
  return clock;
}

/** Record every session event, as a connected client would receive it. */
function recordEvents(sessions: AgentSessions): SessionEvent[] {
  const events: SessionEvent[] = [];
  sessions.subscribe((event) => {
    events.push(structuredClone(event));
  });
  return events;
}

/** The newest published state of one conversation. */
function lastPublished(events: SessionEvent[], id: string): AgentSession {
  const updates = events.filter(
    (event) =>
      (event.type === 'agent-session' || event.type === 'agent-restored') &&
      event.session.id === id,
  );
  const last = updates.at(-1);
  assert.ok(last && 'session' in last, `Expected a published update for ${id}`);
  return last.session;
}

async function savedJson(directory: string, id: string): Promise<Record<string, any>> {
  const path = join(directory, '.companion-sessions', `${id}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

/** A conversation exactly as a listener without times saved it. */
function oldFormatConversation(id: string) {
  const row = (
    rowId: string,
    kind: AgentMessage['kind'],
    text: string,
  ): Record<string, unknown> => {
    return { id: rowId, kind, text, toolName: '', input: '', state: 'done', screenshot: false };
  };
  return {
    id,
    title: 'An older conversation',
    status: 'completed',
    model: defaultAgentSettings.model,
    profile: 'coding',
    error: '',
    messages: [
      row('user', 'user', 'What is the answer?'),
      row('old-turn:answer', 'assistant', 'Forty-two.'),
      row('old-turn:notice', 'notice', 'Synthetic older notice'),
    ],
    updatedAt: 1_700_000_000_000,
  };
}

async function writeConversation(
  directory: string,
  conversation: Record<string, unknown> & { id: string },
) {
  const sessionsDirectory = join(directory, '.companion-sessions');
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(sessionsDirectory, `${conversation.id}.json`),
    JSON.stringify(conversation) + '\n',
  );
}

for (const harness of harnesses) {
  test(`${harness}: a running turn publishes its start; a finished turn only its duration`, async (context) => {
    const clock = fakeClock();
    const fixture = await harnessFixture(context, { configuration, wakeClock: clock.now });
    const events = recordEvents(fixture.sessions);

    // The completion signal must never arrive while a running time is shown.
    const runningAtCompletion: (number | undefined)[] = [];
    fixture.sessions.subscribe((event) => {
      if (event.type === 'agent-turn-completed') {
        runningAtCompletion.push(fixture.view(event.id).turnStartedAt);
      }
    });

    const startedAt = clock.current;
    const id = fixture.sessions.start(frame, signal(), 'coding', harness);

    // Admission publishes the start together with the `starting` status.
    assert.equal(fixture.view(id).status, 'starting');
    assert.equal(fixture.view(id).turnStartedAt, startedAt);
    assert.equal(lastPublished(events, id).turnStartedAt, startedAt);
    assert.equal(fixture.view(id).lastTurnDurationMs, undefined);

    fixture.script(id, async (run) => {
      assert.equal(run.harness, harness);
      assert.equal(fixture.view(id).status, 'running');
      assert.equal(fixture.view(id).turnStartedAt, startedAt);
      clock.advance(4_000);
    });
    await fixture.sessions.idle();

    const view = fixture.view(id);
    assert.equal(view.status, 'completed');
    assert.equal('turnStartedAt' in view, false);
    assert.equal(view.lastTurnDurationMs, 4_000);

    const published = lastPublished(events, id);
    assert.equal('turnStartedAt' in published, false);
    assert.equal(published.lastTurnDurationMs, 4_000);
    assert.deepEqual(runningAtCompletion, [undefined]);

    // Only the duration is saved; a running time never is.
    const saved = await savedJson(fixture.directory, id);
    assert.equal('turnStartedAt' in saved, false);
    assert.equal(saved.lastTurnDurationMs, 4_000);
  });
}

test('several attempts inside one backend run are one turn and one measurement', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const startedAt = clock.current;
  const id = fixture.sessions.start(frame, signal());

  fixture.script(id, async (run) => {
    // A first attempt fails inside the harness, which retries by itself.
    run.emit({ ...chatMessage('attempt', 'assistant', 'Partial'), state: 'running' });
    clock.advance(1_000);
    run.emit(chatMessage('retry', 'notice', 'Retrying after a provider error'));
    assert.equal(fixture.view(id).turnStartedAt, startedAt);

    clock.advance(1_500);
    run.emit(chatMessage('attempt', 'assistant', 'Complete answer'));
    assert.equal(fixture.view(id).turnStartedAt, startedAt);
  });
  await fixture.sessions.idle();

  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.view(id).lastTurnDurationMs, 2_500);
});

test('simultaneous conversations keep independent turn times', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { configuration, wakeClock: clock.now });
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();

  const firstStartedAt = clock.current;
  const first = fixture.sessions.start(frame, signal(), 'coding', 'pi');
  fixture.script(first, () => releaseFirst.promise);

  const secondStartedAt = clock.advance(1_000);
  const second = fixture.sessions.start(frame, signal(), 'coding', 'claude-code');
  fixture.script(second, () => releaseSecond.promise);

  await waitFor(() => fixture.runs.length === 2);
  assert.equal(fixture.view(first).turnStartedAt, firstStartedAt);
  assert.equal(fixture.view(second).turnStartedAt, secondStartedAt);

  // The second conversation finishes first; the first one keeps running.
  clock.advance(2_000);
  releaseSecond.resolve();
  await waitFor(() => fixture.view(second).status === 'completed');
  assert.equal(fixture.view(second).lastTurnDurationMs, 2_000);
  assert.equal(fixture.view(second).turnStartedAt, undefined);
  assert.equal(fixture.view(first).turnStartedAt, firstStartedAt);
  assert.equal(fixture.view(first).lastTurnDurationMs, undefined);

  clock.advance(500);
  releaseFirst.resolve();
  await fixture.sessions.idle();
  assert.equal(fixture.view(first).lastTurnDurationMs, 3_500);
  assert.equal(fixture.view(first).turnStartedAt, undefined);
  assert.equal(fixture.view(second).lastTurnDurationMs, 2_000);
});

for (const harness of harnesses) {
  test(`${harness}: a queued follow-up is its own turn with its own measurement`, async (context) => {
    const clock = fakeClock();
    const fixture = await harnessFixture(context, { configuration, wakeClock: clock.now });
    const releaseFirst = deferred<void>();

    const firstStartedAt = clock.current;
    const id = fixture.sessions.start(frame, signal(), 'coding', harness);
    let secondStartedAt = 0;
    fixture.script(
      id,
      () => releaseFirst.promise,
      async () => {
        // The follow-up's turn began when the previous one ended, not when
        // the message was queued, and the previous duration is already final.
        assert.equal(fixture.view(id).turnStartedAt, secondStartedAt);
        assert.equal(fixture.view(id).lastTurnDurationMs, secondStartedAt - firstStartedAt);
        clock.advance(700);
      },
    );
    await waitFor(() => fixture.runs.length === 1);

    const queuedAt = clock.advance(1_000);
    const outcome = fixture.sessions.followUp(id, 'And the next step?', signal());
    assert.equal(outcome.outcome, 'queued');

    // Queuing does not restart the running turn's measurement.
    assert.equal(fixture.view(id).turnStartedAt, firstStartedAt);
    const queued = fixture.view(id).messages.find((row) => row.text === 'And the next step?');
    assert.equal(queued?.state, 'queued');
    assert.equal(queued?.createdAt, queuedAt);

    secondStartedAt = clock.advance(1_000);
    releaseFirst.resolve();
    await fixture.sessions.idle();

    assert.equal(fixture.runs.length, 2);
    assert.equal(fixture.view(id).turnStartedAt, undefined);
    assert.equal(fixture.view(id).lastTurnDurationMs, 700);

    // The message keeps the time it was written, not the time its turn began.
    const delivered = fixture.view(id).messages.find((row) => row.text === 'And the next step?');
    assert.equal(delivered?.state, 'done');
    assert.equal(delivered?.createdAt, queuedAt);
  });
}

for (const harness of harnesses) {
  test(`${harness}: nothing running remains after Stop or an error`, async (context) => {
    const clock = fakeClock();
    const fixture = await harnessFixture(context, { configuration, wakeClock: clock.now });
    const events = recordEvents(fixture.sessions);

    // Stop, with a queued follow-up that must never start a turn.
    const stoppedId = fixture.sessions.start(frame, signal(), 'coding', harness);
    fixture.script(stoppedId, (run) => stopped(run.signal));
    await waitFor(() => fixture.runs.length === 1);
    fixture.sessions.followUp(stoppedId, 'Queued behind the stopped turn', signal());
    clock.advance(300);
    await fixture.sessions.stop(stoppedId);
    await fixture.sessions.idle();

    assert.equal(fixture.runs.length, 1);
    assert.equal(fixture.view(stoppedId).status, 'cancelled');
    assert.equal(fixture.view(stoppedId).turnStartedAt, undefined);
    assert.equal(lastPublished(events, stoppedId).turnStartedAt, undefined);
    assert.equal(fixture.view(stoppedId).lastTurnDurationMs, 300);

    // An error inside the harness.
    const failedId = fixture.sessions.start(frame, signal(), 'coding', harness);
    fixture.script(failedId, async () => {
      clock.advance(200);
      throw Error('Synthetic harness failure');
    });
    await fixture.sessions.idle();

    assert.equal(fixture.view(failedId).status, 'error');
    assert.equal(fixture.view(failedId).turnStartedAt, undefined);
    assert.equal(lastPublished(events, failedId).turnStartedAt, undefined);
    assert.equal(fixture.view(failedId).lastTurnDurationMs, 200);
  });
}

/** Copy a scripted harness executable into the fixture directory. */
async function scriptedExecutable(directory: string, fixtureName: string): Promise<string> {
  const executable = join(directory, `scripted-${fixtureName}`);
  await copyFile(fileURLToPath(new URL(`../fixtures/${fixtureName}`, import.meta.url)), executable);
  await chmod(executable, 0o700);
  return executable;
}

test('nothing running remains after the real Pi or Claude Code process exits mid-turn', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { configuration, wakeClock: clock.now });
  const { directory } = fixture;
  const events = recordEvents(fixture.sessions);

  // The production backends, driven by the scripted executables, which exit
  // with status 3 when the prompt is `exit`.
  const piSettings = {
    ...defaultAgentSettings,
    executable: await scriptedExecutable(directory, 'pi-rpc.mjs'),
  };
  const claudeSettings = {
    executable: await scriptedExecutable(directory, 'claude-stream.mjs'),
    model: 'claude-opus-5-5',
    effort: 'high' as const,
  };

  const piId = fixture.sessions.start(frame, signal(), 'coding', 'pi');
  fixture.script(piId, async (run) => {
    clock.advance(250);
    await new PiBackend().run(
      { id: piId, directory, settings: piSettings, prompt: { text: 'exit' }, resume: false },
      run.signal,
      run.emit,
    );
  });

  const claudeId = fixture.sessions.start(frame, signal(), 'coding', 'claude-code');
  fixture.script(claudeId, async (run) => {
    clock.advance(250);
    await new ClaudeCodeBackend().run(
      {
        id: claudeId,
        directory,
        settings: claudeSettings,
        prompt: { text: 'exit' },
        resume: false,
      },
      run.signal,
      run.emit,
    );
  });
  await fixture.sessions.idle();

  for (const [id, reason] of [
    [piId, /Pi exited before finishing/],
    [claudeId, /Claude Code exited before finishing/],
  ] as const) {
    const view = fixture.view(id);
    assert.equal(view.status, 'error');
    assert.match(view.error, reason);
    assert.equal(view.turnStartedAt, undefined);
    assert.equal(lastPublished(events, id).turnStartedAt, undefined);
    assert.equal(typeof view.lastTurnDurationMs, 'number');
  }
});

test('a turn does not survive a listener restart; its conversation reopens without times running', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const releaseSecond = deferred<void>();

  // One finished turn, then one that is cut off by the restart.
  const id = fixture.sessions.start(frame, signal());
  fixture.script(
    id,
    async () => {
      clock.advance(800);
    },
    () => releaseSecond.promise,
  );
  await fixture.sessions.idle();
  assert.equal(fixture.view(id).lastTurnDurationMs, 800);

  fixture.sessions.followUp(id, 'A turn the restart interrupts', signal());
  await waitFor(() => fixture.runs.length === 2);

  // The question was saved before the harness started, without a running time.
  const saved = await savedJson(fixture.directory, id);
  assert.equal(saved.status, 'starting');
  assert.equal('turnStartedAt' in saved, false);
  assert.equal(saved.lastTurnDurationMs, 800);

  // A second listener over the same directory, as after a restart.
  const restarted = fixture.open();
  await restarted.loadPrevious();
  const summary = restarted.previousSnapshot().find((entry) => entry.id === id);
  assert.ok(summary);
  assert.equal(summary.status, 'cancelled');
  assert.equal('turnStartedAt' in summary, false);
  assert.equal('lastTurnDurationMs' in summary, false, 'the interrupted turn has no duration');

  await restarted.reopen(id);
  const reopened = fixture.view(id, restarted);
  assert.equal(reopened.turnStartedAt, undefined);
  assert.equal(reopened.lastTurnDurationMs, undefined);

  releaseSecond.resolve();
});

test('an old-format conversation loads without times and gets them only on new messages and turns', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const id = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab';
  const old = oldFormatConversation(id);
  await writeConversation(fixture.directory, old);

  await fixture.sessions.loadPrevious();
  const summary = fixture.sessions.previousSnapshot().find((entry) => entry.id === id);
  assert.ok(summary);
  assert.equal(summary.lastTurnDurationMs, undefined);

  await fixture.sessions.reopen(id);
  const reopened = fixture.view(id);
  assert.equal(reopened.status, 'completed');
  assert.equal(reopened.turnStartedAt, undefined);
  assert.equal(reopened.lastTurnDurationMs, undefined);
  for (const message of reopened.messages) {
    assert.equal('createdAt' in message, false, `no time is invented for ${message.id}`);
  }

  // A new turn in the old conversation starts at zero elapsed time, not at
  // the conversation's age or its last update.
  const followUpAt = clock.current;
  fixture.script(id, async () => {
    assert.equal(fixture.view(id).turnStartedAt, followUpAt);
    clock.advance(1_500);
  });
  fixture.sessions.followUp(id, 'One more question', signal());
  assert.equal(fixture.view(id).turnStartedAt, followUpAt);
  assert.equal(clock.now() - fixture.view(id).turnStartedAt!, 0);
  await fixture.sessions.idle();

  const continued = fixture.view(id);
  assert.equal(continued.status, 'completed');
  assert.equal(continued.lastTurnDurationMs, 1_500);
  const times = continued.messages.map((message) => [message.id, message.createdAt]);
  assert.deepEqual(times.slice(0, 3), [
    ['user', undefined],
    ['old-turn:answer', undefined],
    ['old-turn:notice', undefined],
  ]);
  const added = continued.messages.slice(3);
  assert.equal(added.length, 2);
  assert.equal(added[0].text, 'One more question');
  assert.equal(added[0].createdAt, followUpAt);
  assert.equal(added[1].kind, 'assistant');
  assert.equal(added[1].createdAt, followUpAt + 1_500);

  // The saved file keeps the old rows untouched and loads the same way again.
  const saved = await savedJson(fixture.directory, id);
  for (const message of saved.messages.slice(0, 3)) {
    assert.equal('createdAt' in message, false);
  }
  const store = new SessionStore(join(fixture.directory, '.companion-sessions'));
  const reread = await store.read(id);
  assert.deepEqual(
    reread.messages.map((message) => message.createdAt),
    [undefined, undefined, undefined, followUpAt, followUpAt + 1_500],
  );
  assert.equal(reread.lastTurnDurationMs, 1_500);
  store.tools.close();
});

test('the store drops damaged times and the duration of an interrupted turn', async (context) => {
  const fixture = await harnessFixture(context);
  const id = '7a2b3c4d-5e6f-4a7b-8c9d-0123456789ab';
  const conversation = oldFormatConversation(id);
  const [question, answer, notice] = conversation.messages;
  await writeConversation(fixture.directory, {
    ...conversation,
    status: 'running',
    // A field that only a live listener publishes; a file must never revive it.
    turnStartedAt: 1_700_000_000_000,
    lastTurnDurationMs: 5_000,
    messages: [
      { ...question, createdAt: 1_700_000_000_000 },
      { ...answer, createdAt: -1 },
      { ...notice, createdAt: 'yesterday' },
    ],
  });

  const store = new SessionStore(join(fixture.directory, '.companion-sessions'));
  context.after(async () => store.tools.close());
  const view = await store.read(id);
  assert.equal(view.status, 'cancelled');
  assert.equal('turnStartedAt' in view, false);
  assert.equal('lastTurnDurationMs' in view, false);
  assert.deepEqual(
    view.messages.map((message) => message.createdAt),
    [1_700_000_000_000, undefined, undefined],
  );

  // A completed conversation keeps a valid duration and drops a damaged one.
  await writeConversation(fixture.directory, { ...conversation, lastTurnDurationMs: 5_000 });
  assert.equal((await store.read(id)).lastTurnDurationMs, 5_000);
  await writeConversation(fixture.directory, { ...conversation, lastTurnDurationMs: 1.5 });
  assert.equal('lastTurnDurationMs' in (await store.read(id)), false);
});

test('every new message carries a creation time that later updates keep', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const questionAt = clock.current;
  const id = fixture.sessions.start(frame, signal());

  let replyAt = 0;
  let toolsAt = 0;
  let noticeAt = 0;
  fixture.script(id, async (run) => {
    replyAt = clock.advance(100);
    run.emit({ ...chatMessage('reply', 'assistant', 'Part'), state: 'running' });
    clock.advance(100);
    run.emit({ ...chatMessage('reply', 'assistant', 'Part and more'), state: 'running' });
    run.emit(chatMessage('reply', 'assistant', 'Part and more, finished'));

    // Two consecutive tool calls form one group, created with its first call.
    toolsAt = clock.advance(100);
    const call = { ...chatMessage('call-1', 'tool', ''), toolName: 'bash', input: 'ls' };
    run.emit({ ...call, state: 'running' });
    clock.advance(100);
    run.emit({ ...call, text: 'file.txt' });
    clock.advance(100);
    run.emit({ ...call, id: 'call-2', text: 'second output' });

    noticeAt = clock.advance(100);
    run.emit(chatMessage('notice', 'notice', 'Synthetic notice'));
  });
  await fixture.sessions.idle();

  const messages = fixture.view(id).messages;
  const byKind = (kind: AgentMessage['kind']) => messages.filter((row) => row.kind === kind);
  assert.equal(byKind('user')[0].createdAt, questionAt);
  assert.equal(byKind('tool').length, 1);
  assert.equal(byKind('tool')[0].toolGroup?.count, 2);
  assert.equal(byKind('tool')[0].createdAt, toolsAt);
  assert.equal(byKind('notice')[0].createdAt, noticeAt);

  const reply = byKind('assistant').find((row) => row.text.startsWith('Part'));
  assert.equal(reply?.text, 'Part and more, finished');
  assert.equal(reply?.createdAt, replyAt);
  for (const message of messages) {
    assert.equal(Number.isSafeInteger(message.createdAt), true, `${message.id} has a time`);
  }

  // History pages carry the times, including a fragment of an oversized row.
  const page = fixture.sessions.historyPage({
    id,
    epoch: fixture.view(id).toolEpoch!,
    direction: 'after',
    index: 0,
    offset: 0,
  });
  assert.deepEqual(
    page.messages.map((row) => row.createdAt),
    messages.map((row) => row.createdAt),
  );

  // Saving, closing and reopening keeps every time, tool groups included.
  await fixture.sessions.remove(id);
  await fixture.sessions.reopen(id);
  const reopened = fixture.view(id).messages;
  assert.equal(reopened.find((row) => row.kind === 'tool')?.createdAt, toolsAt);
  assert.equal(reopened.find((row) => row.kind === 'notice')?.createdAt, noticeAt);
  assert.equal(reopened[0].createdAt, questionAt);

  const largeAt = clock.advance(100);
  fixture.script(id, async (run) => {
    run.emit(chatMessage('large', 'assistant', 'x'.repeat(70_000)));
  });
  fixture.sessions.followUp(id, 'A long answer, please', signal());
  await fixture.sessions.idle();
  const latest = fixture.view(id).messages;
  const fragment = latest.find((row) => row.historyFragment && row.text.startsWith('x'));
  assert.ok(fragment, 'the oversized answer is shown as a fragment');
  assert.equal(fragment.createdAt, largeAt);
});

test('state messages carry the listener clock from the same source as turn times', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const desktop = await desktopFixture(
    async () => assert.fail('No desktop input'),
    fixture.sessions,
  );
  context.after(() => desktop.close());

  await waitFor(() => desktop.messages.some((message) => message.type === 'state'));
  const state = desktop.messages.find((message) => message.type === 'state');
  assert.equal((state as Record<string, unknown> | undefined)?.listenerTime, clock.current);
});

test('a remote client receives exactly the listener’s turn times, message times and clock', async (context) => {
  // A listener clock far from the test machine's, so that a value the
  // gateway substituted from its own clock could not pass.
  const clock = fakeClock();
  const fixture = await remoteFixture({ clock: clock.now });
  context.after(() => fixture.close());
  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);

  const state = await phone.engine('state');
  assert.equal(state.listenerTime, clock.current);

  const startedAt = clock.advance(1_000);
  const id = fixture.sessions.start(frame, signal());
  await waitFor(() => fixture.runs.length === 1);
  const running = await phone.engine(
    'agent-session',
    (message) => message.session.id === id && message.session.status === 'running',
  );
  assert.equal(running.session.turnStartedAt, startedAt);

  const question = await phone.engine('agent-session', (message) =>
    message.session.messages.some((row: AgentMessage) => row.id === 'user'),
  );
  const questionRow = question.session.messages.find((row: AgentMessage) => row.id === 'user');
  assert.equal(questionRow.createdAt, startedAt);

  const answeredAt = clock.advance(2_000);
  fixture.runs[0].emit(chatMessage('answer', 'assistant', 'Synthetic answer'));
  fixture.runs[0].finish();
  await fixture.sessions.idle();

  const finished = await phone.engine(
    'agent-session',
    (message) => message.session.id === id && message.session.status === 'completed',
  );
  assert.equal('turnStartedAt' in finished.session, false);
  assert.equal(finished.session.lastTurnDurationMs, 2_000);

  // A history page relayed to the phone keeps every message's time.
  phone.send({ requestId: 'select', action: 'panel-state', id });
  await phone.reply('select');
  phone.send({
    requestId: 'page',
    action: 'agent-history-page',
    id,
    epoch: finished.session.toolEpoch,
    direction: 'after',
    index: 0,
    offset: 0,
  });
  const reply = (await phone.reply('page')) as { type: string; result: HistoryPage };
  assert.equal(reply.type, 'result');
  assert.deepEqual(
    reply.result.messages.map((message) => message.createdAt),
    [startedAt, answeredAt],
  );

  // A phone that connects later receives the same fields in its snapshot.
  const connectedAt = clock.advance(5_000);
  const later = await fixture.phone(token);
  const snapshot = await later.engine('state');
  const session = snapshot.sessions.find((entry: AgentSession) => entry.id === id);
  assert.equal(session.lastTurnDurationMs, 2_000);
  assert.equal('turnStartedAt' in session, false);
  assert.equal(snapshot.listenerTime, connectedAt);
});

/**
 * Hold the session store's saves while `held` is set, to observe what clients
 * see while persistence is slow. Reaches into the private store on purpose.
 */
function holdSaves(sessions: AgentSessions) {
  const store = (sessions as unknown as { store: SessionStore }).store;
  const save = store.save.bind(store);
  let gate: ReturnType<typeof deferred<void>> | undefined;
  let waiting = 0;

  let failure: Error | undefined;

  store.save = async (session) => {
    const current = gate;
    if (current) {
      waiting++;
      await current.promise;
      if (failure) {
        throw failure;
      }
    }
    return save(session);
  };

  return {
    hold() {
      gate = deferred<void>();
      waiting = 0;
      failure = undefined;
    },
    waiting: () => waiting,
    /** Let the held saves continue, or fail them with `error`. */
    release(error?: Error) {
      const current = gate;
      gate = undefined;
      failure = error;
      current?.resolve();
    },
  };
}

for (const saveFails of [false, true]) {
  const outcome = saveFails ? 'a failed' : 'a successful';
  test(`the end of a turn is published before ${outcome} final save; its status after it`, async (context) => {
    const clock = fakeClock();
    const fixture = await harnessFixture(context, { wakeClock: clock.now });
    const events = recordEvents(fixture.sessions);
    const saves = holdSaves(fixture.sessions);

    const id = fixture.sessions.start(frame, signal());
    fixture.script(id, async () => {
      clock.advance(900);
      saves.hold();
    });
    await waitFor(() => saves.waiting() === 1);

    // The final save is pending. Clients already see that the turn ended
    // and how long it took, but still the `running` status: the conversation
    // is busy and queues new messages. The completion signal also waits.
    // The save is released even when an assertion fails, so that cleanup
    // cannot hang.
    try {
      const published = lastPublished(events, id);
      assert.equal('turnStartedAt' in published, false);
      assert.equal(published.lastTurnDurationMs, 900);
      assert.equal(published.status, 'running');
      assert.equal(fixture.view(id).status, 'running', 'snapshots agree');

      const queued = fixture.sessions.followUp(id, 'Sent while saving', signal());
      assert.equal(queued.outcome, 'queued');
      assert.equal(lastPublished(events, id).status, 'running');
      assert.equal(
        events.some((event) => event.type === 'agent-turn-completed'),
        false,
      );
    } finally {
      saves.release(saveFails ? Error('Synthetic save failure') : undefined);
    }
    await fixture.sessions.idle();

    const queuedRow = fixture.view(id).messages.find((row) => row.text === 'Sent while saving');
    if (saveFails) {
      // The failed save fails the turn and cancels the queued message.
      assert.equal(fixture.view(id).status, 'error');
      assert.match(fixture.view(id).error, /Synthetic save failure/);
      assert.equal(queuedRow?.state, 'error');
      assert.equal(fixture.runs.length, 1);
      assert.equal(
        events.some((event) => event.type === 'agent-turn-completed'),
        false,
      );
    } else {
      assert.equal(fixture.view(id).status, 'completed');
      assert.equal(queuedRow?.state, 'done');
      assert.equal(fixture.runs.length, 2);
      assert.equal(
        events.some((event) => event.type === 'agent-turn-completed'),
        true,
      );
    }
    assert.equal(fixture.view(id).turnStartedAt, undefined);
    assert.equal(lastPublished(events, id).turnStartedAt, undefined);
  });
}

/** An authored application's send, as its origin records it. */
const applicationOrigin = {
  kind: 'application-message' as const,
  applicationId: '8b1c2d3e-4f5a-4b6c-8d7e-0123456789ab',
  name: 'synthetic',
  version: 1,
  bundle: 'synthetic-bundle',
  receiptId: '9c1d2e3f-4a5b-4c6d-8e7f-0123456789ab',
  title: 'Synthetic application',
  depth: 1 as const,
};

/**
 * Stand in for the application service's send bookkeeping, so that an
 * application send can be followed through a turn without authored code.
 * Reaches into private fields on purpose. Counts sends admitted to the model.
 */
function replaceApplicationSends(sessions: AgentSessions) {
  let began = 0;
  const applications = (
    sessions as unknown as {
      widgets: { applications: { chatSendTurn: () => unknown } };
    }
  ).widgets.applications;

  applications.chatSendTurn = () => {
    return {
      begin: () => {
        began++;
        return true;
      },
      finish: async () => {},
    };
  };

  return { began: () => began };
}

test('an application send stopped before it began keeps the previous duration', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const id = fixture.sessions.start(frame, signal());
  fixture.script(id, async () => {
    clock.advance(800);
  });
  await fixture.sessions.idle();
  assert.equal(fixture.view(id).lastTurnDurationMs, 800);

  const sends = replaceApplicationSends(fixture.sessions);

  // Stop while the send is still starting: the question's save is held.
  const saves = holdSaves(fixture.sessions);
  saves.hold();
  fixture.sessions.followUp(id, 'From the application', signal(), applicationOrigin);
  let stopping: Promise<number> | undefined;
  try {
    await waitFor(() => saves.waiting() === 1);
    clock.advance(15);
    stopping = fixture.sessions.stop(id);
  } finally {
    saves.release();
  }
  await stopping;
  await fixture.sessions.idle();

  assert.equal(sends.began(), 0);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.view(id).turnStartedAt, undefined);
  assert.equal(fixture.view(id).lastTurnDurationMs, 800);
});

test('an application send that fails while starting is measured like any turn', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const id = fixture.sessions.start(frame, signal());
  fixture.script(id, async () => {
    clock.advance(100);
  });
  await fixture.sessions.idle();
  assert.equal(fixture.view(id).lastTurnDurationMs, 100);

  replaceApplicationSends(fixture.sessions);

  // The question's save fails: the admitted turn fails before the model.
  const saves = holdSaves(fixture.sessions);
  saves.hold();
  fixture.sessions.followUp(id, 'From the application', signal(), applicationOrigin);
  try {
    await waitFor(() => saves.waiting() === 1);
    clock.advance(500);
  } finally {
    saves.release(Error('Synthetic save failure'));
  }
  await fixture.sessions.idle();

  assert.equal(fixture.view(id).status, 'error');
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.view(id).turnStartedAt, undefined);
  assert.equal(fixture.view(id).lastTurnDurationMs, 500);
});

test('a timer notice has the same time live and after a restart, with a moving clock', async (context) => {
  // Every reading of this clock is one millisecond later than the previous.
  const clock = fakeClock();
  const movingClock = () => clock.advance(1);
  const fixture = await harnessFixture(context, {
    configuration: { ...defaultAgentSettings, model: 'configured/one' },
    wakeClock: movingClock,
  });
  const id = fixture.sessions.start(frame, signal(), 'coding', 'pi');
  fixture.script(id, async (run) => {
    await callTool(run, 'companion_wake_schedule', {
      afterSeconds: 60,
      label: 'Synthetic check',
      message: 'Look again',
    });
  });
  await fixture.sessions.idle();

  const timer = fixture.sessions.wakes.list(id)[0];
  const live = fixture.view(id).messages.find((message) => message.id === `wake:${timer.id}`);
  assert.equal(live?.createdAt, timer.createdAt);

  // A normal restart: close (saves), stop the listener, reopen elsewhere.
  await fixture.sessions.remove(id);
  await fixture.sessions.close();
  const restarted = fixture.open();
  await restarted.loadPrevious();
  await restarted.reopen(id);
  const reopened = fixture
    .view(id, restarted)
    .messages.find((message) => message.id === `wake:${timer.id}`);
  assert.equal(reopened?.createdAt, timer.createdAt);
});

test('an application send revoked before it began keeps the previous duration, even if starting fails', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  const id = fixture.sessions.start(frame, signal());
  fixture.script(id, async () => {
    clock.advance(100);
  });
  await fixture.sessions.idle();
  assert.equal(fixture.view(id).lastTurnDurationMs, 100);

  const sends = replaceApplicationSends(fixture.sessions);
  const saves = holdSaves(fixture.sessions);
  saves.hold();
  fixture.sessions.followUp(id, 'From the application', signal(), applicationOrigin);
  try {
    await waitFor(() => saves.waiting() === 1);
    clock.advance(500);
    // The application service withdraws the send, as when its permission is
    // revoked. Reaches into the private callback on purpose.
    const withdraw = (
      fixture.sessions as unknown as {
        withdrawApplicationChat(owner: string, receipts: { receiptId: string }[]): void;
      }
    ).withdrawApplicationChat.bind(fixture.sessions);
    withdraw(id, [{ receiptId: applicationOrigin.receiptId }]);
  } finally {
    saves.release(Error('Synthetic save failure'));
  }
  await fixture.sessions.idle();

  assert.equal(sends.began(), 0);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.view(id).status, 'error');
  assert.equal(fixture.view(id).turnStartedAt, undefined);
  assert.equal(fixture.view(id).lastTurnDurationMs, 100);
});

test('a timer service warning row takes the time of the warning it first shows', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, { wakeClock: clock.now });
  // Reaches into the private warning path on purpose; no timer store fails.
  const warn = (
    fixture.sessions as unknown as { wakeWarning(text: string): void }
  ).wakeWarning.bind(fixture.sessions);

  warn('An earlier synthetic warning');
  clock.advance(1_000);
  const id = fixture.sessions.start(frame, signal());
  await fixture.sessions.idle();

  const warnedAt = clock.advance(1_000);
  warn('A later synthetic warning');
  const row = () => {
    return fixture.view(id).messages.find((message) => message.id === 'wake-service-warning');
  };
  assert.equal(row()?.createdAt, warnedAt);
  assert.ok(row()!.createdAt! > fixture.view(id).messages[0].createdAt!);

  // A further warning updates the row's text but keeps its creation time.
  clock.advance(1_000);
  warn('A still later synthetic warning');
  assert.equal(row()?.text, 'A still later synthetic warning');
  assert.equal(row()?.createdAt, warnedAt);
});

test('a recovered timer notice keeps the same time on every reopen and restart', async (context) => {
  const clock = fakeClock();
  const fixture = await harnessFixture(context, {
    configuration: { ...defaultAgentSettings, model: 'configured/one' },
    wakeClock: clock.now,
  });
  const id = fixture.sessions.start(frame, signal(), 'coding', 'pi');
  const scheduledAt = clock.advance(100);
  fixture.script(id, async (run) => {
    await callTool(run, 'companion_wake_schedule', {
      afterSeconds: 60,
      label: 'Synthetic check',
      message: 'Look again',
    });
  });
  await fixture.sessions.idle();
  const timerId = fixture.sessions.wakes.list(id)[0].id;
  assert.equal(fixture.sessions.wakes.list(id)[0].createdAt, scheduledAt);
  await fixture.sessions.remove(id);

  // An archive without the notice, as when a timer changed while the tab
  // was closed.
  const saved = await savedJson(fixture.directory, id);
  saved.messages = saved.messages.filter(
    (message: AgentMessage) => message.id !== `wake:${timerId}`,
  );
  await writeConversation(fixture.directory, saved as Record<string, unknown> & { id: string });

  // Reopening does not save; a restarted listener reopens the same archive.
  // The first listener stops first: only one may own the timer store.
  await fixture.sessions.close();
  for (const advance of [60_000, 120_000]) {
    clock.advance(advance);
    const instance = fixture.open();
    await instance.loadPrevious();
    await instance.reopen(id);
    const notice = fixture
      .view(id, instance)
      .messages.find((message) => message.id === `wake:${timerId}`);
    assert.ok(notice, 'the missing timer notice is recovered');
    assert.equal(notice.createdAt, scheduledAt);
    await instance.close();
  }
});
