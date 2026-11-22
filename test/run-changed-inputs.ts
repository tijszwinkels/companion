// Which repository files a unit test file depends on, for `npm run test:changed`.
//
// A test file's inputs are found by three rules:
//   1. Imports: every file it imports, directly or indirectly.
//   2. Paths: every repository file or directory that one of those files names in a quoted
//      string, as in new URL('../fixtures/speech.wav', import.meta.url) or
//      join(here, '..', 'bin', 'companion-phone'), read from the file's own directory and
//      from each directory above it up to the checkout root. A script found this way is
//      followed like an import, because it is usually started as a program. In a file under
//      test/ that refers to the checkout root, a bare directory name such as 'starter-kit'
//      counts too. A template that is filled in at run time, as in
//      `../../integrations/widgets/${name}.js`, names the whole directory its fixed start
//      names.
//   3. Programs: a test that starts programs (a file under test/ that uses
//      node:child_process) or that refers to the checkout root depends on every file in the
//      program directories as well.
// Rule 2 only sees paths written as text. A path built in another way is missed; run-changed.ts
// runs each test file with only these inputs present, so a missed input fails the test there.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

export interface TestInputs {
  /** Repository-relative paths, sorted; includes the test file itself. */
  files: string[];
  /** Rule 3 applied: the program directories are among the inputs. */
  startsPrograms: boolean;
  /** False when a file's imports could not be read; such a test must run and not be saved. */
  complete: boolean;
}

export interface CollectOptions {
  /** Absolute path of the checkout. */
  root: string;
  /** Repository-relative paths of the checkout's files; directories are expanded from these. */
  repositoryFiles: string[];
  /** Repository-relative paths of the test files. */
  tests: string[];
  /** Directory prefixes rule 3 adds, for example ['src/', 'bin/']. */
  programDirectories: string[];
}

