import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Lua is already needed by the desktop integration. Keeping the fixture in Lua
// exercises the installed binding source without translating its logic to JS.
test('history finishes only after every shortcut key is released', async () => {
  const fixture = fileURLToPath(new URL('../omarchy-shortcut.lua', import.meta.url));
  const bindings = fileURLToPath(
    new URL('../../integrations/omarchy/bindings.lua', import.meta.url),
  );
  const result = await promisify(execFile)('lua', [fixture, bindings]);
  assert.match(result.stdout, /PASS all release permutations/);
});
