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
import { AgentSessions } from '../../src/agents/sessions.ts';
import { bridgeTools } from '../../src/agents/claude/bridge-tools.ts';
import { ConversationUnavailableError } from '../../src/agents/resume-error.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { type AgentBackend, type AgentRunRequest } from '../../src/agents/types.ts';
import { deferred, signal } from '../helpers.ts';

const input = {
  afterSeconds: 60,
  label: 'Review check',
  message: 'Reassess whether review returned',
  key: 'review',
};

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-wakes-'));
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
  const store = new WakeStore(directory, (text) => warnings.push(text));
  const scheduler = new WakeScheduler(store, host, () => now);
  const caller: WakeCaller = {
    owner: randomUUID(),
    turnId: randomUUID(),
    callId: randomUUID(),
    depth: 2,
    harness: 'pi',
    signal: signal(),
  };
  t.after(async () => {
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    scheduler,
    store,
    caller,
    host,
    warnings,
    dispatched,
    changed,
    time(value: number) {
      now = value;
    },
    advance(delta = 60_000) {
      now += delta;
    },
    now: () => now,
  };
}

test('durable receipts, keyed replacement, ownership and cancellation across restart', async (t) => {
  const f = await fixture(t);
  const first = f.scheduler.schedule(f.caller, input);
  assert.deepEqual(f.scheduler.schedule(f.caller, input), first);
  assert.equal(f.store.all().length, 1);
  const second = f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, input);
  assert.notEqual(second.timerId, first.timerId);
  assert.equal(
    f.scheduler.cancel(f.caller.owner, String(first.timerId)).outcome,
    'already-finished',
  );
  assert.equal(
    f.scheduler.cancel(randomUUID(), String(second.timerId)).outcome,
    'unknown-or-not-owned',
  );
  assert.equal(f.scheduler.list(f.caller.owner).length, 1);
  assert.equal(f.scheduler.cancel(f.caller.owner, String(second.timerId)).outcome, 'cancelled');
  await f.scheduler.close();
  const restarted = new WakeScheduler(new WakeStore(f.directory, () => {}), f.host, f.now);
  t.after(() => restarted.close());
  assert.equal(restarted.list(f.caller.owner).length, 0);
  f.advance();
  await restarted.tick();
  assert.equal(f.dispatched.length, 0);
});

test('cancel wins during async preparation; dispatch wins only after durable claim', async (t) => {
  const f = await fixture(t);
  const gate = deferred<void>();
  f.host.prepare = async () => {
    await gate.promise;
    return 'ready';
  };
  const first = f.scheduler.schedule(f.caller, input);
  f.advance();
  const ticking = f.scheduler.tick();
  assert.equal(f.scheduler.cancel(f.caller.owner, String(first.timerId)).outcome, 'cancelled');
  gate.resolve();
  await ticking;
  assert.equal(f.dispatched.length, 0);
  const second = f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, input);
  f.advance();
  await f.scheduler.tick();
  assert.equal(f.dispatched.length, 1);
  assert.equal(
    f.scheduler.cancel(f.caller.owner, String(second.timerId)).outcome,
    'dispatch-started',
  );
  assert.equal(f.store.get(String(second.timerId))?.cancellationRequested, true);
});

test('waiting remains outside ordinary capacity; clock changes and grace visibly expire it', async (t) => {
  const f = await fixture(t);
  f.host.prepare = async () => 'waiting';
  f.scheduler.schedule(f.caller, input);
  f.advance(-3600_000);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list(f.caller.owner)[0].state, 'scheduled');
  f.advance(3660_000);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list(f.caller.owner)[0].state, 'waiting');
  f.advance(3600_001);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list(f.caller.owner, 1)[0].state, 'expired');
  assert.equal(f.dispatched.length, 0);
});

test('restart retains undispatched timers; every claimed/started boundary becomes uncertain', async (t) => {
  for (const state of ['scheduled', 'dispatching', 'started'] as const) {
    const f = await fixture(t);
    f.scheduler.schedule(f.caller, input);
    if (state !== 'scheduled') {
      f.advance();
      await f.scheduler.tick();
      if (state === 'started') {
        f.scheduler.transitionAttempt(f.dispatched[0], 'started');
      }
    }
    await f.scheduler.close();
    const scheduler = new WakeScheduler(new WakeStore(f.directory, () => {}), f.host, f.now);
    t.after(() => scheduler.close());
    const record = scheduler.list(f.caller.owner, 5)[0];
    assert.equal(record.state, state === 'scheduled' ? 'scheduled' : 'delivery-uncertain');
    f.advance();
    const before = f.dispatched.length;
    await scheduler.tick();
    assert.equal(f.dispatched.length - before, state === 'scheduled' ? 1 : 0);
  }
});

