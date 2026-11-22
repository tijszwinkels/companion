// `npm run test:changed` on a small checkout of its own: each test file runs in a sandbox that
// holds only its computed inputs, a test file that needs more takes the fallback and from then
// on depends on every file, and without bwrap every test file runs and nothing is saved.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxWorks } from '../run-changed-process.ts';

const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPTS = [
  'test/run-changed.ts',
  'test/run-changed-inputs.ts',
  'test/run-changed-process.ts',
  'test/run-changed-reporter.ts',
];
const FILES: Record<string, string> = {
  'package.json': '{ "type": "module" }\n',
  'package-lock.json': '{}\n',
  'tsconfig.json': '{}\n',
  // Read through a template: the rules count the whole directory as an input.
  'widgets/host.js': 'export const host = 1;\n',
  'src/document.ts':
    "import { readFileSync } from 'node:fs';\n" +
    "export const read = (name: string): string =>\n  readFileSync(new URL(`../widgets/${name}.js`, import.meta.url), 'utf8');\n",
  // The same from the file's own directory.
  'src/note.txt': 'note\n',
  'src/notes.ts':
    "import { readFileSync } from 'node:fs';\n" +
    "export const note = (name: string): string =>\n  readFileSync(new URL(`./${name}.txt`, import.meta.url), 'utf8');\n",
  'test/unit/template.test.ts':
    "import test from 'node:test';\nimport { read } from '../../src/document.ts';\n" +
    "import { note } from '../../src/notes.ts';\n" +
    "test('reads the widget and the note', () => { read('host'); note('note'); });\n",
  // Read through a path the rules cannot see: only the fallback finds it.
  'data/hidden.txt': 'hidden\n',
  'test/unit/hidden.test.ts':
    "import test from 'node:test';\nimport { readFileSync } from 'node:fs';\n" +
    "const name = 'txt.neddih/atad'.split('').reverse().join('');\n" +
    "test('reads the hidden file', () => { readFileSync(new URL('../../' + name, import.meta.url)); });\n",
  // Reads the hidden file only when it exists: there it exists, but cannot be read.
  'test/unit/probes.test.ts':
    "import test from 'node:test';\nimport { existsSync, readFileSync } from 'node:fs';\n" +
    "const name = 'txt.neddih/atad'.split('').reverse().join('');\n" +
    "test('checks the file if there', () => { if (existsSync(name)) readFileSync(name); });\n",
  // No test at all: never saved as a pass.
  'test/unit/empty.test.ts': 'export {};\n',
  'test/unit/plain.test.ts': "import test from 'node:test';\ntest('passes', () => {});\n",
  'test/unit/fails.test.ts':
    "import test from 'node:test';\ntest('fails', () => { throw new Error('as intended'); });\n",
};

const root = mkdtempSync(join(tmpdir(), 'run-changed-sandbox-'));
const cache = mkdtempSync(join(tmpdir(), 'run-changed-cache-')); // outside the checkout
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});
for (const [file, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
for (const script of SCRIPTS) {
  copyFileSync(join(checkoutRoot, script), join(root, script));
}
symlinkSync(join(checkoutRoot, 'node_modules'), join(root, 'node_modules'));
execFileSync('git', ['init', '--quiet'], { cwd: root });

function testChanged(args: string[], path = process.env.PATH): { output: string; status: number } {
  // Without NODE_TEST_CONTEXT, which tells a test process started by `node --test` how to
  // report, the nested runs report as if started from a terminal.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, COMPANION_TEST_CACHE: cache };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/run-changed.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  return { output: result.stdout + result.stderr, status: result.status ?? -1 };
}

const skip = sandboxWorks(root) ? false : 'bwrap is not available here';

test('the sandbox holds only the inputs, and a missed input takes the fallback', { skip }, () => {
  const first = testChanged([]);
  assert.equal(first.status, 1, first.output);
  assert.match(first.output, /^✔ test\/unit\/template\.test\.ts/m);
  assert.match(first.output, /^✔ test\/unit\/plain\.test\.ts/m);
  assert.match(
    first.output,
    /^↻ test\/unit\/hidden\.test\.ts .* \(missing: data\/hidden\.txt\)\.$/m,
  );
  assert.match(first.output, /^✖ test\/unit\/fails\.test\.ts[^]*as intended/m);
  assert.match(
    first.output,
    /^↻ test\/unit\/probes\.test\.ts .* \(missing: data\/hidden\.txt\)\.$/m,
  );
  assert.match(first.output, /^✔ test\/unit\/empty\.test\.ts .*none passed/m);
  assert.match(
    first.output,
    /4 passes saved, 1 failed, 2 needed files outside .*, 1 passed but not saved/,
  );

  // Only the failure runs again.
  const unchanged = testChanged(['--list']);
  assert.match(unchanged.output, /4 already passed with these inputs, 2 to run/);
  assert.match(unchanged.output, /^ {2}test\/unit\/fails\.test\.ts /m);

  // A file outside every computed input: only the test file that took the fallback runs.
  writeFileSync(join(root, 'data/hidden.txt'), 'changed\n');
  const afterEdit = testChanged(['--list']);
  assert.match(
    afterEdit.output,
    /^ {2}test\/unit\/hidden\.test\.ts .*every file of the repository/m,
  );
  assert.doesNotMatch(afterEdit.output, /template\.test|plain\.test/);

  // A file found by the template rule runs the test that reads it.
  writeFileSync(join(root, 'widgets/host.js'), 'export const host = 2;\n');
  assert.match(testChanged(['--list']).output, /^ {2}test\/unit\/template\.test\.ts /m);

  // A new file changes which files the sandbox shows, so every test file runs again.
  writeFileSync(join(root, 'data/new.txt'), 'new\n');
  assert.match(testChanged(['--list']).output, / 0 already passed with these inputs/);
});

test('without bwrap every test file runs and no pass is used or saved', () => {
  const saved = readdirSync(cache).sort();
  const listed = testChanged(['--list'], '');
  assert.match(listed.output, /bwrap is missing or cannot start/);
  assert.match(listed.output, /^ {2}test\/unit\/plain\.test\.ts$/m);

  const run = testChanged(['test/unit/plain.test.ts'], '');
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /bwrap is missing or cannot start/);
  assert.match(run.output, /pass 1/);
  assert.deepEqual(readdirSync(cache).sort(), saved);
});
