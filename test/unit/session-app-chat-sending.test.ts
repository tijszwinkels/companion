import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationSending, applicationSendLimits } from '../../src/session-apps/sending.ts';
import { SessionApplicationError } from '../../src/session-apps/errors.ts';

const identity = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  name: 'synthetic-app',
  version: 1,
  bundle: 'a'.repeat(64),
};

function fixture() {
  let time = 10000;
  const policy = new ApplicationSending(identity, () => time);
  const command = (index: number, text = 'Synthetic message') => ({
    version: identity.version,
    grantId: policy.access().grantId,
    requestId: 'request-' + String(index).padStart(16, '0'),
    text,
  });
  return {
    policy,
    command,
    advance() {
      time += applicationSendLimits.intervalMilliseconds;
    },
    complete(index: number) {
      const input = command(index);
      const result = policy.reserve(input);
      assert.equal(result.duplicate, false);
      policy.attach(result.receipt.receiptId, 'message-' + index);
      assert.equal(policy.begin(result.receipt.receiptId), true);
      assert.equal(policy.finish(result.receipt.receiptId, 'completed'), true);
      return { input, receipt: result.receipt };
    },
  };
}

function status(code: number) {
  return (error: unknown) => error instanceof SessionApplicationError && error.status === code;
}

test('sending starts denied and each explicit grant has exactly five non-refundable slots', () => {
  const f = fixture();
  assert.throws(() => f.policy.reserve(f.command(0)), status(403));
  const denied = f.policy.access().grantId;
  f.policy.permit();
  assert.notEqual(f.policy.access().grantId, denied);
  for (let index = 0; index < 5; index++) {
    f.complete(index);
    assert.equal(f.policy.access().remaining, 4 - index);
    f.advance();
  }
  assert.throws(() => f.policy.reserve(f.command(6)), status(403));
  assert.equal(f.policy.access().remaining, 0);
  f.policy.permit();
  assert.equal(f.policy.access().remaining, 5);
});

test('exact retries deduplicate before quota, rate and revocation; changed text conflicts', () => {
  const f = fixture();
  f.policy.permit();
  const first = f.complete(1);
  const duplicate = f.policy.reserve(first.input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.receiptId, first.receipt.receiptId);
  assert.equal(duplicate.receipt.state, 'completed');
  assert.equal(f.policy.access().remaining, 4);
  assert.throws(() => f.policy.reserve({ ...first.input, text: 'Changed' }), status(409));
  f.policy.revoke('revoked');
  assert.equal(f.policy.reserve(first.input).duplicate, true);
  assert.throws(
    () => f.policy.reserve({ ...first.input, requestId: 'another-request-id' }),
    status(403),
  );
});

test('receipt identities cannot bypass a shared active slot or the minimum admission interval', () => {
  const f = fixture();
  f.policy.permit();
  const first = f.policy.reserve(f.command(1));
  assert.throws(() => f.policy.reserve(f.command(2)), status(409));
  assert.equal(
    f.policy.begin(first.receipt.receiptId),
    false,
    'Reservation alone is not queue admission',
  );
  f.policy.attach(first.receipt.receiptId, 'message-1');
  assert.equal(f.policy.begin(first.receipt.receiptId), true);
  f.advance();
  assert.throws(() => f.policy.reserve(f.command(2)), status(409));
  assert.equal(f.policy.finish(first.receipt.receiptId, 'completed'), true);
  const second = f.complete(2);
  assert.throws(() => f.policy.reserve(f.command(3)), status(429));
  f.policy.permit();
  assert.throws(
    () => f.policy.reserve(f.command(3)),
    status(429),
    'Renewal must not reset the rate clock',
  );
  f.advance();
  f.policy.reserve(f.command(3));
  assert.equal(
    f.policy.finish(second.receipt.receiptId, 'completed'),
    false,
    'A late completion cannot release a successor',
  );
  assert.equal(f.policy.access().busy, true);
});

test('revoke, Stop and close withdraw queued work and delayed begin cannot run it', () => {
  for (const reason of ['revoked', 'stopped', 'closed'] as const) {
    const f = fixture();
    f.policy.permit();
    const input = f.command(1);
    const pending = f.policy.reserve(input);
    f.policy.attach(pending.receipt.receiptId, 'message-1');
    const withdrawn = f.policy.revoke(reason);
    assert.equal(withdrawn.length, 1);
    assert.equal(withdrawn[0].messageId, 'message-1');
    assert.equal(withdrawn[0].reason, reason);
    assert.equal(f.policy.begin(pending.receipt.receiptId), false);
    assert.equal(f.policy.receipt(input.grantId, input.requestId)?.state, 'cancelled');
    assert.equal(f.policy.access().busy, false);
    assert.equal(f.policy.access().allowed, false);
  }
});

