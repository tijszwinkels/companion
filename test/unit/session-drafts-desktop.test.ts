import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

interface DraftMessage {
  type: string;
  requestId: string;
  id: string;
  text: string;
  ifDraftExists: string;
  focus: boolean;
  source: { sessionId: string; title: string };
}

/**
 * The listener forwards a draft to one panel over the real control socket and
 * reports that panel's explicit answer. Everything here is synthetic.
 */
test('the desktop protocol confirms drafts only from the asked panel', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-draft-desktop-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let lease: { endpoint: string; token: string } | undefined;
  let releaseTurn: () => void = () => {};
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'draft-fixture',
        label: 'Draft fixture',
        dependencies: {},
        async run(request) {
          // Keep the requesting turn open while the test drives its tools.
          if (request.prompt.text === 'Requester') {
            lease = request.sessionTools;
            await new Promise<void>((resolve) => {
              releaseTurn = resolve;
            });
          }
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
  context.after(async () => {
    releaseTurn();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  const target = sessions.start({ ...frame, utterance: 'Target' }, signal());
  await sessions.idle();
  const requester = sessions.start({ ...frame, utterance: 'Requester' }, signal());
  await waitFor(() => lease !== undefined);
  const draft = sessionTools(lease!.endpoint, lease!.token).find(
    (tool) => tool.name === 'companion_session_draft',
  )!;
  const attempt = async (text: string) => {
    try {
      return (await draft.execute(randomUUID(), { id: target, text })).details;
    } catch (error) {
      return { error: (error as Error).message };
    }
  };

  // An older panel that does not advertise draftHost cannot receive drafts.
  desktop.send({ action: 'panel-state', id: '', composerFocused: false });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');
  assert.match(String((await attempt('Too early')).error), /\[offline\]$/);

  desktop.send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  assert.equal((await desktop.reply('panel-state')).result, 'panel-recorded');

  const pending = attempt('Please review this');
  await waitFor(() => desktop.messages.some((message) => message.type === 'agent-draft'));
  const index = desktop.messages.findIndex((message) => message.type === 'agent-draft');
  const request = desktop.messages.splice(index, 1)[0] as unknown as DraftMessage;
  assert.equal(request.id, target);
  assert.equal(request.text, 'Please review this');
  assert.equal(request.ifDraftExists, 'reject');
  assert.equal(request.focus, false);
  assert.deepEqual(request.source, { sessionId: requester, title: 'Requester' });

  // Another connection cannot answer for the panel that was asked.
  const stranger = createConnection(desktop.socketPath);
  await once(stranger, 'connect');
  const strangerReplies: string[] = [];
  stranger.setEncoding('utf8');
  stranger.on('data', (chunk: string) => strangerReplies.push(chunk));
  stranger.write(
    JSON.stringify({
      action: 'agent-draft-result',
      requestId: request.requestId,
      outcome: 'inserted',
    }) + '\n',
  );
  await waitFor(() => strangerReplies.join('').includes('This draft request has expired'));
  stranger.destroy();

  desktop.send({
    action: 'agent-draft-result',
    requestId: request.requestId,
    outcome: 'conflict',
    reason: '',
  });
  assert.equal((await desktop.reply('agent-draft-result')).result, 'draft-recorded');
  assert.match(String((await pending).error), /left unchanged.*\[conflict\]$/);

  // A late duplicate answer is refused rather than applied to a later draft.
  desktop.send({ action: 'agent-draft-result', requestId: request.requestId, outcome: 'inserted' });
  assert.match(
    String((await desktop.reply('agent-draft-result')).message),
    /This draft request has expired/,
  );

  // The panel disconnecting before it answers leaves the outcome uncertain.
  const uncertain = attempt('Second proposal');
  await waitFor(() => desktop.messages.some((message) => message.type === 'agent-draft'));
  desktop.client.destroy();
  assert.match(
    String((await uncertain).error),
    /may or may not have been inserted.*\[unconfirmed\]$/,
  );

  // Nothing was ever submitted to the target conversation.
  const view = sessions.snapshot().find((session) => session.id === target)!;
  assert.deepEqual(
    view.messages.filter((message) => message.kind === 'user').map((message) => message.text),
    ['Target'],
  );
});
