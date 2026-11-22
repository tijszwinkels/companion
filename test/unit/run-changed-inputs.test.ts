import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { collectTestInputs, contentHasher, testKey } from '../run-changed-inputs.ts';

// A small checkout: each test file shows one way of depending on other files.
const FILES: Record<string, string> = {
  // './b.js' is the file b.ts: only reading the import finds it, not the text of the path.
  'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/program.ts': "import { b } from './b.js';\nconsole.log(b);\n",
  'src/unrelated.ts': 'export const unrelated = true;\n',
  'src/broken.ts': 'export const broken = ;\n',
  'bin/tool': '#!/bin/sh\n',
  'docs/guide.md': '# Guide\n',
  'docs/other.md': '# Other\n',
  'kit/skill.md': '# Skill\n',
  'build/result.txt': 'built\n',
  'test/fixtures/data.json': '{}\n',
  'test/unit/imports.test.ts': "import { a } from '../../src/a.js';\nconsole.log(a);\n",
  'test/unit/url.test.ts':
    "const data = new URL('../fixtures/data.json', import.meta.url);\nconsole.log(data);\n",
  'test/unit/joined.test.ts':
    "import { join } from 'node:path';\n" +
    'const here = import.meta.dirname;\n' +
    "console.log(join(here, '..', '..', 'docs', 'guide.md'), ['.', '..'], 'kit');\n",
  'test/unit/program.test.ts':
    "const program = new URL('../../src/program.ts', import.meta.url);\nconsole.log(program);\n",
  'test/unit/spawns.test.ts': "import { spawn } from 'node:child_process';\nconsole.log(spawn);\n",
  'test/unit/root.test.ts':
    "import { join } from 'node:path';\n" +
    "const root = new URL('../../', import.meta.url).pathname;\n" +
    "console.log(join(root, 'kit'));\n",
  'test/unit/names.test.ts': "console.log('test/unit/url.test.ts', '../../build/result.txt');\n",
  'test/unit/broken.test.ts':
    "import { broken } from '../../src/broken.js';\nconsole.log(broken);\n",
};
// A build result: on disk, but not among the files git lists.
const UNLISTED = ['build/result.txt'];
const PROGRAMS = [
  'bin/tool',
  'src/a.ts',
  'src/b.ts',
  'src/broken.ts',
  'src/program.ts',
  'src/unrelated.ts',
];

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'run-changed-'));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function collect(root: string) {
  const repositoryFiles = Object.keys(FILES).filter((file) => !UNLISTED.includes(file));
  return collectTestInputs({
    root,
    repositoryFiles,
    tests: repositoryFiles.filter((file) => file.endsWith('.test.ts')),
    programDirectories: ['src/', 'bin/'],
  });
}

// One checkout for every test; only the last test changes files, after the inputs are known.
const root = checkout();
after(() => rmSync(root, { recursive: true, force: true }));
const inputs = await collect(root);

test('imports are followed to the files they import in turn', () => {
  assert.deepEqual(inputs.get('test/unit/imports.test.ts'), {
    files: ['src/a.ts', 'src/b.ts', 'test/unit/imports.test.ts'],
    startsPrograms: false,
    complete: true,
  });
});

test('a file named by a path relative to the test is an input', () => {
  assert.deepEqual(inputs.get('test/unit/url.test.ts')!.files, [
    'test/fixtures/data.json',
    'test/unit/url.test.ts',
  ]);
});

test('path parts given one by one are joined; lone dots and bare names are not inputs', () => {
  assert.deepEqual(inputs.get('test/unit/joined.test.ts'), {
    files: ['docs/guide.md', 'test/unit/joined.test.ts'],
    startsPrograms: false,
    complete: true,
  });
});

test('a TypeScript file named by path brings its own imports', () => {
  assert.deepEqual(inputs.get('test/unit/program.test.ts')!.files, [
    'src/b.ts',
    'src/program.ts',
    'test/unit/program.test.ts',
  ]);
});

test('a named test file and a file git does not list are inputs', () => {
  assert.deepEqual(inputs.get('test/unit/names.test.ts')!.files, [
    'build/result.txt',
    'test/fixtures/data.json',
    'test/unit/names.test.ts',
    'test/unit/url.test.ts',
  ]);
});

test('a test that starts programs depends on the program directories', () => {
  assert.deepEqual(inputs.get('test/unit/spawns.test.ts'), {
    files: [...PROGRAMS, 'test/unit/spawns.test.ts'],
    startsPrograms: true,
    complete: true,
  });
});

test('a test that names the checkout root also reaches a directory by its bare name', () => {
  assert.deepEqual(inputs.get('test/unit/root.test.ts'), {
    files: [...PROGRAMS, 'kit/skill.md', 'test/unit/root.test.ts'].sort(),
    startsPrograms: true,
    complete: true,
  });
});

test('a test whose imports cannot be read is marked, and the others are unaffected', () => {
  const broken = inputs.get('test/unit/broken.test.ts')!;
  assert.equal(broken.complete, false);
  assert.ok(broken.files.includes('test/unit/broken.test.ts'));
  for (const [name, input] of inputs) {
    if (name !== 'test/unit/broken.test.ts') assert.equal(input.complete, true, name);
  }
});

test('a key changes exactly when an input changes', () => {
  const keys = () => {
    const hashOf = contentHasher(root);
    return new Map(
      [...inputs].map(([name, input]) => [name, testKey(name, input, ['node'], hashOf)]),
    );
  };
  const changedBetween = (earlier: Map<string, string>, later: Map<string, string>) =>
    [...earlier.keys()].filter((name) => earlier.get(name) !== later.get(name)).sort();
  const before = keys();
  assert.deepEqual(keys(), before);

  writeFileSync(join(root, 'src/b.ts'), 'export const b = 2;\n');
  const edited = keys();
  assert.deepEqual(changedBetween(before, edited), [
    'test/unit/imports.test.ts',
    'test/unit/program.test.ts',
    'test/unit/root.test.ts',
    'test/unit/spawns.test.ts',
  ]);

  // Becoming executable, and disappearing, change the key of the tests that use the file.
  chmodSync(join(root, 'bin/tool'), 0o755);
  const executable = keys();
  assert.deepEqual(changedBetween(edited, executable), [
    'test/unit/root.test.ts',
    'test/unit/spawns.test.ts',
  ]);
  rmSync(join(root, 'bin/tool'));
  assert.deepEqual(changedBetween(executable, keys()), [
    'test/unit/root.test.ts',
    'test/unit/spawns.test.ts',
  ]);

  // The test file's own name and what every test depends on are part of the key.
  const url = inputs.get('test/unit/url.test.ts')!;
  const hashOf = contentHasher(root);
  const key = testKey('test/unit/url.test.ts', url, ['node'], hashOf);
  assert.equal(key, before.get('test/unit/url.test.ts'));
  assert.notEqual(testKey('test/unit/url.test.ts', url, ['another node'], hashOf), key);
  assert.notEqual(testKey('test/unit/other.test.ts', url, ['node'], hashOf), key);
});
