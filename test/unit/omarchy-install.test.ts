import assert from 'node:assert/strict';
import test from 'node:test';

import { assertShortcutsAvailable } from '../../integrations/omarchy/shortcuts.ts';

test('installer rejects conflicts reported as either plain keys or Lua display chords', () => {
  for (const key of [
    'C',
    'SUPER + ALT + C',
    'SUPER+ALT+v',
    'P',
    'SUPER + ALT + P',
    'D',
    'SUPER + ALT + D',
    'TAB',
    'SUPER + ALT + TAB',
  ]) {
    const bindings = JSON.stringify([{ modmask: 72, key, description: 'Existing action' }]);
    assert.throws(
      () => assertShortcutsAvailable(bindings, false),
      /already bound to Existing action/,
    );
  }
});

test('reinstall permits its own shortcuts but still rejects another action on the same chord', () => {
  const own = [
    { modmask: 72, key: 'SUPER + ALT + C', description: 'Companion side panel' },
    { modmask: 72, key: 'SUPER + ALT + P', description: 'Companion pause/resume listening' },
    { modmask: 72, key: 'SUPER + ALT + D', description: 'Companion conversation input focus' },
    { modmask: 72, key: 'TAB', description: 'Companion next tab or next grouped window' },
    {
      modmask: 72,
      key: 'V',
      description: 'Companion utterance history (hold, select, release to paste)',
    },
  ];
  assert.doesNotThrow(() => assertShortcutsAvailable(JSON.stringify(own), true));
  assert.throws(() => assertShortcutsAvailable(JSON.stringify(own), false), /already bound/);

  const conflicting = [...own, { modmask: 72, key: 'C', description: 'Other plugin' }];
  assert.throws(
    () => assertShortcutsAvailable(JSON.stringify(conflicting), true),
    /already bound to Other plugin/,
  );

  const pauseConflict = [...own, { modmask: 72, key: 'P', description: 'Existing pause action' }];
  assert.throws(
    () => assertShortcutsAvailable(JSON.stringify(pauseConflict), true),
    /Super\+Alt\+P is already bound to Existing pause action/,
  );

  const differentModifiers = JSON.stringify([{ modmask: 64, key: 'C' }]);
  assert.doesNotThrow(() => assertShortcutsAvailable(differentModifiers, false));
});

test('local tab routing preserves the known Omarchy group action', () => {
  const stock = [{ modmask: 72, key: 'TAB', description: 'Next window in group' }];
  assert.doesNotThrow(() => assertShortcutsAvailable(JSON.stringify(stock), false));
  const custom = [{ modmask: 72, key: 'TAB', description: 'My Tab action' }];
  assert.throws(
    () => assertShortcutsAvailable(JSON.stringify(custom), true),
    /already bound to My Tab action/,
  );
});

test('installer fails closed when compositor bindings cannot be inspected', () => {
  for (const bindings of ['invalid JSON', '{}', '[null]', '[{"key":"C"}]']) {
    assert.throws(
      () => assertShortcutsAvailable(bindings, true),
      /Cannot check shortcut conflicts/,
    );
  }
});

test('resize routing accepts stock or installed bindings and rejects custom actions', () => {
  for (const code of [20, 21]) {
    for (const key of [
      { key: `SUPER + code:${code}` },
      { key: '', keycode: code },
      { key: code === 20 ? 'minus' : 'equal' },
    ]) {
      const stock = code === 20 ? 'Expand window left' : 'Shrink window left';
      const own = `Companion width or ${stock.toLowerCase()}`;
      const binding = { modmask: 64, ...key, description: stock };
      const check = (description: string, installed: boolean) =>
        assertShortcutsAvailable(JSON.stringify([{ ...binding, description }]), installed);

      assert.doesNotThrow(() => check(stock, false));
      assert.doesNotThrow(() => check(own, true));
      assert.throws(() => check(own, false), /already bound/);
      assert.throws(() => check('My resize action', true), /already bound to My resize action/);
    }
  }
});
