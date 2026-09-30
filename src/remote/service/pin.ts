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
 * It compares the actual bytes on disk with the approved commit's tree and
 * trusts nothing the checkout's owner could have configured to hide a change
 * (review findings M1, including clean filters and work-tree redirection):
 * - Git environment redirections are unset; the checkout must be its own
 *   work tree (`core.worktree` elsewhere is refused), and every later command
 *   uses that explicit Git directory and work tree;
 * - the approved tree is listed without replace refs (GIT_NO_REPLACE_OBJECTS);
 * - every entry must exist with the same type and executable bit, and every
 *   file is hashed with `hash-object --no-filters`: no index, stat cache,
 *   attributes, clean/smudge filters or line-ending conversion is involved,
 *   and no configured command (filter, fsmonitor, external diff) runs;
 * - no symbolic link may appear in the code paths unless the tree has it;
 * - untracked files there are judged only by the tracked top-level
 *   .gitignore (whose bytes were just verified), not by .git/info/exclude, a
 *   global excludes file or new nested .gitignore files.
 * Residual trust: Git's object store and the git binary, owned by the same
 * user or root.
 */
export const pinCheckProgram = [
  'set -u',
  'dir=$1',
  'rev=$2',
  'git=$3',
  'unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'export GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1',
  'tmp=$(mktemp -d) || exit 1',
  'fail() { rm -rf "$tmp"; echo "companion-phone: $dir $1; refusing to start" >&2; exit 1; }',
  'cd "$dir" || fail "cannot be entered"',
  'test "$("$git" rev-parse --show-toplevel 2>/dev/null)" = "$dir" || fail "is not the work tree of its own Git repository"',
  'gd=$("$git" rev-parse --absolute-git-dir 2>/dev/null) || fail "is not a Git checkout"',
  'g() { "$git" --git-dir="$gd" --work-tree="$dir" -c core.fsmonitor=false -c core.untrackedCache=false -c core.splitIndex=false -c core.sparseCheckout=false -c core.quotePath=false "$@"; }',
  'test "$(g rev-parse --verify --quiet "HEAD^{commit}")" = "$rev" || fail "is not at the approved revision $rev"',
  'g ls-tree -r --full-tree "$rev" > "$tmp/tree" || fail "cannot read the approved revision"',
  ': > "$tmp/paths"',
  ': > "$tmp/expected"',
  'while read -r mode type oid path; do case $mode in ' +
    '100644|100755) { test -f "$path" && ! test -L "$path"; } || fail "has a changed file type at $path"; ' +
    'if test -x "$path"; then test "$mode" = 100755 || fail "has a changed file mode at $path"; ' +
    'else test "$mode" = 100644 || fail "has a changed file mode at $path"; fi; ' +
    'echo "$path" >> "$tmp/paths"; echo "$oid" >> "$tmp/expected" ;; ' +
    '120000) { test -L "$path" && test "$(readlink -n -- "$path" | g hash-object --stdin)" = "$oid"; } || fail "has a changed symbolic link at $path" ;; ' +
    '*) fail "has an unsupported $type entry at $path" ;; ' +
    'esac; done < "$tmp/tree"',
  'g hash-object --no-filters --stdin-paths < "$tmp/paths" > "$tmp/actual" || fail "has unreadable tracked files"',
  'cmp -s "$tmp/expected" "$tmp/actual" || fail "has uncommitted changes"',
  `for link in $(find ${pinnedCodePaths.join(' ')} tsconfig.json -type l 2>/dev/null); do ` +
    'test "$(g ls-tree "$rev" -- "$link" | cut -d " " -f 1)" = 120000 || fail "has a symbolic link at $link"; done',
  'export GIT_INDEX_FILE="$tmp/index"',
  'g read-tree "$rev" || fail "cannot read the approved revision"',
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
