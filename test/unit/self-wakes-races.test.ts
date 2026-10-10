// Regression probes adapted from Flint’s independent R1 reproductions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WakeStore } from '../../src/agents/wakes/store.ts';
import { WakeScheduler, type WakeCaller, type WakeHost } from '../../src/agents/wakes/scheduler.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import type { AgentBackend, AgentModelCatalog, AgentRunRequest } from '../../src/agents/types.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const input = {
  afterSeconds: 60,
  label: 'Synthetic check',
  message: 'Synthetic instructions',
  key: 'review',
};

async function schedulerFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'review-r1-wakes-'));
  let now = Date.parse('2026-10-08T12:00:00Z');
  const dispatched: string[] = [];
  const host: WakeHost = {
    async prepare() {
      return 'ready';
    },
    admit(_record, claim) {
      const record = claim();
      if (record) dispatched.push(record.id);
      return !!record;
    },
    changed() {},
    warning() {},
  };
  const store = new WakeStore(directory, () => {});
  const scheduler = new WakeScheduler(store, host, () => now);
  const caller: WakeCaller = {
    owner: randomUUID(),
    turnId: randomUUID(),
    callId: randomUUID(),
    depth: 0,
    harness: 'pi',
    signal: new AbortController().signal,
  };
  t.after(async () => {
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    scheduler,
    store,
    host,
    caller,
    dispatched,
    directory,
    advance: (delta = 60_000) => {
      now += delta;
    },
    now: () => now,
  };
}

for (const otherOwner of [false, true]) {
  for (const mutation of ['cancel', 'replace', 'stop', 'block', 'expire'] as const) {
    test(`later sweep candidate: ${mutation}, different owner=${otherOwner}`, async (t) => {
      const f = await schedulerFixture(t);
      const first = f.scheduler.schedule(f.caller, { ...input, key: 'first' });
      const caller = {
        ...f.caller,
        callId: randomUUID(),
        owner: otherOwner ? randomUUID() : f.caller.owner,
      };
      const second = f.scheduler.schedule(caller, { ...input, expiresAfterSeconds: 1 });
      const entered = gate();
      const release = gate();
      const prepared: string[] = [];
      f.host.prepare = async (record) => {
        prepared.push(record.id);
        if (record.id === first.timerId) {
          entered.resolve();
          await release.promise;
        }
        return 'ready';
      };
      f.advance();
      const ticking = f.scheduler.tick();
      await entered.promise;
      if (mutation === 'cancel')
        assert.equal(f.scheduler.cancel(caller.owner, String(second.timerId)).outcome, 'cancelled');
      if (mutation === 'replace') f.scheduler.schedule({ ...caller, callId: randomUUID() }, input);
      if (mutation === 'stop')
        assert.equal(f.scheduler.cancelOwner(caller.owner, 'Human Stop'), otherOwner ? 1 : 2);
      if (mutation === 'block') f.scheduler.blockOwner(caller.owner, 'Failed predecessor');
      if (mutation === 'expire') f.advance(1001);
      release.resolve();
      await ticking;
      assert.equal(f.dispatched.includes(String(second.timerId)), false);
      assert.equal(
        prepared.includes(String(second.timerId)),
        false,
        'terminal/expired owner must not even be restored',
      );
      assert.equal(
        f.store.get(String(second.timerId))?.state,
        mutation === 'replace'
          ? 'superseded'
          : mutation === 'block'
            ? 'blocked'
            : mutation === 'expire'
              ? 'expired'
              : 'cancelled',
      );
      assert.equal(
        f.dispatched.includes(String(first.timerId)),
        otherOwner || ['cancel', 'replace', 'expire'].includes(mutation),
      );
    });
  }
}

async function sessionFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'review-r1-sessions-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let now = Date.now();
  const runs: AgentRunRequest[] = [];
  const warnings: string[] = [];
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
    (_kind, text) => warnings.push(text),
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
    warnings,
    now: () => now,
    advance: () => {
      now += 60_000;
    },
    script: (value: typeof script) => {
      script = value;
    },
  };
}

