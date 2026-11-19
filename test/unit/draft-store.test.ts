import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DraftStore,
  draftEditLimit,
  draftStorageLimit,
  type DraftChange,
} from '../../src/desktop/draft-store.ts';

/**
 * The listener's single draft map (src/desktop/draft-store.ts): last received
 * write wins, writes name their conversation, reads never write, and the
 * agent, recording and send rules apply to the same record.
 */

function store(known: string[] = ['A', 'B']) {
  const changes: DraftChange[] = [];
  const drafts = new DraftStore((id) => known.includes(id));
  drafts.subscribe((change) => changes.push(change));
  return { drafts, changes };
}

const editor = (clientId: number, editId: string) => ({
  kind: 'editor' as const,
  clientId,
  editId,
});

test('the last write the listener receives wins, in either order', () => {
  for (const order of [
    ['first', 'second'],
    ['second', 'first'],
  ]) {
    const { drafts } = store();
    // Two editors (e.g. the sidebar and a pop-out) write the same draft.
    drafts.write('A', order[0], editor(1, 'e1'));
    const last = drafts.write('A', order[1], editor(2, 'e2'));
    assert.equal(last.accepted, true);
    assert.equal(drafts.read('A').text, order[1]);
  }
});

test('a delayed earlier edit received last wins (the chosen tradeoff)', () => {
  const { drafts } = store();
  drafts.write('A', 'typed later elsewhere', editor(2, 'late-but-newer'));
  // An edit typed earlier, delivered after: no base check, it wins.
  const delayed = drafts.write('A', 'typed earlier', editor(1, 'early'));
  assert.equal(delayed.accepted, true);
  assert.equal(drafts.read('A').text, 'typed earlier');
});

test('writes go to the named conversation only; reading writes nothing', () => {
  const { drafts, changes } = store();
  drafts.write('B', 'B text', editor(1, 'b1'));
  const before = changes.length;

  // Showing A or B (a switch, remount or reopen) only reads.
  assert.equal(drafts.read('A').text, '');
  assert.equal(drafts.read('B').text, 'B text');
  assert.equal(changes.length, before, 'reads emit no change');

  // A's edit, typed before a switch to B and delivered after it, still
  // names A: A gets it, B is untouched.
  drafts.write('A', 'A text', editor(1, 'a1'));
  assert.equal(drafts.read('A').text, 'A text');
  assert.equal(drafts.read('B').text, 'B text');
});

test('each change carries the writer, so its editor can ignore its own echo', () => {
  const { drafts, changes } = store();
  const result = drafts.write('A', 'hello', editor(7, 'edit-42'));
  assert.equal(result.accepted, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sessionId, 'A');
  assert.equal(changes[0].writer.clientId, 7);
  assert.equal(changes[0].writer.editId, 'edit-42');
  assert.equal(changes[0].sequence, result.accepted ? result.sequence : -1);
  // Sequences only increase.
  drafts.write('B', 'x', editor(7, 'edit-43'));
  assert.ok(changes[1].sequence > changes[0].sequence);
});

test('unknown conversations are refused and create no entry', () => {
  const { drafts, changes } = store(['A']);
  assert.deepEqual(drafts.write('ghost', 'text', editor(1, 'g')), {
    accepted: false,
    reason: 'unknown conversation',
  });
  assert.equal(drafts.append('ghost', 'words', { kind: 'recording' }).accepted, false);
  assert.equal(
    drafts.propose({ sessionId: 'ghost', text: 't', ifDraftExists: 'append', source: 's' }).outcome,
    'conflict',
  );
  assert.deepEqual(drafts.snapshot(), []);
  assert.equal(changes.length, 0);
});

test('an over-long edit is refused and the previous draft stays exactly', () => {
  const { drafts } = store();
  drafts.write('A', 'kept', editor(1, 'a1'));
  const refused = drafts.write('A', 'x'.repeat(draftEditLimit + 1), editor(1, 'a2'));
  assert.equal(refused.accepted, false);
  assert.match(refused.accepted ? '' : refused.reason, /at most 16000/);
  assert.equal(drafts.read('A').text, 'kept');
  // Exactly at the bound is fine.
  assert.equal(drafts.write('A', 'y'.repeat(draftEditLimit), editor(1, 'a3')).accepted, true);
});

