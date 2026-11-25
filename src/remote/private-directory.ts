/**
 * Refuse to keep gateway secrets or sockets in a directory other users can
 * reach or redirect.
 *
 * Input: a directory path that should belong to the current user only.
 * Output: nothing on success; an Error explaining the refusal otherwise.
 *
 * `lstat` (not `stat`) is deliberate: a symlink at the final path component
 * could point the gateway at a directory someone else controls, so a
 * symlink is refused rather than followed. We never chmod an existing
 * directory; someone may have made it readable on purpose, and silently
 * tightening it would hide that mistake.
 */

import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);

  if (info.isSymbolicLink()) {
    throw Error(`${path} is a symbolic link; use the real directory path`);
  }
  if (!info.isDirectory()) {
    throw Error(`${path} is not a directory`);
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw Error(`${path} is not owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw Error(`${path} must not be accessible to other users (chmod 700)`);
  }
}

/**
 * `assertPrivateDirectory`, and also every directory above it, because
 * whoever may write to a parent can rename the directory away and put
 * another in its place. Used for the runtime directory of a listener started
 * without a desktop (`--headless`), whose control socket the gateway finds by
 * that path.
 *
 * The rule, the same as the same-user session API's
 * (src/agents/external/paths.ts):
 * - the path is absolute and canonical, and no component of it, the final
 *   one included, is a symbolic link;
 * - every ancestor is owned by the current user or by root, and is writable
 *   by nobody else, unless it is root-owned and sticky (like `/tmp`, where
 *   other users cannot rename this user's entries);
 * - the directory itself passes `assertPrivateDirectory`.
 *
 * Input: the directory path. Output: nothing on success; an Error naming the
 * first component that fails otherwise. A check by path: it does not hold
 * the directories open, so it guards against a wrong setup, not against a
 * change made while the listener starts.
 */
export async function assertPrivateDirectoryPath(path: string): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw Error(`${path} must be an absolute, canonical path`);
  }

  const components = path.split('/').filter(Boolean);
  let ancestor = '';

  // Every directory above the final one, from the root down.
  for (const component of components.slice(0, -1)) {
    ancestor += '/' + component;
    const info = await lstat(ancestor);

    if (info.isSymbolicLink()) {
      throw Error(`${ancestor} is a symbolic link; use the real directory path`);
    }
    if (!info.isDirectory()) {
      throw Error(`${ancestor} is not a directory`);
    }

    const ownedByUser = process.getuid !== undefined && info.uid === process.getuid();
    const ownedByRoot = info.uid === 0;
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;

    if (!ownedByUser && !ownedByRoot) {
      throw Error(`${ancestor} is owned by another user`);
    }
    if (writableByOthers && !(ownedByRoot && sticky)) {
      throw Error(`${ancestor} is writable by other users, who could replace ${path}`);
    }
  }

  await assertPrivateDirectory(path);
}
