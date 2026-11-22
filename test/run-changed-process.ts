// Starts one unit test file for `npm run test:changed`, either inside a sandbox in which the
// checkout holds only the test file's computed inputs, or in the checkout as it is.
//
// The sandbox is bubblewrap (`bwrap`): the whole file system stays visible as it is, and a
// private copy of the inputs is mounted over the checkout's own path. Absolute paths, the tsx
// cache and everything outside the checkout keep working; an input that the rules in
// run-changed-inputs.ts missed is absent, so a test that needs it fails instead of passing.
// node_modules is mounted from the checkout, because package-lock.json, an input of every
// test, stands for it.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileOutcome } from './run-changed-reporter.ts';

export interface TestRun {
  /** The process exited with status 0 and reported no failing test, hook or process. */
  succeeded: boolean;
  /** Succeeded, at least one test passed, and no test was skipped, todo or cancelled. */
  complete: boolean;
  /** What the spec reporter and the test process wrote, stdout and stderr together. */
  output: string;
  /** Wall-clock duration in seconds. */
  seconds: number;
}

export interface TestRunOptions {
  /** Absolute path of the checkout. */
  root: string;
  /** Repository-relative path of the test file. */
  test: string;
  /** The files the sandbox holds, repository-relative; undefined runs outside the sandbox. */
  sandboxFiles: string[] | undefined;
  /** An empty private directory outside the checkout, removed afterwards. */
  workDirectory: string;
}

/** Whether bwrap is installed and may mount here (user namespaces can be switched off). */
export function sandboxWorks(root: string): boolean {
  const check = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', root, root, 'true'], {
    stdio: 'ignore',
  });
  return check.status === 0;
}

export async function runTestFile(options: TestRunOptions): Promise<TestRun> {
  const { root, test, sandboxFiles, workDirectory } = options;
  const started = performance.now();
  const outcomeFile = join(workDirectory, 'outcome.json');
  mkdirSync(workDirectory, { recursive: true });

  const node = [
    process.execPath,
    '--import',
    'tsx',
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${join(root, 'test/run-changed-reporter.ts')}`,
    `--test-reporter-destination=${outcomeFile}`,
    test,
  ];
  let command = node;
  if (sandboxFiles) {
    const copy = join(workDirectory, 'checkout');
    for (const file of sandboxFiles) {
      mkdirSync(dirname(join(copy, file)), { recursive: true });
      copyFileSync(join(root, file), join(copy, file)); // keeps the executable bit
    }
    mkdirSync(join(copy, 'node_modules'), { recursive: true }); // where node_modules is mounted

    // bwrap reads the source of each mount from the file system as it was before the
    // mounts, so node_modules still comes from the real checkout. --die-with-parent ends
    // the test when this command is interrupted.
    const nodeModules = join(root, 'node_modules');
    command = [
      'bwrap',
      '--dev-bind',
      '/',
      '/',
      '--bind',
      copy,
      root,
      '--bind',
      nodeModules,
      nodeModules,
      '--chdir',
      root,
      '--die-with-parent',
      ...node,
    ];
  }

  const chunks: Buffer[] = [];
  const exitCode = await new Promise<number | null>((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });

  // No outcome file (the process could not start or was killed) counts as a failure.
  let outcome: FileOutcome = { succeeded: false, passed: 0, partial: true };
  try {
    outcome = JSON.parse(readFileSync(outcomeFile, 'utf8')) as FileOutcome;
  } catch {
    // Keeps the failure above.
  }
  rmSync(workDirectory, { recursive: true, force: true });

  const succeeded = exitCode === 0 && outcome.succeeded;
  return {
    succeeded,
    complete: succeeded && outcome.passed > 0 && !outcome.partial,
    output: Buffer.concat(chunks).toString('utf8'),
    seconds: (performance.now() - started) / 1000,
  };
}