test('Unicode text is kept exactly (UTF-16 units are the bound)', () => {
  const { drafts } = store();
  const text = 'Grüße 👋🏽 — 你好\n🇳🇱';
  drafts.write('A', text, editor(1, 'u'));
  assert.equal(drafts.read('A').text, text);
});

test('a confirmed send clears the draft only if it is still the sent text', () => {
  const { drafts } = store();
  drafts.write('A', 'send this', editor(1, 'a1'));
  assert.equal(drafts.clearIfEqual('A', 'send this'), true);
  assert.equal(drafts.read('A').text, '');

  // Typing after the send (before its confirmation) is kept.
  drafts.write('A', 'send this', editor(1, 'a2'));
  drafts.write('A', 'send this and more', editor(1, 'a3'));
  assert.equal(drafts.clearIfEqual('A', 'send this'), false);
  assert.equal(drafts.read('A').text, 'send this and more');
});

test('agent drafts never overwrite: conflict by default, append when asked', () => {
  const { drafts } = store();
  assert.equal(
    drafts.propose({
      sessionId: 'A',
      text: 'agent idea',
      ifDraftExists: 'reject',
      source: 'Helper',
    }).outcome,
    'inserted',
  );
  assert.equal(drafts.read('A').source, 'Helper');

  drafts.write('A', 'my own words', editor(1, 'a1'));
  assert.equal(drafts.read('A').source, '', "the person's edit removes agent provenance");
  const conflict = drafts.propose({
    sessionId: 'A',
    text: 'other idea',
    ifDraftExists: 'reject',
    source: 'Helper',
  });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(drafts.read('A').text, 'my own words');

  const appended = drafts.propose({
    sessionId: 'A',
    text: 'added below',
    ifDraftExists: 'append',
    source: 'Helper',
  });
  assert.equal(appended.outcome, 'appended');
  assert.equal(drafts.read('A').text, 'my own words\n\nadded below');

  // A proposal that would pass the editing envelope changes nothing.
  drafts.write('A', 'z'.repeat(draftEditLimit - 5), editor(1, 'a2'));
  assert.equal(
    drafts.propose({ sessionId: 'A', text: 'too much', ifDraftExists: 'append', source: 'Helper' })
      .outcome,
    'conflict',
  );
  assert.equal(drafts.read('A').text.length, draftEditLimit - 5);
});

test('recorded words keep a long final chunk whole, within the storage ceiling', () => {
  const { drafts } = store();
  drafts.write('A', 'Typed. ', editor(1, 'a1'));
  // A final dictation chunk longer than the editing envelope is kept whole.
  const chunk = 'word '.repeat(4_000);
  assert.equal(drafts.append('A', chunk, { kind: 'recording' }).accepted, true);
  assert.equal(drafts.read('A').text, 'Typed. ' + chunk);

  // Past the ceiling it is refused, never cut; the draft stays.
  const before = drafts.read('A').text;
  const refused = drafts.append('A', 'x'.repeat(draftStorageLimit), { kind: 'recording' });
  assert.equal(refused.accepted, false);
  assert.equal(drafts.read('A').text, before);
});

test('empty drafts are removed; nonempty ones survive views and reopening', () => {
  const { drafts } = store();
  drafts.write('A', 'kept while the listener runs', editor(1, 'a1'));
  drafts.write('B', 'temporary', editor(1, 'b1'));
  drafts.write('B', '', editor(1, 'b2'));
  assert.deepEqual(
    drafts.snapshot().map((change) => [change.sessionId, change.text]),
    [['A', 'kept while the listener runs']],
  );
  // A new view (another window, a reload) reads the same record.
  assert.equal(drafts.read('A').text, 'kept while the listener runs');
});

test('a recording write may pass the editing bound up to the storage ceiling only', () => {
  const { drafts } = store();
  const long = 'r'.repeat(draftEditLimit + 500);
  assert.equal(drafts.write('A', long, editor(1, 'a1')).accepted, false);
  assert.equal(
    drafts.write('A', long, { kind: 'recording', clientId: 1 }, 'storage').accepted,
    true,
  );
  assert.equal(drafts.read('A').text, long);
  const tooLong = 'r'.repeat(draftStorageLimit + 1);
  assert.equal(drafts.write('A', tooLong, { kind: 'recording' }, 'storage').accepted, false);
  assert.equal(drafts.read('A').text, long);
});
