import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What the saved capture-storage file says, as read at startup.
 *
 * - `saved`: a valid `{"version":1,"enabled":…}` file.
 * - `missing`: no file. This is the normal state of every installation that
 *   never touched the switch, fresh or upgraded; it means off.
 * - `invalid`: the file exists but could not be read or does not match the
 *   schema exactly. Storage stays off and the file is left untouched.
 */
export type CaptureStoragePreferenceRead =
  { status: 'saved'; enabled: boolean } | { status: 'missing' } | { status: 'invalid' };

/**
 * The persisted "Save captured audio and screenshots" choice: a tiny file
 * beside the utterance database (`~/companion/capture-storage.json` for the
 * live app), holding `{"version":1,"enabled":true|false}` and nothing else.
 *
 * Unlike the transcription cleanup preference, an unreadable or malformed
 * file does not stop the listener: privacy fails closed (off) while normal
 * processing stays available. Loading never repairs or rewrites the file;
 * only a later explicit settings action saves a new one.
 *
 * Writes are atomic and private: a uniquely named 0600 temporary file in the
 * same 0700 directory is flushed to disk and then renamed over the old file,
 * so a crash leaves either the old or the new complete file. The caller
 * (CaptureStoragePolicy) serializes writes.
 */
export class CaptureStoragePreference {
  constructor(readonly path: string) {}

  async load(): Promise<CaptureStoragePreferenceRead> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'missing' };
      }
      return { status: 'invalid' };
    }

    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return { status: 'invalid' };
    }

    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      (input as { version?: unknown }).version !== 1 ||
      typeof (input as { enabled?: unknown }).enabled !== 'boolean'
    ) {
      return { status: 'invalid' };
    }

    return { status: 'saved', enabled: (input as { enabled: boolean }).enabled };
  }

  /** Atomically replace the saved choice. Rejects when it may not be durable. */
  async save(enabled: boolean): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The directory normally already exists (it holds the database). Keep it
    // private like the database directory, without touching its ancestors.
    await chmod(directory, 0o700);

    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, enabled }) + '\n');
        // A privacy choice must survive a crash right after "saved" is shown.
        await file.sync();
      } finally {
        await file.close();
      }

      await rename(temporary, this.path);

      // Make the rename itself durable before reporting success.
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      // Only this write's own temporary file; never another writer's.
      await rm(temporary, { force: true });
    }
  }
}
