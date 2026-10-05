import assert from 'node:assert/strict';
import test from 'node:test';

import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';

/** Real gateway/listener, disposable sessions and an immediately completing backend. */
test('phones share the sixteen-tab cap without taking desktop navigation ownership', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const { sessions, desktop } = fixture;

  // Keep a saved conversation to exercise reopen admission at the same cap.
  const previousId = sessions.start({ ...frame, utterance: 'Saved fixture' }, signal());
  await waitFor(() => sessions.interaction(previousId).agentAcceptsFollowUp);
  await sessions.remove(previousId);

  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  await phone.engine('state');
  const ids: string[] = [];
  for (let number = 1; number <= 16; number++) {
    const requestId = `start-${number}`;
    phone.send({
      action: 'start-agent',
      text: `Phone fixture ${number}`,
      profile: 'coding',
      requestId,
    });
    const reply = await phone.reply(requestId);
    assert.equal(reply.type, 'result', JSON.stringify(reply));
    assert.ok(reply.type === 'result');
    const result = reply.result as { id: string; outcome: string };
    assert.equal(result.outcome, 'started');
    ids.push(result.id);
    await waitFor(() => sessions.interaction(result.id).agentAcceptsFollowUp);
  }
  assert.equal(sessions.snapshot().length, 16);
  assert.ok(sessions.snapshot().every((session) => session.openInBackground));

  desktop.send({
    action: 'panel-state',
    id: ids[0],
    composerFocused: true,
    visible: true,
    navigationToken: 'desktop-sixteen',
  });
  await desktop.reply('panel-state');
  const activity = desktop.runtime.activity;
  const captured = activity.interactionContext!();
  assert.deepEqual(captured.agentNavigation?.ids, ids);

  phone.send({ action: 'panel-state', id: ids[15], requestId: 'select-last' });
  assert.equal((await phone.reply('select-last')).type, 'result');
  assert.deepEqual(activity.interactionContext!(), captured);
  assert.equal(activity.selectSession!(captured, 15), true);
  await waitFor(() =>
    desktop.messages.some((message) => message.type === 'agent-select' && message.id === ids[15]),
  );
  assert.equal(activity.selectSession!(captured, 16), false);

  // Both create and reopen enforce the shared limit, with no partial admission.
  for (const request of [
    {
      action: 'start-agent',
      text: 'Seventeenth fixture',
      profile: 'coding',
      requestId: 'overflow',
    },
    { action: 'reopen-agent', id: previousId, requestId: 'reopen-full' },
  ]) {
    phone.send(request);
    const reply = await phone.reply(request.requestId);
    assert.equal(reply.type, 'error');
    assert.ok(reply.type === 'error');
    assert.match(reply.message, /16 tabs maximum/);
    assert.equal(sessions.snapshot().length, 16);
    assert.deepEqual(activity.interactionContext!(), captured);
  }

  phone.send({ action: 'close-agent', id: ids[15], requestId: 'close-last' });
  assert.equal((await phone.reply('close-last')).type, 'result');
  phone.send({ action: 'reopen-agent', id: previousId, requestId: 'reopen-free' });
  assert.equal((await phone.reply('reopen-free')).type, 'result');
  assert.equal(sessions.snapshot().length, 16);
  assert.equal(
    sessions.snapshot().find((session) => session.id === previousId)?.openInBackground,
    true,
  );
  assert.equal(activity.interactionContext!().agentSessionId, ids[0]);
  assert.equal(activity.interactionContext!().agentComposerFocused, true);
  // Closing/reopening changes the tab order: an old spoken position is stale.
  assert.equal(activity.selectSession!(captured, 15), false);
});
