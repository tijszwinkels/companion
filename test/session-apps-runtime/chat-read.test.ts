/** Real session/service/renderer permission checks with scripted, synthetic agents. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import type { AgentHarness } from '../../src/agents/types.ts';
import type { SessionApplicationDescriptor } from '../../src/session-apps/types.ts';
import { applicationChatLimits } from '../../src/session-apps/chat.ts';
import { frame, signal } from '../helpers.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { applicationFixture } from './fixture.ts';

const manifest = {
  version: 1,
  description: 'Synthetic chat permission fixture',
  application: { capabilities: ['chat.read', 'chat.send'], eventMode: 'next-input' },
  parameters: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  },
  actions: {},
  queries: {},
  example: { count: 0 },
};
const javascript = `
  export function describe(state) { return 'Synthetic counter: ' + state.count; }
  export function mount(root) { root.textContent = 'Synthetic app'; return { update() {}, dispose() {} }; }
`;

async function setup(context: TestContext, harness: AgentHarness = 'pi') {
  const fixture = await applicationFixture(context);
  await fixture.bundle('chat-fixture', manifest, javascript);
  const { sessions } = fixture;
  const id = sessions.start(
    { ...frame, utterance: 'Synthetic earlier conversation' },
    signal(),
    'coding',
    harness,
  );
  await sessions.idle();
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'chat-fixture', expectedVersion: 0 });
    assert.ok(!turn.toolNames.some((name) => /chat.*grant|chat.*read/.test(name)));
  });
  sessions.followUp(id, 'Install the synthetic application', signal());
  await sessions.idle();
  return { ...fixture, id, application: () => fixture.view(id).application! };
}

function permission(application: SessionApplicationDescriptor, allowed: boolean) {
  return {
    applicationId: application.id,
    version: application.version,
    revision: application.chatAccess!.revision,
    allowed,
  };
}

async function read(application: SessionApplicationDescriptor, after?: string) {
  return fetch(application.viewUrl + '/chat-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: application.version, ...(after ? { after } : {}) }),
  });
}

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: declared chat reading is denied until trusted consent; reads stay bounded and same-session`, async (context) => {
    const fixture = await setup(context, harness);
    const { sessions, id, application } = fixture;
    const other = sessions.start({ ...frame, utterance: 'OTHER-CONVERSATION-SENTINEL' }, signal());
    await sessions.idle();
    assert.notEqual(other, id);
    assert.equal(application().chatAccess!.read, false);
    assert.equal((await read(application())).status, 403);

    const beforeTurns = fixture.turns.length;
    await sessions.setApplicationChatRead(id, permission(application(), true));
    assert.equal(fixture.turns.length, beforeTurns, 'Consent must not start a model turn');
    const state = (await (await fetch(application().viewUrl + '/state')).json()) as Record<
      string,
      unknown
    >;
    assert.equal(state.chatReadAllowed, true);
    assert.deepEqual(state.data, { count: 0 }, 'History is not implicitly copied into state');

    const response = await read(application());
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Synthetic earlier conversation/);
    assert.doesNotMatch(body, /OTHER-CONVERSATION-SENTINEL/);
    assert.ok(Buffer.byteLength(body) <= applicationChatLimits.responseBytes);
    const snapshot = JSON.parse(body);
    assert.equal(snapshot.changed, true);
    assert.equal(snapshot.status, 'completed');
    assert.equal(
      (await read(application(), snapshot.revision)).status,
      429,
      'Direct HTTP cannot bypass rate limits',
    );
    await delay(applicationChatLimits.readIntervalMilliseconds + 20);
    assert.deepEqual(await (await read(application(), snapshot.revision)).json(), {
      revision: snapshot.revision,
      changed: false,
    });

    const saved = await readFile(
      join(fixture.directory, '.companion-widgets', 'applications', id + '.json'),
      'utf8',
    );
    assert.doesNotMatch(saved, /chatAccess|Synthetic earlier conversation|OTHER-CONVERSATION/);
    assert.equal(JSON.parse(saved).data.count, 0);
  });
}

test('revocation rejects existing URLs immediately and stale consent cannot undo it', async (context) => {
  const { sessions, id, application } = await setup(context);
  const denied = application();
  await sessions.setApplicationChatRead(id, permission(denied, true));
  const granted = application();
  assert.equal((await read(granted)).status, 200);
  await sessions.setApplicationChatRead(id, permission(granted, false));
  assert.equal(
    (await read(granted)).status,
    403,
    'No rate-limit or old cursor can mask revocation',
  );
  await assert.rejects(
    sessions.setApplicationChatRead(id, permission(denied, true)),
    /permissions changed/,
  );
  assert.equal(application().chatAccess!.read, false);
  const state = (await (await fetch(granted.viewUrl + '/state')).json()) as Record<string, unknown>;
  assert.equal(state.chatReadAllowed, false);

  for (const operation of ['chat-grant', 'set-chat-read', 'app_set_chat_read']) {
    const response = await fetch(granted.viewUrl + '/' + operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permission(application(), true)),
    });
    assert.equal(response.status, 404, 'A view must have no grant route');
  }
  assert.equal(application().chatAccess!.read, false);
});

test('successful replacement resets consent even for identical code; failed apply does not', async (context) => {
  const fixture = await setup(context);
  const { sessions, id, application } = fixture;
  await sessions.setApplicationChatRead(id, permission(application(), true));
  await sessions.setApplicationChatSend(id, permission(application(), true));
  const original = application();
  await fixture.bundle(
    'broken-chat',
    manifest,
    `
    export function describe() { throw Error('Synthetic invalid candidate'); }
    export function mount() { return { update() {}, dispose() {} }; }
  `,
  );
  fixture.script(id, async (turn) => {
    await assert.rejects(
      turn.tool('companion_app_apply', { bundle: 'chat-fixture', expectedVersion: 0 }),
      /Expected application version/,
    );
    await assert.rejects(
      turn.tool('companion_app_apply', { bundle: 'broken-chat', expectedVersion: 1 }),
      /failed to load/,
    );
  });
  sessions.followUp(id, 'Attempt stale replacement', signal());
  await sessions.idle();
  assert.deepEqual(application().chatAccess, original.chatAccess);

  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'chat-fixture', expectedVersion: 1 });
  });
  sessions.followUp(id, 'Replace with the same bundle', signal());
  await sessions.idle();
  assert.equal(application().version, 2);
  assert.equal(application().chatAccess!.send!.allowed, false);
  assert.equal(application().chatAccess!.read, false);
  assert.notEqual(application().chatAccess!.revision, original.chatAccess!.revision);
  assert.equal((await read(original)).status, 409);
  assert.equal((await read(application())).status, 403);
  await assert.rejects(
    sessions.setApplicationChatRead(id, permission(original, true)),
    /permissions changed/,
  );
});

test('close/reopen and listener recreation reset grants and reject old consent and URLs', async (context) => {
  const fixture = await setup(context);
  const { sessions, id, application } = fixture;
  await sessions.setApplicationChatRead(id, permission(application(), true));
  await sessions.setApplicationChatSend(id, permission(application(), true));
  const original = application();
  await sessions.remove(id);
  assert.equal((await read(original)).status, 404);
  await sessions.reopen(id);
  assert.equal(application().chatAccess!.send!.allowed, false);
  assert.equal(application().chatAccess!.read, false);
  assert.notEqual(application().viewUrl, original.viewUrl);
  await assert.rejects(
    sessions.setApplicationChatRead(id, permission(original, true)),
    /permissions changed/,
  );
  await sessions.setApplicationChatRead(id, permission(application(), true));
  const reopened = application();
  await sessions.close();

  const successor = fixture.open();
  await successor.loadPrevious();
  await successor.reopen(id);
  const restored = fixture.view(id, successor).application!;
  assert.equal(restored.chatAccess!.read, false);
  assert.notEqual(restored.chatAccess!.revision, reopened.chatAccess!.revision);
  assert.equal((await read(restored)).status, 403);
  await assert.rejects(
    successor.setApplicationChatRead(id, permission(reopened, true)),
    /permissions changed/,
  );
});

test('undeclared read access and malformed read requests are refused', async (context) => {
  const fixture = await setup(context);
  const { sessions, id, application } = fixture;
  await fixture.bundle(
    'chat-no-access',
    { ...manifest, application: { eventMode: 'next-input' } },
    javascript,
  );
  const other = sessions.start(frame, signal());
  await sessions.idle();
  fixture.script(other, async (turn) => {
    await turn.tool('companion_app_apply', { bundle: 'chat-no-access', expectedVersion: 0 });
  });
  sessions.followUp(other, 'Install no-access fixture', signal());
  await sessions.idle();
  const noAccess = fixture.view(other).application!;
  await assert.rejects(
    sessions.setApplicationChatRead(other, permission(noAccess, true)),
    /does not request/,
  );
  await assert.rejects(
    sessions.setApplicationChatSend(other, permission(noAccess, true)),
    /does not request/,
  );

  await sessions.setApplicationChatRead(id, permission(application(), true));
  for (const body of [
    {},
    { version: 1, after: 'x' },
    { version: 1, owner: other },
    { version: 1, limit: 1000000 },
  ]) {
    const response = await fetch(application().viewUrl + '/chat-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

for (const mode of ['read', 'send'] as const) {
  test(`real desktop ${mode} permission requires a shown conversation and rejects remote role`, async (context) => {
    const fixture = await setup(context);
    const { sessions, id, application } = fixture;
    const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions);
    context.after(() => desktop.close());
    const action = 'set-application-chat-' + mode;
    const allowed = () =>
      mode === 'read' ? application().chatAccess!.read : application().chatAccess!.send!.allowed;
    desktop.send({ action, id, ...permission(application(), true) });
    assert.match((await desktop.reply(action)).message!, /no longer selected/);
    desktop.send({ action: 'panel-state', id, composerFocused: false, visible: true });
    assert.equal((await desktop.reply('panel-state')).type, 'result');
    desktop.send({ action, id, ...permission(application(), true) });
    assert.equal((await desktop.reply(action)).type, 'result');
    assert.equal(allowed(), true);
    desktop.send({ action, id, ...permission(application(), false) });
    assert.equal((await desktop.reply(action)).type, 'result');

    // A fresh connection may declare remote; it cannot use desktop-only consent.
    const remote = createConnection(desktop.socketPath);
    context.after(() => remote.destroy());
    const replies: { action?: string; type: string; message?: string }[] = [];
    let buffer = '';
    remote.setEncoding('utf8');
    remote.on('data', (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, boundary)));
        buffer = buffer.slice(boundary + 1);
      }
    });
    await once(remote, 'connect');
    async function send(request: Record<string, unknown>) {
      remote.write(JSON.stringify(request) + '\n');
      const match = (reply: (typeof replies)[number]) =>
        reply.action === request.action && ['result', 'error'].includes(reply.type);
      await waitFor(() => replies.some(match));
      return replies.splice(replies.findIndex(match), 1)[0];
    }
    assert.equal((await send({ action: 'client-role', role: 'remote' })).type, 'result');
    assert.equal((await send({ action: 'panel-state', id })).type, 'result');
    assert.match(
      (await send({ action, id, ...permission(application(), true) })).message!,
      /only available on the desktop/,
    );
    assert.equal(allowed(), false);
  });
}
