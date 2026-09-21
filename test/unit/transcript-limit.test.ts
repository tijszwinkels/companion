import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage, type AgentBackend } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';

for (const count of [201, 800, 801]) {
  test(`panel history handles ${count} bubbles through completion and reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-transcript-limit-'));
    const backend: AgentBackend = {
      id: 'transcript-fixture',
      label: 'Transcript fixture',
      dependencies: {},
      async run(_request, _signal, emit) {
        // The initial user question is already one bubble. Keep each output
        // small so this checks the message count independently of the size cap.
        for (let index = 1; index < count; index++) {
          emit(chatMessage(`answer-${index}`, 'assistant', `Answer ${index}`));
        }
      },
    };
    const sessions = new AgentSessions({ backend }, () => {}, directory);
    try {
      const id = sessions.start(frame, signal());
      await sessions.idle();
      const view = sessions.snapshot()[0];
      assert.equal(view.status, count <= 800 ? 'completed' : 'error');
      assert.equal(view.messages.length, Math.min(count, 800));
      if (count > 800) {
        assert.match(view.error, /panel transcript limit/);
      } else {
        assert.equal(view.error, '');
      }

      // Increasing only the live limit would still make long conversations
      // unreadable when the archive is validated on reopening.
      await sessions.remove(id);
      await sessions.reopen(id);
      assert.deepEqual(sessions.snapshot()[0].messages, view.messages);
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