test('successive one-shots preserve history and depth without a lifetime count limit', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) {
    f.scheduler.schedule({ ...f.caller, turnId: randomUUID(), callId: randomUUID() }, input);
    f.advance();
    await f.scheduler.tick();
    const record = f.dispatched[index];
    assert.equal(record.depth, 2);
    f.scheduler.transitionAttempt(record, 'started');
    f.scheduler.transitionAttempt(record, 'completed');
  }
  assert.equal(f.dispatched.length, 12);
  assert.equal(f.scheduler.list(f.caller.owner, 50).length, 12);
  for (let i = 0; i < 3; i++) {
    f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, { ...input, key: String(i) });
  }
  assert.throws(
    () => f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, { ...input, key: 'fourth' }),
    /limit/,
  );
});

test('exclusive ownership, malformed-record quarantine, and failed cancel save', async (t) => {
  const f = await fixture(t);
  const receipt = f.scheduler.schedule(f.caller, input);
  const second = new WakeStore(f.directory, () => {});
  assert.throws(() => second.open(f.now()), /already owned/);
  const original = f.store.put.bind(f.store);
  f.store.put = () => {
    throw Error('synthetic disk failure');
  };
  assert.throws(() => f.scheduler.cancel(f.caller.owner, String(receipt.timerId)), /disk failure/);
  assert.equal(f.scheduler.list(f.caller.owner)[0].state, 'scheduled');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /Wake scheduling stopped/);
  f.store.put = original;
  await f.scheduler.close();
  const db = new DatabaseSync(join(f.directory, 'timers.sqlite'));
  db.prepare('INSERT INTO timers VALUES (?, ?)').run(randomUUID(), '{invalid');
  db.close();
  const restarted = new WakeStore(f.directory, (text) => f.warnings.push(text));
  restarted.open(f.now());
  assert.equal(restarted.all().length, 1);
  assert.equal(f.warnings.length, 2);
  restarted.close();
});

test('explicit offsets, delay and bounded grace validation', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const { afterSeconds: _, ...absolute } = input;
  assert.equal(
    scheduleDeadline({ ...absolute, at: '2026-10-08T14:01:00+02:00' }, now).dueAt,
    now + 60000,
  );
  assert.throws(() => scheduleDeadline({ ...absolute, at: '2026-10-08T12:01:00' }, now), /offset/);
  assert.throws(() => scheduleDeadline({ ...input, afterSeconds: 1 }, now), /Delay/);
  assert.throws(() => scheduleDeadline({ ...input, expiresAfterSeconds: 86401 }, now), /lateness/);
  assert.throws(
    () => scheduleDeadline({ ...input, at: '2026-10-08T12:01:00Z' }, now),
    /exactly one/,
  );
});

async function integration(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-wake-sessions-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let now = Date.now();
  const runs: AgentRunRequest[] = [];
  let script: (request: AgentRunRequest) => Promise<void> = async () => {};
  const backend: AgentBackend = {
    id: 'synthetic',
    label: 'Synthetic',
    dependencies: {},
    async run(request) {
      runs.push(request);
      await script(request);
    },
  };
  const sessions = new AgentSessions(
    { pi: backend },
    () => {},
    directory,
    undefined,
    undefined,
    undefined,
    () => now,
  );
  t.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sessions,
    backend,
    runs,
    directory,
    advance() {
      now += 60_000;
    },
    script(value: typeof script) {
      script = value;
    },
  };
}

async function invoke(
  request: AgentRunRequest,
  name: string,
  parameters: Record<string, unknown>,
  id = randomUUID(),
) {
  const lease = request.sessionTools!;
  const tool = sessionTools(lease.endpoint, lease.token, lease.capabilities).find(
    (tool) => tool.name === name,
  )!;
  assert.ok(tool);
  return (await tool.execute(id, parameters)).details;
}

