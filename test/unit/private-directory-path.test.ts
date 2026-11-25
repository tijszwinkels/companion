// The rule of assertPrivateDirectoryPath (src/remote/private-directory.ts):
// the runtime directory of a listener started without a desktop, and every
// directory above it, must be such that no other user can replace it.
//
// One table of cases on real directories under a temporary directory (in
// the system's temporary directory, itself normally the root-owned sticky
// /tmp). Cases that need another user or root to own a directory cannot be
// made by an unprivileged test; root-owned ancestors are covered by every
// case's real path (/, /tmp) and by the machine's own /run/user/<uid>.

import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertPrivateDirectoryPath } from '../../src/remote/private-directory.ts';

/** The reason a path is refused, or '' when it passes. */
async function refusal(path: string): Promise<string> {
  try {
    await assertPrivateDirectoryPath(path);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

test('a runtime directory is private only if no other user can replace it or a directory above it', async (context) => {
  // The real path of the temporary directory, so no case meets a symbolic
  // link it did not make itself (on some systems /tmp is one).
  const base = await mkdtemp(join(await realpath(tmpdir()), 'companion-private-path-'));
  context.after(() => rm(base, { recursive: true, force: true }));
  await chmod(base, 0o700);

  // Builds one case's directories and returns the path to check.
  async function privateDirectory(parent: string, name: string): Promise<string> {
    const path = join(parent, name);
    await mkdir(path, { recursive: true });
    await chmod(path, 0o700);
    return path;
  }

  const ordinary = await privateDirectory(base, 'ordinary/run');
  await chmod(join(base, 'ordinary'), 0o755);

  const openParent = join(base, 'open-parent');
  const underOpenParent = await privateDirectory(openParent, 'run');
  await chmod(openParent, 0o777);

  const groupParent = join(base, 'group-parent');
  const underGroupParent = await privateDirectory(groupParent, 'run');
  await chmod(groupParent, 0o770);

  // Sticky, but owned by this user rather than root: only a root-owned
  // sticky directory such as /tmp is accepted.
  const ownSticky = join(base, 'own-sticky');
  const underOwnSticky = await privateDirectory(ownSticky, 'run');
  await chmod(ownSticky, 0o1777);

  const realParent = join(base, 'real-parent');
  await privateDirectory(realParent, 'run');
  await symlink(realParent, join(base, 'linked-parent'));

  await symlink(ordinary, join(base, 'linked-final'));

  const sharedFinal = join(base, 'shared-final');
  await mkdir(sharedFinal);
  await chmod(sharedFinal, 0o770);

  const cases: Array<[string, string, RegExp | '']> = [
    ['ordinary: private, below directories only this user can write', ordinary, ''],
    ['an ancestor anyone may write to', underOpenParent, /open-parent is writable by other users/],
    ['an ancestor its group may write to', underGroupParent, /group-parent is writable by other/],
    ['a sticky ancestor owned by this user, not root', underOwnSticky, /own-sticky is writable/],
    ['a symbolic link above it', join(base, 'linked-parent', 'run'), /linked-parent is a symbolic/],
    ['the directory itself is a symbolic link', join(base, 'linked-final'), /symbolic link/],
    ['the directory itself is open to its group', sharedFinal, /chmod 700/],
    ['a missing directory', join(base, 'missing'), /ENOENT/],
    ['not canonical', `${base}/ordinary/../ordinary/run`, /absolute, canonical/],
    ['relative', 'run', /absolute, canonical/],
  ];

  for (const [name, path, expected] of cases) {
    const reason = await refusal(path);
    if (expected === '') {
      assert.equal(reason, '', name);
    } else {
      assert.match(reason, expected, name);
    }
  }

  // Every case above lies below the system's temporary directory. When that
  // is the root-owned sticky /tmp, it is an accepted ancestor (the ordinary
  // case passed through it).
  const temporary = await stat(await realpath(tmpdir()));
  if (temporary.uid === 0 && (temporary.mode & 0o1000) !== 0) {
    assert.equal(await refusal(ordinary), '', 'below a root-owned sticky directory');
  }
});

test('the ordinary per-user runtime directory /run/user/<uid> passes', async (context) => {
  const path = `/run/user/${process.getuid!()}`;
  try {
    await access(path);
  } catch {
    context.skip(`${path} does not exist on this machine`);
    return;
  }
  assert.equal(await refusal(path), '');
});
