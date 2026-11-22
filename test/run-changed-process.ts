// Starts one unit test file for `npm run test:changed`, either inside a sandbox in which the
// checkout holds only the test file's computed inputs, or in the checkout as it is.
//
// The sandbox is bubblewrap (`bwrap`): the whole file system stays visible as it is, and a
// private copy of the inputs is mounted over the checkout's own path. Absolute paths, the tsx
// cache and everything outside the checkout keep working. Every other file git lists is there
// as an empty file that cannot be read: a test that reads an input the rules in
// run-changed-inputs.ts missed fails instead of passing, and a test that only checks whether
// a file exists or lists a directory sees the same names as in the checkout. node_modules is
// mounted from the checkout, because package-lock.json, an input of every test, stands for it.
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { contentHasher } from './run-changed-inputs.ts';
import type { FileOutcome } from './run-changed-reporter.ts';

export interface TestRun {
  /** The process exited with status 0 and reported no failing test, hook or process. */
  succeeded: boolean;
  /**
   * Succeeded, at least one test passed, no test was skipped, todo or cancelled, and the
   * sandbox held the inputs the key describes.
   */
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
  /** What the sandbox holds, repository-relative; undefined runs outside the sandbox. */
  sandbox: SandboxFiles | undefined;
  /** An empty private directory outside the checkout, removed afterwards. */
  workDirectory: string;
}

export interface SandboxFiles {
  /** Copied as they are. */
  inputs: string[];
  /** Present as empty files that cannot be read. */
  unreadable: string[];
  /** The fingerprints of the inputs the key was computed from (see contentHasher). */
  fingerprint: (file: string) => string;
}

/** Whether bwrap is installed and may mount here (user namespaces can be switched off). */
export function sandboxWorks(root: string): boolean {
  const check = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', root, root, 'true'], {
    stdio: 'ignore',
  });
  return check.status === 0;
}

export async function runTestFile(options: TestRunOptions): Promise<TestRun> {
  const { root, test, sandbox, workDirectory } = options;
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
  // False when a copied input differs from what the key was computed from: it changed in
  // between, so a pass must not be saved under that key.
  let copiedAsKeyed = true;
  if (sandbox) {
    const copy = join(workDirectory, 'checkout');
    try {
      copyCheckout(root, copy, sandbox);
    } catch (error) {
      // A file that changed type or vanished while the copy was made: a failure, so that the
      // test file runs once more in the checkout.
      rmSync(workDirectory, { recursive: true, force: true });
      return {
        succeeded: false,
        complete: false,
        output: `Could not prepare the sandbox: ${String(error)}`,
        seconds: (performance.now() - started) / 1000,
      };
    }

    const copied = contentHasher(copy);
    copiedAsKeyed = sandbox.inputs.every((file) => copied(file) === sandbox.fingerprint(file));

    // bwrap reads the source of each mount from the file system as it was before the
    // mounts, so node_modules still comes from the real checkout. A checkout without its own
    // node_modules (a worktree inside another checkout) finds the one above it, which the
    // sandbox leaves as it is. --die-with-parent ends the test when this command is
    // interrupted.
    const nodeModules = join(root, 'node_modules');
    const mountNodeModules = existsSync(nodeModules) ? ['--bind', nodeModules, nodeModules] : [];
    if (mountNodeModules.length) {
      mkdirSync(join(copy, 'node_modules'), { recursive: true });
    }
    command = [
      'bwrap',
      '--dev-bind',
      '/',
      '/',
      '--bind',
      copy,
      root,
      ...mountNodeModules,
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
    complete: succeeded && outcome.passed > 0 && !outcome.partial && copiedAsKeyed,
    output: Buffer.concat(chunks).toString('utf8'),
    seconds: (performance.now() - started) / 1000,
  };
}

/**
 * Builds the sandbox's checkout in `copy`: the inputs, and the unreadable placeholders.
 * Symbolic links are recreated as they are (a dangling one stays dangling), and last, so that
 * no file or directory is ever made through a link, which could lead into the real checkout.
 */
function copyCheckout(root: string, copy: string, sandbox: SandboxFiles): void {
  const inputs = new Set(sandbox.inputs);
  const links: string[] = [];
  for (const file of [...sandbox.inputs, ...sandbox.unreadable]) {
    const source = join(root, file);
    const target = join(copy, file);
    const type = lstatSync(source, { throwIfNoEntry: false });
    if (!type) {
      continue; // gone since the files were listed, so absent in the checkout too
    }
    if (type.isSymbolicLink()) {
      links.push(file);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (inputs.has(file)) {
      copyFileSync(source, target); // keeps the executable bit
    } else {
      writeFileSync(target, '', { mode: 0 });
    }
  }

  for (const file of links) {
    const target = join(copy, file);
    for (let parent = dirname(target); parent !== copy; parent = dirname(parent)) {
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`${file} lies behind a symbolic link`);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(readlinkSync(join(root, file)), target);
  }
}
