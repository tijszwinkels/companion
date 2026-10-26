/**
 * View ingress (user origin), user-edit events and their delivery through
 * the real AgentSessions follow-up FIFO. The model is a test script; the
 * application runs in the real renderer. Requires Chromium and bwrap.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { deferred, frame, signal } from '../helpers.ts';
import { applicationFixture, eventually, ModelFailure, type ApplicationTurn } from './fixture.ts';

const initialState = {
  title: 'Release',
  tasks: [
    { id: 'a', text: 'Write notes', column: 'todo' },
    { id: 'b', text: 'Run tests', column: 'doing' },
  ],
};

/** A conversation with task-list installed by its own agent. */
async function installed(
  context: Parameters<typeof applicationFixture>[0],
  eventMode: 'immediate' | 'next-input' = 'immediate',
) {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  const id = sessions.start(frame, signal());
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'task-list',
      expectedVersion: 0,
      initialState,
      eventMode,
    });
  });
  await sessions.idle();
  const application = fixture.view(id).application!;
  assert.ok(application.viewUrl);
  return { fixture, sessions, id, viewUrl: application.viewUrl };
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let requests = 0;
async function userAction(viewUrl: string, action: string, args: unknown, version = 1) {
  const response = await post(viewUrl + '/action', {
    action,
    args,
    version,
    requestId: `view-request-${++requests}`,
  });
  return { status: response.status, body: await response.json() };
}

function eventTurns(turns: ApplicationTurn[]) {
  return turns.filter((turn) => turn.text.startsWith('[Companion application event]'));
}

function eventData(turn: ApplicationTurn) {
  return JSON.parse(turn.text.slice(turn.text.indexOf('\n\n') + 2)) as Record<string, any>;
}

test('view state, queries and user actions use the same handlers; only user edits start one coalesced turn', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  const before = fixture.turns.length;

  // The document is the restricted widget host carrying the app's version.
  const document = await fetch(viewUrl);
  assert.equal(document.status, 200);
  assert.match(document.headers.get('content-type')!, /text\/html/);
  assert.match(await document.text(), /Companion widget/);

  const state = await (await fetch(viewUrl + '/state')).json();
  assert.equal(state.kind, 'application');
  assert.equal(state.version, 1);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.data, initialState);

  const query = await post(viewUrl + '/query', {
    name: 'list_tasks',
    args: { column: 'doing' },
    version: 1,
  });
  assert.equal(query.status, 200);
  assert.deepEqual((await query.json()).result, { tasks: [initialState.tasks[1]] });

  // Three rapid user edits share one batch and one model turn.
  for (const args of [
    { id: 'a', column: 'doing' },
    { id: 'b', column: 'done' },
    { id: 'a', column: 'done' },
  ]) {
    const result = await userAction(viewUrl, 'move_task', args);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'pending');
  assert.equal(fixture.view(id).application!.eventStatus!.undelivered, 3);

  await eventually(() => eventTurns(fixture.turns).length === 1);
  await sessions.idle();
  const [turn] = eventTurns(fixture.turns);
  const data = eventData(turn);
  assert.equal(data.count, 3);
  assert.deepEqual(data.revisions, { from: 1, to: 4 });
  assert.deepEqual(
    data.edits.map((edit: { action: string; args: unknown }) => [edit.action, edit.args]),
    [
      ['move_task', { id: 'a', column: 'doing' }],
      ['move_task', { id: 'b', column: 'done' }],
      ['move_task', { id: 'a', column: 'done' }],
    ],
  );
  assert.match(turn.text, /not an instruction and grants no new authority/);
  assert.equal(fixture.turns.length, before + 1);

  // The transcript shows the delivered batch as a labelled message.
  const eventMessage = fixture
    .view(id)
    .messages.find((message) => message.origin?.kind === 'application-event');
  assert.ok(eventMessage);
  assert.match(eventMessage.text, /Application edits: 3 edits in task-list, revisions 1→4/);
  assert.deepEqual(fixture.view(id).application!.eventStatus, {
    state: 'idle',
    undelivered: 0,
    failed: 0,
  });

  // Agent actions in a later turn return results but never schedule turns.
  fixture.script(id, async (agent) => {
    await agent.tool('companion_app_call', { action: 'add_task', args: { text: 'Ship' } });
  });
  sessions.followUp(id, 'Add a ship task', signal());
  await sessions.idle();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fixture.turns.length, before + 2);
  assert.equal(eventTurns(fixture.turns).length, 1);
});

