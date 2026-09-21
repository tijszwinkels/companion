import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { IntentMode } from '../core/router.ts';

export interface DisabledIntents {
  inference: ReadonlySet<string>;
  shortcut: ReadonlySet<string>;
}

function names(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) ||
    value.includes('IGNORE')
  ) {
    throw Error('Invalid disabled intent preferences');
  }
  return value;
}

/** Small, atomic preferences file beside the database; no transcript data. */
export class IntentPreferences {
  private disabled: DisabledIntents = { inference: new Set(), shortcut: new Set() };
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<DisabledIntents> {
    try {
      const input: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (Array.isArray(input)) {
        // The old switch disabled both routes. Preserve that decision until
        // the user changes either mode; only the next click rewrites the file.
        const legacy = names(input);
        this.disabled = { inference: new Set(legacy), shortcut: new Set(legacy) };
      } else {
        if (!input || typeof input !== 'object' || !('version' in input) || input.version !== 1) {
          throw Error('Invalid disabled intent preferences');
        }
        const saved = input as { disabledInference?: unknown; disabledShortcuts?: unknown };
        this.disabled = {
          inference: new Set(names(saved.disabledInference)),
          shortcut: new Set(names(saved.disabledShortcuts)),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return {
      inference: new Set(this.disabled.inference),
      shortcut: new Set(this.disabled.shortcut),
    };
  }

  /** Serialize clicks; persist before applying and retain the other mode's state. */
  setEnabled(name: string, enabled: boolean, apply: () => void, mode?: IntentMode): Promise<void> {
    const write = this.writes.then(async () => {
      const next = {
        inference: new Set(this.disabled.inference),
        shortcut: new Set(this.disabled.shortcut),
      };
      const modes: IntentMode[] = mode ? [mode] : ['inference', 'shortcut'];
      for (const route of modes) {
        if (enabled) {
          next[route].delete(name);
        } else {
          next[route].add(name);
        }
      }

      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const saved = {
          version: 1,
          disabledInference: [...next.inference].sort(),
          disabledShortcuts: [...next.shortcut].sort(),
        };
        await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 });
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
