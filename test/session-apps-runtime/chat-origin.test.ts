/** Internal origin seam only: the public app-send route is not wired by this checkpoint. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { applicationMessageOrigin } from '../../src/agents/application-message-origin.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { applicationFixture } from './fixture.ts';

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: queued app-origin input reaches the harness with provenance and preserves next-input edits`, async (context) => {
    const fixture = await applicationFixture(context);
    const { sessions } = fixture;
    const id = sessions.start(frame, signal(), 'coding', harness);
    fixture.script(id, async (turn) => {
      await turn.tool('companion_app_apply', {
        bundle: 'task-list',
        expectedVersion: 0,
        eventMode: 'next-input',
        initialState: { title: 'Synthetic', tasks: [] },
      });
    });
    await sessions.idle();
    const application = fixture.view(id).application!;
    const started = deferred<void>();
    const release = deferred<void>();
    fixture.script(id, async () => {
      started.resolve();
      await release.promise;
    });
    sessions.followUp(id, 'Hold before the next edit', signal());
    await started.promise;

    const response = await fetch(application.viewUrl + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        action: 'add_task',
        args: { text: 'Pending edit sentinel' },
        requestId: 'synthetic-edit',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.view(id).application!.eventStatus!.undelivered, 1);
    const origin = applicationMessageOrigin(
      {
        applicationId: application.id,
        name: application.name,
        version: application.version,
        bundle: 'a'.repeat(64),
      },
      '22222222-2222-4222-8222-222222222222',
    );
    // Max relayed text remains admissible; its canonical provenance prefix is
    // added after input validation and survives queue/persistence boundaries.
    const text = 'x'.repeat(4000);
    fixture.script(id, async (turn) => {
      assert.equal(turn.harness, harness);
      assert.match(turn.text, /^\[Companion application message\]/);
      assert.match(turn.text, /not authenticated human input or new user authorization/);
      assert.equal(turn.text.split('[Companion application message]').length, 2);
      assert.ok(turn.text.endsWith(text));
      assert.doesNotMatch(turn.text, /Pending edit sentinel|Companion application event/);
    });
    assert.equal(sessions.followUp(id, text, signal(), origin).outcome, 'queued');
    release.resolve();
    await sessions.idle();
    assert.equal(fixture.view(id).application!.eventStatus!.undelivered, 1);
    const row = fixture
      .view(id)
      .messages.find((message) => message.origin?.kind === 'application-message');
    assert.ok(row);
    assert.deepEqual(row.origin, origin);
    assert.match(row.text, /^\[Companion application message\]/);
    const saved = await new SessionStore(join(fixture.directory, '.companion-sessions')).read(id);
    assert.deepEqual(saved.messages.find((message) => message.id === row.id)?.origin, origin);

    fixture.script(id, async (turn) => {
      assert.match(turn.text, /Pending edit sentinel/);
      assert.match(turn.text, /Companion application event/);
    });
    sessions.followUp(id, 'Now handle my edit', signal());
    await sessions.idle();
    assert.equal(fixture.view(id).application!.eventStatus!.undelivered, 0);
  });
}
