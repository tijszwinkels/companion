/**
 * Durable registry of trusted local web apps.
 *
 * A registered app is an ordinary web application whose backend runs on this
 * computer with the OS user's full trust. The registry records only what
 * Companion needs to present it:
 *
 *   id           stable slug chosen by the user
 *   registrationId
 *                random UUID created when the app is added and never reused.
 *                Removing and re-adding the same id creates a new registration:
 *                phone grants/sessions and the desktop profile of the old one
 *                never carry over to it.
 *   name         display label
 *   upstream     the exact loopback origin its backend listens on, for
 *                example `http://127.0.0.1:8123` (literal address, no DNS)
 *   launch       optional executable argv and working directory for
 *                `companion-app run`; never interpreted by a shell
 *   phoneAccess  whether a paired phone may open it; false unless enabled
 *   revision     increases on every change; phone grants bind to it
 *
 * Files (inside the private apps directory, default `~/companion/apps`, 0700):
 *
 *   registry.json   this registry, 0600, replaced by atomic rename
 *   state.lock      permanent flock file serializing CLI writers
 *   profiles/<id>-<registrationId>/
 *                   each registration's persistent desktop browser profile
 *
 * Only the local `companion-app` CLI writes the registry. Nothing derived from a
 * transcript, widget, phone request or page navigation can register an app,
 * change its endpoint or launch command, or enable phone access. App-owned data
 * lives wherever the app itself keeps it; the registry never stores or deletes it.
 */

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { withStateLock } from '../remote/state-lock.ts';

/** How an app's backend is started by `companion-app run`. */
export interface AppLaunch {
  /** Absolute executable path followed by its arguments; no shell is involved. */
  argv: string[];
  /** Absolute working directory for the backend process. */
  cwd: string;
}

export interface RegisteredApp {
  id: string;
  /** Random UUID of this registration; see the module comment. */
  registrationId: string;
  name: string;
  /** Exact origin such as `http://127.0.0.1:8123` or `http://[::1]:8123`. */
  upstream: string;
  launch?: AppLaunch;
  phoneAccess: boolean;
  revision: number;
  /** Unix milliseconds. */
  createdAt: number;
  /** Unix milliseconds. */
  updatedAt: number;
}

interface RegistryFile {
  version: 1;
  apps: RegisteredApp[];
}

/** A parsed loopback upstream: where the proxy and browser connect. */
export interface LoopbackEndpoint {
  /** Canonical origin string, identical to `RegisteredApp.upstream`. */
  origin: string;
  /** Literal address passed to `net.connect`/`http.request`, never a hostname. */
  address: '127.0.0.1' | '::1';
  port: number;
}

/** Fields `companion-app add` supplies; revision and timestamps are assigned here. */
export interface NewApp {
  id: string;
  name: string;
  upstream: string;
  launch?: AppLaunch;
}

/** Explicit changes; omitted fields stay as they are. */
export interface AppChanges {
  name?: string;
  upstream?: string;
  /** `null` removes the launch command. */
  launch?: AppLaunch | null;
  phoneAccess?: boolean;
}

/**
 * IDs double as directory names and as DNS labels in synthetic app hostnames
 * such as `budget.localhost`, so they follow DNS label rules.
 */
const idPattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const registrationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const maximumArguments = 64;
const maximumArgumentLength = 4096;
const maximumApps = 64;

export function defaultAppsDirectory(): string {
  return join(homedir(), 'companion', 'apps');
}

export function checkAppId(id: unknown): string {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw Error(
      'App ID must be 1–32 lowercase letters, digits or inner hyphens (for example "budget")',
    );
  }

  return id;
}

/** Display names are labels only; keep them short and free of control characters. */
export function checkAppName(name: unknown): string {
  if (typeof name !== 'string') {
    throw Error('App name must be text');
  }

  const printable = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
  if (printable.length === 0 || printable.length > 60) {
    throw Error('App name must be 1–60 printable characters');
  }

  return printable;
}

/**
 * Accept only `http://127.0.0.1:PORT` or `http://[::1]:PORT`, with an explicit
 * port and nothing else. Hostnames (including `localhost`) are refused so no
 * DNS answer can redirect the proxy or browser; paths are refused because the
 * app is served at its own root and the proxy never rewrites paths.
 */
