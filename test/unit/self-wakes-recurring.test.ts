import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WakeStore } from '../../src/agents/wakes/store.ts';
import { WakeScheduler, type WakeCaller, type WakeHost } from '../../src/agents/wakes/scheduler.ts';
import { scheduleDeadline, type WakeRecord } from '../../src/agents/wakes/types.ts';
import { nextOccurrence } from '../../src/agents/wakes/recurrence.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { type AgentBackend, type AgentRunRequest } from '../../src/agents/types.ts';
import { signal } from '../helpers.ts';

// Synthetic coverage for fixed-interval (repeating) self-wake timers. Every
// test uses a fake clock, a temporary directory and a fake backend: no model,
// no live listener and no real timer is involved.

const minute = 60_000;
const interval = 2700;
const intervalMilliseconds = interval * 1000;

const repeating = {
  afterSeconds: 60,
  everySeconds: interval,
  label: 'Inbox check',
  message: 'Check whether new mail needs attention',
};

const oneShot = {
  afterSeconds: 60,
  label: 'Review check',
  message: 'Reassess whether review returned',
};

/** A scheduler on a temporary store, a fake host that admits everything and a settable clock. */
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-recurring-'));
  let now = Date.parse('2026-10-08T12:00:00Z');
  const warnings: string[] = [];
  const dispatched: WakeRecord[] = [];
  const changed: WakeRecord[] = [];
  const host: WakeHost = {
    async prepare() {
      return 'ready';
    },
    admit(_record, claim) {
      const claimed = claim();
      if (claimed) {
        dispatched.push(claimed);
      }
      return !!claimed;
    },
    changed(record) {
      changed.push(record);
    },
    warning(text) {
      warnings.push(text);
    },
  };
  let scheduler = new WakeScheduler(
    new WakeStore(directory, (text) => warnings.push(text)),
    host,
    () => now,
  );
  const caller: WakeCaller = {
    owner: randomUUID(),
    turnId: randomUUID(),
    callId: randomUUID(),
    depth: 1,
    harness: 'pi',
    signal: signal(),
  };
  t.after(async () => {
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    host,
    caller,
    warnings,
    dispatched,
    changed,
    get scheduler() {
      return scheduler;
    },
    get store() {
      return scheduler.store;
    },
    /** Simulate a listener restart on the same directory. */
    async restart() {
      await scheduler.close();
      scheduler = new WakeScheduler(
        new WakeStore(directory, (text) => warnings.push(text)),
        host,
        () => now,
      );
      scheduler.open();
    },
    advance(delta: number) {
      now += delta;
    },
    now: () => now,
    /** A fresh tool call in a fresh turn of the same conversation. */
    call(): WakeCaller {
      return { ...caller, turnId: randomUUID(), callId: randomUUID() };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Dispatch the due occurrence and finish it with `state`. Returns the finished claim. */
async function runDue(f: Fixture, state: 'completed' | 'failed' = 'completed') {
  const before = f.dispatched.length;
  await f.scheduler.tick();
  assert.equal(f.dispatched.length, before + 1, 'exactly one occurrence dispatched');
  const claim = f.dispatched[before];
  f.scheduler.transitionAttempt(claim, 'started');
  f.scheduler.transitionAttempt(claim, state);
  return claim;
}

/** The series' live (unstarted or running) occurrences. */
function live(f: Fixture, seriesId: string) {
  return f.store
    .all()
    .filter(
      (record) =>
        record.recurrence?.seriesId === seriesId &&
        ['scheduled', 'waiting', 'dispatching', 'started'].includes(record.state),
    );
}

function series(f: Fixture, seriesId: string) {
  return f.store.series(f.caller.owner, seriesId);
}

test('receipt and successor follow anchor + k·interval with one live occurrence', async (t) => {
  const f = await fixture(t);
  const receipt = f.scheduler.schedule(f.caller, repeating);
  const anchor = f.now() + minute;
  assert.equal(receipt.outcome, 'scheduled');
  assert.equal(receipt.everySeconds, interval);
  assert.equal(receipt.occurrence, 1);
  assert.equal(receipt.dueAt, anchor);
  // Default grace is the shorter of one hour and half the interval.
  assert.equal(receipt.expiresAt, anchor + (interval / 2) * 1000);
  const seriesId = String(receipt.seriesId);
  assert.notEqual(seriesId, receipt.timerId);

  // Repeating the same tool call returns the same receipt and no second series.
  assert.deepEqual(f.scheduler.schedule(f.caller, repeating), receipt);
  assert.equal(f.store.all().length, 1);

  for (let occurrence = 1; occurrence <= 4; occurrence++) {
    const current = live(f, seriesId);
    assert.equal(current.length, 1);
    assert.equal(current[0].recurrence!.occurrence, occurrence);
    assert.equal(current[0].dueAt, anchor + (occurrence - 1) * intervalMilliseconds);
    // Run each occurrence a little late; the next slot keeps to the anchor.
    f.advance(current[0].dueAt - f.now() + 5 * minute);
    await runDue(f);
  }

  const history = series(f, seriesId);
  assert.equal(history.length, 5);
  assert.deepEqual(
    history.map((record) => record.state),
    ['completed', 'completed', 'completed', 'completed', 'scheduled'],
  );
  const next = history[4];
  assert.equal(next.version, 2);
  assert.equal(next.recurrence!.slot, 4);
  assert.equal(next.dueAt, anchor + 4 * intervalMilliseconds);
  assert.equal(next.label, repeating.label);
  assert.equal(next.message, repeating.message);
  assert.equal(next.depth, 1);
  assert.equal(next.attemptId, undefined);
  // Each successor is published, so the transcript gets its notice.
  assert.ok(f.changed.some((record) => record.id === next.id && record.state === 'scheduled'));
  // The active occurrence's dueAt is the next due time in the list.
  const listed = f.scheduler.list(f.caller.owner);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].recurrence?.seriesId, seriesId);
  assert.equal(listed[0].dueAt, next.dueAt);
});

test('a long outage and restart skip missed slots without a catch-up burst', async (t) => {
  const f = await fixture(t);
  const receipt = f.scheduler.schedule(f.caller, repeating);
  const seriesId = String(receipt.seriesId);
  const anchor = Number(receipt.dueAt);

  // The listener is down for ten hours: more than thirteen slots pass.
  await f.restart();
  f.advance(10 * 3600_000);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(f.dispatched.length, 0);

  const history = series(f, seriesId);
  assert.equal(history.length, 2, 'one skipped occurrence, one successor; no row per missed slot');
  assert.equal(history[0].state, 'expired');
  assert.match(history[0].reason, /grace elapsed/);
  const next = history[1];
  assert.ok(next.dueAt >= f.now() + minute);
  assert.ok(next.dueAt - f.now() <= intervalMilliseconds + minute);
  assert.equal((next.dueAt - anchor) % intervalMilliseconds, 0);
  assert.equal(next.recurrence!.occurrence, 2);

  // The series survives another restart and runs once at its slot.
  await f.restart();
  f.advance(next.dueAt - f.now());
  await runDue(f);
  assert.equal(live(f, seriesId).length, 1);
});

test('restart across a claimed run records uncertainty and still continues once', async (t) => {
  for (const state of ['dispatching', 'started'] as const) {
    const f = await fixture(t);
    const seriesId = String(f.scheduler.schedule(f.caller, repeating).seriesId);
    f.advance(minute);
    await f.scheduler.tick();
    if (state === 'started') {
      f.scheduler.transitionAttempt(f.dispatched[0], 'started');
    }

    await f.restart();
    let history = series(f, seriesId);
    assert.deepEqual(
      history.map((record) => record.state),
      ['delivery-uncertain', 'scheduled'],
    );

    // Neither another restart nor a repeated tick replays or duplicates it.
    await f.restart();
    await f.scheduler.tick();
    history = series(f, seriesId);
    assert.equal(history.length, 2);
    assert.equal(f.dispatched.length, 1);
  }
});

test('failed, blocked and skipped occurrences are never retried; the series continues', async (t) => {
  const f = await fixture(t);
  const seriesId = String(f.scheduler.schedule(f.caller, repeating).seriesId);

  f.advance(minute);
  await runDue(f, 'failed');

  f.host.prepare = async () => 'Owner harness changed';
  f.advance(intervalMilliseconds);
  await f.scheduler.tick();

  f.host.prepare = async () => 'not-open';
  f.advance(intervalMilliseconds);
  await f.scheduler.tick();

  const history = series(f, seriesId);
  assert.deepEqual(
    history.map((record) => record.state),
    ['failed', 'blocked', 'expired', 'scheduled'],
  );
  assert.match(history[2].reason, /not an open tab; skipped without reopening/);
  assert.equal(f.dispatched.length, 1, 'only the first occurrence was ever admitted');
  assert.deepEqual(
    history.map((record) => record.recurrence!.slot),
    [0, 1, 2, 3],
  );
});

test('repeated terminal transitions and stale snapshots never create a second successor', async (t) => {
  const f = await fixture(t);
  const seriesId = String(f.scheduler.schedule(f.caller, repeating).seriesId);
  f.advance(minute);
  const claim = await runDue(f);

  // Late or duplicate outcome reports for the same attempt.
  f.scheduler.transitionAttempt(claim, 'completed');
  f.scheduler.transitionAttempt(claim, 'failed');
  f.scheduler.transition(claim, 'completed');
  assert.equal(live(f, seriesId).length, 1);
  assert.equal(series(f, seriesId).length, 2);

  // A stale unstarted snapshot cannot expire or block the live successor twice.
  const successor = live(f, seriesId)[0];
  f.advance(successor.expiresAt - f.now() + 1);
  f.scheduler.transition(successor, 'expired', 'first');
  f.scheduler.transition(successor, 'expired', 'second');
  f.scheduler.transition(successor, 'blocked', 'third');
  assert.equal(live(f, seriesId).length, 1);
  assert.equal(series(f, seriesId).length, 3);

  // Defensive store check: finishing an occurrence while another live one
  // exists records the outcome without adding a third.
  const current = live(f, seriesId)[0];
  const forgedTwin: WakeRecord = { ...current, id: randomUUID(), state: 'started', revision: 2 };
  f.store.transaction(() => {
    const created = f.store.finish(
      { ...forgedTwin, state: 'completed', revision: 3 },
      f.now(),
      false,
    );
    assert.equal(created, undefined);
  });
  assert.equal(live(f, seriesId).length, 1);
});

test('a failed successor write rolls back the outcome; restart then creates exactly one successor', async (t) => {
  const f = await fixture(t);
  const seriesId = String(f.scheduler.schedule(f.caller, repeating).seriesId);
  f.advance(minute);
  await f.scheduler.tick();
  const claim = f.dispatched[0];
  f.scheduler.transitionAttempt(claim, 'started');

  // The disk refuses the successor row inside the terminal transaction.
  const put = f.store.put.bind(f.store);
  f.store.put = (record) => {
    if (record.recurrence?.occurrence === 2) {
      throw Error('Synthetic disk failure');
    }
    put(record);
  };
  assert.throws(() => f.scheduler.transitionAttempt(claim, 'completed'), /disk failure/);
  f.store.put = put;
  assert.equal(f.store.get(claim.id)!.state, 'started', 'the completion rolled back with it');
  assert.equal(series(f, seriesId).length, 1);

  await f.restart();
  assert.deepEqual(
    series(f, seriesId).map((record) => record.state),
    ['delivery-uncertain', 'scheduled'],
  );
});

test('cancellation intent recorded during a run survives restart; no successor', async (t) => {
  const f = await fixture(t);
  const seriesId = String(f.scheduler.schedule(f.caller, repeating).seriesId);
  f.advance(minute);
  await f.scheduler.tick();
  f.scheduler.transitionAttempt(f.dispatched[0], 'started');
  assert.equal(f.scheduler.cancel(f.caller.owner, seriesId).outcome, 'dispatch-started');

  await f.restart();
  const history = series(f, seriesId);
  assert.equal(history.length, 1);
  assert.equal(history[0].state, 'delivery-uncertain');
  assert.match(history[0].reason, /series ended \(cancelled during this run\)/);
});

test('cancel by series ID, current occurrence, earlier occurrence and after dispatch', async (t) => {
  const f = await fixture(t);

  // Series ID while unstarted.
  const first = f.scheduler.schedule(f.call(), { ...repeating, key: 'a' });
  const firstSeries = String(first.seriesId);
  assert.deepEqual(f.scheduler.cancel(f.caller.owner, firstSeries), {
    outcome: 'cancelled',
    timerId: first.timerId,
    seriesId: firstSeries,
    seriesEnded: true,
  });
  assert.equal(f.scheduler.cancel(f.caller.owner, firstSeries).outcome, 'already-cancelled');
  assert.match(f.store.get(String(first.timerId))!.reason, /series ended/);

  // Earlier occurrence ID leaves the series running; current ID ends it.
  const second = f.scheduler.schedule(f.call(), { ...repeating, key: 'b' });
  const secondSeries = String(second.seriesId);
  f.advance(minute);
  await runDue(f);
  const old = f.scheduler.cancel(f.caller.owner, String(second.timerId));
  assert.equal(old.outcome, 'already-finished');
  assert.equal(old.seriesEnded, false);
  assert.equal(live(f, secondSeries).length, 1);
  const current = live(f, secondSeries)[0];
  const ended = f.scheduler.cancel(f.caller.owner, current.id);
  assert.equal(ended.outcome, 'cancelled');
  assert.equal(ended.seriesEnded, true);
  assert.equal(live(f, secondSeries).length, 0);

  // Series ID after dispatch began: the run finishes, nothing follows it.
  const third = f.scheduler.schedule(f.call(), { ...repeating, key: 'c' });
  const thirdSeries = String(third.seriesId);
  f.advance(minute);
  await f.scheduler.tick();
  const running = f.dispatched.at(-1)!;
  f.scheduler.transitionAttempt(running, 'started');
  const late = f.scheduler.cancel(f.caller.owner, thirdSeries);
  assert.equal(late.outcome, 'dispatch-started');
  assert.equal(late.seriesEnded, true);
  f.scheduler.transitionAttempt(running, 'completed');
  assert.equal(live(f, thirdSeries).length, 0);
  assert.match(f.store.get(running.id)!.reason, /series ended \(cancelled during this run\)/);
  assert.equal(f.scheduler.cancel(f.caller.owner, thirdSeries).outcome, 'already-finished');

  // Foreign owners and unknown IDs learn nothing.
  assert.deepEqual(f.scheduler.cancel(randomUUID(), thirdSeries), {
    outcome: 'unknown-or-not-owned',
  });
  assert.deepEqual(f.scheduler.cancel(f.caller.owner, randomUUID()), {
    outcome: 'unknown-or-not-owned',
  });

  // One-shot replies keep their original shape.
  const single = f.scheduler.schedule(f.call(), oneShot);
  assert.deepEqual(f.scheduler.cancel(f.caller.owner, String(single.timerId)), {
    outcome: 'cancelled',
    timerId: single.timerId,
  });
});

test('Stop/close end a series even mid-run; a failed ordinary turn does not block it ahead of time', async (t) => {
  const f = await fixture(t);

  // Ordinary failure: one-shots are blocked, the series keeps its next slot.
  const keep = f.scheduler.schedule(f.call(), { ...repeating, key: 'keep' });
  const single = f.scheduler.schedule(f.call(), oneShot);
  f.scheduler.blockOwner(f.caller.owner, 'Preceding turn failed or stopped');
  assert.equal(f.store.get(String(single.timerId))!.state, 'blocked');
  assert.equal(f.store.get(String(keep.timerId))!.state, 'scheduled');

  // Stop while one series runs and another waits: both end, none continues.
  const waiting = f.scheduler.schedule(f.call(), { ...repeating, key: 'waiting' });
  f.advance(minute);
  f.host.prepare = async (record) => (record.id === keep.timerId ? 'ready' : 'waiting');
  await f.scheduler.tick();
  const running = f.dispatched.at(-1)!;
  assert.equal(running.id, keep.timerId);
  f.scheduler.transitionAttempt(running, 'started');
  assert.equal(f.scheduler.cancelOwner(f.caller.owner, 'Human Stop or explicit close'), 1);
  assert.equal(f.store.get(String(waiting.timerId))!.state, 'cancelled');
  f.scheduler.transitionAttempt(running, 'failed', 'Wake turn stopped');
  assert.equal(live(f, String(keep.seriesId)).length, 0);
  assert.equal(live(f, String(waiting.seriesId)).length, 0);
  assert.equal(f.scheduler.list(f.caller.owner).length, 0);

  // An owner that can never be opened again ends its series too.
  const unavailable = f.scheduler.schedule(f.call(), repeating);
  f.scheduler.blockUnavailableOwner(f.caller.owner, 'Saved owner is malformed or unavailable');
  assert.equal(f.store.get(String(unavailable.timerId))!.state, 'blocked');
  assert.equal(live(f, String(unavailable.seriesId)).length, 0);

  // Owner deletion removes the series with its instruction text.
  f.scheduler.schedule(f.call(), repeating);
  f.scheduler.deleteOwner(f.caller.owner);
  assert.equal(f.store.all().length, 0);
});

test('cancelling a series during preparation wins; nothing runs and nothing follows', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.host.prepare = async () => {
    await gate;
    return 'ready';
  };
  const receipt = f.scheduler.schedule(f.caller, repeating);
  f.advance(minute);
  const ticking = f.scheduler.tick();
  assert.equal(f.scheduler.cancel(f.caller.owner, String(receipt.seriesId)).outcome, 'cancelled');
  release();
  await ticking;
  assert.equal(f.dispatched.length, 0);
  assert.equal(live(f, String(receipt.seriesId)).length, 0);
  assert.equal(series(f, String(receipt.seriesId)).length, 1);
});

