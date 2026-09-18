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

test('installer fails closed when compositor bindings cannot be inspected', () => {
  for (const bindings of ['invalid JSON', '{}', '[null]', '[{"key":"C"}]']) {
    assert.throws(
      () => assertShortcutsAvailable(bindings, true),
      /Cannot check shortcut conflicts/,
    );
  }
});
