import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { desktopFixture, waitFor, windowReply } from '../desktop-fixture.ts';
import { frame, processor, screenshot, testDetector } from '../helpers.ts';

test('Activity exposes completed entries only, retains more than 100, and pages reconnects', async (context) => {
  const setup = await desktopFixture(async () => Buffer.alloc(0));
  context.after(setup.close);
  const activity = setup.runtime.activity;
  await waitFor(() => setup.messages.some((message) => message.activitySessionId !== undefined));
  const sessionId = setup.messages.find((message) => message.activitySessionId)?.activitySessionId;

  const first = setup.seed(1);
  activity.intentRecognized?.(1, 'IGNORE');
  activity.outcome?.(1, 'ignored');
  setup.send({ action: 'activity-history', sessionId, after: 0, through: 0 });
  const before = (await setup.reply('activity-history')).result;
  assert.ok(before && typeof before === 'object');
  assert.deepEqual(before.entries, [], 'Outcome alone is not pipeline completion');
  activity.finished?.(1);
  for (let index = 2; index <= 123; index++) {
    setup.seed(index);
    activity.intentRecognized?.(index, 'IGNORE');
    activity.outcome?.(index, 'ignored');
    activity.finished?.(index);
    // Let the socket drain between synthetic bursts; real speech cannot emit
    // hundreds of full state snapshots in one synchronous JavaScript turn.
    if (index % 10 === 0) {
      await waitFor(
        () =>
          setup.messages.filter((message) => message.type === 'activity-entry').length === index,
      );
    }
  }
  await waitFor(
    () => setup.messages.filter((message) => message.type === 'activity-entry').length === 123,
  );
  const received: string[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    setup.send({ action: 'activity-history', sessionId, after: cursor, through: 123 });
    const page = (await setup.reply('activity-history')).result;
    assert.ok(page && typeof page === 'object');
    assert.ok(page.entries.length <= 50);
    received.push(...page.entries.map((entry) => entry.id));
    cursor = page.next;
  }
  assert.equal(received.length, 123);
  assert.equal(received[0], first);
  assert.equal(new Set(received).size, 123);
  const latest = setup.messages.filter((message) => message.type === 'state').at(-1)!;
  assert.equal(latest.history?.length, 100, 'Shortcut picker remains bounded separately');
  setup.send({ action: 'activity-history', sessionId: 'old-session', after: 0, through: 1 });
  assert.equal((await setup.reply('activity-history')).type, 'error');
});

test('history feedback targets its explicit row and publishes corrected labels without rewriting prediction', async (context) => {
  const setup = await desktopFixture(async () => Buffer.alloc(0));
  context.after(setup.close);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  processor('INSERT').subscribe(router);
  await setup.runtime.connectRouter(router);
  const first = setup.seed(1);
  setup.runtime.activity.intentRecognized?.(1, 'IGNORE');
  setup.runtime.activity.outcome?.(1, 'ignored');
  setup.runtime.activity.finished?.(1);
  const second = setup.seed(2);
  setup.runtime.activity.intentRecognized?.(2, 'INSERT');
  setup.runtime.activity.outcome?.(2, 'sent');
  setup.runtime.activity.finished?.(2);

  for (const value of [
    { correct: false },
    { correct: false, actualIntent: 'INSERT' },
    { correct: true },
  ]) {
    setup.send({ action: 'label-history', id: first, ...value });
    assert.equal((await setup.reply('label-history')).result, 'labeled');
    const row = setup.database.prepare('SELECT * FROM intent_feedback WHERE id = ?').get(first)!;
    assert.equal(row.correct, Number(value.correct));
    assert.equal(row.actual_intent, value.correct ? 'IGNORE' : (value.actualIntent ?? null));
    assert.equal(row.recognized_intent, 'IGNORE');
  }
  assert.equal(
    setup.database.prepare('SELECT COUNT(*) AS count FROM intent_feedback WHERE id = ?').get(second)
      ?.count,
    0,
  );
  assert.deepEqual(
    setup.database
      .prepare('SELECT recognized_intent, outcome FROM utterances WHERE id = ?')
      .get(first),
    Object.assign(Object.create(null), { recognized_intent: 'IGNORE', outcome: 'ignored' }),
  );
  const last = setup.messages
    .filter((message) => message.type === 'activity-entry' && message.entry?.id === first)
    .at(-1)!.entry!;
  assert.equal(last.correct, true);
  assert.equal(last.sequence, 1, 'Feedback never reorders completed cards');
  for (const request of [
    { id: first, correct: false, actualIntent: 'UNKNOWN' },
    { id: first, correct: false, actualIntent: 'IGNORE' },
    { id: 'absent', correct: true },
  ]) {
    setup.send({ action: 'label-history', ...request });
    assert.equal((await setup.reply('label-history')).type, 'error');
  }
  const pending = setup.seed(3);
  setup.send({ action: 'label-history', id: pending, correct: true });
  assert.equal((await setup.reply('label-history')).type, 'error');
});

test('new coding session uses the selected utterance and its recorded screenshot', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-history-agent-'));
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const agents = new AgentSessions(
    {
      pi: {
        id: 'test',
        label: 'test',
        dependencies: {},
        async run(request) {
          requests.push(request);
        },
      },
    },
    () => {},
    directory,
  );
  const setup = await desktopFixture(
    async () => assert.fail('No desktop capture or typing'),
    agents,
  );
  context.after(async () => {
    await setup.close();
    await rm(directory, { recursive: true, force: true });
  });
  const id = setup.seed();
  await setup.runtime.activity.screenshotCaptured?.(frame.id, screenshot);
  setup.runtime.activity.intentRecognized?.(frame.id, 'IGNORE');
  setup.runtime.activity.outcome?.(frame.id, 'ignored');
  setup.runtime.activity.finished?.(frame.id);
  setup.send({ action: 'start-history-agent', id });
  assert.equal((await setup.reply('start-history-agent')).result, 'started');
  await agents.idle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt.text, frame.utterance);
  assert.deepEqual(requests[0].prompt.screenshot?.png, screenshot.png);
  const absentScreenshot = setup.seed(2);
  setup.runtime.activity.outcome?.(2, 'error');
  setup.runtime.activity.finished?.(2);
  setup.send({ action: 'start-history-agent', id: absentScreenshot });
  assert.match((await setup.reply('start-history-agent')).message!, /screenshot is unavailable/);
  assert.equal(requests.length, 1);
});

test('Activity focus blocks insertion even when Hyprland still names the ordinary window', async (context) => {
  const typed: string[][] = [];
  const setup = await desktopFixture(async (binary, args) => {
    if (binary === 'wtype') typed.push(args);
    return binary === 'hyprctl' ? windowReply() : Buffer.alloc(0);
  });
  context.after(setup.close);
  const id = setup.seed();
  setup.runtime.activity.outcome?.(frame.id, 'ignored');
  setup.runtime.activity.finished?.(frame.id);
  setup.send({ action: 'panel-state', id: '', composerFocused: false, keyboardFocused: true });
  await setup.reply('panel-state');
  setup.send({ action: 'paste', id, target: screenshot.window.address, composer: '' });
  assert.equal((await setup.reply('paste')).result, 'skipped');
  assert.deepEqual(typed, []);
  setup.send({ action: 'panel-state', id: '', composerFocused: false, keyboardFocused: false });
  await setup.reply('panel-state');
  setup.send({ action: 'paste', id, target: screenshot.window.address, composer: '' });
  assert.equal((await setup.reply('paste')).result, 'sent');
  assert.equal(typed.length, 1);
  assert.deepEqual(typed[0], ['-d', '1', '--', frame.utterance]);
});
