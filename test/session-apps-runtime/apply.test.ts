/**
 * Chat → authored application → different authored code, through real
 * AgentSessions turns, real agent tool definitions and the real renderer.
 * The model is a test script (see fixture.ts). Requires Chromium and bwrap.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { frame, signal } from '../helpers.ts';
import { applicationFixture } from './fixture.ts';

const initialState = {
  title: 'Release',
  tasks: [
    { id: 'a', text: 'Write notes', column: 'todo' },
    { id: 'b', text: 'Run tests', column: 'doing' },
  ],
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('Expected the tool call to be refused');
}

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: the session's own agent replaces chat with an app, then with different code, keeping identity, history and state`, async (context) => {
    const fixture = await applicationFixture(context);
    const { sessions } = fixture;
    const id = sessions.start(frame, signal(), 'coding', harness);
    await sessions.idle();

    // Ordinary chat first: no application.
    assert.equal(fixture.view(id).application, undefined);
    const firstMessages = fixture.view(id).messages.map((message) => message.id);

    // Turn 2: discover and install task-list. The lease of this turn was
    // issued with no application, so its queries are not callable yet.
    fixture.script(id, async (turn) => {
      for (const name of [
        'companion_app',
        'companion_app_apply',
        'companion_app_query',
        'companion_app_call',
      ]) {
        assert.ok(turn.toolNames.includes(name), `${harness} exposes ${name}`);
      }
      const inspection = await turn.tool('companion_app');
      assert.equal(inspection.application, null);
      const library = (inspection.library as { name: string }[]).map((entry) => entry.name);
      assert.deepEqual(library, ['task-board', 'task-list']);

      const applied = await turn.tool('companion_app_apply', {
        bundle: 'task-list',
        expectedVersion: 0,
        initialState,
      });
      assert.equal(applied.version, 1);
      assert.equal(applied.revision, 1);
      assert.match(
        await refusal(turn.tool('companion_app_query', { name: 'summary' })),
        /no application when this turn started/,
      );
    });
    sessions.followUp(id, 'Make this a task list', signal());
    await sessions.idle();

    const installed = fixture.view(id).application;
    assert.ok(installed);
    assert.equal(installed.name, 'task-list');
    assert.equal(installed.version, 1);
    assert.equal(installed.revision, 1);
    assert.match(installed.viewUrl!, /^http:\/\/127\.0\.0\.1:\d+\/view\/[0-9a-f]{64}$/);
    assert.match(installed.text, /Release: 2 tasks/);
    // Same conversation: original messages are still there, no new session.
    assert.equal(sessions.snapshot().length, 1);
    for (const message of firstMessages) {
      assert.ok(fixture.view(id).messages.some((entry) => entry.id === message));
    }
    const turnsBefore = fixture.turns.length;

    // Turn 3: queries and a targeted action; then replace the code.
    fixture.script(id, async (turn) => {
      const summary = await turn.tool('companion_app_query', { name: 'summary' });
      assert.deepEqual(summary.result, { todo: 1, doing: 1, done: 0, total: 2 });

      const moved = await turn.tool('companion_app_call', {
        action: 'move_task',
        args: { id: 'a', column: 'done' },
      });
      assert.equal(moved.revision, 2);

      // A stale expectedVersion is refused without change.
      assert.match(
        await refusal(
          turn.tool('companion_app_apply', { bundle: 'task-board', expectedVersion: 0 }),
        ),
        /Expected application version 0, but it is 1/,
      );
      // Replacement keeps state; initialState is refused.
      assert.match(
        await refusal(
          turn.tool('companion_app_apply', {
            bundle: 'task-board',
            expectedVersion: 1,
            initialState,
          }),
        ),
        /keeps its existing state/,
      );

      const replaced = await turn.tool('companion_app_apply', {
        bundle: 'task-board',
        expectedVersion: 1,
      });
      assert.equal(replaced.version, 2);
      assert.equal(replaced.revision, 2);
      assert.ok((replaced.actions as string[]).includes('rename_task'));

      // The lease froze version 1: old and new names fail, even when the
      // call names the successor version explicitly.
      for (const call of [
        turn.tool('companion_app_query', { name: 'summary' }),
        turn.tool('companion_app_query', { name: 'summary', version: 2 }),
        turn.tool('companion_app_call', { action: 'rename_task', args: { id: 'b', text: 'x' } }),
        turn.tool('companion_app_call', {
          action: 'rename_task',
          args: { id: 'b', text: 'x' },
          version: 2,
        }),
      ]) {
        assert.match(await refusal(call), /changed during this turn \(version 1 → 2\)/);
      }
      // Management inspection still reports the new code, but not as callable.
      const inspection = (await turn.tool('companion_app')).application as Record<string, unknown>;
      assert.equal(inspection.version, 2);
      assert.deepEqual((inspection.thisTurn as Record<string, unknown>).callableVersion, 1);
    });
    sessions.followUp(id, 'Turn it into a board', signal());
    await sessions.idle();

    // Agent edits and code replacement never start turns themselves.
    assert.equal(fixture.turns.length, turnsBefore + 1);
    const board = fixture.view(id).application!;
    assert.equal(board.name, 'task-board');
    assert.equal(board.version, 2);
    assert.equal(board.revision, 2);
    assert.equal(board.id, installed.id);
    assert.equal(board.viewUrl, installed.viewUrl);
    assert.match(board.text, /Done \(1\): Write notes/);

    // Turn 4: the next lease uses the new code and its new names.
    fixture.script(id, async (turn) => {
      const renamed = await turn.tool('companion_app_call', {
        action: 'rename_task',
        args: { id: 'b', text: 'Run all tests' },
        version: 2,
      });
      assert.equal(renamed.revision, 3);
      const task = await turn.tool('companion_app_query', { name: 'get_task', args: { id: 'b' } });
      assert.deepEqual(task.result, { task: { id: 'b', text: 'Run all tests', column: 'doing' } });
      const inspection = (await turn.tool('companion_app', { state: true })).application as Record<
        string,
        unknown
      >;
      assert.deepEqual((inspection.state as Record<string, unknown>).revision, 3);
    });
    sessions.followUp(id, 'Rename the test task', signal());
    await sessions.idle();
    assert.equal(fixture.view(id).application!.revision, 3);
  });
}

test('incompatible, broken and non-application bundles are refused without changing the installed app', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  const id = sessions.start(frame, signal());
  await sessions.idle();

  const base = {
    version: 1,
    description: 'Synthetic test bundle',
    application: {},
    actions: {},
    queries: {},
    example: {},
  };
  // Requires a field the task state does not have.
  await fixture.bundle(
    'needs-owner',
    {
      ...base,
      parameters: {
        type: 'object',
        properties: { owner: { type: 'string' } },
        required: ['owner'],
      },
    },
    'export function describe(){return "x"} export function mount(){return {update(){}}}',
  );
  // Declares a query it does not implement.
  await fixture.bundle(
    'missing-query',
    {
      ...base,
      parameters: { type: 'object' },
      queries: {
        count: { description: 'n', parameters: { type: 'object' }, returns: { type: 'object' } },
      },
    },
    'export function describe(){return "x"} export function mount(){return {update(){}}}',
  );
  // Throws while loading.
  await fixture.bundle(
    'throws',
    { ...base, parameters: { type: 'object' } },
    'throw new Error("boom");',
  );
  // An ordinary widget, not an application.
  await fixture.bundle(
    'plain-widget',
    { version: 1, description: 'w', parameters: { type: 'object' }, actions: {}, example: {} },
    'export function describe(){return "x"} export function mount(){return {update(){}}}',
  );

  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'task-list',
      expectedVersion: 0,
      initialState,
    });
    for (const [bundle, pattern] of [
      ['needs-owner', /does not accept the existing state/],
      ['missing-query', /does not implement: count/],
      ['throws', /failed to load/],
      ['plain-widget', /not an application/],
    ] as const) {
      await assert.rejects(
        turn.tool('companion_app_apply', { bundle, expectedVersion: 1 }),
        pattern,
      );
    }
  });
  sessions.followUp(id, 'Try some bundles', signal());
  await sessions.idle();

  const application = fixture.view(id).application!;
  assert.equal(application.name, 'task-list');
  assert.equal(application.version, 1);
  assert.equal(application.revision, 1);
  const state = await (await fetch(application.viewUrl + '/state')).json();
  assert.deepEqual(state.data, initialState);
});
