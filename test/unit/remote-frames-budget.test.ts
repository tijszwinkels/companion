/**
 * The frame origin's per-device request budget (src/remote/README.md, "Rules:
 * request admission", rule 9): bursts of 120, refilled at 40 per second on
 * the monotonic clock, kept across a reconnect within the grace period and
 * reset when the device's record ends. A wall-clock step must neither stall
 * a device's frames nor give it extra requests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  FrameHandles,
  frameRequestBurst,
  frameRequestsPerSecond,
} from '../../src/remote/frames/handles.ts';

/** How many requests the device may make now, taking them all. */
function takeAll(handles: FrameHandles, deviceId: string): number {
  let taken = 0;
  while (handles.takeRequest(deviceId)) {
    taken++;
    assert.ok(taken <= 100_000, 'The budget never ends');
  }
  return taken;
}

test('frame budget: a clock that goes back refills nothing and never stalls the device', () => {
  let now = 1_000_000;
  const handles = new FrameHandles('https://frames.example', () => now);
  const connection = handles.connect('device');

  assert.equal(takeAll(handles, 'device'), frameRequestBurst);

  // The clock steps back an hour: no refill, and no debt either.
  now -= 3_600_000;
  assert.equal(takeAll(handles, 'device'), 0);

  // One second later the device has one second's refill, as always.
  now += 1000;
  assert.equal(takeAll(handles, 'device'), frameRequestsPerSecond);

  connection.close();
  handles.clear();
});

test('frame budget: setting the wall clock back does not stall frames (monotonic by default)', async (context) => {
  // The wall clock is under the test's control from the start, so a budget
  // that read it would see the step below.
  let wallClock = Date.now();
  context.mock.method(Date, 'now', () => wallClock);

  const handles = new FrameHandles('https://frames.example');
  const connection = handles.connect('device');
  context.after(() => {
    connection.close();
    handles.clear();
  });

  assert.equal(takeAll(handles, 'device'), frameRequestBurst);

  // The system clock is set back an hour; the budget does not notice.
  wallClock -= 3_600_000;

  // 40 per second: one request is back after 25 ms.
  await delay(100);
  assert.ok(handles.takeRequest('device'));
});

test('frame budget: kept across a reconnect within the grace period, fresh after the device ends', () => {
  let now = 0;
  const handles = new FrameHandles('https://frames.example', () => now, 60_000);

  const first = handles.connect('device');
  assert.equal(takeAll(handles, 'device'), frameRequestBurst);
  first.close();

  // Reconnecting within the grace period finds the spent budget.
  const second = handles.connect('device');
  assert.equal(takeAll(handles, 'device'), 0);
  second.close();

  // Revoked (its record ends) and paired again: a full budget.
  handles.retainDevices(new Set());
  assert.equal(handles.takeRequest('device'), false, 'Unknown devices take nothing');
  const third = handles.connect('device');
  assert.equal(takeAll(handles, 'device'), frameRequestBurst);
  third.close();
  handles.clear();
});
