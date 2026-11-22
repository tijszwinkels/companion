import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectTestInputs, contentHasher, testKey } from '../run-changed-inputs.ts';

// A small checkout: each test file shows one way of depending on other files.
const FILES: Record<string, string> = {
  'src/a.ts': "import { b } from './b.ts';\nexport const a = b + 1;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/program.ts': "import { b } from './b.ts';\nconsole.log(b);\n",
  'src/unrelated.ts': 'export const unrelated = true;\n',
  'bin/tool': '#!/bin/sh\n',
  'docs/guide.md': '# Guide\n',
  'docs/other.md': '# Other\n',
  'test/fixtures/data.json': '{}\n',
  'test/unit/imports.test.ts': "import { a } from '../../src/a.ts';\nconsole.log(a);\n",
  'test/unit/url.test.ts':
    "const data = new URL('../fixtures/data.json', import.meta.url);\nconsole.log(data);\n",
  'test/unit/joined.test.ts':
    "import { join } from 'node:path';\n" +
    'const here = import.meta.dirname;\n' +
    "console.log(join(here, '..', '..', 'docs', 'guide.md'), ['.', '..'], 'test/unit/imports.test.ts');\n",
  'test/unit/program.test.ts':
    "const program = new URL('../../src/program.ts', import.meta.url);\nconsole.log(program);\n",
  'test/unit/spawns.test.ts': "import { spawn } from 'node:child_process';\nconsole.log(spawn);\n",
  'test/unit/root.test.ts':
    "const root = new URL('../../', import.meta.url);\nconsole.log(root);\n",
};

function checkout(context: { after(cleanup: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'run-changed-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function collect(root: string) {
  const repositoryFiles = Object.keys(FILES);
  return collectTestInputs({
    root,
    repositoryFiles,
    tests: repositoryFiles.filter((file) => file.endsWith('.test.ts')),
    programDirectories: ['src/', 'bin/'],
  });
}

test('imports are followed to the files they import in turn', async (context) => {
  const inputs = await collect(checkout(context));
  assert.deepEqual(inputs.get('test/unit/imports.test.ts'), {
    files: ['src/a.ts', 'src/b.ts', 'test/unit/imports.test.ts'],
    startsPrograms: false,
  });
});

test('a file named by a path relative to the test is an input', async (context) => {
  const inputs = await collect(checkout(context));
  assert.deepEqual(inputs.get('test/unit/url.test.ts')!.files, [
    'test/fixtures/data.json',
    'test/unit/url.test.ts',
  ]);
});

test('path parts given one by one are joined; lone dots and other tests are not inputs', async (context) => {
  const inputs = await collect(checkout(context));
  assert.deepEqual(inputs.get('test/unit/joined.test.ts'), {
    files: ['docs/guide.md', 'test/unit/joined.test.ts'],
    startsPrograms: false,
  });
});

test('a TypeScript file named by path brings its own imports', async (context) => {
  const inputs = await collect(checkout(context));
  assert.deepEqual(inputs.get('test/unit/program.test.ts')!.files, [
    'src/b.ts',
    'src/program.ts',
    'test/unit/program.test.ts',
  ]);
});

test('a test that starts programs or names the checkout root depends on the program directories', async (context) => {
  const inputs = await collect(checkout(context));
  for (const name of ['test/unit/spawns.test.ts', 'test/unit/root.test.ts']) {
    assert.deepEqual(inputs.get(name), {
      files: ['bin/tool', 'src/a.ts', 'src/b.ts', 'src/program.ts', 'src/unrelated.ts', name],
      startsPrograms: true,
    });
  }
});

test('a key changes exactly when the content of an input changes', async (context) => {
  const root = checkout(context);
  const inputs = await collect(root);
  const keys = () => {
    const hashOf = contentHasher(root);
    return new Map([...inputs].map(([name, input]) => [name, testKey(input, ['node'], hashOf)]));
  };
  const before = keys();
  assert.deepEqual(keys(), before);

  writeFileSync(join(root, 'src/b.ts'), 'export const b = 2;\n');
  const after = keys();
  const changed = [...before.keys()].filter((name) => before.get(name) !== after.get(name));
  assert.deepEqual(changed.sort(), [
    'test/unit/imports.test.ts',
    'test/unit/program.test.ts',
    'test/unit/root.test.ts',
    'test/unit/spawns.test.ts',
  ]);

  const hashOf = contentHasher(root);
  assert.notEqual(
    testKey(inputs.get('test/unit/url.test.ts')!, ['another node'], hashOf),
    after.get('test/unit/url.test.ts'),
    'what every test depends on is part of the key',
  );
});