test('a running series holds its pending slot; a same-key timer ends the series', async (t) => {
  const f = await fixture(t);
  const receipt = f.scheduler.schedule(f.call(), { ...repeating, key: 'inbox' });
  f.advance(minute);
  await f.scheduler.tick();
  const running = f.dispatched[0];
  f.scheduler.transitionAttempt(running, 'started');

  // While it runs, two more pending timers fit; a third would leave no room
  // for the successor and is refused.
  f.scheduler.schedule(f.call(), { ...oneShot, key: 'one' });
  f.scheduler.schedule(f.call(), { ...oneShot, key: 'two' });
  assert.throws(() => f.scheduler.schedule(f.call(), { ...oneShot, key: 'three' }), /limit/);
  f.scheduler.transitionAttempt(running, 'completed');
  assert.equal(live(f, String(receipt.seriesId)).length, 1);
  assert.equal(f.scheduler.list(f.caller.owner).length, 3);

  // A same-key schedule supersedes the series' unstarted occurrence.
  f.scheduler.schedule(f.call(), { ...oneShot, key: 'inbox' });
  assert.equal(live(f, String(receipt.seriesId)).length, 0);
  const superseded = series(f, String(receipt.seriesId)).at(-1)!;
  assert.equal(superseded.state, 'superseded');
  assert.match(superseded.reason, /series ended/);
});