export function parseUpstream(upstream: unknown): LoopbackEndpoint {
  if (typeof upstream !== 'string') {
    throw Error('Upstream must be text such as http://127.0.0.1:8123');
  }

  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    throw Error(`Upstream is not a URL: ${upstream}`);
  }

  const withoutSlash = upstream.endsWith('/') ? upstream.slice(0, -1) : upstream;
  if (parsed.origin !== withoutSlash) {
    throw Error(`Upstream must be exactly http://ADDRESS:PORT with no path: ${upstream}`);
  }
  if (parsed.protocol !== 'http:') {
    throw Error('Upstream must use http on a loopback address; TLS is not used on loopback');
  }

  let address: LoopbackEndpoint['address'];
  if (parsed.hostname === '127.0.0.1') {
    address = '127.0.0.1';
  } else if (parsed.hostname === '[::1]') {
    address = '::1';
  } else {
    throw Error('Upstream address must be the literal 127.0.0.1 or [::1], not a hostname');
  }

  // URL drops default ports, so an empty port means :80 was given or omitted.
  const port = Number(parsed.port);
  if (parsed.port === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Error('Upstream must include an explicit port other than 80, for example :8123');
  }

  return { origin: parsed.origin, address, port };
}

export function checkLaunch(launch: unknown): AppLaunch {
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) {
    throw Error('Launch must have argv and cwd');
  }

  const { argv, cwd } = launch as { argv?: unknown; cwd?: unknown };

  if (!Array.isArray(argv) || argv.length === 0 || argv.length > maximumArguments) {
    throw Error(`Launch argv must contain 1–${maximumArguments} entries`);
  }
  for (const argument of argv) {
    if (
      typeof argument !== 'string' ||
      argument.length > maximumArgumentLength ||
      argument.includes('\0')
    ) {
      throw Error('Launch arguments must be text without NUL characters');
    }
  }

  // An absolute executable avoids PATH lookup at launch time: what was
  // registered is what runs, regardless of the caller's environment.
  if (!isAbsolute(argv[0]) || argv[0].length === 0) {
    throw Error('Launch executable must be an absolute path');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
    throw Error('Launch working directory must be an absolute path');
  }

  return { argv: [...(argv as string[])], cwd };
}

/** Validate one stored entry, so a hand-edited registry cannot smuggle in bad values. */
function checkStoredApp(value: unknown): RegisteredApp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('Invalid app entry');
  }

  const entry = value as Record<string, unknown>;
  if (
    typeof entry.registrationId !== 'string' ||
    !registrationIdPattern.test(entry.registrationId)
  ) {
    throw Error('App entry has an invalid registrationId');
  }

  const app: RegisteredApp = {
    id: checkAppId(entry.id),
    registrationId: entry.registrationId,
    name: checkAppName(entry.name),
    upstream: parseUpstream(entry.upstream).origin,
    phoneAccess: entry.phoneAccess === true,
    revision: Number(entry.revision),
    createdAt: Number(entry.createdAt),
    updatedAt: Number(entry.updatedAt),
  };

  if (entry.launch !== undefined) {
    app.launch = checkLaunch(entry.launch);
  }
  if (!Number.isSafeInteger(app.revision) || app.revision < 1) {
    throw Error(`App ${app.id} has an invalid revision`);
  }

  return app;
}

