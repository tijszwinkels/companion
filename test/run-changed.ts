// Runs only the unit test files whose inputs changed since they last passed.
//
//   npm run test:changed                 run the test files without a saved pass for their inputs
//   npm run test:changed -- --list       show which test files would run, and run nothing
//   npm run test:changed -- --all        run every test file (passes are still saved)
//   npm run test:changed -- <files>      consider only these test files
//
// One key is computed per test file from the content of its inputs (see
// run-changed-inputs.ts for what counts as an input). After a test file passes, a small file
// named after its key is saved outside the repository; a test file whose key is already saved
// is skipped. Failures are never saved. `npm test` does not use any of this and always runs
// everything.
import { execFileSync } from 'node:child_process';
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
import { dirname, join, relative, resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import { collectTestInputs, contentHasher, testKey } from './run-changed-inputs.ts';

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDirectory =
  process.env.COMPANION_TEST_CACHE ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'companion-test-results');

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith('--')));
const named = args.filter((argument) => !argument.startsWith('--'));
for (const flag of flags) {
  if (flag !== '--list' && flag !== '--all') {
    console.error(`Unknown option ${flag}. Options: --list, --all.`);
    process.exit(2);
  }
}

const repositoryFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
)
  .split('\n')
  .filter(
    (file) =>
      file &&
      !file.startsWith('node_modules') &&
      statSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
  );

const tests = (
  named.length
    ? named.map((file) => relative(root, resolve(file)))
    : readdirSync(join(root, 'test/unit'))
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => `test/unit/${name}`)
).sort();
for (const test of tests) {
  if (!repositoryFiles.includes(test)) {
    console.error(`Not a test file in this checkout: ${test}`);
    process.exit(2);
  }
}

const started = performance.now();
const inputs = await collectTestInputs({
  root,
  repositoryFiles,
  tests,
  programDirectories: PROGRAM_DIRECTORIES,
});
function keysNow(): Map<string, string> {
  const hashOf = contentHasher(root);
  const everyTest = [
    FORMAT,
    process.version,
    process.platform,
    process.arch,
    ...EVERY_TEST.filter((file) => repositoryFiles.includes(file)).map(
      (file) => `${file} ${hashOf(file)}`,
    ),
  ];
  return new Map(tests.map((test) => [test, testKey(inputs.get(test)!, everyTest, hashOf)]));
}

const keys = keysNow();
const now = new Date();
const toRun = tests.filter((test) => {
  const saved = join(cacheDirectory, keys.get(test)!);
  if (!existsSync(saved)) return true;
  utimesSync(saved, now, now); // a pass that is still in use is kept
  return flags.has('--all');
});
console.log(
  `${tests.length} test files: ${tests.length - toRun.length} already passed with these inputs, ` +
    `${toRun.length} to run.`,
);
if (flags.has('--list')) {
  for (const test of toRun) {
    const { files, startsPrograms } = inputs.get(test)!;
    const note = startsPrograms ? `, including all of ${PROGRAM_DIRECTORIES.join(' and ')}` : '';
    console.log(`  ${test}  (${files.length} inputs${note})`);
  }
  process.exit(0);
}
if (!toRun.length) process.exit(0);

const failed = new Set<string>();
const passed = new Set<string>();
const stream = run({
  files: toRun.map((test) => join(root, test)),
  cwd: root,
  concurrency: Math.max(1, availableParallelism() - 1), // what `node --test` uses
});
stream.on('test:fail', (event) => {
  if (event.file) failed.add(relative(root, event.file));
});
stream.on('test:pass', (event) => {
  if (event.file) passed.add(relative(root, event.file));
});
stream.compose(spec).pipe(process.stdout);
await new Promise<void>((done) => stream.once('end', () => done()));

// A pass is saved only when the inputs are still what they were before the run.
const keysAfter = keysNow();
mkdirSync(cacheDirectory, { recursive: true });
let saved = 0;
for (const test of toRun) {
  if (failed.has(test) || !passed.has(test)) continue;
  if (keysAfter.get(test) !== keys.get(test)) continue;
  writeFileSync(
    join(cacheDirectory, keys.get(test)!),
    JSON.stringify({ test, passed: new Date().toISOString(), node: process.version }) + '\n',
  );
  saved++;
}
// Saved passes that no run has used for a month are removed.
const oldest = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
for (const name of readdirSync(cacheDirectory)) {
  const path = join(cacheDirectory, name);
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
  if (/^[0-9a-f]{64}$/.test(name) && modified !== undefined && modified < oldest) {
    rmSync(path, { force: true });
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const notSaved = toRun.length - saved - failed.size;
console.log(
  `Ran ${toRun.length} test files in ${seconds} s: ${saved} passes saved, ${failed.size} failed` +
    (notSaved > 0
      ? `, ${notSaved} not saved (no test ran, or an input changed during the run)`
      : '') +
    (failed.size ? `:\n  ${[...failed].join('\n  ')}` : '.'),
);
process.exitCode = failed.size ? 1 : 0;