async function schedule(request: AgentRunRequest, parameters = input) {
  const lease = request.sessionTools!;
  const tool = sessionTools(lease.endpoint, lease.token, lease.capabilities).find(
    (t) => t.name === 'companion_wake_schedule',
  )!;
  return (await tool.execute(randomUUID(), parameters)).details;
}

for (const action of ['stop', 'remove'] as const) {
  test(`R1 real session ${action} must prevent all cancelled timers from dispatching`, async (t) => {
    const f = await sessionFixture(t);
    f.script(async (request) => {
      await schedule(request, { ...input, key: 'first' });
      await schedule(request);
    });
    const owner = f.sessions.startRemote('Synthetic task', 'coding', new AbortController().signal);
    await f.sessions.idle();
    const entered = gate();
    const release = gate();
    f.backend.models = async () => {
      entered.resolve();
      await release.promise;
      return { models: [defaultAgentSettings.model], thinkingLevels: {} };
    };
    f.script(async () => {});
    f.advance();
    const ticking = f.sessions.wakes.tick();
    await entered.promise;
    assert.equal(await f.sessions[action](owner), 2);
    release.resolve();
    await ticking;
    await f.sessions.idle();
    assert.equal(f.runs.length, 1, 'successful Stop/close must prevent any new wake turn');
    assert.equal(
      f.sessions.snapshot().some((view) => view.id === owner),
      action !== 'remove',
    );
    assert.deepEqual(
      f.sessions.wakes.list(owner, 5).map((record) => record.state),
      ['cancelled', 'cancelled'],
    );
  });
}

for (const action of ['stop', 'remove'] as const) {
  for (const preparing of [false, true]) {
    test(`failed ${action} save halts admission before/during preparation=${preparing}`, async (t) => {
      const f = await sessionFixture(t);
      f.script(async (request) => {
        await schedule(request);
      });
      const owner = f.sessions.startRemote(
        'Synthetic task',
        'coding',
        new AbortController().signal,
      );
      await f.sessions.idle();
      const entered = gate();
      const release = gate();
      f.backend.models = async () => {
        entered.resolve();
        await release.promise;
        return { models: [defaultAgentSettings.model], thinkingLevels: {} };
      };
      f.script(async () => {});
      f.advance();
      const ticking = preparing ? f.sessions.wakes.tick() : undefined;
      if (preparing) await entered.promise;
      const put = f.sessions.wakes.store.put.bind(f.sessions.wakes.store);
      f.sessions.wakes.store.put = () => {
        throw Error('Synthetic cancellation disk failure');
      };
      await assert.rejects(f.sessions[action](owner), /disk failure/);
      f.sessions.wakes.store.put = put;
      release.resolve();
      await ticking;
      await f.sessions.wakes.tick();
      await f.sessions.idle();
      assert.equal(f.runs.length, 1);
      assert.equal(
        f.sessions.snapshot().some((view) => view.id === owner),
        true,
        'failed close keeps its tab',
      );
      assert.ok(f.warnings.some((text) => text.includes('Failed writes are not durable')));
      // Ordinary work does not implicitly re-enable the faulted scheduler.
      f.sessions.followUp(owner, 'Explicit ordinary work', new AbortController().signal);
      await f.sessions.idle();
      await f.sessions.wakes.tick();
      assert.equal(f.runs.length, 2);
      // Recovery is explicit: retry cancellation after repairing storage.
      assert.equal(await f.sessions[action](owner), 1);
      assert.equal(f.sessions.wakes.list(owner, 1)[0].state, 'cancelled');
      await f.sessions.close();
      const restarted = new AgentSessions(
        { pi: f.backend },
        () => {},
        f.directory,
        undefined,
        undefined,
        undefined,
        f.now,
      );
      t.after(() => restarted.close());
      await restarted.loadPrevious();
      await restarted.wakes.tick();
      await restarted.idle();
      assert.equal(f.runs.length, 2, 'successful retry is durable across restart');
    });
  }
}

