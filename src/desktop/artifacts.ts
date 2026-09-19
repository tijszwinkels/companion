import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
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
  const date = new Date(observedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const extension = kind === 'screenshots' ? 'png' : 'wav';
  const path = join(directory, 'data', `${year}-${month}-${day}`, kind, `${id}.${extension}`);
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