test('a same-key timer during a run ends the series after that run', async (t) => {
  const f = await fixture(t);
  const receipt = f.scheduler.schedule(f.call(), { ...repeating, key: 'inbox' });
  f.advance(minute);
  await f.scheduler.tick();
  const running = f.dispatched[0];
  f.scheduler.transitionAttempt(running, 'started');
  const replacement = f.scheduler.schedule(f.call(), { ...repeating, key: 'inbox' });
  f.scheduler.transitionAttempt(running, 'completed');
  assert.equal(live(f, String(receipt.seriesId)).length, 0);
  assert.equal(live(f, String(replacement.seriesId)).length, 1);
});

test('interval, grace and long-interval bounds', async (t) => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.throws(() => scheduleDeadline({ ...repeating, everySeconds: 2699 }, now), /2700/);
  assert.throws(() => scheduleDeadline({ ...repeating, everySeconds: 2592001 }, now), /2700/);
  assert.throws(() => scheduleDeadline({ ...repeating, everySeconds: 2700.5 }, now), /whole/);
  assert.throws(
    () => scheduleDeadline({ ...repeating, everySeconds: '3600' as unknown as number }, now),
    /whole/,
  );
  assert.throws(
    () => scheduleDeadline({ ...repeating, expiresAfterSeconds: interval }, now),
    /shorter than its interval/,
  );
  const allowed = scheduleDeadline({ ...repeating, expiresAfterSeconds: interval - 1 }, now);
  assert.equal(allowed.expiresAt - allowed.dueAt, (interval - 1) * 1000);
  const hourly = scheduleDeadline({ ...repeating, everySeconds: 7200 }, now);
  assert.equal(hourly.expiresAt - hourly.dueAt, 3600_000);
  // Without everySeconds nothing changes.
  const single = scheduleDeadline(oneShot, now);
  assert.equal(single.expiresAt - single.dueAt, 3600_000);

  // A 30-day series whose next slot falls inside the margin needs a successor
  // slightly over 30 days away; it must persist rather than be quarantined.
  const f = await fixture(t);
  const month = 30 * 86400;
  const receipt = f.scheduler.schedule(f.caller, { ...repeating, everySeconds: month });
  const seriesId = String(receipt.seriesId);
  f.advance(month * 1000 + 30_000);
  f.host.prepare = async () => 'not-open';
  // The first occurrence is long expired: skip to slot 2, just over 30 days ahead.
  await f.scheduler.tick();
  const next = live(f, seriesId)[0];
  assert.equal(next.recurrence!.slot, 2);
  assert.ok(next.dueAt - f.now() > month * 1000);
  await f.restart();
  assert.equal(f.warnings.length, 0);
  assert.equal(live(f, seriesId).length, 1);

  // A clock far behind the series can produce no valid slot; the series ends.
  const behind = nextOccurrence({ ...next, state: 'completed' }, next.dueAt - 40 * 86400_000);
  assert.equal(behind, undefined);
});

