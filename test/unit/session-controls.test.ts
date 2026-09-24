import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { desktopFixture, waitFor, type DesktopMessage } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

test('desktop session controls discover once, validate models, publish order and restore it on snapshots', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-controls-'));
  const discovery = deferred<void>();
  let discoveries = 0;
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'control-fixture',
        label: 'Control fixture',
        dependencies: {},
        async models() {
          discoveries++;
          await discovery.promise;
          const models = ['configured/one', 'configured/two'];
          return {
            models,
            pinned: models,
            thinkingLevels: Object.fromEntries(
              models.map((model) => [model, ['off', 'minimal', 'low', 'medium', 'high']]),
            ),
          };
        },
        async run() {},
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
  context.after(async () => {
    discovery.resolve();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = sessions.start(frame, signal());
  const second = sessions.start(frame, signal(), 'quickQuestion');
  await sessions.idle();
  const configPath = join(directory, 'companion-agent.json');
  const config = await readFile(configPath, 'utf8');

  desktop.send({ action: 'agent-models' });
  desktop.send({ action: 'agent-models' });
  await waitFor(() => discoveries > 0);
  assert.equal(discoveries, 1);
  discovery.resolve();
  const firstModels = await desktop.reply('agent-models');
  const secondModels = await desktop.reply('agent-models');
  assert.equal(firstModels.type, 'result');
  assert.deepEqual(firstModels.result, secondModels.result);

  desktop.send({ action: 'set-agent-model', id: second, model: 'configured/two' });
  assert.equal((await desktop.reply('set-agent-model')).result, 'model-selected');
  assert.equal(sessions.snapshot()[1].modelOverride, 'configured/two');
  assert.equal(sessions.snapshot()[0].modelOverride, undefined);
  assert.equal(await readFile(configPath, 'utf8'), config);
  desktop.send({ action: 'set-agent-model', id: second, model: 'unknown/model' });
  assert.equal((await desktop.reply('set-agent-model')).type, 'error');
  assert.equal(sessions.snapshot()[1].modelOverride, 'configured/two');

  desktop.send({ action: 'set-agent-thinking', id: second, thinking: 'high' });
  assert.equal((await desktop.reply('set-agent-thinking')).result, 'thinking-selected');
  assert.equal(sessions.snapshot()[1].thinkingOverride, 'high');
  assert.equal(sessions.snapshot()[0].thinkingOverride, undefined);
  desktop.send({ action: 'set-agent-thinking', id: second, thinking: 'ultra' });
  assert.equal((await desktop.reply('set-agent-thinking')).type, 'error');
  assert.equal(sessions.snapshot()[1].thinkingOverride, 'high');
  desktop.send({ action: 'set-agent-thinking', id: second, thinking: '' });
  await desktop.reply('set-agent-thinking');
  assert.equal(sessions.snapshot()[1].thinkingOverride, undefined);
  assert.equal(await readFile(configPath, 'utf8'), config);

  const order = sessions.order();
  desktop.send({ action: 'move-agent', id: second, beforeId: first, revision: order.revision });
  assert.equal((await desktop.reply('move-agent')).result, 'moved');
  assert.deepEqual(sessions.order().ids, [second, first]);
  desktop.send({ action: 'move-agent', id: first, beforeId: second, revision: order.revision });
  assert.equal((await desktop.reply('move-agent')).type, 'error');
  desktop.send({
    action: 'panel-state',
    id: '',
    composerFocused: false,
    visible: true,
    navigationToken: 'activity',
  });
  await desktop.reply('panel-state');
  const snapshot = desktop.messages.filter((message) => message.type === 'state').at(-1)!;
  assert.deepEqual(
    snapshot.sessions!.map((session) => session.id),
    [second, first],
  );
  assert.equal(
    desktop.runtime.activity.interactionContext!().agentNavigation!.orderRevision,
    sessions.order().revision,
  );
});

test('panel reports broadcast once for selection or navigation ownership and never for tokens alone', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-navigation-broadcast-'));
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'broadcast-fixture',
        label: 'Broadcast fixture',
        dependencies: {},
        async run() {},
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), sessions);
  const peers: Socket[] = [];
  context.after(async () => {
    for (const peer of peers) {
      peer.destroy();
    }
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = sessions.start(frame, signal());
  const second = sessions.start(frame, signal());
  await sessions.idle();
  await waitFor(() => desktop.messages.some((message) => message.type === 'state'));

  const snapshots = (messages: DesktopMessage[]) => {
    return messages.filter((message) => message.type === 'state').length;
  };
  async function connectObserver() {
    const client = createConnection(desktop.socketPath);
    peers.push(client);
    const messages: DesktopMessage[] = [];
    let buffered = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    });
    await waitFor(() => snapshots(messages) === 1);
    return { client, messages };
  }
  async function report(
    peer: { client: Socket; messages: DesktopMessage[] },
    id: string,
    token: string,
    visible: boolean,
    expected: number,
    description: string,
  ) {
    const before = snapshots(peer.messages);
    const replies = peer.messages.filter((message) => message.action === 'panel-state').length;
    peer.client.write(
      JSON.stringify({
        action: 'panel-state',
        id,
        composerFocused: false,
        visible,
        navigationToken: token,
      }) + '\n',
    );
    // Snapshots and the acknowledgement share one ordered socket stream.
    // Counting at the acknowledgement avoids a timing-dependent sleep.
    await waitFor(
      () => peer.messages.filter((message) => message.action === 'panel-state').length > replies,
    );
    assert.equal(peer.messages.at(-1)!.type, 'result');
    assert.equal(snapshots(peer.messages) - before, expected, description);
  }

  await report(desktop, first, 'first', true, 1, 'First selected/visible conversation');
  await report(desktop, second, 'second', true, 1, 'Conversation selection');
  await report(desktop, '', 'activity', true, 1, 'Return to Activity');
  await report(desktop, '', 'previous', true, 0, 'Activity to Previous changes only the token');
  await report(
    desktop,
    '',
    'activity-again',
    true,
    0,
    'Previous to Activity changes only the token',
  );
  assert.equal(
    desktop.runtime.activity.interactionContext!().agentNavigation!.token,
    'activity-again',
  );
  await report(desktop, '', 'hidden', false, 1, 'Last visible navigation disappears');
  assert.equal(desktop.runtime.activity.interactionContext!().agentNavigation, undefined);
  await report(desktop, '', 'shown', true, 1, 'First visible navigation appears');
  const firstOwner = desktop.runtime.activity.interactionContext!().agentNavigation!.clientId;

  const other = await connectObserver();
  await report(other, '', 'other-activity', true, 1, 'Activity navigation changes owner');
  const otherOwner = desktop.runtime.activity.interactionContext!().agentNavigation!.clientId;
  assert.notEqual(otherOwner, firstOwner);
  await report(desktop, '', 'stale-hide', false, 0, 'Stale observer cannot clear the owner');
  assert.equal(
    desktop.runtime.activity.interactionContext!().agentNavigation!.clientId,
    otherOwner,
  );
  const beforeStaleDisconnect = snapshots(other.messages);
  desktop.client.destroy();
  await delay(25);
  await report(other, '', 'still-owned', true, 0, 'Owner remains after observer disconnect');
  assert.equal(snapshots(other.messages), beforeStaleDisconnect);

  const observer = await connectObserver();
  await report(other, first, 'owned-conversation', true, 1, 'New owner selects a conversation');
  // Flush preceding broadcasts through the observer before measuring closure.
  await report(observer, '', 'observer-hidden', false, 0, 'Hidden observer has no ownership');
  const beforeOwnerDisconnect = snapshots(observer.messages);
  other.client.destroy();
  await waitFor(() => !desktop.runtime.activity.interactionContext!().agentNavigation);
  await report(
    observer,
    '',
    'observer-still-hidden',
    false,
    0,
    'Disconnect already cleared the conversation',
  );
  assert.equal(
    snapshots(observer.messages) - beforeOwnerDisconnect,
    1,
    'Owner disconnect publishes one final snapshot',
  );

  await report(observer, '', 'visible-activity', true, 1, 'Activity can reclaim navigation');
  const watcher = await connectObserver();
  const beforeActivityDisconnect = snapshots(watcher.messages);
  observer.client.destroy();
  await waitFor(() => !desktop.runtime.activity.interactionContext!().agentNavigation);
  await report(
    watcher,
    '',
    'watcher-hidden',
    false,
    0,
    'Activity disconnect needs no conversation change',
  );
  assert.equal(
    snapshots(watcher.messages) - beforeActivityDisconnect,
    1,
    'Activity owner disconnect still publishes availability',
  );
});
