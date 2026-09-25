import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The persisted transcription cleanup switch: a tiny file beside the database
 * (`~/companion/transcription-cleanup.json` for the live app), holding
 * `{"version":1,"enabled":true|false}` and no transcript data.
 *
 * A missing file means off, so a fresh install and every older checkout
 * behave exactly as before cleanup existed. Deleting the file, or clicking
 * the switch off, returns to the raw ASR text for the next utterance.
 * A malformed file is refused at startup rather than guessed.
 */
export class CleanupPreference {
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<boolean> {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      (input as { version?: unknown }).version !== 1 ||
      typeof (input as { enabled?: unknown }).enabled !== 'boolean'
    ) {
      throw Error('Invalid transcription cleanup preference');
    }

    return (input as { enabled: boolean }).enabled;
  }

  /**
   * Serialize clicks. Persist atomically first, then apply, so the running
   * state never claims a choice that was not saved.
   */
  set(enabled: boolean, apply: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, enabled }) + '\n', {
          mode: 0o600,
        });
        await rename(temporary, this.path);
        apply();
      } finally {
        await rm(temporary, { force: true });
      }
    });

    this.writes = write.catch(() => {});
    return write;
  }
}
