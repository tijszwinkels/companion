import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { historyPageRows, historyPageText } from '../../src/agents/history-pages.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import type { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage, type AgentMessage, type AgentSession } from '../../src/agents/types.ts';
import { callTool, harnessFixture } from '../harness-fixture.ts';
import { frame, signal } from '../helpers.ts';

const timer = { afterSeconds: 60, label: 'Long history check', message: 'Review retained work' };

function bounded(view: Pick<AgentSession, 'messages' | 'history'>) {
  assert.ok(view.messages.length <= historyPageRows);
  assert.ok(
    view.messages.reduce((sum, row) => sum + row.text.length + row.input.length, 0) <=
      historyPageText,
  );
  assert.equal(new Set(view.history!.ids).size, view.history!.ids.length);
}

function allRows(sessions: AgentSessions, id: string): AgentMessage[] {
  const view = sessions.snapshot().find((session) => session.id === id)!;
  const rows = new Map<string, AgentMessage>();
  let position = { index: 0, offset: 0 };
  do {
    const page = sessions.historyPage({
      id,
      epoch: view.toolEpoch!,
      direction: 'after',
      ...position,
    });
    bounded(page);
    for (const message of page.messages) {
      const { historyFragment: _, ...row } = message;
      const previous = rows.get(row.id);
      rows.set(
        row.id,
        previous
          ? { ...row, text: previous.text + row.text, input: previous.input + row.input }
          : row,
      );
    }
    assert.notDeepEqual(page.history.end, position);
    position = page.history.end;
  } while (position.index < view.history!.total || position.offset > 0);
  return [...rows.values()];
}