test('rows in the existing one-shot format load and run unchanged; malformed series rows are quarantined', async (t) => {
  const f = await fixture(t);
  // Create the empty database, then add rows to it while no listener owns it.
  f.scheduler.open();
  await f.scheduler.close();
  const owner = f.caller.owner;
  const now = f.now();
  // Exactly what the one-shot scheduler saved before recurrence existed.
  const legacy = {
    version: 1,
    id: randomUUID(),
    owner,
    receipt: `${owner}:${randomUUID()}:call`,
    label: 'Legacy check',
    message: 'Saved before recurring timers',
    harness: 'pi',
    schedulingTurn: randomUUID(),
    depth: 0,
    createdAt: now,
    dueAt: now + minute,
    expiresAt: now + minute + 3600_000,
    state: 'scheduled',
    revision: 1,
    transitionedAt: now,
    reason: '',
  };
  const validSeries = {
    seriesId: randomUUID(),
    everySeconds: interval,
    anchorAt: now + minute,
    slot: 0,
    occurrence: 1,
  };
  const malformed = [
    // A one-shot version carrying recurrence data.
    { ...legacy, id: randomUUID(), recurrence: validSeries },
    // A series version without recurrence data.
    { ...legacy, id: randomUUID(), version: 2 },
    // Due time off the series' slots.
    { ...legacy, id: randomUUID(), version: 2, recurrence: { ...validSeries, slot: 1 } },
    // Interval below the 45-minute minimum.
    {
      ...legacy,
      id: randomUUID(),
      version: 2,
      expiresAt: legacy.dueAt + 60_000,
      recurrence: { ...validSeries, everySeconds: 600 },
    },
    // Grace not shorter than the interval.
    {
      ...legacy,
      id: randomUUID(),
      version: 2,
      expiresAt: legacy.dueAt + intervalMilliseconds,
      recurrence: validSeries,
    },
  ];
  const database = new DatabaseSync(join(f.directory, 'timers.sqlite'));
  for (const row of [legacy, ...malformed]) {
    database.prepare('INSERT INTO timers VALUES (?, ?)').run(row.id, JSON.stringify(row));
  }
  database.close();

  await f.restart();
  assert.match(f.warnings.join('\n'), /5 malformed wake records quarantined/);
  assert.deepEqual(
    f.store.all().map((record) => record.id),
    [legacy.id],
  );
  f.advance(minute);
  const claim = await runDue(f);
  assert.equal(claim.id, legacy.id);
  assert.equal(claim.recurrence, undefined);
  assert.deepEqual(
    f.store.all().map((record) => record.state),
    ['completed'],
  );
});

