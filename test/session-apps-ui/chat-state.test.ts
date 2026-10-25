import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error: plain ES module shared with QML, without type declarations.
import { chatRow, diffRows, draftEditAllowed } from '../../integrations/session-apps/ChatState.mjs';

/**
 * Pure page-mirroring rules of the trusted HTML chat (ChatState.mjs), the same
 * module the native view imports. No Qt or browser involved.
 */

function rowData(overrides: Record<string, unknown> = {}) {
  return {
    rowKey: 'a@0',
    messageId: 'a',
    kind: 'assistant',
    body: 'Hello',
    toolName: '',
    input: 'never copied',
    state: '',
    toolCount: 0,
    toolUnavailable: false,
    screenshot: false,
    screenshotUrl: '',
    screenshotNotSaved: false,
    fromWake: false,
    fromExternal: false,
    fromApplication: false,
    fromAgent: false,
    originTitle: '',
    originSessionId: '',
    originGroupId: '',
    fragmentLabel: '',
    widgetJson: '',
    ...overrides,
  };
}

test('chat rows omit tool inputs and capability URLs and keep provenance', () => {
  const row = chatRow(
    rowData({
      kind: 'user',
      screenshot: true,
      screenshotUrl: 'http://127.0.0.1:1/screenshot/secret',
      fromAgent: true,
      fromExternal: true,
      originTitle: 'Script',
      widgetJson: JSON.stringify({ name: 'todo', viewUrl: 'http://127.0.0.1:1/view/abc' }),
    }),
  );

  assert.equal(JSON.stringify(row).includes('secret'), false);
  assert.equal(JSON.stringify(row).includes('never copied'), false);
  assert.equal(JSON.stringify(row).includes('/view/'), false);
  assert.equal(row.screenshotAvailable, true);
  assert.deepEqual(row.origin, { kind: 'external', title: 'Script', sessionId: '', groupId: '' });
  assert.deepEqual(row.widget, { name: 'todo' });
});

test('row diffs send only changed rows and the full order', () => {
  const first = diffRows(
    {},
    [chatRow(rowData()), chatRow(rowData({ rowKey: 'b@0', body: 'B' }))],
    true,
  );
  assert.equal(first.changed.length, 2);

  const streamed = diffRows(
    first.sent,
    [chatRow(rowData()), chatRow(rowData({ rowKey: 'b@0', body: 'B more' }))],
    false,
  );
  assert.deepEqual(streamed.order, ['a@0', 'b@0']);
  assert.deepEqual(
    streamed.changed.map((row: { key: string }) => row.key),
    ['b@0'],
  );

  const removed = diffRows(
    streamed.sent,
    [chatRow(rowData({ rowKey: 'b@0', body: 'B more' }))],
    false,
  );
  assert.deepEqual(removed.order, ['b@0']);
  assert.equal(removed.changed.length, 0);
  assert.equal('a@0' in removed.sent, false);
});

test('page draft edits need the displayed conversation and current host revision', () => {
  const edit = { sessionId: 'one', base: 4, text: 'hello' };
  assert.deepEqual(draftEditAllowed(edit, 'one', 4, 100), { allowed: true, reason: '' });
  assert.equal(draftEditAllowed(edit, 'two', 4, 100).reason, 'other-session');
  assert.equal(draftEditAllowed(edit, 'one', 5, 100).reason, 'stale');
  assert.equal(
    draftEditAllowed({ ...edit, text: 'x'.repeat(101) }, 'one', 4, 100).reason,
    'too-long',
  );
  assert.equal(draftEditAllowed({ ...edit, sessionId: '' }, '', 4, 100).reason, 'other-session');
  assert.equal(
    draftEditAllowed({ sessionId: 'one', base: 4, text: 3 }, 'one', 4, 100).reason,
    'invalid',
  );
});

test('application event turns keep their own provenance, not an agent origin', () => {
  const row = chatRow(rowData({ kind: 'user', fromAgent: true, fromApplication: true }));
  assert.deepEqual(row.origin, {
    kind: 'application-event',
    title: '',
    sessionId: '',
    groupId: '',
  });
});