for (const preparing of [false, true]) {
  test(`failed block persistence halts admission before/during preparation=${preparing}`, async (t) => {
    const f = await sessionFixture(t);
    f.script(async (request) => {
      await schedule(request);
    });
    const owner = f.sessions.startRemote('Synthetic task', 'coding', new AbortController().signal);
    await f.sessions.idle();
    const entered = gate();
    const release = gate();
    f.backend.models = async () => {
      entered.resolve();
      await release.promise;
      return { models: [defaultAgentSettings.model], thinkingLevels: {} };
    };
    f.advance();
    const ticking = preparing ? f.sessions.wakes.tick() : undefined;
    if (preparing) await entered.promise;
    const put = f.sessions.wakes.store.put.bind(f.sessions.wakes.store);
    f.sessions.wakes.store.put = (record) => {
      if (record.state === 'blocked') throw Error('Synthetic block save failure');
      return put(record);
    };
    f.script(async () => {
      throw Error('Synthetic quota failure');
    });
    f.sessions.followUp(owner, 'Ordinary work', new AbortController().signal);
    await f.sessions.idle();
    assert.equal(f.sessions.snapshot()[0].status, 'error');
    f.sessions.wakes.store.put = put;
    f.script(async () => {});
    release.resolve();
    await ticking;
    await f.sessions.wakes.tick();
    await f.sessions.idle();
    assert.equal(f.runs.length, 2, 'failed predecessor cannot cause scheduled retry');
    assert.ok(f.warnings.some((text) => text.includes('Wake dispatch is halted')));
    await f.sessions.close();
    const restarted = new AgentSessions(
      { pi: f.backend },
      () => {},
      f.directory,
      undefined,
      undefined,
      undefined,
      f.now,
    );
    t.after(() => restarted.close());
    await restarted.loadPrevious();
    await restarted.wakes.tick();
    await restarted.idle();
    assert.equal(f.runs.length, 2, 'saved owner error also blocks after restart');
    assert.equal(restarted.wakes.list(owner, 1)[0].state, 'blocked');
  });
}

test('failed cancellation cannot claim durable revocation after an unreconciled restart', async (t) => {
  const f = await sessionFixture(t);
  f.script(async (request) => {
    await schedule(request);
  });
  const owner = f.sessions.startRemote('Synthetic task', 'coding', new AbortController().signal);
  await f.sessions.idle();
  const put = f.sessions.wakes.store.put.bind(f.sessions.wakes.store);
  f.sessions.wakes.store.put = () => {
    throw Error('Synthetic disk failure');
  };
  await assert.rejects(f.sessions.stop(owner), /disk failure/);
  f.sessions.wakes.store.put = put;
  assert.equal(f.sessions.wakes.list(owner)[0].state, 'scheduled');
  assert.ok(
    f.sessions.snapshot()[0].messages.some((message) => message.text.includes('before restarting')),
  );
  await f.sessions.close();
  // A fresh process only knows the last committed timer/owner state. This is
  // intentionally explicit evidence of the warning's recovery limitation.
  f.script(async () => {});
  f.advance();
  const restarted = new AgentSessions(
    { pi: f.backend },
    () => {},
    f.directory,
    undefined,
    undefined,
    undefined,
    f.now,
  );
  t.after(() => restarted.close());
  await restarted.loadPrevious();
  await restarted.wakes.tick();
  await restarted.idle();
  assert.equal(f.runs.length, 2);
});

test('successful intervening ordinary turn invalidates prepared wake until a fresh preparation', async (t) => {
  const f = await sessionFixture(t);
  f.script(async (request) => {
    await schedule(request);
  });
  const owner = f.sessions.startRemote('Synthetic task', 'coding', new AbortController().signal);
  await f.sessions.idle();
  const entered = gate();
  const release = gate();
  f.backend.models = async () => {
    entered.resolve();
    await release.promise;
    return { models: [defaultAgentSettings.model], thinkingLevels: {} };
  };
  f.advance();
  const ticking = f.sessions.wakes.tick();
  await entered.promise;
  f.script(async () => {});
  f.sessions.followUp(owner, 'Ordinary work', new AbortController().signal);
  await f.sessions.idle();
  release.resolve();
  await ticking;
  await f.sessions.idle();
  assert.equal(f.runs.length, 2);
  await f.sessions.wakes.tick();
  await f.sessions.idle();
  assert.equal(f.runs.length, 3);
});