// --- Real AgentSessions with a synthetic backend ---------------------------

async function integration(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-recurring-sessions-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let now = Date.now();
  const runs: AgentRunRequest[] = [];
  let script: (request: AgentRunRequest, turn: AbortSignal) => Promise<void> = async () => {};
  const backend: AgentBackend = {
    id: 'synthetic',
    label: 'Synthetic',
    dependencies: {},
    async run(request, turn) {
      runs.push(request);
      await script(request, turn);
    },
  };
  const create = () =>
    new AgentSessions(
      { pi: backend },
      () => {},
      directory,
      undefined,
      undefined,
      undefined,
      () => now,
    );
  let sessions = create();
  t.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    runs,
    get sessions() {
      return sessions;
    },
    /** Shut the listener down (timers preserved) and start a new one on the same data. */
    async restart() {
      await sessions.close();
      sessions = create();
      await sessions.loadPrevious();
    },
    advance(delta: number) {
      now += delta;
    },
    now: () => now,
    script(value: typeof script) {
      script = value;
    },
  };
}

async function invoke(request: AgentRunRequest, name: string, parameters: Record<string, unknown>) {
  const lease = request.sessionTools!;
  const tool = sessionTools(lease.endpoint, lease.token, lease.capabilities).find(
    (candidate) => candidate.name === name,
  )!;
  assert.ok(tool, name);
  return (await tool.execute(randomUUID(), parameters)).details as Record<string, unknown>;
}

