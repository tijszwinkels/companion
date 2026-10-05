/**
 * Retained `fetch_content` results, so that `get_search_content` can read
 * them later by `responseId`, as with Pi.
 *
 * Pi keeps these in its session; Companion's bridge process ends with each
 * turn, so the results are files instead, and a later turn of the same
 * conversation (or its next bridge) can read them.
 *
 * - Location: `$XDG_RUNTIME_DIR/companion-claude-web`. The runtime directory
 *   is private to the user and cleared at logout. Without it, nothing is
 *   retained and results say so.
 * - The directory must be a real directory (not a symlink) owned by this user
 *   with no group/other permissions; it is created 0700 and never repaired.
 * - One 0600 file per result, named by a random 128-bit ID; reads open it
 *   without following symlinks. IDs are unguessable, but same-user processes
 *   can list the directory: this is privacy from other users, not isolation
 *   between conversations. Contents are public web pages the agent fetched.
 * - Results expire after `retentionMilliseconds`. After each write, expired
 *   files are deleted and then the oldest ones until the total is at most
 *   `maximumStoreBytes`.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const retentionMilliseconds = 24 * 60 * 60 * 1000;
export const maximumStoreBytes = 64 * 1024 * 1024;

/** One requested URL of a `fetch_content` call. */
export interface StoredUrl {
  /** The URL as requested; `get_search_content({ url })` matches this. */
  url: string;
  /** The final URL after redirects, when different. */
  finalUrl?: string;
  title: string;
  content: string;
  error?: string;
  mediaType?: string;
  status?: number;
}

export interface StoredFetch {
  id: string;
  type: 'fetch';
  timestamp: number;
  urls: StoredUrl[];
}

const idPattern = /^[0-9a-f]{32}$/;

export function newResponseId(): string {
  return randomBytes(16).toString('hex');
}

export class ContentStore {
  /**
   * @param directory Where results are kept; `undefined` disables retention.
   * @param now Clock, replaceable in tests.
   */
  constructor(
    private readonly directory: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The store for the bridge's environment (see the module comment). */
  static forEnvironment(environment: NodeJS.ProcessEnv): ContentStore {
    const runtime = environment.XDG_RUNTIME_DIR;
    const usable = typeof runtime === 'string' && runtime.startsWith('/');
    return new ContentStore(usable ? join(runtime, 'companion-claude-web') : undefined);
  }

  /** Why nothing can be retained, or `undefined` when retention is possible. */
  get unavailableReason(): string | undefined {
    return this.directory ? undefined : 'XDG_RUNTIME_DIR is not set';
  }

  /** Create or check the private directory. Throws when it is unsafe. */
  private async privateDirectory(): Promise<string> {
    if (!this.directory) {
      throw Error(this.unavailableReason);
    }

    await mkdir(this.directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });

    const status = await lstat(this.directory);
    const owner = process.getuid?.();
    if (
      !status.isDirectory() ||
      (owner !== undefined && status.uid !== owner) ||
      (status.mode & 0o077) !== 0
    ) {
      throw Error(`${this.directory} is not a private directory owned by this user`);
    }

    return this.directory;
  }

  /** Write one result, then prune. Throws when it cannot be retained. */
  async save(data: StoredFetch): Promise<void> {
    if (!idPattern.test(data.id)) {
      throw Error('Invalid response ID');
    }

    const directory = await this.privateDirectory();
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > maximumStoreBytes) {
      throw Error('The fetched content is too large to retain');
    }

    // Write a temporary file and rename it, so readers never see a partial file.
    const temporary = join(directory, `${data.id}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `${data.id}.json`));

    await this.prune(directory);
  }

  /** Read a result by ID, or `undefined` when unknown, expired or unavailable. */
  async load(id: string): Promise<StoredFetch | undefined> {
    if (!idPattern.test(id) || !this.directory) {
      return undefined;
    }

    const directory = await this.privateDirectory();
    const path = join(directory, `${id}.json`);

    let text: string;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const status = await file.stat();
        if (this.now() - status.mtimeMs > retentionMilliseconds) {
          await rm(path, { force: true });
          return undefined;
        }
        text = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    return JSON.parse(text) as StoredFetch;
  }

  /** Delete expired results, then the oldest until within `maximumStoreBytes`. */
  private async prune(directory: string): Promise<void> {
    const entries: { path: string; size: number; modified: number }[] = [];
    for (const name of await readdir(directory)) {
      if (!/^[0-9a-f]{32}\.json$/.test(name)) {
        continue;
      }

      const path = join(directory, name);
      const status = await stat(path).catch(() => undefined);
      if (!status) {
        continue;
      }

      if (this.now() - status.mtimeMs > retentionMilliseconds) {
        await rm(path, { force: true });
      } else {
        entries.push({ path, size: status.size, modified: status.mtimeMs });
      }
    }

    entries.sort((left, right) => left.modified - right.modified);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= maximumStoreBytes) {
        break;
      }
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}