test('real leased tools: forged owner refused, reply before due cancels, stale lease cannot rearm', async (t) => {
  const f = await integration(t);
  let timerId = '';
  let initial!: AgentRunRequest;
  f.script(async (request) => {
    initial = request;
    await assert.rejects(
      () => invoke(request, 'companion_wake_schedule', { ...input, owner: randomUUID() }),
      /Unknown wake/,
    );
    timerId = String((await invoke(request, 'companion_wake_schedule', input)).timerId);
  });
  const owner = f.sessions.startRemote('Synthetic task', 'coding', signal());
  await f.sessions.idle();
  await assert.rejects(() => invoke(initial, 'companion_wake_schedule', input), /expired/);
  f.script(async (request) => {
    assert.equal(
      (await invoke(request, 'companion_wake_cancel', { timerId })).outcome,
      'cancelled',
    );
  });
  f.sessions.followUp(owner, 'Review arrived', signal());
  await f.sessions.idle();
  f.advance();
  await f.sessions.wakes.tick();
  assert.equal(f.runs.length, 2);
});

test('due wake waits behind ordinary FIFO; review reply cancels without an extra turn', async (t) => {
  const f = await integration(t);
  let timerId = '';
  f.script(async (request) => {
    timerId = String((await invoke(request, 'companion_wake_schedule', input)).timerId);
  });
  const owner = f.sessions.startRemote('Task', 'coding', signal());
  await f.sessions.idle();
  const gate = deferred<void>();
  f.script(async (request) => {
    if (request.prompt.text === 'Busy') {
      await gate.promise;
    }
    if (request.prompt.text === 'Review') {
      await invoke(request, 'companion_wake_cancel', { timerId });
    }
  });
  f.sessions.followUp(owner, 'Busy', signal());
  f.sessions.followUp(owner, 'First ordinary', signal());
  f.sessions.followUp(owner, 'Review', signal());
  f.advance();
  await f.sessions.wakes.tick();
  assert.equal(f.sessions.wakes.list(owner)[0].state, 'waiting');
  gate.resolve();
  await f.sessions.idle();
  await f.sessions.wakes.tick();
  assert.deepEqual(
    f.runs.map((run) => run.prompt.text),
    ['Task', 'Busy', 'First ordinary', 'Review'],
  );
});

test('wake attributed, screenshot-free, same owner and terminal on provider error; Stop cancels successor', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  const owner = f.sessions.startRemote('Task', 'coding', signal());
  await f.sessions.idle();
  f.script(async (request) => {
    assert.equal(request.id, owner);
    assert.equal(request.resume, true);
    assert.equal(request.prompt.screenshot, undefined);
    assert.match(request.prompt.text, /scheduled wake.*not newly typed/s);
    await invoke(request, 'companion_wake_schedule', input);
    throw Error('Synthetic provider quota / policy error');
  });
  f.advance();
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.deepEqual(
    f.sessions.wakes
      .list(owner, 20)
      .map((record) => record.state)
      .sort(),
    ['blocked', 'failed'],
  );
  f.advance();
  await f.sessions.wakes.tick();
  assert.equal(f.runs.length, 2);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  f.sessions.followUp(owner, 'New human request', signal());
  await f.sessions.idle();
  await f.sessions.stop(owner);
  assert.equal(f.sessions.wakes.list(owner).length, 0);
});

test('four active agents and full ordinary queue defer wake without losing it', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  const owner = f.sessions.startRemote('Owner', 'coding', signal());
  await f.sessions.idle();
  const gate = deferred<void>();
  f.script(async () => {
    await gate.promise;
  });
  for (let i = 0; i < 4; i++) {
    f.sessions.startRemote('Busy ' + i, 'coding', signal());
  }
  f.advance();
  await f.sessions.wakes.tick();
  assert.equal(f.sessions.wakes.list(owner)[0].state, 'waiting');
  gate.resolve();
  await f.sessions.idle();
  const second = deferred<void>();
  f.script(async () => {
    await second.promise;
  });
  f.sessions.followUp(owner, 'Busy owner', signal());
  for (let i = 0; i < 8; i++) {
    f.sessions.followUp(owner, 'Queued ' + i, signal());
  }
  await f.sessions.wakes.tick();
  assert.equal(f.sessions.wakes.list(owner)[0].state, 'waiting');
  second.resolve();
  await f.sessions.idle();
  f.script(async () => {});
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(
    f.runs.filter((run) => run.prompt.text.includes('[Companion scheduled wake]')).length,
    1,
  );
});