const isWake = (run: AgentRunRequest) => run.prompt.text.startsWith('[Companion scheduled wake]');

/** Start a conversation whose first turn schedules a repeating timer. */
async function startSeries(f: Awaited<ReturnType<typeof integration>>) {
  let receipt: Record<string, unknown> = {};
  f.script(async (request) => {
    receipt = await invoke(request, 'companion_wake_schedule', repeating);
  });
  const owner = f.sessions.startRemote('Repeating task', 'coding', signal());
  await f.sessions.idle();
  f.script(async () => {});
  return { owner, receipt };
}

test('session: occurrences run in the open tab with series-aware prompt and notice', async (t) => {
  const f = await integration(t);
  const { owner, receipt } = await startSeries(f);
  assert.equal(receipt.everySeconds, interval);
  const seriesId = String(receipt.seriesId);

  for (let occurrence = 1; occurrence <= 2; occurrence++) {
    const due = f.sessions.wakes.list(owner)[0];
    f.advance(due.dueAt - f.now());
    await f.sessions.wakes.tick();
    await f.sessions.idle();
  }
  const wakes = f.runs.filter(isWake);
  assert.equal(wakes.length, 2);
  assert.match(wakes[0].prompt.text, /repeats every 45 min/);
  assert.match(wakes[0].prompt.text, new RegExp(`series ${seriesId}, occurrence 1`));
  assert.match(wakes[0].prompt.text, /do not re-arm it/);
  assert.match(wakes[0].prompt.text, /no new authority/);
  assert.doesNotMatch(wakes[0].prompt.text, /schedule another one-shot/);
  assert.match(wakes[1].prompt.text, /occurrence 2/);

  const view = f.sessions.snapshot().find((session) => session.id === owner)!;
  const notice = view.messages.find(
    (message) =>
      message.kind === 'notice' &&
      message.text.includes('· scheduled ·') &&
      message.text.includes('occurrence 3'),
  );
  assert.ok(notice, 'the next occurrence has its own transcript notice');
  assert.match(notice.text, new RegExp(`repeats every 45 min · occurrence 3 · series ${seriesId}`));
  assert.equal(f.sessions.wakes.list(owner)[0].recurrence?.occurrence, 3);
});

