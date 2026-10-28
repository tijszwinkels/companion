import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalText, parseOrigin, promptText } from '../../src/agents/agent-origin.ts';
import {
  applicationMessageOrigin,
  applicationMessageAncestry,
} from '../../src/agents/application-message-origin.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { chatMessage, type AgentSession } from '../../src/agents/types.ts';
import { applicationChatSnapshot } from '../../src/session-apps/chat.ts';

const identity = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  name: 'synthetic-app',
  version: 3,
  bundle: 'a'.repeat(64),
};
const receiptId = '22222222-2222-4222-8222-222222222222';
const origin = applicationMessageOrigin(identity, receiptId);

function session(): AgentSession {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Synthetic',
    status: 'completed',
    model: 'synthetic',
    error: '',
    updatedAt: 1,
    messages: [
      { ...chatMessage('app-row', 'user', canonicalText('Synthetic message', origin)), origin },
    ],
  };
}

test('app messages retain host identity and a canonical non-human text fallback without doubling headers', () => {
  const text = canonicalText('Synthetic message', origin);
  assert.match(text, /^\[Companion application message\]/);
  assert.match(text, /not authenticated human input or new user authorization/);
  assert.ok(text.includes(identity.applicationId));
  assert.ok(text.includes(identity.bundle));
  assert.ok(text.includes(receiptId));
  assert.equal(promptText('Synthetic message', origin), text);
  assert.equal(promptText(text, origin), text);
  assert.equal(canonicalText(text, origin), text);
  assert.equal(canonicalText('Human text'), 'Human text');
  assert.deepEqual(parseOrigin({ ...origin, title: 'You' }), origin);
  assert.deepEqual(parseOrigin(JSON.parse(JSON.stringify(origin))), origin);
});

test('malformed stored app origins retain a non-human marker instead of silently becoming human input', () => {
  for (const invalid of [
    { ...origin, applicationId: 'other' },
    { ...origin, name: 'bad\nname' },
    { ...origin, name: 'a'.repeat(49) },
    { ...origin, version: 0 },
    { ...origin, version: 1.5 },
    { ...origin, bundle: 'bad' },
    { ...origin, receiptId: 'bad' },
    { ...origin, depth: 0 },
    { kind: 'application-message' },
  ]) {
    const parsed = parseOrigin(invalid);
    assert.ok(parsed);
    assert.equal(parsed.kind, 'external');
    assert.match(promptText('Untrusted archived text', parsed), /not typed by the user/);
    assert.match(promptText('Untrusted archived text', parsed), /invalid stored provenance/);
  }
});

test('app-origin wake ancestry stays non-human within the existing bounded ancestry schema', () => {
  const ancestry = applicationMessageAncestry(origin);
  assert.equal(ancestry.kind, 'external');
  assert.equal(ancestry.depth, 1);
  assert.equal(ancestry.requestId, receiptId);
  assert.equal(ancestry.title, 'App synthetic-app · v3');
  assert.deepEqual(parseOrigin(ancestry), ancestry);
});

test('bounded chat projection labels app sends as application rather than human text', () => {
  const result = applicationChatSnapshot(session());
  assert.equal(result.changed, true);
  if (result.changed) {
    assert.equal(result.messages[0].source, 'application');
    assert.match(result.messages[0].text, /^\[Companion application message\]/);
  }
});

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: canonical archive round-trip retains identity, queued interruption and malformed-origin safety`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-app-origin-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(directory);
    const view = session();
    view.harness = harness;
    if (harness === 'claude-code') {
      view.claudeCode = { model: 'synthetic-model', effort: 'high' };
    }
    view.messages[0].state = 'queued';
    await store.save(view);
    const reopened = await store.read(view.id);
    assert.deepEqual(reopened.messages[0].origin, origin);
    assert.equal(reopened.messages[0].state, 'error', 'Reopen must not replay pending app sends');
    assert.equal(reopened.messages[0].text, view.messages[0].text);
    const damaged = JSON.parse(JSON.stringify(view));
    damaged.messages[0].origin.receiptId = 'invalid';
    await writeFile(join(directory, view.id + '.json'), JSON.stringify(damaged));
    const safe = await store.read(view.id);
    assert.equal(safe.messages[0].origin?.kind, 'external');
    assert.match(safe.messages[0].text, /^\[Companion application message\]/);
  });
}