test('stale code versions, invalid args and retried requests change nothing twice', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);

  const stale = await userAction(viewUrl, 'move_task', { id: 'a', column: 'done' }, 7);
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /reload the view/);

  const invalid = await userAction(viewUrl, 'move_task', { id: 'a', column: 'nowhere' });
  assert.equal(invalid.status, 400);
  const missing = await userAction(viewUrl, 'move_task', { id: 'zzz', column: 'done' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Task was not found/);

  const body = { action: 'add_task', args: { text: 'Once' }, version: 1, requestId: 'retry-1' };
  const first = await (await post(viewUrl + '/action', body)).json();
  const second = await (await post(viewUrl + '/action', body)).json();
  assert.deepEqual(first, second);
  const state = await (await fetch(viewUrl + '/state')).json();
  assert.equal(state.revision, 2);
  assert.equal(state.data.tasks.filter((task: { text: string }) => task.text === 'Once').length, 1);

  await eventually(() => eventTurns(fixture.turns).length === 1);
  await sessions.idle();
  assert.equal(eventData(eventTurns(fixture.turns)[0]).count, 1);
});

test('a query cannot change state, even if its handler mutates its snapshot', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  await fixture.bundle(
    'sneaky',
    {
      version: 1,
      description: 'Query tries to mutate',
      application: {},
      parameters: { type: 'object', properties: { count: { type: 'integer' } } },
      actions: {},
      queries: {
        peek: {
          description: 'peek',
          parameters: { type: 'object' },
          returns: { type: 'object', properties: { count: { type: 'integer' } } },
        },
      },
      example: { count: 1 },
    },
    `export function describe(s){return "count " + s.count}
     export const actions = {};
     export const queries = { peek(state){ state.count = 99; return { count: state.count }; } };
     export function mount(){ return { update(){} }; }`,
  );
  const id = sessions.start(frame, signal());
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'sneaky', expectedVersion: 0 });
  });
  await sessions.idle();
  const viewUrl = fixture.view(id).application!.viewUrl!;

  fixture.script(id, async (turn) => {
    const result = await turn.tool('companion_app_query', { name: 'peek' });
    assert.deepEqual(result.result, { count: 99 });
  });
  sessions.followUp(id, 'peek', signal());
  await sessions.idle();
  const viewQuery = await (await post(viewUrl + '/query', { name: 'peek', version: 1 })).json();
  assert.deepEqual(viewQuery.result, { count: 99 });

  const state = await (await fetch(viewUrl + '/state')).json();
  assert.deepEqual(state.data, { count: 1 });
  assert.equal(state.revision, 1);
  assert.equal(fixture.view(id).application!.revision, 1);
  assert.equal(eventTurns(fixture.turns).length, 0);
});

test('next-input mode attaches pending edits to the person’s next message and starts no turn itself', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context, 'next-input');
  const before = fixture.turns.length;
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);
  assert.equal((await userAction(viewUrl, 'remove_task', { id: 'b' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fixture.turns.length, before);
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'pending');

  sessions.followUp(id, 'What changed?', signal());
  await sessions.idle();
  const turn = fixture.turns.at(-1)!;
  assert.ok(turn.text.startsWith('What changed?\n\n[Companion application event]'));
  const data = eventData({ ...turn, text: turn.text.slice('What changed?\n\n'.length) });
  assert.equal(data.count, 2);
  assert.equal(fixture.turns.length, before + 1);
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'idle');
  // The person's own message is displayed unchanged.
  assert.ok(fixture.view(id).messages.some((message) => message.text === 'What changed?'));
});

