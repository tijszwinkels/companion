// Which repository files a unit test file depends on, for `npm run test:changed`.
//
// A test file's inputs are found by three rules:
//   1. Imports: every file it imports, directly or indirectly.
//   2. Paths: every repository file or directory that one of those files names in a quoted
//      string, as in new URL('../fixtures/speech.wav', import.meta.url) or
//      join(here, '..', 'bin', 'companion-phone'). A TypeScript file found this way is
//      followed like an import, because it is usually started as a program.
//   3. Programs: a test that starts programs (a file under test/ that uses
//      node:child_process) or that refers to the checkout root depends on every file in the
//      program directories as well.
// Rule 2 only sees paths written as text. A path built in another way is missed, which is why
// `npm test` keeps running everything.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

export interface TestInputs {
  /** Repository-relative paths, sorted; includes the test file itself. */
  files: string[];
  /** Rule 3 applied: the program directories are among the inputs. */
  startsPrograms: boolean;
}

export interface CollectOptions {
  /** Absolute path of the checkout. */
  root: string;
  /** Repository-relative paths of every file that may be an input. */
  repositoryFiles: string[];
  /** Repository-relative paths of the test files. */
  tests: string[];
  /** Directory prefixes rule 3 adds, for example ['src/', 'bin/']. */
  programDirectories: string[];
}

const SCRIPT = /\.(ts|mts|js|mjs|cjs)$/;
const FOLLOWED = /\.(ts|mts)$/;
const QUOTED = /(['"])([^'"\n]{1,200})\1/g;
const QUOTED_RUN = /(?:(['"])[^'"\n]{1,200}\1\s*,\s*)*(['"])[^'"\n]{1,200}\2/g;

interface PathReferences {
  files: string[];
  root: boolean;
  startsPrograms: boolean;
}

export async function collectTestInputs(options: CollectOptions): Promise<Map<string, TestInputs>> {
  const { root, repositoryFiles, tests, programDirectories } = options;
  const fileSet = new Set(repositoryFiles);

  // Rule 1: file -> the files it imports directly.
  const imports = new Map<string, string[]>();
  const addImportsOf = async (entries: string[]): Promise<void> => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: entries,
      bundle: true,
      write: false,
      metafile: true,
      outdir: join(root, '.run-changed-unused'),
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    for (const [file, input] of Object.entries(result.metafile.inputs)) {
      imports.set(
        file,
        input.imports.filter((entry) => !entry.external).map((entry) => entry.path),
      );
    }
  };

  // Rule 2: file -> the repository files it names by path.
  const references = new Map<string, PathReferences>();
  const referencesOf = (file: string): PathReferences => {
    let found = references.get(file);
    if (found) return found;
    const text = SCRIPT.test(file) ? readFileSync(join(root, file), 'utf8') : '';
    const files = new Set<string>();
    let refersToRoot = false;
    const consider = (literal: string): void => {
      if (literal.length < 2 || /[\s$`\\*]/.test(literal)) return;
      const relativeToFile = literal.startsWith('.');
      if (!relativeToFile && !literal.includes('/') && !fileSet.has(literal)) return;
      const from = relativeToFile ? dirname(join(root, file)) : root;
      const target = relative(root, resolve(from, literal));
      if (target.startsWith('..')) return;
      if (target === '') {
        if (relativeToFile) refersToRoot = true;
      } else if (/^[./]*$/.test(literal)) {
        // '.', '..' and the like count only when they reach the checkout root.
      } else if (fileSet.has(target)) {
        files.add(target);
      } else if (!target.startsWith('node_modules')) {
        const prefix = target + '/';
        for (const inside of repositoryFiles) if (inside.startsWith(prefix)) files.add(inside);
      }
    };
    for (const run of text.matchAll(QUOTED_RUN)) {
      const parts = [...run[0].matchAll(QUOTED)].map((part) => part[2]);
      for (const part of parts) consider(part);
      for (let start = 0; start < parts.length - 1; start++) {
        consider(parts.slice(start).join('/'));
      }
    }
    files.delete(file);
    found = {
      files: [...files],
      root: refersToRoot,
      startsPrograms: file.startsWith('test/') && /['"]node:child_process['"]/.test(text),
    };
    references.set(file, found);
    return found;
  };

  await addImportsOf(tests);
  for (;;) {
    const unknown = new Set<string>();
    for (const file of [...imports.keys()]) {
      for (const target of referencesOf(file).files) {
        if (FOLLOWED.test(target) && !target.endsWith('.d.ts') && !imports.has(target)) {
          unknown.add(target);
        }
      }
    }
    if (!unknown.size) break;
    try {
      await addImportsOf([...unknown]);
    } catch {
      // A file that cannot be bundled still counts as an input, without its imports.
    }
    for (const file of unknown) if (!imports.has(file)) imports.set(file, []);
  }

  const programFiles = repositoryFiles.filter((file) =>
    programDirectories.some((directory) => file.startsWith(directory)),
  );
  const result = new Map<string, TestInputs>();
  for (const test of tests) {
    const seen = new Set<string>([test]);
    const queue = [test];
    let startsPrograms = false;
    while (queue.length) {
      const file = queue.pop()!;
      const found = referencesOf(file);
      if (found.root || found.startsPrograms) startsPrograms = true;
      const imported = imports.get(file) ?? [];
      for (const next of [...imported, ...found.files]) {
        // Another test file that is only named by path is not an input.
        if (seen.has(next) || (next.endsWith('.test.ts') && !imported.includes(next))) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (startsPrograms) for (const file of programFiles) seen.add(file);
    result.set(test, {
      files: [...seen].filter((file) => fileSet.has(file)).sort(),
      startsPrograms,
    });
  }
  return result;
}

/** Content hashes of repository files, read once per instance. */
export function contentHasher(root: string): (file: string) => string {
  const hashes = new Map<string, string>();
  return (file) => {
    let hash = hashes.get(file);
    if (!hash) {
      hash = createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex');
      hashes.set(file, hash);
    }
    return hash;
  };
}

/** One key for a test file: changes when any input's path or content changes. */
export function testKey(
  inputs: TestInputs,
  everyTest: string[],
  hashOf: (file: string) => string,
): string {
  const hash = createHash('sha256');
  for (const line of everyTest) hash.update(`${line}\n`);
  for (const file of inputs.files) hash.update(`${file} ${hashOf(file)}\n`);
  return hash.digest('hex');
}
