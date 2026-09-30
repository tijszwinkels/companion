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

  const head = await git(gitExecutable, checkout, ['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== revision) {
    problems.push(
      `${checkout} is at ${head.stdout.trim() || 'an unknown commit'}, not the approved ${revision}`,
    );
  }

  const tracked = await git(gitExecutable, checkout, ['diff', '--quiet', 'HEAD', '--']);
  if (tracked.code !== 0) {
    problems.push(`${checkout} has uncommitted changes to tracked files`);
  }

  const untracked = await git(gitExecutable, checkout, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...pinnedCodePaths,
  ]);
  if (untracked.code !== 0 || untracked.stdout.trim() !== '') {
    problems.push(`${checkout} has untracked files in ${pinnedCodePaths.join(', ')}`);
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
 * Shell program for `ExecStartPre=`. The checkout, revision and git binary
 * arrive as positional parameters ($1, $2, $3), so no value is ever pasted
 * into the program text. It contains no single quote, `%` or backslash, so it
 * survives systemd's command-line parsing unchanged (the `:` prefix in the
 * unit additionally turns off systemd's own `$` expansion).
 */
export const pinCheckProgram = [
  'export GIT_OPTIONAL_LOCKS=0',
  'test "$("$3" -C "$1" rev-parse HEAD)" = "$2" || { echo "companion-phone: $1 is not at the approved revision $2; refusing to start" >&2; exit 1; }',
  '"$3" -C "$1" diff --quiet HEAD -- || { echo "companion-phone: $1 has uncommitted changes; refusing to start" >&2; exit 1; }',
  `test -z "$("$3" -C "$1" ls-files --others --exclude-standard -- ${pinnedCodePaths.join(' ')})" || { echo "companion-phone: $1 has untracked code files; refusing to start" >&2; exit 1; }`,
].join('; ');

/** The complete `ExecStartPre=` value (systemd syntax). */
export function pinCheckCommand(checkout: string, revision: string, gitExecutable: string): string {
  return `:/bin/sh -c '${pinCheckProgram}' companion-phone-pin-check ${checkout} ${revision} ${gitExecutable}`;
}
