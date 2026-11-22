// Runs only the unit test files whose inputs changed since they last passed.
//
//   npm run test:changed                 run the test files without a saved pass for their inputs
//   npm run test:changed -- --list       show which test files would run, and run nothing
//   npm run test:changed -- --all        run every test file (passes are still saved)
//   npm run test:changed -- <files>      consider only these files from test/unit
//
// One key is computed per test file from the content of its inputs (see
// run-changed-inputs.ts for what counts as an input). After a test file passes, a small file
// named after its key is saved outside the repository; a test file whose key is already saved
// is skipped. A failure is never saved, and neither is a file in which a test was skipped.
// `npm test` does not use any of this and always runs everything.
//
// Each test file runs in a sandbox in which the checkout holds only its inputs
// (run-changed-process.ts), so an input the rules missed makes it fail rather than pass. A
// test file that fails there runs once more in the checkout as it is. When it passes there,
// its inputs are incomplete: from then on it depends on every file of the repository, and a
// small marker file, named after its computed key, remembers that until its inputs change.
// Without a working sandbox every test file runs, and no pass is used or saved.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTestInputs,
  contentHasher,
  testKey,
  type TestInputs,
} from './run-changed-inputs.ts';
import { runTestFile, sandboxWorks, type TestRun } from './run-changed-process.ts';

const FORMAT = 'test-changed-2';
// Files that are an input of every test, and are in every sandbox.
const EVERY_TEST = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'test/run-changed.ts',
  'test/run-changed-inputs.ts',
  'test/run-changed-process.ts',
  'test/run-changed-reporter.ts',
];
// What a test that starts programs is taken to depend on.
const PROGRAM_DIRECTORIES = ['src/', 'bin/'];
const KEEP_DAYS = 30;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDirectory =
  process.env.COMPANION_TEST_CACHE ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'companion-test-results');

function stop(message: string): never {
  console.error(message);
  process.exit(2);
}
// The sandbox hides the checkout's own files, so the copies and results must be elsewhere.
const cacheInCheckout = relative(root, cacheDirectory);
const cacheOutside = cacheInCheckout === '..' || cacheInCheckout.startsWith('../');
if (!cacheOutside && !isAbsolute(cacheInCheckout)) {
  stop(`The cache directory must be outside the checkout: ${cacheDirectory}`);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith('--')));
const named = args
  .filter((argument) => !argument.startsWith('--'))
  .map((file) => relative(root, resolve(file)));
