/**
 * Keep the phone gateway on reviewed code (security review item H1).
 *
 * The gateway service runs directly from a Git checkout. It must run exactly
 * the approved commit: a later checkout, merge, edit or stray file must stop
 * it from starting rather than silently change what phones talk to. Two
 * checks enforce that:
 *
 * 1. `verifyPinnedCheckout()` runs in `companion-phone configure` and before
 *    every `start`, with readable explanations.
 * 2. `pinCheckCommand()` is the unit's `ExecStartPre=`, so systemd repeats the
 *    essential part before each automatic restart as well.
 *
 * What is pinned: HEAD, every tracked file, and the absence of untracked (not
 * ignored) files where code lives. Not pinned: `node_modules` and the built
 * phone app in `integrations/mobile/dist` (ignored build output). Changing
 * them requires running as this user, which can already change everything
 * else this user runs; that residual risk is documented, not hidden.
 */

import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Where untracked files would change what runs. */
export const pinnedCodePaths = ['src', 'bin', 'integrations', 'package.json', 'package-lock.json'];

/** Options the gateway must understand for the service to be safe. */
const requiredGatewayOptions = ["'check-tailscale-serve'", "'require-tailscale-login'", 'listen:'];

/** Git must never write in the checkout while we inspect it (read-only in the unit). */
const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

function git(
  gitExecutable: string,
  checkout: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      gitExecutable,
      ['-C', checkout, ...args],
      { env: gitEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the checkout against its approved revision. Returns a list of
 * problems in plain language; an empty list means it may be started.
 */
export async function verifyPinnedCheckout(
  checkout: string,
  revision: string,
  gitExecutable: string,
): Promise<string[]> {
  // The path itself: a real directory, with no symlink anywhere in it, owned
  // by us. A symlinked path could be repointed at other code after review.
  let canonical: string;
  try {
    canonical = await realpath(checkout);
  } catch {
    return [`Checkout ${checkout} does not exist`];
  }
  if (canonical !== checkout) {
    return [`Checkout ${checkout} contains a symbolic link (it resolves to ${canonical})`];
  }
  const info = await lstat(checkout);
  if (!info.isDirectory()) {
    return [`Checkout ${checkout} is not a directory`];
  }
  if (process.getuid && info.uid !== process.getuid()) {
    return [`Checkout ${checkout} is not owned by the current user`];
  }

  const problems: string[] = [];

  const topLevel = await git(gitExecutable, checkout, ['rev-parse', '--show-toplevel']);
  if (topLevel.code !== 0 || topLevel.stdout.trim() !== checkout) {
    return [`${checkout} is not the top directory of a Git checkout`];
  }

  // The Git checks are the very program systemd runs before every start,
  // so the two can never disagree.
  const pin = await runPinCheck(checkout, revision, gitExecutable);
  if (pin !== undefined) {
    problems.push(pin);
  }

  // What the unit will execute must be present.
  if (!(await exists(join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs')))) {
    problems.push(`${checkout} has no installed dependencies (run npm ci there)`);
  }
  if (!(await exists(join(checkout, 'integrations', 'mobile', 'dist', 'index.html')))) {
    problems.push(`${checkout} has no built phone app (run npm run mobile:build there)`);
  }

  let gatewaySource = '';
  try {
    gatewaySource = await readFile(join(checkout, 'src', 'remote', 'cli.ts'), 'utf8');
  } catch {
    problems.push(`${checkout} has no src/remote/cli.ts`);
  }
  for (const option of requiredGatewayOptions) {
    if (gatewaySource && !gatewaySource.includes(option)) {
      problems.push(
        `The gateway in ${checkout} lacks ${option.replaceAll("'", '')}; it is too old`,
      );
    }
  }

  return problems;
}

/**
 * Shell program for `ExecStartPre=` and for `verifyPinnedCheckout()`. The
 * checkout, revision and git binary arrive as positional parameters ($1, $2,
 * $3), so no value is ever pasted into the program text. It contains no
 * single quote, `%` or backslash, so it survives systemd's command-line
 * parsing unchanged (the `:` prefix in the unit additionally turns off
 * systemd's own `$` expansion).
 *
 * It compares the files on disk with the approved commit's own tree, and
 * trusts nothing the checkout's owner could have configured to hide changes:
 * - a fresh temporary index built from that commit, re-hashing every file,
 *   so assume-unchanged / skip-worktree flags and stale stat data in the
 *   checkout's index cannot mask an edit;
 * - no replace refs (GIT_NO_REPLACE_OBJECTS), so a substituted commit or tree
 *   cannot stand in for the approved one;
 * - no fsmonitor, untracked cache, split index, sparse checkout or external
 *   diff, which could run commands or answer from a cache;
 * - untracked files are judged only by the tracked top-level .gitignore (just
 *   verified unchanged), not by .git/info/exclude, a global excludes file or
 *   new .gitignore files inside the code directories.
 * Residual trust: Git's object store itself, owned by the same user.
 */
export const pinCheckProgram = [
  'set -u',
  'dir=$1',
  'rev=$2',
  'git=$3',
  'export GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0',
  'g() { "$git" -C "$dir" -c core.fsmonitor=false -c core.untrackedCache=false -c core.splitIndex=false -c core.sparseCheckout=false "$@"; }',
  'tmp=$(mktemp -d) || exit 1',
  'fail() { rm -rf "$tmp"; echo "companion-phone: $dir $1; refusing to start" >&2; exit 1; }',
  'test "$(g rev-parse --verify --quiet "HEAD^{commit}")" = "$rev" || fail "is not at the approved revision $rev"',
  'export GIT_INDEX_FILE="$tmp/index"',
  'g read-tree "$rev" || fail "cannot read the approved revision"',
  'g update-index -q --really-refresh >/dev/null 2>&1',
  'g diff-files --quiet --no-ext-diff || fail "has uncommitted changes"',
  `test -z "$(g ls-files --others --exclude-from=.gitignore -- ${pinnedCodePaths.join(' ')})" || fail "has untracked code files"`,
  'rm -rf "$tmp"',
].join('; ');

/** Run the pin program; undefined when the checkout passes, else its message. */
export function runPinCheck(
  checkout: string,
  revision: string,
  gitExecutable: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', pinCheckProgram, 'companion-phone-pin-check', checkout, revision, gitExecutable],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve(undefined);
          return;
        }
        const message = String(stderr)
          .trim()
          .replace(/^companion-phone: /, '');
        resolve(message || `the pin check failed (${error.message})`);
      },
    );
  });
}

/** The complete `ExecStartPre=` value (systemd syntax). */
export function pinCheckCommand(checkout: string, revision: string, gitExecutable: string): string {
  return `:/bin/sh -c '${pinCheckProgram}' companion-phone-pin-check ${checkout} ${revision} ${gitExecutable}`;
}
