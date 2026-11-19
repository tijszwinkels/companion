/**
 * Capability boundaries: the phone gateway never receives an application
 * view capability, and agent leases and view capabilities stay scoped to
 * their own conversation and lifetime. Real gateway, desktop socket,
 * AgentSessions, WidgetService and renderer; the model is scripted.
 * Requires Chromium and bwrap.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { widgetTools } from '../../src/agents/widget-tools.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import { applicationFixture } from './fixture.ts';

async function tool(
  lease: { endpoint: string; token: string },
  name: string,
  parameters: Record<string, unknown>,
) {
  const definition = widgetTools(lease.endpoint, lease.token).find((entry) => entry.name === name)!;
  const result = await definition.execute(`call-${Math.random()}`, parameters);
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

test('phone snapshots and patches keep application metadata but never its view capability', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  fixture.sessions.start(frame, signal());
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  await tool(run.request.widgets!, 'companion_app_apply', {
    bundle: 'task-list',
    expectedVersion: 0,
    eventMode: 'next-input',
  });
  run.finish();
  await fixture.sessions.idle();
  const viewUrl = fixture.sessions.snapshot()[0].application!.viewUrl!;
  assert.match(viewUrl, /\/view\/[0-9a-f]{64}$/);
  const capability = viewUrl.slice(-64);

  const { token } = await fixture.pair();
  const phone = await fixture.phone(token);
  const snapshot = await phone.engine('state');
  const application = snapshot.sessions[0].application;
  assert.equal(application.name, 'task-list');
  assert.equal(application.version, 1);
  assert.equal(application.viewUrl, undefined);

  // A user edit on the desktop view publishes a patch; it is redacted too.
  const response = await fetch(viewUrl + '/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_task',
      args: { text: 'From the desktop view' },
      version: 1,
      requestId: 'remote-redaction',
    }),
  });
  assert.equal(response.status, 200);
  const patch = await phone.engine(
    'agent-session',
    (message) => message.session.application?.revision === 2,
  );
  assert.equal(patch.session.application.viewUrl, undefined);
  assert.ok(!JSON.stringify(phone.messages).includes(capability));
});

test('agent leases and views act only on their own conversation and lifetime', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions } = fixture;
  const first = sessions.start(frame, signal());
  const second = sessions.start(frame, signal());
  fixture.script(first, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'task-list',
      expectedVersion: 0,
      initialState: { title: 'First', tasks: [] },
    });
  });
  fixture.script(second, async (turn) => {
    // The second conversation has no application: its tools see none, even
    // while the first conversation has one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inspection = await turn.tool('companion_app');
    assert.equal(inspection.application, null);
  });
  await sessions.idle();

  fixture.script(first, async (turn) => {
    const summary = await turn.tool('companion_app_query', { name: 'summary' });
    assert.equal(summary.result.total, 0);
  });
  sessions.followUp(first, 'Count', signal());
  await sessions.idle();

  // The second conversation cannot address the first one's app: tools take
  // no conversation or application ID, and its own lease sees nothing.
  fixture.script(second, async (turn) => {
    await assert.rejects(turn.tool('companion_app_query', { name: 'summary' }), /no application/);
    await assert.rejects(
      turn.tool('companion_app_call', { action: 'add_task', args: { text: 'x' } }),
      /no application/,
    );
  });
  sessions.followUp(second, 'Try the other app', signal());
  await sessions.idle();
  assert.equal(fixture.view(first).application!.revision, 1);

  // A view capability is only that conversation's, and dies with it.
  const viewUrl = fixture.view(first).application!.viewUrl!;
  const forged = viewUrl.slice(0, -64) + 'f'.repeat(64);
  assert.equal((await fetch(forged + '/state')).status, 404);
  // Host header must be the service itself (DNS-rebinding guard). fetch()
  // cannot override Host, so use a raw request.
  const target = new URL(viewUrl);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: target.port,
        path: target.pathname + '/state',
        headers: { Host: 'attacker.example:' + target.port },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once('error', reject);
    request.end();
  });
  assert.equal(status, 403);
  await sessions.remove(first);
  assert.equal((await fetch(viewUrl + '/state')).status, 404);
});

test('an agent lease stops working when its turn ends', async (context) => {
  const fixture = await remoteFixture();
  context.after(() => fixture.close());
  fixture.sessions.start(frame, signal());
  await waitFor(() => fixture.runs.length === 1);
  const run = fixture.runs[0];
  const lease = run.request.widgets!;
  await tool(lease, 'companion_app_apply', { bundle: 'task-list', expectedVersion: 0 });
  run.finish();
  await fixture.sessions.idle();
  await assert.rejects(tool(lease, 'companion_app_query', { name: 'summary' }), /lease expired/);
  await assert.rejects(
    tool(lease, 'companion_app_apply', { bundle: 'task-board', expectedVersion: 1 }),
    /lease expired/,
  );
  assert.equal(fixture.sessions.snapshot()[0].application!.version, 1);
});
