import assert from 'node:assert/strict';
import test from 'node:test';
import { widgetTools } from '../../src/agents/widget-tools.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';

/** A temporary loopback gateway, not the user's held phone service. */
test('phone snapshots and patches omit application chat permission controls and their epochs', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  fixture.sessions.start(frame, signal());
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  const lease = run.request.widgets!;
  const apply = widgetTools(lease.endpoint, lease.token).find(
    (tool) => tool.name === 'companion_app_apply',
  )!;
  await apply.execute('synthetic-apply', {
    bundle: 'task-list',
    expectedVersion: 0,
    eventMode: 'next-input',
  });
  run.finish();
  await fixture.sessions.idle();
  const application = fixture.sessions.snapshot()[0].application!;
  assert.ok(application.chatAccess?.revision);
  const epoch = application.chatAccess.revision;
  const capability = application.viewUrl!.slice(-64);

  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state');
  assert.equal(snapshot.sessions[0].application.chatAccess, undefined);
  assert.equal(snapshot.sessions[0].application.viewUrl, undefined);

  const response = await fetch(application.viewUrl + '/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_task',
      args: { text: 'Synthetic task' },
      version: 1,
      requestId: 'synthetic-edit',
    }),
  });
  assert.equal(response.status, 200);
  const patch = await phone.engine(
    'agent-session',
    (message) => message.session.application?.revision === 2,
  );
  assert.equal(patch.session.application.chatAccess, undefined);
  assert.equal(patch.session.application.viewUrl, undefined);
  assert.ok(!JSON.stringify(phone.messages).includes(epoch));
  assert.ok(!JSON.stringify(phone.messages).includes(capability));
});