test('absolute durable receipt replays after elapsed time and store reopen, but never for an aborted caller', async (t) => {
  const f = await schedulerFixture(t);
  const { afterSeconds, ...absolute } = input;
  const request = { ...absolute, at: new Date(f.now() + afterSeconds * 1000).toISOString() };
  const receipt = f.scheduler.schedule(f.caller, request);
  f.advance();
  assert.deepEqual(f.scheduler.schedule(f.caller, request), receipt);
  await f.scheduler.close();
  const restarted = new WakeScheduler(new WakeStore(f.directory, () => {}), f.host, f.now);
  t.after(() => restarted.close());
  f.advance();
  assert.deepEqual(restarted.schedule(f.caller, request), receipt);
  assert.equal(restarted.list(f.caller.owner).length, 1);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(
    () => restarted.schedule({ ...f.caller, signal: aborted.signal }, request),
    /abort/i,
  );
});

test('R1 preserved ancestry/depth hold through four real leased self-wakes', async (t) => {
  const f = await sessionFixture(t);
  const owner = f.sessions.startRemote('Owner', 'coding', new AbortController().signal);
  await f.sessions.idle();
  const target = f.sessions.startRemote('Target', 'coding', new AbortController().signal);
  await f.sessions.idle();
  const ancestry = {
    kind: 'agent' as const,
    sessionId: target,
    title: 'Synthetic sender',
    depth: 3,
  };
  let wakeCount = 0;
  f.script(async (request) => {
    if (request.prompt.text.startsWith('[Companion scheduled wake]')) {
      wakeCount++;
      const lease = request.sessionTools!;
      const tool = sessionTools(lease.endpoint, lease.token, lease.capabilities).find(
        (t) => t.name === 'companion_session_send',
      )!;
      await assert.rejects(
        tool.execute(randomUUID(), { id: target, text: 'Fourth hop must be refused' }),
        /loop-limit/,
      );
    }
    if (wakeCount < 4) await schedule(request);
  });
  f.sessions.followUp(
    owner,
    'Synthetic agent-origin instruction',
    new AbortController().signal,
    ancestry,
  );
  await f.sessions.idle();
  for (let i = 0; i < 4; i++) {
    f.advance();
    await f.sessions.wakes.tick();
    await f.sessions.idle();
  }
  assert.equal(wakeCount, 4);
  const origins = f.sessions
    .snapshot()
    .find((s) => s.id === owner)!
    .messages.map((m) => m.origin)
    .filter((o) => o?.kind === 'scheduled-wake');
  assert.equal(origins.length, 4);
  for (const origin of origins) {
    assert.equal(origin!.depth, 3);
    assert.deepEqual(origin!.kind === 'scheduled-wake' ? origin.ancestry : undefined, ancestry);
  }
});

test('R1 whole-store corruption refuses startup without admitting any callback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-r1-corruption-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'timers.sqlite'), 'Synthetic corrupted database', {
    mode: 0o600,
  });
  const store = new WakeStore(directory, () => {});
  assert.throws(() => store.open(Date.now()), /database|file/i);
  store.close();
});

