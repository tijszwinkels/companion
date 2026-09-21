import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Save an observation's PNG or WAV under its utterance UUID. Both artifact types
 * share local-day folders and private atomic writes. Filenames link to SQLite
 * through the UUID; no filesystem paths are stored in the database.
 */
export async function saveArtifact(
  directory: string,
  id: string,
  observedAt: number,
  kind: 'screenshots' | 'audio',
  content: Buffer,
): Promise<void> {
  const path = artifactPath(directory, id, observedAt, kind);
  const temporary = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  try {
    // The sequential sensor worker owns this UUID. Publish only a complete file
    // so a later reader can treat its presence as a finished recording.
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Delete only this UUID's recordings, including incomplete atomic writes. */
export async function removeArtifacts(directory: string, id: string): Promise<void> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw Error('Invalid utterance id');
  }

  const data = join(directory, 'data');
  const days = await readdir(data, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  // Date buckets were named in the timezone used when recording. Search the
  // bucket names, not every recorded file, so a timezone change cannot leave
  // this observation behind. Never remove a directory or another UUID.
  for (const day of days) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) {
      continue;
    }
    for (const [kind, extension] of [
      ['screenshots', 'png'],
      ['audio', 'wav'],
    ]) {
      const path = join(data, day.name, kind, `${id}.${extension}`);
      await rm(path, { force: true });
      await rm(`${path}.tmp`, { force: true });
    }
  }
}

/** Resolve only a database-owned UUID, never an arbitrary path from the UI. */
export function artifactPath(
  directory: string,
  id: string,
  observedAt: number,
  kind: 'screenshots' | 'audio',
): string {
  const date = new Date(observedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const extension = kind === 'screenshots' ? 'png' : 'wav';
  return join(directory, 'data', `${year}-${month}-${day}`, kind, `${id}.${extension}`);
}