test('shutdown preserves; restarted timer waits at full tab capacity then restores quietly', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  const owner = f.sessions.startRemote('Saved owner', 'coding', signal());
  await f.sessions.idle();
  await f.sessions.close();
  const events: any[] = [];
  const runs: AgentRunRequest[] = [];
  const backend: AgentBackend = {
    id: 'restart',
    label: 'Restart',
    dependencies: {},
    async run(request) {
      runs.push(request);
    },
  };
  const restarted = new AgentSessions(
    { pi: backend },
    () => {},
    f.directory,
    undefined,
    undefined,
    undefined,
    () => Date.now() + 61_000,
  );
  t.after(() => restarted.close());
  await restarted.loadPrevious();
  restarted.subscribe((event) => events.push(event));
  const tabs: string[] = [];
  for (let i = 0; i < 16; i++) {
    tabs.push(restarted.startRemote('Tab ' + i, 'coding', signal()));
    await restarted.idle();
  }
  await restarted.wakes.tick();
  assert.equal(restarted.wakes.list(owner)[0].state, 'waiting');
  assert.equal(runs.length, 16);
  await restarted.remove(tabs[0]);
  await restarted.wakes.tick();
  await restarted.idle();
  assert.equal(runs.length, 17);
  assert.equal(runs[16].id, owner);
  assert.equal(events.find((event) => event.type === 'agent-restored').reveal, false);
  assert.equal(restarted.snapshot().find((view) => view.id === owner)?.openInBackground, true);
});

test('Stop revokes an active lease; close cancels pending timers', async (t) => {
  const f = await integration(t);
  const entered = deferred<void>();
  const gate = deferred<void>();
  let run!: AgentRunRequest;
  f.script(async (request) => {
    run = request;
    await invoke(request, 'companion_wake_schedule', input);
    entered.resolve();
    await gate.promise;
    await assert.rejects(() => invoke(request, 'companion_wake_schedule', input), /expired/);
  });
  const owner = f.sessions.startRemote('Stop test', 'coding', signal());
  await entered.promise;
  const stopping = f.sessions.stop(owner);
  gate.resolve();
  await stopping;
  assert.equal(f.sessions.wakes.list(owner).length, 0);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  f.sessions.followUp(owner, 'Continue explicitly', signal());
  await f.sessions.idle();
  await f.sessions.remove(owner);
  assert.equal(f.sessions.wakes.list(owner).length, 0);
  await assert.rejects(() => invoke(run, 'companion_wake_schedule', input), /expired/);
});

test('keyed successor while predecessor runs leaves predecessor and new occurrence distinct', async (t) => {
  const f = await fixture(t);
  f.scheduler.schedule(f.caller, input);
  f.advance();
  await f.scheduler.tick();
  const running = f.dispatched[0];
  f.scheduler.transitionAttempt(running, 'started');
  const next = f.scheduler.schedule({ ...f.caller, turnId: randomUUID() }, input);
  assert.equal(f.store.get(running.id)?.state, 'started');
  assert.equal(f.scheduler.cancel(f.caller.owner, running.id).outcome, 'dispatch-started');
  assert.equal(f.store.get(String(next.timerId))?.state, 'scheduled');
});

test('failed atomic replacement rolls back old timer; failed claim invokes no backend', async (t) => {
  const f = await fixture(t);
  const first = f.scheduler.schedule(f.caller, input);
  const save = f.store.saveReceipt.bind(f.store);
  f.store.saveReceipt = () => {
    throw Error('synthetic receipt save failure');
  };
  assert.throws(
    () => f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, input),
    /save failure/,
  );
  f.store.saveReceipt = save;
  assert.equal(f.store.all().length, 1);
  assert.equal(f.store.get(String(first.timerId))?.state, 'scheduled');
  f.store.claim = () => {
    throw Error('synthetic claim failure');
  };
  f.advance();
  await assert.rejects(f.scheduler.tick(), /claim failure/);
  assert.equal(f.dispatched.length, 0);
});

test('deleted owner removes stored instructions and receipts', async (t) => {
  const f = await fixture(t);
  f.scheduler.schedule(f.caller, input);
  f.scheduler.deleteOwner(f.caller.owner);
  assert.equal(f.store.all().length, 0);
  assert.equal(
    f.store.receipt(`${f.caller.owner}:${f.caller.turnId}:${f.caller.callId}`),
    undefined,
  );
  f.advance();
  await f.scheduler.tick();
  assert.equal(f.dispatched.length, 0);
});

