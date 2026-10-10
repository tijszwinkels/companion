import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentBackend } from '../../src/agents/types.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { callTool, harnessFixture } from '../harness-fixture.ts';
import { deferred, frame, screenshot, signal } from '../helpers.ts';

const timer = { afterSeconds: 60, label: 'Synthetic check', message: 'Reassess work' };

for (const harness of ['pi', 'claude-code'] as const) {
  for (const path of ['native', 'leased'] as const) {
    // Pi model discovery supplies a real asynchronous preparation boundary.
    // Claude uses the fixed catalog; its public lease path is covered before due.
    for (const preparing of harness === 'pi' ? [false, true] : [false]) {
      test(`${harness} ${path}: failed cancel ${preparing ? 'during' : 'before'} preparation stays halted after repair/retry`, async (t) => {
        let now = Date.now();
        const policy = new CaptureStoragePolicy();
        await policy.setEnabled(path === 'native');
        const f = await harnessFixture(t, {
          captureStorage: policy,
          wakeClock: () => now,
          configuration: { ...defaultAgentSettings, model: 'configured/one' },
        });
        const owner = f.sessions.start(frame, signal(), 'coding', harness);
        f.script(owner, async (run) => {
          await callTool(run, 'companion_wake_schedule', timer);
          await callTool(run, 'companion_wake_schedule', {
            ...timer,
            label: 'Another pending timer',
          });
        });
        await f.sessions.idle();
        const pending = f.sessions.wakes.list(owner);
        assert.equal(pending.length, 2);
        const id = pending[0].id;
        const entered = deferred<void>();
        const release = deferred<void>();
        let ticking: Promise<void> | undefined;
        if (preparing) {
          const backend = (f.sessions as unknown as { backends: { pi: AgentBackend } }).backends.pi;
          const models = backend.models!.bind(backend);
          backend.models = async (...args) => {
            // Only the first discovery is suspended; explicit turns stay usable.
            backend.models = models;
            entered.resolve();
            await release.promise;
            return models(...args);
          };
          now += 60_000;
          ticking = f.sessions.wakes.tick();
          await entered.promise;
        }
        const store = f.sessions.wakes.store;
        const put = store.put.bind(store);
        const fail = () => {
          store.put = (record) => {
            if (record.state === 'cancelled') {
              throw Error('Synthetic single-cancel storage failure');
            }
            return put(record);
          };
        };
        try {
          if (path === 'native') {
            fail();
            assert.throws(() => f.sessions.cancelWake(owner, id), /single-cancel storage failure/);
          } else {
            let checked = false;
            f.script(owner, async (run) => {
              fail();
              await assert.rejects(
                callTool(run, 'companion_wake_cancel', { timerId: id }),
                /single-cancel storage failure/,
              );
              checked = true;
            });
            f.sessions.followUp(owner, 'Explicit review', signal());
            await f.sessions.idle();
            assert.equal(checked, true, 'backend must finish the assertion');
            assert.equal(f.view(owner).status, 'completed');
          }
          assert.equal(store.get(id)?.state, preparing ? 'waiting' : 'scheduled');
          const warning = f
            .view(owner)
            .messages.find((message) => message.id === 'wake-service-warning');
          assert.match(warning?.text ?? '', /No pending timers will dispatch/);
          assert.match(warning?.text ?? '', /Failed writes are not durable.*before restarting/);
        } finally {
          store.put = put;
          release.resolve();
        }
        await ticking;
        now += 60_000;
        await f.sessions.wakes.tick();
        await f.sessions.idle();
        assert.equal(
          f.runs.some((run) => run.text.startsWith('[Companion scheduled wake]')),
          false,
        );

        let repaired = false;
        f.script(owner, async (run) => {
          await assert.rejects(
            callTool(run, 'companion_wake_schedule', timer),
            /scheduler is stopped/,
          );
          const result =
            path === 'native'
              ? f.sessions.cancelWake(owner, id)
              : await callTool(run, 'companion_wake_cancel', { timerId: id });
          assert.equal(result.outcome, 'cancelled');
          await assert.rejects(
            callTool(run, 'companion_wake_schedule', timer),
            /scheduler is stopped/,
          );
          repaired = true;
        });
        f.sessions.followUp(owner, 'Explicit repair and cancellation retry', signal());
        await f.sessions.idle();
        assert.equal(repaired, true);
        assert.equal(f.view(owner).status, 'completed');
        assert.equal(store.get(id)?.state, 'cancelled');
        await f.sessions.wakes.tick();
        await f.sessions.idle();
        assert.equal(
          f.runs.some((run) => run.text.startsWith('[Companion scheduled wake]')),
          false,
        );
        assert.ok(f.view(owner).messages.some((message) => message.id === 'wake-service-warning'));

        // The wake fault neither changes capture policy nor blocks explicit input.
        for (const enabled of [false, true]) {
          await policy.setEnabled(enabled);
          const explicit = f.sessions.start(
            { ...frame, storage: policy.admit() },
            signal(),
            'coding',
            harness,
          );
          await f.sessions.idle();
          assert.deepEqual(f.runs.at(-1)?.png, screenshot.png);
          assert.equal(!!f.view(explicit).messages[0].screenshotUrl, enabled);
          assert.equal(policy.enabled, enabled);
        }
        assert.equal(f.sessions.cancelWake(owner, pending[1].id).outcome, 'cancelled');
        const runs = f.runs.length;
        await f.sessions.close();
        const restarted = f.open();
        await restarted.loadPrevious();
        await restarted.wakes.tick();
        await restarted.idle();
        assert.equal(f.runs.length, runs, 'successful cancellation retry survives restart');
        assert.ok(restarted.wakes.list(owner, 5).every((record) => record.state === 'cancelled'));
      });
    }

    test(`${harness} ${path}: failed post-dispatch intent halts future wakes without aborting the active turn`, async (t) => {
      let now = Date.now();
      const f = await harnessFixture(t, {
        wakeClock: () => now,
        configuration: { ...defaultAgentSettings, model: 'configured/one' },
      });
      const owner = f.sessions.start(frame, signal(), 'coding', harness);
      f.script(owner, async (run) => {
        await callTool(run, 'companion_wake_schedule', timer);
        await callTool(run, 'companion_wake_schedule', { ...timer, label: 'Future work' });
      });
      await f.sessions.idle();
      const pending = f.sessions.wakes.list(owner);
      const entered = deferred<void>();
      const release = deferred<void>();
      const store = f.sessions.wakes.store;
      const put = store.put.bind(store);
      let activeId = '';
      let checked = false;
      f.script(owner, async (run) => {
        activeId = f.sessions.wakes.list(owner).find((record) => record.state === 'started')!.id;
        entered.resolve();
        await release.promise;
        if (path === 'leased') {
          await assert.rejects(
            callTool(run, 'companion_wake_cancel', { timerId: activeId }),
            /intent storage failure/,
          );
          assert.equal(store.get(activeId)?.cancellationRequested, undefined);
          store.put = put;
          const retry = await callTool(run, 'companion_wake_cancel', { timerId: activeId });
          assert.equal(retry.outcome, 'dispatch-started');
        }
        assert.equal(run.signal.aborted, false);
        await assert.rejects(
          callTool(run, 'companion_wake_schedule', timer),
          /scheduler is stopped/,
        );
        checked = true;
      });
      now += 60_000;
      const ticking = f.sessions.wakes.tick();
      await entered.promise;
      store.put = (record) => {
        if (record.cancellationRequested) {
          throw Error('Synthetic intent storage failure');
        }
        return put(record);
      };
      try {
        if (path === 'native') {
          assert.throws(() => f.sessions.cancelWake(owner, activeId), /intent storage failure/);
          assert.equal(store.get(activeId)?.cancellationRequested, undefined);
          store.put = put;
          assert.equal(f.sessions.cancelWake(owner, activeId).outcome, 'dispatch-started');
        }
      } finally {
        release.resolve();
      }
      await ticking;
      await f.sessions.idle();
      store.put = put;
      assert.equal(checked, true);
      assert.equal(f.view(owner).status, 'completed');
      assert.equal(store.get(activeId)?.state, 'completed');
      assert.equal(store.get(activeId)?.cancellationRequested, true);
      assert.match(
        f.view(owner).messages.find((message) => message.id === 'wake-service-warning')?.text ?? '',
        /Failed writes are not durable/,
      );
      f.sessions.followUp(owner, 'Explicit ordinary work still works', signal());
      await f.sessions.idle();
      await f.sessions.wakes.tick();
      await f.sessions.idle();
      assert.equal(
        f.runs.length,
        3,
        'one initiating, one already dispatched and one explicit turn',
      );
      assert.equal(
        store.get(pending.find((record) => record.id !== activeId)!.id)?.state,
        'waiting',
      );
    });
  }

  test(`${harness}: successful/unknown/foreign/invalid cancellation outcomes do not fault scheduling`, async (t) => {
    let now = Date.now();
    const f = await harnessFixture(t, {
      wakeClock: () => now,
      configuration: { ...defaultAgentSettings, model: 'configured/one' },
    });
    const owner = f.sessions.start(frame, signal(), 'coding', harness);
    let checked = false;
    f.script(owner, async (run) => {
      const first = await callTool(run, 'companion_wake_schedule', timer);
      assert.equal(
        f.sessions.cancelWake('foreign-owner', String(first.timerId)).outcome,
        'unknown-or-not-owned',
      );
      assert.equal(f.sessions.cancelWake(owner, 'absent').outcome, 'unknown-or-not-owned');
      await assert.rejects(
        callTool(run, 'companion_wake_cancel', { timerId: first.timerId, owner: 'forged' }),
      );
      assert.equal(
        (await callTool(run, 'companion_wake_cancel', { timerId: first.timerId })).outcome,
        'cancelled',
      );
      assert.equal(
        f.sessions.cancelWake(owner, String(first.timerId)).outcome,
        'already-cancelled',
      );
      await callTool(run, 'companion_wake_schedule', timer);
      checked = true;
    });
    await f.sessions.idle();
    assert.equal(checked, true);
    now += 60_000;
    await f.sessions.wakes.tick();
    await f.sessions.idle();
    assert.equal(f.runs.length, 2);
    const finished = f.sessions.wakes
      .list(owner, 5)
      .find((record) => record.state === 'completed')!;
    assert.equal(f.sessions.cancelWake(owner, finished.id).outcome, 'already-finished');
    assert.equal(
      f.view(owner).messages.some((message) => message.id === 'wake-service-warning'),
      false,
    );
  });
}