export class AppRegistry {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string = defaultAppsDirectory()) {}

  private get registryPath(): string {
    return join(this.directory, 'registry.json');
  }

  /**
   * Persistent browser profile for one registration's desktop window. It is
   * keyed by the registration, not just the id: a re-added app with the same
   * id starts with a fresh profile instead of inheriting the old app's cookies,
   * while the old profile stays on disk.
   */
  profileDirectory(app: Pick<RegisteredApp, 'id' | 'registrationId'>): string {
    const name = `${checkAppId(app.id)}-${app.registrationId}`;
    if (!registrationIdPattern.test(app.registrationId)) {
      throw Error('Invalid registrationId');
    }

    return join(this.directory, 'profiles', name);
  }

  /**
   * Create (or check) the profile directory and its parent as private,
   * owned, real directories. A symlink anywhere below the apps directory is
   * refused, so a profile cannot be redirected to, for example, a personal
   * browser profile.
   */
  async prepareProfile(app: Pick<RegisteredApp, 'id' | 'registrationId'>): Promise<string> {
    await this.prepare();

    const profiles = join(this.directory, 'profiles');
    await mkdirIfMissing(profiles);
    await checkPrivateDirectory(profiles);

    const profile = this.profileDirectory(app);
    await mkdirIfMissing(profile);
    await checkPrivateDirectory(profile);

    return profile;
  }

  /**
   * Create the private directory. An existing directory must already be
   * private and owned by this user; it is never silently chmod-ed.
   */
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await checkPrivateDirectory(this.directory);
  }

  /** Read the current registry. A missing file is an empty registry. */
  async list(): Promise<RegisteredApp[]> {
    let text: string;

    try {
      text = await readFile(this.registryPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(text) as RegistryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.apps)) {
      throw Error('Unsupported apps registry format');
    }

    return parsed.apps.map(checkStoredApp);
  }

  async get(id: string): Promise<RegisteredApp | undefined> {
    const apps = await this.list();
    return apps.find((app) => app.id === id);
  }

  async add(app: NewApp, now = Date.now()): Promise<RegisteredApp> {
    const entry: RegisteredApp = {
      id: checkAppId(app.id),
      registrationId: randomUUID(),
      name: checkAppName(app.name),
      upstream: parseUpstream(app.upstream).origin,
      phoneAccess: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (app.launch) {
      entry.launch = checkLaunch(app.launch);
    }

    return this.exclusive(async () => {
      const apps = await this.list();

      if (apps.some((existing) => existing.id === entry.id)) {
        throw Error(`An app named ${entry.id} is already registered`);
      }
      if (apps.length >= maximumApps) {
        throw Error(`At most ${maximumApps} apps can be registered`);
      }

      await this.save([...apps, entry]);
      return entry;
    });
  }

  /**
   * Apply explicit changes and advance the revision. Any change, including
   * turning phone access off, invalidates existing phone grants and sessions.
   */
  update(id: string, changes: AppChanges, now = Date.now()): Promise<RegisteredApp> {
    return this.exclusive(async () => {
      const apps = await this.list();
      const index = apps.findIndex((app) => app.id === id);

      if (index < 0) {
        throw Error(`No app named ${id}`);
      }

      const updated: RegisteredApp = { ...apps[index] };
      if (changes.name !== undefined) {
        updated.name = checkAppName(changes.name);
      }
      if (changes.upstream !== undefined) {
        updated.upstream = parseUpstream(changes.upstream).origin;
      }
      if (changes.launch === null) {
        delete updated.launch;
      } else if (changes.launch !== undefined) {
        updated.launch = checkLaunch(changes.launch);
      }
      if (changes.phoneAccess !== undefined) {
        updated.phoneAccess = changes.phoneAccess;
      }
      updated.revision += 1;
      updated.updatedAt = now;

      const next = [...apps];
      next[index] = updated;
      await this.save(next);
      return updated;
    });
  }

  /**
   * Forget an app. Its browser profile and its own data are left in place:
   * removing a registration must not destroy anything the app stored.
   */
  remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const apps = await this.list();
      const remaining = apps.filter((app) => app.id !== id);

      if (remaining.length === apps.length) {
        return false;
      }

      await this.save(remaining);
      return true;
    });
  }

  /** Queue local writers, then lock against every other CLI process. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const locked = async () => {
      await this.prepare();
      return withStateLock(join(this.directory, 'state.lock'), operation);
    };

    const result = this.writes.then(locked, locked);
    this.writes = result.catch(() => {});
    return result;
  }

  private async save(apps: RegisteredApp[]): Promise<void> {
    const file: RegistryFile = { version: 1, apps };
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.registryPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Create one directory level as 0700 unless it already exists. */
async function mkdirIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Refuse directories that are symlinks, not ours, or readable by other users.
 * `lstat` inspects the final path component itself, not a link's target.
 */
export async function checkPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);

  if (info.isSymbolicLink()) {
    throw Error(`${path} is a symbolic link; use a real directory`);
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
