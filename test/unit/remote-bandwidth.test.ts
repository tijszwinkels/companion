import assert from 'node:assert/strict';
import test from 'node:test';
import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, delay, waitFor } from '../remote-fixture.ts';

/** Compare exact wire bytes with identical synthetic state; never load personal transcripts. */
test('incremental phone state avoids repeating sixteen transcripts and reconnect hydrates afresh', async (context) => {
  const fixture = await remoteFixture({
    backend: async (_request, _signal, emit) => {
      for (let index = 0; index < 12; index++) {
        emit({
          ...chatMessage(`answer-${index}`, 'assistant', 'Supplied fixture. '.repeat(240)),
          state: 'done',
        });
      }
    },
  });
  context.after(() => fixture.close());
  for (let index = 0; index < 16; index++) {
    const id = fixture.sessions.start({ ...frame, utterance: `Fixture ${index}` }, signal());
    await waitFor(() => fixture.sessions.interaction(id).agentAcceptsFollowUp);
  }

  const { token } = await fixture.pair();
  const legacy = await fixture.phone(token);
  const modern = await fixture.phone(token, fixture.origin, true);
  assert.equal((await legacy.engine('state')).sessions.length, 16);
  assert.equal((await modern.engine('state')).sessions.length, 16);
  let legacyBytes = 0;
  let modernBytes = 0;
  for (let index = 0; index < 10; index++) {
    legacy.messages.length = 0;
    modern.messages.length = 0;
    fixture.desktop.pause.toggle();
    const expectedPause = fixture.desktop.pause.paused;
    const [full, partial] = await Promise.all([
      legacy.engine('state', (event) => event.paused === expectedPause),
      modern.engine('state', (event) => event.paused === expectedPause),
    ]);
    assert.equal(full.sessions.length, 16);
    assert.equal(partial.sessions, undefined);
    assert.equal(partial.previousSessions, undefined);
    assert.equal(partial.sessionOrderRevision, undefined);
    assert.equal(partial.agentActions, undefined);
    assert.deepEqual(partial.history, []);
    legacyBytes += Buffer.byteLength(JSON.stringify(full));
    modernBytes += Buffer.byteLength(JSON.stringify(partial));
  }
  assert.ok(
    modernBytes < legacyBytes / 100,
    `Expected >99% smaller routine state: ${modernBytes}/${legacyBytes}`,
  );
  context.diagnostic(
    `Ten broadcasts, sixteen synthetic transcripts: full=${legacyBytes}B incremental=${modernBytes}B`,
  );

  // Disconnected removals/reopens must be recovered by a new FULL snapshot.
  modern.socket.close();
  await modern.closed;
  const removedId = fixture.sessions.snapshot()[0].id;
  await fixture.sessions.remove(removedId);
  await delay(30);
  const reconnected = await fixture.phone(token, fixture.origin, true);
  const snapshot = await reconnected.engine('state');
  assert.equal(snapshot.sessions.length, 15);
  assert.ok(!snapshot.sessions.some((session: { id: string }) => session.id === removedId));
  assert.ok(snapshot.previousSessions.some((session: { id: string }) => session.id === removedId));
  reconnected.send({ action: 'reopen-agent', id: removedId, requestId: 'restore' });
  assert.equal((await reconnected.reply('restore')).type, 'result');
  const restored = await reconnected.engine(
    'agent-restored',
    (event) => event.session.id === removedId,
  );
  assert.ok(
    restored.session.messages.some((message: { text: string }) =>
      message.text.includes('Supplied fixture'),
    ),
  );
});
