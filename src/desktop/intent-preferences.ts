import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Small, atomic preferences file beside the desktop database; no transcript data. */
export class IntentPreferences {
  private disabled = new Set<string>();
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<ReadonlySet<string>> {
    try {
      const input: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !Array.isArray(input) ||
        input.some(
          (name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name),
        ) ||
        input.includes('IGNORE')
      ) {
        throw Error('Invalid disabled intent preferences');
      }
      this.disabled = new Set(input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return new Set(this.disabled);
  }

  /** Serialize clicks from multiple UIs; failed writes leave the prior state intact. */
  setEnabled(name: string, enabled: boolean, apply: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      const next = new Set(this.disabled);
      if (enabled) {
        next.delete(name);
      } else {
        next.add(name);
      }

      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify([...next].sort()) + '\n', { mode: 0o600 });
        await rename(temporary, this.path);
        this.disabled = next;
        apply();
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