test('session: a closed owner is never restored; after restart the series skips until the tab is reopened', async (t) => {
  const f = await integration(t);
  const { owner, receipt } = await startSeries(f);
  const seriesId = String(receipt.seriesId);

  // Restart: no tabs are open afterwards.
  await f.restart();
  const due = f.sessions.wakes.list(owner)[0];
  f.advance(due.dueAt - f.now());
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.runs.filter(isWake).length, 0);
  assert.equal(
    f.sessions.snapshot().some((session) => session.id === owner),
    false,
    'the conversation stayed closed',
  );
  const history = f.sessions.wakes.list(owner, 5);
  const skipped = history.find((record) => record.id === due.id)!;
  assert.equal(skipped.state, 'expired');
  assert.match(skipped.reason, /not an open tab/);
  const next = history.find((record) => record.state === 'scheduled')!;
  assert.equal(next.recurrence?.seriesId, seriesId);

  // Once the user reopens the tab, the next slot runs there.
  await f.sessions.reopen(owner);
  f.advance(next.dueAt - f.now());
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.runs.filter(isWake).length, 1);
  assert.equal(f.runs.filter(isWake)[0].id, owner);
});

test('session: reopening after two skipped slots shows the next occurrence last', async (t) => {
  const f = await integration(t);
  const { owner } = await startSeries(f);

  // Restart, then leave the tab closed for two due slots.
  await f.restart();
  for (let skipped = 0; skipped < 2; skipped++) {
    const due = f.sessions.wakes.list(owner)[0];
    f.advance(due.dueAt - f.now());
    await f.sessions.wakes.tick();
  }
  assert.equal(f.runs.filter(isWake).length, 0);

  await f.sessions.reopen(owner);
  const view = f.sessions.snapshot().find((session) => session.id === owner)!;
  const notices = view.messages.filter((message) => message.id.startsWith('wake:'));
  assert.deepEqual(
    notices.map((notice) =>
      notice.text
        .match(/ · (\w+) · .* occurrence (\d)/)!
        .slice(1)
        .join(' '),
    ),
    ['expired 1', 'expired 2', 'scheduled 3'],
  );
});

