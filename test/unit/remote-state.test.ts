import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeviceStore } from '../../src/remote/devices.ts';
import { ReceiptBook, receiptLifetimeMilliseconds } from '../../src/remote/receipts.ts';

test('independent device stores consume a code only once', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-state-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new DeviceStore(directory);
  await owner.prepare();
  const { code } = await owner.createPairingCode();

  // CLI and gateway have independent store objects. A per-object promise
  // queue cannot serialize this shared-file read/modify/write transaction.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => new DeviceStore(directory).redeemPairingCode(code, 'Fixture')),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await owner.devices()).length, 1);
});

test('receipt capacity never evicts a still-valid mutation outcome', () => {
  let now = 1000;
  const book = new ReceiptBook(() => now);
  for (let index = 0; index < 512; index++) {
    const receipt = book.claim('phone', String(index), 'toggle');
    assert.equal(receipt.kind, 'new');
    if (receipt.kind === 'new') {
      receipt.settle({
        type: 'result',
        requestId: String(index),
        action: 'toggle-pause',
        result: 'paused',
      });
    }
  }

  assert.equal(book.claim('phone', 'overflow', 'toggle').kind, 'full');
  assert.equal(book.claim('phone', '0', 'toggle').kind, 'replay');
  now += receiptLifetimeMilliseconds + 1;
  assert.equal(book.claim('phone', 'overflow', 'toggle').kind, 'new');
});

test('concurrent CLI-like revocations never restore another removed device', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-revoke-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DeviceStore(directory);
  const ids: string[] = [];
  for (let index = 0; index < 8; index++) {
    const { code } = await store.createPairingCode();
    const result = await store.redeemPairingCode(code, `Fixture ${index}`);
    assert.ok(result.ok);
    ids.push(result.device.id);
  }

  await Promise.all(ids.map((id) => new DeviceStore(directory).revoke(id)));
  assert.deepEqual(await store.devices(), []);
});

test('pending duplicate waiters are bounded and releasable on disconnect', () => {
  const book = new ReceiptBook();
  const original = book.claim('phone', 'pending', 'same');
  assert.equal(original.kind, 'new');
  const cancellations: (() => void)[] = [];
  for (let index = 0; index < 32; index++) {
    const duplicate = book.claim('phone', 'pending', 'same');
    assert.equal(duplicate.kind, 'pending');
    if (duplicate.kind === 'pending') {
      cancellations.push(duplicate.wait(() => assert.fail('Disconnected waiter')));
    }
  }
  assert.equal(book.claim('phone', 'pending', 'same').kind, 'full');
  for (const cancel of cancellations) {
    cancel();
  }
  assert.equal(book.claim('phone', 'pending', 'same').kind, 'pending');
  if (original.kind === 'new') {
    original.settle({
      type: 'result',
      requestId: 'pending',
      action: 'toggle-pause',
      result: 'paused',
    });
  }
});
