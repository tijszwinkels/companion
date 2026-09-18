import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

interface Screen {
  name: string;
  x: number;
  width: number;
}

// QML imports plain JavaScript namespaces. Exercise the same monitor policy in
// Node without requiring a desktop or copying its implementation into a test.
const policy = await readFile(
  new URL('../../integrations/omarchy/plugin/MonitorSelection.js', import.meta.url),
  'utf8',
);
const chooseScreen = runInNewContext(`${policy}\nchooseScreen`) as (
  screens: Screen[],
) => Screen | null;

test('panel uses the sole display, including a built-in screen', () => {
  const laptop = { name: 'eDP-1', x: 0, width: 1728 };
  assert.equal(chooseScreen([laptop]), laptop);
  assert.equal(chooseScreen([]), null);
});

test('panel prefers an external monitor even when the laptop is farther right', () => {
  const laptop = { name: 'eDP-1', x: 3072, width: 1728 };
  const external = { name: 'HDMI-A-1', x: 0, width: 3072 };
  assert.equal(chooseScreen([laptop, external]), external);
});

test('panel uses the rightmost external edge in logical coordinates', () => {
  const left = { name: 'DP-1', x: -2560, width: 2560 };
  const right = { name: 'HDMI-A-1', x: 864, width: 3072 };
  const laptop = { name: 'eDP-1', x: 0, width: 1728 };
  const screens = [right, laptop, left];
  assert.equal(chooseScreen(screens), right);
  assert.deepEqual(screens, [right, laptop, left]);
});

test('mirrored screens have a stable choice and unplugging falls back', () => {
  const a = { name: 'DP-1', x: 0, width: 1920 };
  const b = { name: 'DP-2', x: 0, width: 1920 };
  const laptop = { name: 'LVDS-1', x: 0, width: 1920 };
  assert.equal(chooseScreen([a, b, laptop]), a);
  assert.equal(chooseScreen([b, a, laptop]), a);
  assert.equal(chooseScreen([laptop]), laptop);
});