test('session: Stop, tab close and agent self-close end the series', async (t) => {
  const f = await integration(t);

  // Human Stop during an occurrence's run.
  const stopped = await startSeries(f);
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.script(async (_request, turn) => {
    entered();
    // Hold the turn until Stop aborts it.
    await new Promise((resolve) => turn.addEventListener('abort', resolve));
  });
  f.advance(f.sessions.wakes.list(stopped.owner)[0].dueAt - f.now());
  await f.sessions.wakes.tick();
  await running;
  assert.equal(f.runs.filter(isWake).length, 1, 'the occurrence is running when Stop arrives');
  await f.sessions.stop(stopped.owner);
  await f.sessions.idle();
  assert.equal(f.sessions.wakes.list(stopped.owner).length, 0);
  assert.match(f.sessions.wakes.list(stopped.owner, 1)[0].reason, /series ended/);
  f.script(async () => {});

  // Explicit tab close while the next occurrence waits.
  const closed = await startSeries(f);
  assert.equal(await f.sessions.remove(closed.owner), 1);
  assert.equal(f.sessions.wakes.list(closed.owner).length, 0);

  // The agent closes its own tab from inside an occurrence's turn.
  const selfClosed = await startSeries(f);
  f.script(async (request) => {
    if (isWake(request)) {
      await invoke(request, 'companion_session_close', { id: selfClosed.owner });
    }
  });
  f.advance(f.sessions.wakes.list(selfClosed.owner)[0].dueAt - f.now());
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.sessions.wakes.list(selfClosed.owner).length, 0);
  assert.equal(
    f.sessions.snapshot().some((session) => session.id === selfClosed.owner),
    false,
  );
  const last = f.sessions.wakes.list(selfClosed.owner, 5)[0];
  assert.match(last.reason, /series ended/);
});

test('session: a failed occurrence continues the series and is not retried', async (t) => {
  const f = await integration(t);
  const { owner } = await startSeries(f);
  f.script(async (request) => {
    if (isWake(request)) {
      throw Error('Synthetic provider error');
    }
  });
  const due = f.sessions.wakes.list(owner)[0];
  f.advance(due.dueAt - f.now());
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.runs.filter(isWake).length, 1);
  const states = f.sessions.wakes.list(owner, 5).map((record) => record.state);
  assert.deepEqual(states.sort(), ['failed', 'scheduled']);
});