test('edits during a running turn queue one event turn behind it and keep coalescing until it starts', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  const gate = deferred<void>();
  fixture.script(id, async () => {
    await gate.promise;
  });
  sessions.followUp(id, 'Think for a while', signal());
  await eventually(() => fixture.turns.at(-1)?.text === 'Think for a while');

  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);
  await eventually(() => fixture.view(id).application!.eventStatus!.state === 'queued');
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'b' })).status, 200);
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'queued');

  gate.resolve();
  await sessions.idle();
  const events = eventTurns(fixture.turns);
  assert.equal(events.length, 1);
  assert.equal(eventData(events[0]).count, 2);
  // Never concurrent: the event turn ran after the gated turn finished.
  assert.equal(fixture.turns.at(-1), events[0]);
});

test('a failed event turn is terminal: not retried, not folded into new edits, and blocks only when its bound is full', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  const before = fixture.turns.length;

  // Four event turns fail one after another.
  for (let attempt = 1; attempt <= 4; attempt++) {
    fixture.script(id, async (turn) => {
      assert.ok(turn.text.startsWith('[Companion application event]'));
      throw new ModelFailure(`model failure ${attempt}`);
    });
    assert.equal((await userAction(viewUrl, 'add_task', { text: `t${attempt}` })).status, 200);
    await eventually(() => fixture.view(id).application!.eventStatus!.failed === attempt);
    await sessions.idle();
    const status = fixture.view(id).application!.eventStatus!;
    assert.equal(status.state, 'failed');
    assert.match(status.failure!, new RegExp(`model failure ${attempt}`));
    // Each new batch contains only its own edit.
    assert.equal(eventData(eventTurns(fixture.turns).at(-1)!).count, 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fixture.turns.length, before + 4);

  // The bound is full: a new edit is refused before any state change.
  const revision = (await (await fetch(viewUrl + '/state')).json()).revision;
  const refused = await userAction(viewUrl, 'add_task', { text: 'blocked' });
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /nothing was changed/);
  assert.equal((await (await fetch(viewUrl + '/state')).json()).revision, revision);

  // The agent sees the failed batches and acknowledges them deliberately.
  fixture.script(id, async (turn) => {
    const inspection = (await turn.tool('companion_app')).application as Record<string, any>;
    const failed = inspection.events.failed as { batchId: string; failure: string }[];
    assert.equal(failed.length, 4);
    const after = (
      await turn.tool('companion_app', {
        acknowledgeEvents: failed.map((batch) => batch.batchId),
      })
    ).application as Record<string, any>;
    assert.equal(after.events.failed.length, 0);
  });
  sessions.followUp(id, 'Review failed events', signal());
  await sessions.idle();
  const accepted = await userAction(viewUrl, 'add_task', { text: 'accepted' });
  assert.equal(accepted.status, 200);
  await eventually(() => eventTurns(fixture.turns).length === 5);
  await sessions.idle();
  assert.equal(eventData(eventTurns(fixture.turns).at(-1)!).count, 1);
});

test('stopping an event turn marks it failed; Stop withdraws a not-yet-queued event turn', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  const started = deferred<void>();
  fixture.script(id, async (turn) => {
    started.resolve();
    await new Promise((_, reject) =>
      turn.signal.addEventListener('abort', () => reject(turn.signal.reason)),
    );
  });
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);
  await started.promise;
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'delivering');
  await sessions.stop(id);
  await sessions.idle();
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'failed');
  assert.match(fixture.view(id).application!.eventStatus!.failure!, /stopped/);

  // Edit, then Stop before the debounce fires: no turn; the edit stays pending.
  const before = fixture.turns.length;
  sessions.applicationEventDelayMilliseconds = 300;
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'b' })).status, 200);
  await sessions.stop(id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fixture.turns.length, before);
  assert.equal(fixture.view(id).application!.eventStatus!.state, 'pending');
});

