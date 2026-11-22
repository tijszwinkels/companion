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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import {
  collectTestInputs,
  contentHasher,
  testKey,
  type TestInputs,
} from './run-changed-inputs.ts';

const FORMAT = 'test-changed-1';
// Files that are an input of every test.
const EVERY_TEST = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'test/run-changed.ts',
  'test/run-changed-inputs.ts',
];
// What a test that starts programs is taken to depend on.
const PROGRAM_DIRECTORIES = ['src/', 'bin/'];
const KEEP_DAYS = 30;
const UNIT_TEST = /^test\/unit\/[^/]+\.test\.ts$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDirectory =
  process.env.COMPANION_TEST_CACHE ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'companion-test-results');

function stop(message: string): never {
  console.error(message);
  process.exit(2);
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
  inputs: Map<string, TestInputs>;
  keys: Map<string, string>;
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
  const everyTest = [
    FORMAT,
    process.version,
    process.platform,
    process.arch,
    ...EVERY_TEST.map((file) => `${file} ${hashOf(file)}`),
  ];
  const keys = new Map(
    tests.map((test) => [test, testKey(test, inputs.get(test)!, everyTest, hashOf)]),
  );
  return { inputs, keys };
}

const unitTests = listRepositoryFiles().filter((file) => UNIT_TEST.test(file));
for (const file of named) {
  if (!unitTests.includes(file)) stop(`Not a test file in test/unit of this checkout: ${file}`);
}
const tests = (named.length ? named : unitTests).sort();

const started = performance.now();
const before = await snapshot(tests);

mkdirSync(cacheDirectory, { recursive: true });
const saved = (test: string, keys: Map<string, string>): string =>
  join(cacheDirectory, keys.get(test)!);
const now = new Date();
const toRun = tests.filter((test) => {
  if (!before.inputs.get(test)!.complete) return true;
  try {
    utimesSync(saved(test, before.keys), now, now); // a pass that is still in use is kept
  } catch {
    return true; // no saved pass
  }
  return flags.has('--all');
});
// Saved passes that no run has used for a month are removed.
const oldest = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
for (const name of readdirSync(cacheDirectory)) {
  const path = join(cacheDirectory, name);
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
  if (/^[0-9a-f]{64}$/.test(name) && modified !== undefined && modified < oldest) {
    rmSync(path, { force: true });
  }
}

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
    ];
    console.log(`  ${test}  (${notes.join(', ')})`);
  }
  process.exit(0);
}
if (!toRun.length) process.exit(0);

// Node reports one summary per test file, and one for the whole run (without a file).
interface Summary {
  success: boolean;
  counts: { passed: number; skipped: number; todo: number; cancelled: number };
}
const summaries = new Map<string, Summary>();
let runSucceeded = false;
const stream = run({
  files: toRun.map((test) => join(root, test)),
  cwd: root,
  concurrency: Math.max(1, availableParallelism() - 1), // what `node --test` uses
});
stream.on('test:summary', (summary) => {
  if (summary.file) summaries.set(relative(root, summary.file), summary);
  else runSucceeded = summary.success;
});
stream.compose(spec).pipe(process.stdout);
await new Promise<void>((done) => stream.once('end', () => done()));

// A pass is saved only for a test file that ran completely and whose inputs, looked up
// again, are still what they were before the run.
const after = await snapshot(tests);
const failed: string[] = [];
let savedCount = 0;
for (const test of toRun) {
  const summary = summaries.get(test);
  if (!summary?.success) {
    failed.push(test);
    rmSync(saved(test, before.keys), { force: true }); // an earlier pass no longer holds
    continue;
  }
  const { passed, skipped, todo, cancelled } = summary.counts;
  if (passed === 0 || skipped > 0 || todo > 0 || cancelled > 0) continue;
  if (!after.inputs.get(test)!.complete || after.keys.get(test) !== before.keys.get(test)) continue;
  writeFileSync(
    saved(test, before.keys),
    JSON.stringify({ test, passed: new Date().toISOString(), node: process.version }) + '\n',
  );
  savedCount++;
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const notSaved = toRun.length - savedCount - failed.length;
console.log(
  `Ran ${toRun.length} test files in ${seconds} s: ${savedCount} passes saved, ` +
    `${failed.length} failed` +
    (notSaved > 0
      ? `, ${notSaved} passed but not saved (a skipped test, or an input changed during the run)`
      : '') +
    (failed.length ? `:\n  ${failed.join('\n  ')}` : '.'),
);
process.exitCode = runSucceeded && !failed.length ? 0 : 1;
