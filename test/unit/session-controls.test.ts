import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { deferred, frame, signal } from '../helpers.ts';

test('desktop session controls discover once, validate models, publish order and restore it on snapshots', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-controls-'));
  const discovery = deferred<void>();
  let discoveries = 0;
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'control-fixture',
        label: 'Control fixture',
        dependencies: {},
        async models() {
          discoveries++;
          await discovery.promise;
          return ['configured/one', 'configured/two'];
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