for (const harness of ['pi', 'claude-code'] as const) {
  for (const restore of [false, true]) {
    test(`${harness}: ${restore ? 'background restored' : 'live'} wake retains >4000 rows/>1M units with bounded pages and stable deltas`, async (t) => {
      let now = Date.now();
      const f = await harnessFixture(t, {
        wakeClock: () => now,
        configuration: { ...defaultAgentSettings, model: 'configured/one' },
      });
      const owner = f.sessions.start(frame, signal(), 'coding', harness);
      f.script(owner, async (run) => {
        await callTool(run, 'companion_wake_schedule', timer);
        run.emit({
          ...chatMessage('retained-tool', 'tool', 'PRIVATE_TOOL_BODY'),
          toolName: 'read',
          input: 'synthetic file',
        });
        if (!restore) {
          run.emit({
            ...chatMessage('pin', 'assistant', 'Pinned fixture'),
            widget: {
              id: '00000000-0000-4000-8000-000000000001',
              name: 'fixture',
              revision: 1,
              presentation: { placement: 'pinned', heightPercent: 25, replaceActivity: true },
              viewUrl: 'http://localhost:1234/synthetic-private-capability',
            },
          });
        }
        for (let index = 0; index < 4200; index++) {
          run.emit(chatMessage(`retained-${index}`, 'assistant', `${index}:` + 'x'.repeat(320)));
        }
        run.emit(chatMessage('giant', 'assistant', '🦋'.repeat(70000)));
      });
      await f.sessions.idle();
      assert.equal(f.view(owner).status, 'completed');
      const initial = f.view(owner);
      bounded(initial);
      const original = allRows(f.sessions, owner);
      const immutable = original.filter(
        (row) => row.id.includes(':retained-') || row.id.endsWith(':giant'),
      );
      assert.equal(immutable.length, 4201);
      assert.ok(immutable.reduce((sum, row) => sum + row.text.length, 0) > 1_000_000);
      const pending = f.sessions.wakes.list(owner)[0];
      const path = join(f.directory, '.companion-sessions', `${owner}.json`);
      const saved = JSON.parse(await readFile(path, 'utf8')) as AgentSession;
      assert.ok(saved.messages.length > 4000);
      assert.equal(saved.history, undefined);
      assert.equal(saved.wakes, undefined);
      assert.ok(saved.messages.every((row) => !row.historyFragment));
      let sessions = f.sessions;
      if (restore) {
        await sessions.close();
        // Simulate a committed timer whose notice was not saved before shutdown,
        // plus dormant queued history. Only the durable timer may execute.
        saved.messages = saved.messages.filter((row) => row.id !== `wake:${pending.id}`);
        saved.messages.push({
          ...chatMessage('dormant-ordinary', 'user', 'Never replay this'),
          state: 'queued',
        });
        await writeFile(path, JSON.stringify(saved));
        sessions = f.open();
        await sessions.loadPrevious();
      }
      const restored: AgentSession[] = [];
      let projected = new Map(initial.messages.map((row) => [row.id, row]));
      let revision = initial.history!.revision;
      const deltaErrors: unknown[] = [];
      sessions.subscribe((event) => {
        try {
          if (event.type === 'agent-restored' && event.session.id === owner) {
            assert.equal(event.reveal, false);
            restored.push(event.session);
            projected = new Map(event.session.messages.map((row) => [row.id, row]));
            revision = event.session.history!.revision;
          }
          if (event.type !== 'agent-session' || event.session.id !== owner) {
            return;
          }
          const delta = event.session;
          bounded(delta);
          assert.ok(delta.history!.revision >= revision);
          revision = delta.history!.revision;
          for (const row of delta.messages) projected.set(row.id, row);
          projected = new Map(delta.history!.ids.map((id) => [id, projected.get(id)!]));
          assert.deepEqual(
            [...projected.values()],
            sessions.snapshot().find((view) => view.id === owner)!.messages,
          );
        } catch (error) {
          deltaErrors.push(error);
        }
      });
      now += 60_000;
      await sessions.wakes.tick();
      await sessions.idle();
      assert.deepEqual(deltaErrors, [], 'Observer assertions must not be swallowed by publication');
      assert.equal(f.runs.length, 2);
      assert.equal(f.runs[1].screenshot, false);
      assert.equal(f.runs[1].png, undefined);
      assert.match(f.runs[1].text, /scheduled wake/);
      assert.equal(sessions.wakes.list(owner, 1)[0].state, 'completed');
      const rows = allRows(sessions, owner);
      assert.deepEqual(
        rows.filter((row) => immutable.some((old) => old.id === row.id)),
        immutable,
      );
      assert.equal(rows.filter((row) => row.id === `wake:${pending.id}`).length, 1);
      const wake = rows.find((row) => row.origin?.kind === 'scheduled-wake')!;
      assert.equal(wake.origin!.kind, 'scheduled-wake');
      const tool = rows.find((row) => row.toolGroup)!;
      const view = sessions.snapshot().find((session) => session.id === owner)!;
      const groupPage = sessions.historyPage({
        id: owner,
        epoch: view.toolEpoch!,
        direction: 'after',
        index: 0,
        offset: 0,
        anchor: tool.id,
      });
      assert.equal(groupPage.messages[0].id, tool.id);
      assert.ok(
        sessions
          .toolPage({
            id: owner,
            epoch: view.toolEpoch!,
            groupId: tool.id,
            revision: tool.toolGroup!.revision,
            index: 0,
            offset: 0,
          })
          .text.includes('PRIVATE_TOOL_BODY'),
      );
      if (restore) {
        assert.equal(restored.length, 1);
        assert.equal(
          restored[0].messages.some((row) => row.id === `wake:${pending.id}`),
          true,
          'missing notice is appended beyond old display caps',
        );
        assert.equal(rows.find((row) => row.id === 'dormant-ordinary')?.state, 'error');
        assert.notEqual(view.toolEpoch, initial.toolEpoch);
        assert.throws(
          () =>
            sessions.historyPage({
              id: owner,
              epoch: initial.toolEpoch!,
              direction: 'after',
              index: 0,
              offset: 0,
            }),
          /unavailable/,
        );
      } else {
        assert.equal(view.pinnedMessage?.widget?.id, '00000000-0000-4000-8000-000000000001');
        assert.equal(view.toolEpoch, initial.toolEpoch);
      }
      // A new leased occurrence can still be scheduled and then explicitly closed.
      f.script(owner, async (run) => {
        await callTool(run, 'companion_wake_schedule', timer);
      });
      sessions.followUp(owner, 'Explicit successor review', signal());
      await sessions.idle();
      assert.equal(await sessions.remove(owner), 1);
      now += 60_000;
      await sessions.wakes.tick();
      assert.equal(sessions.has(owner), false);
      assert.equal(f.runs.length, 3);
    });
  }
}

test('reopen reconciles an existing saved wake warning without duplicate paging IDs', async (t) => {
  const f = await harnessFixture(t, {
    configuration: { ...defaultAgentSettings, model: 'configured/one' },
  });
  const owner = f.sessions.start(frame, signal(), 'coding', 'pi');
  f.script(owner, async (run) => {
    await callTool(run, 'companion_wake_schedule', timer);
  });
  await f.sessions.idle();
  const id = f.sessions.wakes.list(owner)[0].id;
  const put = f.sessions.wakes.store.put.bind(f.sessions.wakes.store);
  f.sessions.wakes.store.put = () => {
    throw Error('Synthetic storage fault');
  };
  assert.throws(() => f.sessions.cancelWake(owner, id), /storage fault/);
  f.sessions.wakes.store.put = put;
  await f.sessions.remove(owner);
  await f.sessions.reopen(owner);
  const view = f.view(owner);
  bounded(view);
  assert.equal(view.messages.filter((row) => row.id === 'wake-service-warning').length, 1);
  assert.equal(view.wakes![0].state, 'cancelled');
  assert.equal(f.runs.length, 1);
});