test('replacement blocks old queued sends and keeps an old running send busy until its terminal outcome', () => {
  const f = fixture();
  f.policy.permit();
  const oldInput = f.command(1);
  const old = f.policy.reserve(oldInput);
  f.policy.attach(old.receipt.receiptId, 'old-message');
  assert.equal(f.policy.begin(old.receipt.receiptId), true);
  const successor = { ...identity, version: 2, bundle: 'b'.repeat(64) };
  assert.deepEqual(f.policy.replace(successor), []);
  assert.equal(f.policy.access().allowed, false);
  assert.equal(f.policy.access().busy, true);
  assert.equal(f.policy.receipt(oldInput.grantId, oldInput.requestId), undefined);
  f.policy.permit();
  f.advance();
  const next = { ...f.command(2), version: 2 };
  assert.throws(() => f.policy.reserve(next), status(409));
  assert.equal(f.policy.cancelUnstarted(old.receipt.receiptId), false);
  assert.equal(f.policy.finish(old.receipt.receiptId, 'cancelled'), true);
  const pending = f.policy.reserve(next);
  f.policy.attach(pending.receipt.receiptId, 'new-message');
  assert.equal(f.policy.replace({ ...successor, version: 3 })[0].reason, 'replaced');
  assert.equal(f.policy.begin(pending.receipt.receiptId), false);
});

test('uncertain admission consumes quota, stays busy and cannot turn into an automatic replay', () => {
  const f = fixture();
  f.policy.permit();
  const input = f.command(1);
  const reserved = f.policy.reserve(input);
  f.policy.unconfirmed(reserved.receipt.receiptId);
  const retry = f.policy.reserve(input);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.receipt.state, 'unknown');
  assert.equal(retry.receipt.reason, 'admission-unconfirmed');
  assert.equal(f.policy.access().remaining, 4);
  assert.equal(f.policy.begin(reserved.receipt.receiptId), false);
  f.advance();
  assert.throws(() => f.policy.reserve(f.command(2)), status(409));
  assert.equal(f.policy.permit()[0].state, 'cancelled');
  assert.equal(f.policy.begin(reserved.receipt.receiptId), false);
  f.complete(2);
});

test('queue cancellation releases only its own unstarted receipt and does not refund quota', () => {
  const f = fixture();
  f.policy.permit();
  const first = f.policy.reserve(f.command(1));
  f.policy.attach(first.receipt.receiptId, 'first-message');
  assert.equal(f.policy.cancelUnstarted('wrong-receipt'), false);
  assert.equal(f.policy.cancelUnstarted(first.receipt.receiptId), true);
  assert.equal(f.policy.access().remaining, 4);
  f.advance();
  const next = f.policy.reserve(f.command(2));
  f.policy.attach(next.receipt.receiptId, 'second-message');
  assert.equal(f.policy.cancelUnstarted(first.receipt.receiptId), false);
  assert.equal(f.policy.begin(next.receipt.receiptId), true);
});

test('bounded eviction cannot make an old grant replayable, even after many explicit renewals', () => {
  const f = fixture();
  f.policy.permit();
  const first = f.complete(1);
  for (let index = 2; index < 100; index++) {
    f.advance();
    f.policy.permit();
    f.complete(index);
  }
  assert.equal(f.policy.receipt(first.input.grantId, first.input.requestId), undefined);
  assert.throws(() => f.policy.reserve(first.input), status(403));
  assert.equal(f.policy.access().remaining, 4);
});

test('raw inputs, exact Unicode fingerprints and returned copies cannot alter host policy', () => {
  const f = fixture();
  f.policy.permit();
  const input = f.command(1);
  for (const invalid of [
    { ...input, allowed: true },
    { ...input, version: 2 },
    { ...input, grantId: '' },
    { ...input, requestId: 'short' },
    { ...input, text: '' },
    { ...input, text: ' '.repeat(10) },
    { ...input, text: 'x'.repeat(4001) },
  ]) {
    assert.throws(() => f.policy.reserve(invalid), status(400));
  }
  assert.equal(f.policy.access().remaining, 5);
  const text = { ...input, text: '\ud800' };
  const first = f.policy.reserve(text);
  assert.throws(() => f.policy.reserve({ ...text, text: '\ud801' }), status(409));
  first.receipt.state = 'completed';
  first.receipt.bundle = 'forged';
  const access = f.policy.access();
  access.remaining = 500;
  access.allowed = false;
  assert.equal(f.policy.receipt(input.grantId, input.requestId)?.state, 'reserved');
  assert.equal(f.policy.receipt(input.grantId, input.requestId)?.bundle, identity.bundle);
  assert.equal(f.policy.access().remaining, 4);
  assert.equal(f.policy.access().allowed, true);
  const successor = new ApplicationSending(identity);
  assert.equal(successor.receipt(input.grantId, input.requestId), undefined);
  assert.throws(
    () => successor.reserve(input),
    status(403),
    'Reopen/restart does not restore a grant',
  );
});