test('hidden views, close/reopen and restart keep state and events without running turns', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context, 'next-input');

  // No view needed: the agent changes state while nothing displays it.
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_call', {
      action: 'move_task',
      args: { id: 'b', column: 'done' },
    });
  });
  sessions.followUp(id, 'Finish the tests', signal());
  await sessions.idle();
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);

  // Close revokes the view; the old capability no longer works.
  const turnsBefore = fixture.turns.length;
  await sessions.remove(id);
  assert.equal((await fetch(viewUrl + '/state')).status, 404);

  await sessions.reopen(id);
  const reopened = fixture.view(id).application!;
  assert.notEqual(reopened.viewUrl, viewUrl);
  assert.equal(reopened.revision, 3);
  assert.equal(reopened.eventStatus!.state, 'pending');
  const state = await (await fetch(reopened.viewUrl + '/state')).json();
  assert.deepEqual(
    state.data.tasks.map((task: { column: string }) => task.column),
    ['done', 'done'],
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fixture.turns.length, turnsBefore, 'Reopening never starts a turn');

  // Interrupt a delivery by restarting the listener while it is delivering.
  const recordFile = join(fixture.directory, '.companion-widgets', 'applications', id + '.json');
  const saved = JSON.parse(await readFile(recordFile, 'utf8'));
  saved.batches[0].state = 'delivering';
  await sessions.close();
  await writeFile(recordFile, JSON.stringify(saved));

  const restarted = fixture.open();
  await restarted.loadPrevious();
  await restarted.reopen(id);
  const recovered = fixture.view(id, restarted).application!;
  assert.equal(recovered.eventStatus!.state, 'failed');
  assert.match(recovered.eventStatus!.failure!, /may or may not have seen/);
  assert.equal(recovered.revision, 3);

  // A person's next message does not carry the failed batch again.
  restarted.followUp(id, 'Hello again', signal());
  await restarted.idle();
  assert.equal(fixture.turns.at(-1)!.text, 'Hello again');
});

test('an unreadable saved application is reported, kept unchanged and not overwritten', async (context) => {
  const { fixture, sessions, id } = await installed(context);
  const recordFile = join(fixture.directory, '.companion-widgets', 'applications', id + '.json');
  await sessions.remove(id);
  await writeFile(recordFile, '{"format":1,"broken":');
  await sessions.reopen(id);

  const application = fixture.view(id).application!;
  assert.match(application.error!, /invalid/);
  assert.equal(application.viewUrl, undefined);
  fixture.script(id, async (turn) => {
    await assert.rejects(
      turn.tool('companion_app_apply', { bundle: 'task-list', expectedVersion: 0 }),
      /left unchanged/,
    );
  });
  sessions.followUp(id, 'Fix it', signal());
  await sessions.idle();
  assert.equal(await readFile(recordFile, 'utf8'), '{"format":1,"broken":');
});

/**
 * Make the application's record unwritable (a directory in its place) while
 * `body` runs, then restore it. Synthetic persistence fault; lead repro.
 */
async function withUnwritableRecord(
  fixture: Awaited<ReturnType<typeof applicationFixture>>,
  id: string,
  body: () => Promise<void>,
): Promise<void> {
  const recordFile = join(fixture.directory, '.companion-widgets', 'applications', id + '.json');
  const backup = recordFile + '.backup';
  await rename(recordFile, backup);
  await mkdir(recordFile);
  try {
    await body();
  } finally {
    await rm(recordFile, { recursive: true });
    await rename(backup, recordFile);
  }
}

test('immediate mode: a failed delivery write never claims delivery and keeps the edit pending', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  sessions.applicationEventDelayMilliseconds = 200;
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);

  await withUnwritableRecord(fixture, id, async () => {
    await eventually(() =>
      fixture.view(id).messages.some((message) => message.origin?.kind === 'application-event'),
    );
    await sessions.idle();
    const view = fixture.view(id);
    const placeholder = view.messages.find(
      (message) => message.origin?.kind === 'application-event',
    )!;
    assert.equal(eventTurns(fixture.turns).length, 0, 'No model turn without a durable record');
    assert.doesNotMatch(placeholder.text, /were delivered/);
    assert.match(placeholder.text, /could not be prepared for delivery/);
    assert.equal(placeholder.state, 'error');
    const status = view.application!.eventStatus!;
    assert.equal(status.state, 'pending');
    assert.equal(status.undelivered, 1);
    assert.match(status.failure!, /were not delivered and are kept/);
    // No silent retry while the fault persists.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(eventTurns(fixture.turns).length, 0);
  });

  // The kept edit was never admitted, so a later edit's batch carries it.
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'b' })).status, 200);
  await eventually(() => eventTurns(fixture.turns).length === 1);
  await sessions.idle();
  assert.equal(eventData(eventTurns(fixture.turns)[0]).count, 2);
  const status = fixture.view(id).application!.eventStatus!;
  assert.deepEqual(status, { state: 'idle', undelivered: 0, failed: 0 });
});