for (const flag of flags) {
  if (flag !== '--list' && flag !== '--all')
    stop(`Unknown option ${flag}. Options: --list, --all.`);
}
// With a filter only part of a test file runs, and that must not be saved as a pass.
const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`;
if (/--test[-_](name[-_]pattern|skip[-_]pattern|only|shard|rerun[-_]failures)/.test(nodeOptions)) {
  stop('npm run test:changed cannot be combined with Node test filters. Use npm test instead.');
}

function listRepositoryFiles(): string[] {
  let listed: string;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    stop('npm run test:changed needs a git checkout to list the files. Use npm test instead.');
  }
  return listed
    .split('\0')
    .filter(
      (file) =>
        file &&
        !file.startsWith('node_modules') &&
        statSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
    );
}

interface Snapshot {
  repositoryFiles: string[];
  inputs: Map<string, TestInputs>;
  keys: Map<string, string>;
  /** The key of a test file that depends on every file of the repository. */
  wholeRepositoryKey: (test: string) => string;
}

// The inputs and keys of the given test files as the checkout is now.
async function snapshot(tests: string[]): Promise<Snapshot> {
  const repositoryFiles = listRepositoryFiles();
  const inputs = await collectTestInputs({
    root,
    repositoryFiles,
    tests,
    programDirectories: PROGRAM_DIRECTORIES,
  });
  const hashOf = contentHasher(root);
  // The sandbox shows every file git lists by name (run-changed-process.ts), so a test can
  // observe which files exist; adding, removing or renaming a file changes every key.
  const names = createHash('sha256')
    .update([...repositoryFiles].sort().join('\n'))
    .digest('hex');
  const everyTest = [
    FORMAT,
    process.version,
    process.platform,
    process.arch,
    `names ${names}`,
    ...EVERY_TEST.map((file) => `${file} ${hashOf(file)}`),
  ];
  const keys = new Map(
    tests.map((test) => [test, testKey(test, inputs.get(test)!, everyTest, hashOf)]),
  );
  // Every file git lists, and the computed inputs, which may include a build result that git
  // does not list. Computed only for the test files that need it.
  const wholeRepositoryKey = (test: string): string => {
    const files = [...new Set([...repositoryFiles, ...inputs.get(test)!.files])].sort();
    const whole = { files, startsPrograms: true, complete: inputs.get(test)!.complete };
    return testKey(test, whole, ['whole repository', ...everyTest], hashOf);
  };
  // Every file is read now, so that the key of a test file that turns out to need the whole
  // repository describes the checkout at this moment, not at a later first use.
  for (const file of repositoryFiles) {
    hashOf(file);
  }
  return { repositoryFiles, inputs, keys, wholeRepositoryKey };
}

// The same files as `npm test`: test/unit/*.test.ts, whether git lists them or not.
const unitTests = readdirSync(join(root, 'test/unit'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `test/unit/${name}`);
for (const file of named) {
  if (!unitTests.includes(file)) stop(`Not a test file in test/unit of this checkout: ${file}`);
}
const tests = (named.length ? named : unitTests).sort();

// Without a sandbox a missed input could not show itself, so nothing may be skipped.
if (!sandboxWorks(root)) {
  console.log(
    'bwrap is missing or cannot start here, so npm run test:changed runs every test file ' +
      'like npm test, without using or saving passes.',
  );
  if (flags.has('--list')) {
    for (const test of tests) {
      console.log(`  ${test}`);
    }
    process.exit(0);
  }
  const fullRun = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(fullRun.status ?? 1);
}

const started = performance.now();
const before = await snapshot(tests);

mkdirSync(cacheDirectory, { recursive: true });
// Saved passes and markers that no run has used for a month are removed.
const oldest = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
for (const name of readdirSync(cacheDirectory)) {
  const path = join(cacheDirectory, name);
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
  if (/^[0-9a-f]{64}$/.test(name) && modified !== undefined && modified < oldest) {
    rmSync(path, { force: true });
  }
}

// The marker that says a test file needs the whole repository is named after its computed
// key, so it stops holding as soon as the computed inputs change.
const markerOf = (computedKey: string): string =>
  join(
    cacheDirectory,
    createHash('sha256').update(`needs the whole repository\n${computedKey}`).digest('hex'),
  );
const now = new Date();
// Marks a saved file as still in use, so that it is kept; false when it does not exist.
const touch = (path: string): boolean => {
  try {
    utimesSync(path, now, now);
    return true;
  } catch {
    return false;
  }
};
const wholeRepository = new Set(tests.filter((test) => touch(markerOf(before.keys.get(test)!))));
const keyOf = (state: Snapshot, test: string): string =>
  wholeRepository.has(test) ? state.wholeRepositoryKey(test) : state.keys.get(test)!;
const saved = (test: string): string => join(cacheDirectory, keyOf(before, test));

const toRun = tests.filter((test) => {
  if (!before.inputs.get(test)!.complete) return true;
  if (!touch(saved(test))) return true; // no saved pass
  if (!flags.has('--all')) return false;
  // An interrupted --all run leaves no pass behind; --list changes nothing.
  if (!flags.has('--list')) rmSync(saved(test), { force: true });
  return true;
});
console.log(
  `${tests.length} test files: ${tests.length - toRun.length} already passed with these inputs, ` +
    `${toRun.length} to run.`,
);
if (flags.has('--list')) {
  for (const test of toRun) {
    const { files, startsPrograms, complete } = before.inputs.get(test)!;
    const notes = [
      `${files.length} inputs`,
      ...(startsPrograms ? [`including all of ${PROGRAM_DIRECTORIES.join(' and ')}`] : []),
      ...(complete ? [] : ['imports could not be read, so it always runs']),
      ...(wholeRepository.has(test)
        ? ['failed with only these inputs, so it depends on every file of the repository']
        : []),
    ];
    console.log(`  ${test}  (${notes.join(', ')})`);
  }
  process.exit(0);
}

// The sandbox copies of a run are in a directory named after its process ID. A directory
// whose process is gone was left behind by an interrupted run.
const sandboxDirectory = join(cacheDirectory, 'sandboxes');
mkdirSync(sandboxDirectory, { recursive: true });
for (const name of readdirSync(sandboxDirectory)) {
  if (!processExists(Number(name))) {
    rmSync(join(sandboxDirectory, name), { recursive: true, force: true });
  }
}
// A directory left by an earlier run with this process ID is emptied as well.
const runDirectory = join(sandboxDirectory, String(process.pid));
rmSync(runDirectory, { recursive: true, force: true });

if (!toRun.length) process.exit(0);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
}

// The first file of the checkout that a test's output names and that was not in its sandbox:
// an absolute path, or the quoted path of a failed file operation (relative to the checkout,
// the working directory of the test).
function missingPath(output: string, sandboxFiles: Set<string>): string | undefined {
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absolute = new RegExp(`${escapedRoot}/([^\\s'"\`),:]+)`, 'g');
  const operation = /(?:ENOENT|EACCES)[^'\n]*'([^'\n]+)'/g;
  const named = [
    ...[...output.matchAll(absolute)].map((match) => match[1]),
    ...[...output.matchAll(operation)].map((match) => relative(root, resolve(root, match[1]))),
  ];
  for (const file of named) {
    if (!sandboxFiles.has(file) && existsSync(join(root, file))) {
      return file;
    }
  }
  return undefined;
}

// One test file: in the sandbox, and once more in the checkout when it fails there. Prints one
// line per test file, with the output of a failure below it.
const runs = new Map<string, TestRun>();
let fellBack = 0;
async function runOne(test: string, index: number): Promise<void> {
  const workDirectory = join(runDirectory, String(index));
  let result: TestRun | undefined;
  let sandboxRun: TestRun | undefined;
  const sandboxFiles = new Set([...EVERY_TEST, ...before.inputs.get(test)!.files]);
  if (!wholeRepository.has(test)) {
    const unreadable = before.repositoryFiles.filter((file) => !sandboxFiles.has(file));
    const sandbox = { inputs: [...sandboxFiles], unreadable };
    sandboxRun = await runTestFile({ root, test, sandbox, workDirectory });
    if (sandboxRun.succeeded) {
      result = sandboxRun;
    }
  }
  if (!result) {
    result = await runTestFile({ root, test, sandbox: undefined, workDirectory });
    if (sandboxRun && result.succeeded) {
      wholeRepository.add(test);
      writeFileSync(markerOf(before.keys.get(test)!), JSON.stringify({ test }) + '\n');
      fellBack++;
      const missing = missingPath(sandboxRun.output, sandboxFiles);
      console.log(
        `↻ ${test} failed with only its computed inputs and passed with the whole checkout, ` +
          `so it depends on every file of the repository until its inputs change` +
          (missing ? ` (missing: ${missing}).` : '.'),
      );
    }
  }
  runs.set(test, result);

  const seconds = `${result.seconds.toFixed(1)} s`;
  if (result.complete) {
    console.log(`✔ ${test} (${seconds})`);
  } else if (result.succeeded) {
    console.log(`✔ ${test} (${seconds}; a test was skipped, todo or cancelled, or none passed)`);
  } else {
    console.log(`✖ ${test} (${seconds})\n${result.output.trimEnd()}\n`);
  }
}

// As many test files at a time as `node --test` runs. The workers share nextIndex; each takes
// the next test file synchronously, between awaits, so no file is taken twice.
const concurrency = Math.max(1, availableParallelism() - 1);
let nextIndex = 0;
const workers = Array.from({ length: Math.min(concurrency, toRun.length) }, async () => {
  while (nextIndex < toRun.length) {
    const index = nextIndex;
    nextIndex++;
    await runOne(toRun[index], index);
  }
});
await Promise.all(workers);
rmSync(runDirectory, { recursive: true, force: true });

// A pass is saved only for a test file that ran completely and whose inputs, looked up
// again, are still what they were before the run. Any other outcome removes an earlier pass.
const after = await snapshot(tests);
const failed: string[] = [];
let savedCount = 0;
for (const test of toRun) {
  const result = runs.get(test)!;
  if (!result.succeeded) {
    failed.push(test);
  }
  if (!result.complete) {
    rmSync(saved(test), { force: true });
    continue;
  }
  if (!after.inputs.get(test)!.complete || keyOf(after, test) !== keyOf(before, test)) continue;
  writeFileSync(
    saved(test),
    JSON.stringify({ test, passed: new Date().toISOString(), node: process.version }) + '\n',
  );
  savedCount++;
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const notSaved = toRun.length - savedCount - failed.length;
console.log(
  `Ran ${toRun.length} test files in ${seconds} s: ${savedCount} passes saved, ` +
    `${failed.length} failed` +
    (fellBack > 0 ? `, ${fellBack} needed files outside their computed inputs` : '') +
    (notSaved > 0
      ? `, ${notSaved} passed but not saved (a skipped test, or an input changed during the run)`
      : '') +
    (failed.length ? `:\n  ${failed.join('\n  ')}` : '.'),
);
process.exitCode = failed.length ? 1 : 0;