test('stale/terminal transitions cannot resurrect a timer; active attempts preserve cancellation intent', async (t) => {
  const f = await schedulerFixture(t);
  const receipt = f.scheduler.schedule(f.caller, input);
  const stale = f.store.get(String(receipt.timerId))!;
  f.scheduler.transition(stale, 'waiting');
  f.scheduler.transition(stale, 'cancelled');
  assert.equal(f.store.get(stale.id)?.state, 'waiting', 'stale revision must not mutate');
  f.scheduler.cancel(f.caller.owner, stale.id);
  const terminal = f.store.get(stale.id)!;
  f.scheduler.transition(terminal, 'waiting');
  assert.deepEqual(
    f.store.get(stale.id),
    terminal,
    'even fresh terminal revision cannot resurrect',
  );
  const successor = f.scheduler.schedule({ ...f.caller, callId: randomUUID() }, input);
  f.advance();
  await f.scheduler.tick();
  const claimed = f.store.get(String(successor.timerId))!;
  f.scheduler.transitionAttempt(claimed, 'started');
  f.scheduler.cancel(f.caller.owner, claimed.id);
  f.scheduler.transitionAttempt({ ...claimed, attemptId: randomUUID() }, 'failed');
  assert.equal(f.store.get(claimed.id)?.state, 'started');
  f.scheduler.transitionAttempt(claimed, 'completed');
  assert.equal(f.store.get(claimed.id)?.state, 'completed');
  assert.equal(f.store.get(claimed.id)?.cancellationRequested, true);
  f.scheduler.transitionAttempt(claimed, 'started');
  assert.equal(f.store.get(claimed.id)?.state, 'completed');
});

test('multi-timer ordinary predecessor failure during preparation durably blocks every wake', async (t) => {
  const f = await sessionFixture(t);
  f.script(async (request) => {
    await schedule(request, { ...input, key: 'first' });
    await schedule(request);
  });
  const owner = f.sessions.startRemote('Synthetic task', 'coding', new AbortController().signal);
  await f.sessions.idle();
  const entered = gate();
  const release = gate();
  f.backend.models = async () => {
    entered.resolve();
    await release.promise;
    return { models: [defaultAgentSettings.model], thinkingLevels: {} };
  };
  f.advance();
  const ticking = f.sessions.wakes.tick();
  await entered.promise;
  f.script(async () => {
    throw Error('Synthetic quota failure');
  });
  f.sessions.followUp(owner, 'Ordinary work', new AbortController().signal);
  await f.sessions.idle();
  release.resolve();
  await ticking;
  await f.sessions.idle();
  assert.equal(f.runs.length, 2);
  assert.deepEqual(
    f.sessions.wakes.list(owner, 5).map((record) => record.state),
    ['blocked', 'blocked'],
  );
});

// Flint's R2 negative-catalog probes: stale failure must not lose accepted work.
for (const intervention of ['model-choice', 'ordinary-turn'] as const) {
  test(`stale unavailable model after ${intervention} waits for fresh preparation`, async (t) => {
    const f = await sessionFixture(t);
    f.script(async (request) => {
      await schedule(request);
    });
    const owner = f.sessions.startRemote('Synthetic owner', 'coding', new AbortController().signal);
    await f.sessions.idle();
    const entered = gate();
    const release = gate();
    const newModel = 'synthetic/available';
    let modelCalls = 0;
    f.backend.models = async (): Promise<AgentModelCatalog> => {
      const first = ++modelCalls === 1;
      if (first) {
        entered.resolve();
        await release.promise;
      }
      return intervention === 'model-choice'
        ? { models: [newModel], thinkingLevels: { [newModel]: ['off'] } }
        : { models: first ? [] : [defaultAgentSettings.model], thinkingLevels: {} };
    };
    f.advance();
    const ticking = f.sessions.wakes.tick();
    await entered.promise;
    f.script(async () => {});
    if (intervention === 'model-choice') {
      await f.sessions.setModel(owner, newModel, new AbortController().signal);
      assert.equal(f.sessions.snapshot()[0].modelOverride, newModel);
    } else {
      f.sessions.followUp(owner, 'Successful ordinary reply', new AbortController().signal);
      await f.sessions.idle();
    }
    const before = f.runs.length;
    release.resolve();
    await ticking;
    assert.equal(f.sessions.wakes.list(owner, 5)[0].state, 'waiting');
    assert.equal(f.runs.length, before, 'obsolete readiness cannot admit or block');
    await f.sessions.wakes.tick();
    await f.sessions.idle();
    assert.equal(f.runs.length, before + 1);
    assert.equal(
      f.runs.at(-1)?.settings?.model,
      intervention === 'model-choice' ? newModel : defaultAgentSettings.model,
    );
    assert.equal(f.sessions.wakes.list(owner, 5)[0].state, 'completed');
  });
}
