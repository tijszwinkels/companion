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