test('Pi and Claude share wake schemas and leased execution; old listeners expose neither', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    const lease = request.sessionTools!;
    const pi = sessionTools(lease.endpoint, lease.token, lease.capabilities).filter((tool) =>
      tool.name.startsWith('companion_wake_'),
    );
    const claude = bridgeTools({ sessionTools: lease }).filter((tool) =>
      tool.name.startsWith('companion_wake_'),
    );
    assert.equal(pi.length, 3);
    assert.deepEqual(
      claude.map((tool) => tool.inputSchema),
      JSON.parse(JSON.stringify(pi.map((tool) => tool.parameters))),
    );
    assert.equal(
      sessionTools(lease.endpoint, lease.token).filter((tool) =>
        tool.name.startsWith('companion_wake_'),
      ).length,
      0,
    );
    assert.equal(
      bridgeTools({ sessionTools: { endpoint: lease.endpoint, token: lease.token } }).filter(
        (tool) => tool.name.startsWith('companion_wake_'),
      ).length,
      0,
    );
    const scheduled = JSON.parse(
      (await claude[0].execute(randomUUID(), input, signal())) as string,
    );
    const listed = JSON.parse((await claude[2].execute(randomUUID(), {}, signal())) as string);
    assert.equal(listed.timers[0].id, scheduled.timerId);
    assert.equal(
      JSON.parse(
        (await claude[1].execute(randomUUID(), { timerId: scheduled.timerId }, signal())) as string,
      ).outcome,
      'cancelled',
    );
  });
  f.sessions.startRemote('Harness parity', 'coding', signal());
  await f.sessions.idle();
  assert.equal(f.sessions.snapshot()[0].status, 'completed');
});

test('missing native transcript blocks the occurrence and never retries', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  const owner = f.sessions.startRemote('Missing history', 'coding', signal());
  await f.sessions.idle();
  f.script(async () => {
    throw new ConversationUnavailableError('Synthetic missing native transcript');
  });
  f.advance();
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'blocked');
  await f.sessions.wakes.tick();
  assert.equal(f.runs.length, 2);
});

test('global pending ceiling, explicit long delay, and clock reversal during preparation', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 64; i++) {
    f.scheduler.schedule(
      { ...f.caller, owner: randomUUID() },
      { ...input, afterSeconds: 30 * 86400 },
    );
  }
  assert.throws(() => f.scheduler.schedule(f.caller, input), /limit/);
  await f.scheduler.tick();
  assert.equal(f.dispatched.length, 0);
  const other = await fixture(t);
  other.scheduler.schedule(other.caller, input);
  other.advance();
  other.host.prepare = async () => {
    other.advance(-120_000);
    return 'ready';
  };
  await other.scheduler.tick();
  assert.equal(other.dispatched.length, 0);
});

test('a failed preceding ordinary turn blocks pending wake; provider runtime errors never retry', async (t) => {
  for (const reason of [
    'quota exhausted',
    'provider policy refusal',
    'runtime limit',
    'unexpected wake exception',
  ]) {
    const f = await integration(t);
    f.script(async (request) => {
      await invoke(request, 'companion_wake_schedule', input);
    });
    const owner = f.sessions.startRemote('Failure test', 'coding', signal());
    await f.sessions.idle();
    f.script(async () => {
      throw Error(reason);
    });
    f.sessions.followUp(owner, 'Ordinary work', signal());
    await f.sessions.idle();
    assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'blocked');
    f.advance();
    await f.sessions.wakes.tick();
    assert.equal(f.runs.length, 2);
  }
});

test('unavailable model and invalid configuration block without fallback or provider invocation', async (t) => {
  for (const unavailable of [true, false]) {
    const f = await integration(t);
    f.script(async (request) => {
      await invoke(request, 'companion_wake_schedule', input);
    });
    const owner = f.sessions.startRemote('Configuration test', 'coding', signal());
    await f.sessions.idle();
    if (unavailable) {
      f.backend.models = async () => ({ models: [], thinkingLevels: {} });
    } else {
      await writeFile(join(f.directory, 'companion-agent.json'), '{malformed');
    }
    f.advance();
    await f.sessions.wakes.tick();
    assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'blocked');
    assert.equal(f.runs.length, 1);
  }
});

