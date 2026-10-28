/** Real capability/FIFO lifecycle. Only scripted agents and temporary state are used. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { WidgetService } from '../../src/widgets/service.ts';
import { deferred, signal } from '../helpers.ts';
import { ModelFailure } from './fixture.ts';
import { sendFixture, waitForRelease } from './chat-send-fixture.ts';

async function receipt(
  fixture: Awaited<ReturnType<typeof sendFixture>>,
  command: ReturnType<Awaited<ReturnType<typeof sendFixture>>['command']>,
) {
  const { text: _text, ...lookup } = command;
  const response = await fixture.post('chat-receipt', lookup);
  assert.equal(response.status, 200);
  return (await response.json()).receipt;
}

test('sending needs its own grant; exact retries never start a second turn and metadata is host-owned', async (context) => {
  const f = await sendFixture(context);
  const { sessions, id } = f;
  const before = f.turns.length;
  assert.equal((await f.post('chat-send', f.command())).status, 403);
  await sessions.setApplicationChatRead(id, f.permission(true));
  assert.equal((await f.post('chat-send', f.command())).status, 403);
  await f.grant();
  assert.equal(f.turns.length, before, 'Neither consent starts a turn');
  const grant = f.application().chatAccess!.send!;
  const stateChange = await f.post('action', {
    version: 1,
    action: 'add_task',
    args: { text: 'Synthetic pending edit' },
    requestId: randomUUID(),
  });
  assert.equal(stateChange.status, 200);
  assert.deepEqual(
    f.application().chatAccess!.send,
    grant,
    'State edits do not rotate or replenish a grant',
  );
  const command = f.command();
  for (const extra of [
    { origin: { kind: 'human' } },
    { applicationId: randomUUID() },
    { receiptId: randomUUID() },
    { owner: randomUUID() },
  ]) {
    assert.equal((await f.post('chat-send', { ...command, ...extra })).status, 400);
  }
  assert.equal(f.application().chatAccess!.send!.remaining, 5);
  assert.equal((await f.post('chat-send', command)).status, 200);
  await sessions.idle();
  const done = await receipt(f, command);
  assert.equal(done.state, 'completed');
  assert.equal(done.applicationId, f.application().id);
  assert.equal(done.name, 'task-list');
  assert.match(done.bundle, /^[0-9a-f]{64}$/);
  assert.equal(f.application().chatAccess!.send!.remaining, 4);
  assert.equal(f.application().chatAccess!.send!.busy, false);
  const applicationFile = await readFile(
    join(f.directory, '.companion-widgets', 'applications', id + '.json'),
    'utf8',
  );
  const sessionFile = await readFile(
    join(f.directory, '.companion-sessions', id + '.json'),
    'utf8',
  );
  assert.doesNotMatch(applicationFile + sessionFile, /grantId|chatAccess|chatSend/);
  assert.deepEqual((await (await f.post('chat-send', command)).json()).receipt, done);
  assert.equal(f.turns.length, before + 1);
  assert.equal((await f.post('chat-send', { ...command, text: 'Different' })).status, 409);
  assert.equal((await f.post('chat-send', f.command())).status, 429);
  await f.grant(false);
  assert.equal(f.application().chatAccess!.read, true, 'Send revoke does not revoke reading');
  assert.deepEqual((await (await f.post('chat-send', command)).json()).receipt, done);
  assert.equal((await f.post('chat-send', f.command())).status, 403);
  assert.equal(await receipt(f, { ...command, requestId: randomUUID() }), null);
});

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: revoke at the last pre-model wait skips only the app message and preserves human FIFO`, async (context) => {
    const f = await sendFixture(context, harness);
    const { sessions, id } = f;
    await f.grant();
    const widgets = (sessions as unknown as { widgets: WidgetService }).widgets;
    const original = widgets.lease.bind(widgets);
    const entered = deferred<void>();
    const release = deferred<void>();
    context.after(() => release.resolve());
    let gated = false;
    widgets.lease = async (...args) => {
      if (!gated) {
        gated = true;
        entered.resolve();
        await waitForRelease(release, args[1]);
      }
      return original(...args);
    };
    const before = f.turns.length;
    let completions = 0;
    const unsubscribe = sessions.subscribe((event) => {
      if (event.type === 'agent-turn-completed') completions++;
    });
    context.after(unsubscribe);
    const command = f.command('Must not reach the model');
    assert.equal((await f.post('chat-send', command)).status, 200);
    await entered.promise;
    assert.equal((await receipt(f, command)).state, 'queued');
    f.script(id, async (turn) => assert.equal(turn.text, 'Preserved human input'));
    sessions.followUp(id, 'Preserved human input', signal());
    await f.grant(false);
    assert.equal((await receipt(f, command)).state, 'cancelled');
    release.resolve();
    await sessions.idle();
    assert.equal(f.turns.length, before + 1);
    assert.equal(completions, 1, 'Skipped app input is not a successful model turn');
    assert.equal(
      f.view(id).messages.find((row) => row.origin?.kind === 'application-message')!.state,
      'error',
    );
  });

  test(`${harness}: Stop revokes a running send and leaves a terminal, non-replayable receipt`, async (context) => {
    const f = await sendFixture(context, harness);
    const { sessions, id } = f;
    await f.grant();
    const entered = deferred<void>();
    f.script(id, async (turn) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        turn.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const command = f.command();
    assert.equal((await f.post('chat-send', command)).status, 200);
    await entered.promise;
    assert.equal((await receipt(f, command)).state, 'running');
    await sessions.stop(id);
    assert.equal((await receipt(f, command)).state, 'cancelled');
    assert.equal(f.application().chatAccess!.send!.allowed, false);
    assert.equal(f.application().chatAccess!.send!.busy, false);
    const before = f.turns.length;
    assert.equal((await f.post('chat-send', command)).status, 200);
    assert.equal(f.turns.length, before);
    assert.equal((await f.post('chat-send', f.command())).status, 403);
  });
}

test('successful replacement withdraws queued app sends without withdrawing human inputs', async (context) => {
  const f = await sendFixture(context);
  const { sessions, id } = f;
  await f.grant();
  const started = deferred<void>();
  const replace = deferred<void>();
  f.script(id, async (turn) => {
    started.resolve();
    await waitForRelease(replace, turn.signal);
    await turn.tool('companion_app_apply', { bundle: 'task-list', expectedVersion: 1 });
  });
  sessions.followUp(id, 'Replace when released', signal());
  await started.promise;
  const command = f.command('Withdraw this queued app input');
  assert.equal((await f.post('chat-send', command)).status, 200);
  f.script(id, async (turn) => assert.equal(turn.text, 'Keep human successor'));
  sessions.followUp(id, 'Keep human successor', signal());
  replace.resolve();
  await sessions.idle();
  assert.equal(f.application().version, 2);
  assert.equal(f.application().chatAccess!.send!.allowed, false);
  assert.equal(f.application().chatAccess!.send!.busy, false);
  assert.equal((await f.post('chat-send', command)).status, 409);
  assert.equal(
    f.view(id).messages.find((row) => row.origin?.kind === 'application-message')!.state,
    'error',
  );
});

test('an app turn replacing its own code retains the old running busy slot until completion', async (context) => {
  const f = await sendFixture(context);
  await f.grant();
  const replaced = deferred<void>();
  const release = deferred<void>();
  f.script(f.id, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'task-list', expectedVersion: 1 });
    replaced.resolve();
    await waitForRelease(release, turn.signal);
  });
  assert.equal((await f.post('chat-send', f.command())).status, 200);
  await replaced.promise;
  assert.equal(f.application().chatAccess!.send!.allowed, false);
  assert.equal(f.application().chatAccess!.send!.busy, true);
  await f.grant();
  assert.equal((await f.post('chat-send', f.command())).status, 409);
  release.resolve();
  await f.sessions.idle();
  assert.equal(f.application().chatAccess!.send!.busy, false);
  assert.equal(f.application().chatAccess!.send!.remaining, 5);
});

test('model failure is terminal and an exact retry does not refund quota or execute again', async (context) => {
  const f = await sendFixture(context);
  await f.grant();
  f.script(f.id, async () => {
    throw new ModelFailure('Synthetic model failure');
  });
  const command = f.command();
  assert.equal((await f.post('chat-send', command)).status, 200);
  await f.sessions.idle();
  assert.equal((await receipt(f, command)).state, 'failed');
  assert.equal(f.application().chatAccess!.send!.remaining, 4);
  const before = f.turns.length;
  assert.equal((await f.post('chat-send', command)).status, 200);
  assert.equal(f.turns.length, before);
});

for (const ending of ['stop', 'failure'] as const) {
  test(`preceding ${ending} cancels a queued app receipt without executing it`, async (context) => {
    const f = await sendFixture(context);
    await f.grant();
    const entered = deferred<void>();
    const release = deferred<void>();
    f.script(f.id, async (turn) => {
      entered.resolve();
      await waitForRelease(release, turn.signal);
      if (ending === 'failure') throw new ModelFailure('Synthetic preceding failure');
    });
    f.sessions.followUp(f.id, 'Held preceding turn', signal());
    await entered.promise;
    const command = f.command();
    assert.equal((await f.post('chat-send', command)).status, 200);
    assert.equal((await receipt(f, command)).state, 'queued');
    if (ending === 'stop') await f.sessions.stop(f.id);
    else {
      release.resolve();
      await f.sessions.idle();
    }
    assert.equal((await receipt(f, command)).state, 'cancelled');
    assert.equal(f.application().chatAccess!.send!.remaining, ending === 'stop' ? 0 : 4);
    assert.equal(f.application().chatAccess!.send!.busy, false);
    assert.ok(!f.turns.some((turn) => turn.text.startsWith('[Companion application message]')));
  });
}

test('oversized HTTP input and malformed receipt probes cannot consume a send slot', async (context) => {
  const f = await sendFixture(context);
  await f.grant();
  const command = f.command();
  let refused = false;
  try {
    const response = await fetch(f.application().viewUrl + '/chat-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ' '.repeat(32 * 1024) + JSON.stringify(command),
    });
    refused = response.status !== 200;
  } catch {
    refused = true;
  } // The stream may close once its fixed byte limit is reached.
  assert.ok(refused);
  for (const body of [
    {},
    { version: 1, grantId: command.grantId, requestId: command.requestId, text: 'not a send' },
    { version: 1, grantId: 'bad', requestId: command.requestId },
  ]) {
    assert.equal((await f.post('chat-receipt', body)).status, 400);
  }
  assert.equal(f.application().chatAccess!.send!.remaining, 5);
  assert.equal(f.turns.length, 1);
});

test('closing/reopening forgets grants and receipts without replaying canonical app messages', async (context) => {
  const f = await sendFixture(context);
  await f.grant();
  const command = f.command();
  const oldUrl = f.application().viewUrl!;
  assert.equal((await f.post('chat-send', command)).status, 200);
  await f.sessions.idle();
  await f.sessions.remove(f.id);
  await f.sessions.reopen(f.id);
  const before = f.turns.length;
  assert.equal(f.application().chatAccess!.send!.allowed, false);
  assert.equal((await f.post('chat-send', command, oldUrl)).status, 404);
  assert.equal((await f.post('chat-send', command)).status, 403);
  assert.equal(
    await receipt(f, command),
    null,
    'Receipt absence is uncertain, not proof of not-sent',
  );
  assert.equal(f.turns.length, before);
  assert.ok(f.view(f.id).messages.some((row) => row.origin?.kind === 'application-message'));
});