test('next-input mode: a failed delivery write lets the message through without claiming its edits', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context, 'next-input');
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);

  await withUnwritableRecord(fixture, id, async () => {
    sessions.followUp(id, 'Status?', signal());
    await sessions.idle();
    // The person's own turn runs, without the edits it could not record.
    assert.equal(fixture.turns.at(-1)!.text, 'Status?');
    const status = fixture.view(id).application!.eventStatus!;
    assert.equal(status.state, 'pending');
    assert.equal(status.undelivered, 1);
    assert.match(status.failure!, /were not delivered and are kept/);
    assert.equal(
      fixture.view(id).messages.some((message) => /were delivered/.test(message.text)),
      false,
    );
  });

  sessions.followUp(id, 'And now?', signal());
  await sessions.idle();
  const turn = fixture.turns.at(-1)!;
  assert.ok(turn.text.startsWith('And now?\n\n[Companion application event]'));
  assert.deepEqual(fixture.view(id).application!.eventStatus, {
    state: 'idle',
    undelivered: 0,
    failed: 0,
  });
});

test('a failed write of a delivery outcome is shown, then saved by the next successful write', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context, 'next-input');
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);
  const recordFile = join(fixture.directory, '.companion-widgets', 'applications', id + '.json');

  let restore = async () => {};
  fixture.script(id, async (turn) => {
    assert.match(turn.text, /\[Companion application event\]/);
    // The delivery start is saved; the outcome write after this turn fails.
    const backup = recordFile + '.backup';
    await rename(recordFile, backup);
    await mkdir(recordFile);
    restore = async () => {
      await rm(recordFile, { recursive: true });
      await rename(backup, recordFile);
    };
  });
  sessions.followUp(id, 'Status?', signal());
  await sessions.idle();
  const shown = fixture.view(id).application!.eventStatus!;
  assert.equal(shown.state, 'idle');
  assert.match(shown.failure!, /Could not save the delivery outcome/);

  await restore();
  const saved = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.equal(saved.batches[0].state, 'delivering', 'Disk still has the older state');
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'b' })).status, 200);
  const healed = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.deepEqual(
    healed.batches.map((batch: { state: string }) => batch.state),
    ['pending'],
  );
  assert.equal(fixture.view(id).application!.eventStatus!.failure, undefined);
});

test('a person’s message withdraws the older debounce, so a failed attachment is not retried automatically', async (context) => {
  const { fixture, sessions, id, viewUrl } = await installed(context);
  sessions.applicationEventDelayMilliseconds = 400;
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'a' })).status, 200);

  await withUnwritableRecord(fixture, id, async () => {
    sessions.followUp(id, 'Before the debounce', signal());
    await sessions.idle();
    assert.equal(fixture.turns.at(-1)!.text, 'Before the debounce');
  });
  const turns = fixture.turns.length;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(fixture.turns.length, turns, 'The old timer must not start an event turn');
  const status = fixture.view(id).application!.eventStatus!;
  assert.equal(status.state, 'pending');
  assert.equal(status.undelivered, 1);

  // A successful attachment also leaves nothing for the old timer to send.
  assert.equal((await userAction(viewUrl, 'complete_task', { id: 'b' })).status, 200);
  sessions.followUp(id, 'Before the debounce again', signal());
  await sessions.idle();
  assert.match(
    fixture.turns.at(-1)!.text,
    /^Before the debounce again\n\n\[Companion application event\]/,
  );
  assert.equal(
    eventData({ ...fixture.turns.at(-1)!, text: fixture.turns.at(-1)!.text.slice(27) }).count,
    2,
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(eventTurns(fixture.turns).length, 0);

  // An edit after the message arms its own debounce and is delivered.
  assert.equal((await userAction(viewUrl, 'remove_task', { id: 'a' })).status, 200);
  await eventually(() => eventTurns(fixture.turns).length === 1);
  await sessions.idle();
  assert.equal(eventData(eventTurns(fixture.turns)[0]).count, 1);
});