const SCRIPT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
// Backticks are left out on purpose: comments use them around file names, and every file a
// widely imported module mentions in a comment would become an input of most tests.
const QUOTED = /(['"])([^'"\n]{1,200})\1/g;
const QUOTED_RUN = /(?:(['"])[^'"\n]{1,200}\1\s*,\s*)*(['"])[^'"\n]{1,200}\2/g;
// The fixed start of a template up to its first ${…}. Unlike a plain backtick string, such a
// template is code that builds a path or a text at run time, not a name in a comment.
const TEMPLATE_START = /`([^`$\n]{0,200})\$\{/g;

interface PathReferences {
  files: string[];
  root: boolean;
  startsPrograms: boolean;
}

export async function collectTestInputs(options: CollectOptions): Promise<Map<string, TestInputs>> {
  const { root, repositoryFiles, tests, programDirectories } = options;
  const fileSet = new Set(repositoryFiles);

  const isFile = (file: string): boolean =>
    fileSet.has(file) || statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true;

  // Rule 1: file -> the files it imports directly.
  const imports = new Map<string, string[]>();
  const unreadable = new Set<string>(); // files whose imports could not be read
  const bundle = async (entries: string[]): Promise<void> => {
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
  const addImportsOf = async (entries: string[]): Promise<void> => {
    try {
      await bundle(entries);
    } catch {
      // One file that cannot be bundled (a syntax error, a missing import) fails the whole
      // batch, so each entry is tried on its own.
      for (const entry of entries) {
        try {
          await bundle([entry]);
        } catch {
          unreadable.add(entry);
          if (!imports.has(entry)) imports.set(entry, []);
        }
      }
    }
  };

  // Rule 2: file -> the repository files it names by path.
  const references = new Map<string, PathReferences>();
  const referencesOf = (file: string): PathReferences => {
    let found = references.get(file);
    if (found) return found;
    let text = '';
    if (SCRIPT.test(file)) {
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        unreadable.add(file); // gone since the files were listed
      }
    }
    const files = new Set<string>();
    const bareNames = new Set<string>();
    let refersToRoot = false;
    const addDirectory = (directory: string): void => {
      const prefix = directory + '/';
      for (const inside of repositoryFiles) if (inside.startsWith(prefix)) files.add(inside);
    };
    const here = dirname(join(root, file));
    // The file's directory and every directory above it, up to the checkout root.
    const upwards = [here];
    while (upwards.at(-1) !== root) upwards.push(dirname(upwards.at(-1)!));
    const consider = (literal: string): void => {
      if (literal.length < 2 || /[\s$`\\*]/.test(literal)) return;
      const relativeToFile = literal.startsWith('.');
      const bare = !relativeToFile && !literal.includes('/');
      if (bare) bareNames.add(literal);
      // '../x' is read from the file's directory, './x' from there or from the checkout root
      // (the working directory of the tests), any other path from each directory upwards.
      const bases = literal.startsWith('..') ? [here] : relativeToFile ? [here, root] : upwards;
      for (const from of bases) {
        const target = relative(root, resolve(from, literal));
        if (target.startsWith('..') || target.startsWith('node_modules')) continue;
        if (target === '') {
          if (relativeToFile) refersToRoot = true;
        } else if (/^[./]*$/.test(literal)) {
          // '.', '..' and the like count only when they reach the checkout root.
        } else if (bare) {
          // A bare name counts as a file only: a listed one, or one on disk with an extension.
          if (fileSet.has(target) || (literal.includes('.') && isFile(target))) files.add(target);
        } else if (isFile(target)) {
          files.add(target); // also a file git does not list, such as a build result
        } else {
          addDirectory(target);
        }
      }
    };
    for (const run of text.matchAll(QUOTED_RUN)) {
      const parts = [...run[0].matchAll(QUOTED)].map((part) => part[2]);
      for (const part of parts) consider(part);
      for (let start = 0; start < parts.length - 1; start++) {
        consider(parts.slice(start).join('/'));
      }
    }
    // Only the directory part counts: 'widgets/' of `widgets/${name}.js`.
    for (const template of text.matchAll(TEMPLATE_START)) {
      const fixedStart = template[1];
      consider(fixedStart.slice(0, fixedStart.lastIndexOf('/') + 1));
    }
    // A test with the checkout root in hand needs only a bare name to reach a directory.
    // Source files are left out: there every word that is also a directory name would count.
    if (refersToRoot && file.startsWith('test/')) {
      for (const name of bareNames) addDirectory(name);
    }
    files.delete(file);
    found = {
      files: [...files],
      root: refersToRoot,
      startsPrograms: file.startsWith('test/') && /['"](node:)?child_process['"]/.test(text),
    };
    references.set(file, found);
    return found;
  };

  await addImportsOf(tests);
  for (;;) {
    const unknown = new Set<string>();
    for (const file of [...imports.keys()]) {
      for (const target of referencesOf(file).files) {
        if (SCRIPT.test(target) && !target.endsWith('.d.ts') && !imports.has(target)) {
          unknown.add(target);
        }
      }
    }
    if (!unknown.size) break;
    await addImportsOf([...unknown]);
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
    let complete = true;
    while (queue.length) {
      const file = queue.pop()!;
      if (unreadable.has(file)) complete = false;
      const found = referencesOf(file);
      if (found.root || found.startsPrograms) startsPrograms = true;
      for (const next of [...(imports.get(file) ?? []), ...found.files]) {
        if (seen.has(next) || next.includes('node_modules/')) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (startsPrograms) for (const file of programFiles) seen.add(file);
    result.set(test, { files: [...seen].filter(isFile).sort(), startsPrograms, complete });
  }
  return result;
}

/**
 * Fingerprints of files, read once per instance: the content, and whether the file may be
 * executed. A file that is gone gets a fingerprint of its own.
 */
export function contentHasher(root: string): (file: string) => string {
  const hashes = new Map<string, string>();
  return (file) => {
    let hash = hashes.get(file);
    if (!hash) {
      try {
        const path = join(root, file);
        const executable = statSync(path).mode & 0o111;
        hash = `${createHash('sha256').update(readFileSync(path)).digest('hex')} ${executable}`;
      } catch {
        hash = 'missing';
      }
      hashes.set(file, hash);
    }
    return hash;
  };
}

/** One key for a test file: changes when the path, content or mode of any input changes. */
export function testKey(
  test: string,
  inputs: TestInputs,
  everyTest: string[],
  hashOf: (file: string) => string,
): string {
  const hash = createHash('sha256').update(`${test}\n`);
  for (const line of everyTest) hash.update(`${line}\n`);
  for (const file of inputs.files) hash.update(`${file} ${hashOf(file)}\n`);
  return hash.digest('hex');
}