test('claimed wake whose transcript admission fails never invokes or retries the backend', async (t) => {
  const f = await integration(t);
  f.script(async (request) => {
    await invoke(request, 'companion_wake_schedule', input);
  });
  const owner = f.sessions.startRemote('Admission failure', 'coding', signal());
  await f.sessions.idle();
  const store = (
    f.sessions as unknown as { store: { save: (...args: unknown[]) => Promise<void> } }
  ).store;
  const save = store.save;
  store.save = async () => {
    throw Error('Synthetic history save failure');
  };
  f.advance();
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  store.save = save;
  assert.equal(f.runs.length, 1);
  assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'failed');
  await f.sessions.wakes.tick();
  assert.equal(f.runs.length, 1);
});

test('completed backend with failed outcome persistence is uncertain after restart, never replayed', async (t) => {
  const f = await fixture(t);
  f.scheduler.schedule(f.caller, input);
  f.advance();
  await f.scheduler.tick();
  const record = f.dispatched[0];
  f.scheduler.transitionAttempt(record, 'started');
  const put = f.store.put.bind(f.store);
  f.store.put = () => {
    throw Error('Synthetic outcome save failure after external effect');
  };
  assert.throws(() => f.scheduler.transitionAttempt(record, 'completed'), /outcome save failure/);
  f.store.put = put;
  await f.scheduler.close();
  const restarted = new WakeScheduler(new WakeStore(f.directory, () => {}), f.host, f.now);
  t.after(() => restarted.close());
  assert.equal(restarted.list(f.caller.owner, 1)[0].state, 'delivery-uncertain');
  await restarted.tick();
  assert.equal(f.dispatched.length, 1);
});

test('Stop and close win while model preparation is awaiting, with truthful cancellation counts', async (t) => {
  for (const action of ['stop', 'remove'] as const) {
    const f = await integration(t);
    f.script(async (request) => {
      await invoke(request, 'companion_wake_schedule', input);
    });
    const owner = f.sessions.startRemote('Race ' + action, 'coding', signal());
    await f.sessions.idle();
    const entered = deferred<void>();
    const gate = deferred<void>();
    f.backend.models = async () => {
      entered.resolve();
      await gate.promise;
      return { models: [defaultAgentSettings.model], thinkingLevels: {} };
    };
    f.advance();
    const tick = f.sessions.wakes.tick();
    await entered.promise;
    assert.equal(await f.sessions[action](owner), 1);
    gate.resolve();
    await tick;
    assert.equal(f.runs.length, 1);
    assert.equal(f.sessions.wakes.list(owner).length, 0);
  }
});

test('diagnostic retention does not become a lifetime rearm cap', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 110; index++) {
    f.scheduler.schedule({ ...f.caller, turnId: randomUUID() }, input);
    f.advance();
    await f.scheduler.tick();
    f.scheduler.transitionAttempt(f.dispatched[index], 'started');
    f.scheduler.transitionAttempt(f.dispatched[index], 'completed');
  }
  assert.equal(f.dispatched.length, 110);
  assert.equal(f.store.all().length, 100);
});

test('at rejects normalized invalid calendar dates and 24-hour rollover', () => {
  const now = Date.parse('2026-02-01T00:00:00Z');
  const { afterSeconds: _, ...absolute } = input;
  assert.throws(
    () => scheduleDeadline({ ...absolute, at: '2026-02-30T12:00:00Z' }, now),
    /calendar/,
  );
  assert.throws(
    () => scheduleDeadline({ ...absolute, at: '2026-02-02T24:00:00Z' }, now),
    /calendar/,
  );
});

test('failed status observer cannot misreport a committed schedule or cancellation', async (t) => {
  const f = await fixture(t);
  f.host.changed = () => {
    throw Error('Synthetic UI observer failure');
  };
  const result = f.scheduler.schedule(f.caller, input);
  assert.equal(result.outcome, 'scheduled');
  assert.equal(f.store.get(String(result.timerId))?.state, 'scheduled');
  assert.equal(f.scheduler.cancel(f.caller.owner, String(result.timerId)).outcome, 'cancelled');
  assert.equal(f.store.get(String(result.timerId))?.state, 'cancelled');
});
