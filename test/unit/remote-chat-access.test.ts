/**
 * The gateway's field checks for application chat access
 * (src/remote/README.md, "Application chat access"):
 * - `remoteChatAccess` rebuilds the listener's permission state for remote
 *   clients, without the send grant's ID, and drops malformed state whole;
 * - `parseRemoteRequest` accepts exactly the desktop's fields for
 *   `set-application-chat-read` and `set-application-chat-send`;
 * - both are mutating actions with receipts.
 * Pure functions; no sockets.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteChatAccess } from '../../src/remote/chat-access.ts';
import { mutatingActions, parseRemoteRequest } from '../../src/remote/protocol.ts';

const revision = '0339198a-eb76-4c2d-843f-316c2b148bdb';
const grantId = '847cc3d1-897a-4a5b-a503-bb243ed612b6';

/** The listener's state as it sends it (src/session-apps/types.ts). */
function listenerState(): Record<string, any> {
  return {
    requested: ['chat.read', 'chat.send'],
    read: true,
    send: { grantId, allowed: true, remaining: 3, busy: false },
    revision,
  };
}

test('chat access: what passes, rebuilt without the grant ID', () => {
  assert.deepEqual(remoteChatAccess(listenerState()), {
    requested: ['chat.read', 'chat.send'],
    read: true,
    send: { allowed: true, remaining: 3, busy: false },
    revision,
  });

  // An older listener without `send`: none is invented.
  const older = listenerState();
  delete older.send;
  assert.deepEqual(remoteChatAccess(older), {
    requested: ['chat.read', 'chat.send'],
    read: true,
    revision,
  });

  // Nothing requested, one name, and a used-up grant.
  const none = { ...listenerState(), requested: [] };
  assert.deepEqual(remoteChatAccess(none)?.requested, []);
  const readOnly = { ...listenerState(), requested: ['chat.read'] };
  assert.deepEqual(remoteChatAccess(readOnly)?.requested, ['chat.read']);
  const usedUp = {
    ...listenerState(),
    send: { grantId, allowed: true, remaining: 0, busy: false },
  };
  assert.deepEqual(remoteChatAccess(usedUp)?.send, { allowed: true, remaining: 0, busy: false });

  // Fields the listener might add later are dropped until reviewed.
  const extended = {
    ...listenerState(),
    viewUrl: 'http://127.0.0.1:1/view/' + 'a'.repeat(64),
    send: { ...listenerState().send, path: '/home/user/x' },
  };
  const rebuilt = remoteChatAccess(extended)!;
  assert.deepEqual(Object.keys(rebuilt).sort(), ['read', 'requested', 'revision', 'send']);
  assert.deepEqual(Object.keys(rebuilt.send!).sort(), ['allowed', 'busy', 'remaining']);
  assert.ok(!JSON.stringify(rebuilt).includes(grantId));
});

test('chat access: malformed state is not sent at all', () => {
  const cases: [string, unknown][] = [
    ['absent', undefined],
    ['null', null],
    ['a string', 'chat'],
    ['an array', [listenerState()]],
    ['requested missing', { ...listenerState(), requested: undefined }],
    ['requested not a list', { ...listenerState(), requested: 'chat.read' }],
    ['an unknown capability', { ...listenerState(), requested: ['chat.read', 'files.read'] }],
    ['a repeated capability', { ...listenerState(), requested: ['chat.read', 'chat.read'] }],
    ['three names', { ...listenerState(), requested: ['chat.read', 'chat.send', 'chat.read'] }],
    ['read not a boolean', { ...listenerState(), read: 'yes' }],
    ['revision missing', { ...listenerState(), revision: undefined }],
    ['revision not a UUID', { ...listenerState(), revision: '/view/' + 'a'.repeat(64) }],
    ['revision in capitals', { ...listenerState(), revision: revision.toUpperCase() }],
    ['send not an object', { ...listenerState(), send: true }],
    ['send null', { ...listenerState(), send: null }],
    ['send.allowed missing', { ...listenerState(), send: { remaining: 1, busy: false } }],
    [
      'send.busy not a boolean',
      { ...listenerState(), send: { allowed: true, remaining: 1, busy: 1 } },
    ],
    [
      'negative remaining',
      { ...listenerState(), send: { allowed: true, remaining: -1, busy: false } },
    ],
    [
      'fractional remaining',
      { ...listenerState(), send: { allowed: true, remaining: 1.5, busy: false } },
    ],
    [
      'huge remaining',
      { ...listenerState(), send: { allowed: true, remaining: 1001, busy: false } },
    ],
    [
      'remaining as text',
      { ...listenerState(), send: { allowed: true, remaining: '1', busy: false } },
    ],
  ];
  for (const [name, value] of cases) {
    assert.equal(remoteChatAccess(value), undefined, name);
  }
});

test('chat access requests: exactly the desktop fields, each checked', () => {
  const conversation = '6c4b5f10-dc5b-42ec-a866-81aead4baf06';
  const application = '5d2a2f6e-1b7c-4c11-9d63-4f9d2f3b8a10';
  const valid = {
    type: 'request',
    requestId: 'consent-1',
    action: 'set-application-chat-read',
    id: conversation,
    applicationId: application,
    version: 2,
    revision,
    allowed: true,
  };

  for (const action of ['set-application-chat-read', 'set-application-chat-send']) {
    assert.ok(mutatingActions.has(action as never), action);
    const parsed = parseRemoteRequest({ ...valid, action });
    assert.ok(parsed.ok, action);
    assert.deepEqual(parsed.request, { ...valid, action });
    // A draft host is validated the same way.
    assert.ok(parseRemoteRequest({ ...valid, action }, { drafts: true }).ok, action);
  }

  const refused: [string, Record<string, unknown>, RegExp][] = [
    ['conversation not a UUID', { id: 'conversation' }, /field: id/],
    ['no conversation', { id: undefined }, /field: id/],
    ['application not a UUID', { applicationId: 'app' }, /field: applicationId/],
    ['version negative', { version: -1 }, /field: version/],
    ['version fractional', { version: 1.5 }, /field: version/],
    ['version as text', { version: '2' }, /field: version/],
    ['revision not a UUID', { revision: 'stale' }, /field: revision/],
    ['allowed as text', { allowed: 'true' }, /field: allowed/],
    ['allowed missing', { allowed: undefined }, /field: allowed/],
    ['an extra field', { grantId }, /Unknown field: grantId/],
    ['a desktop-only field', { visible: true }, /Unknown field: visible/],
  ];
  for (const [name, change, message] of refused) {
    const parsed = parseRemoteRequest({ ...valid, ...change });
    assert.equal(parsed.ok, false, name);
    assert.match((parsed as { message: string }).message, message, name);
  }
});
