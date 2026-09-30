/**
 * Settings of the supervised phone gateway service (`companion-phone`).
 *
 * The service runs `companion-remote serve` from one pinned, reviewed checkout
 * behind a persistent Tailscale Serve route to a private Unix socket. Nothing
 * about a particular machine is built in: the tailnet name, the required
 * Tailscale login, the checkout and its approved revision all come from this
 * small private JSON file, written by `companion-phone configure`.
 *
 * Input: the JSON file (or values from `configure`). Output: a validated
 * `PhoneServiceConfig`, or an Error that says which value is unsafe.
 *
 * Every value ends up as an argument of a systemd transient unit. Instead of
 * trying to quote arbitrary text for systemd and a shell, values are limited
 * to a conservative character set that needs no quoting at all: no spaces,
 * quotes, `$`, `%`, `\`, `;` or control characters. A path that needs any of
 * those is refused with an explanation, never escaped.
 */

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export const configVersion = 1;

export interface PhoneServiceConfig {
  version: typeof configVersion;
  /** The one tailnet HTTPS origin on port 443, e.g. `https://desk.tailnet.ts.net`. */
  origin: string;
  /** The Tailscale login every request must carry, e.g. `user@github`. */
  tailscaleLogin: string;
  /** Canonical absolute path of the checkout the gateway runs from. */
  checkout: string;
  /** Full commit ID that checkout must be at, approved after review. */
  revision: string;
  /** Absolute path of the real `node` binary (not a version-manager shim). */
  nodeExecutable: string;
  /** Durable private pairing state (devices.json holds token hashes only). */
  stateDirectory: string;
  /** Saved conversations, read for screenshots. */
  sessionsDirectory: string;
  /** The desktop listener's private control socket. */
  controlSocket: string;
  /** systemd unit name without `.service`. */
  unitName: string;
  /** Directory below the runtime directory that holds `gateway.sock`. */
  runtimeDirectoryName: string;
}

export const defaultUnitName = 'companion-phone-gateway';
export const defaultRuntimeDirectoryName = 'companion-phone';

/** Characters allowed in paths: letters, digits and `/ . _ + -`. */
const safePathPattern = /^\/[A-Za-z0-9/._+-]*$/;

/** A DNS name in lower case, at least two labels (MagicDNS names have more). */
const hostnamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Tailscale logins look like `name@github` or `name@example.com`. */
const loginPattern = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

/** SHA-1 (40) or SHA-256 (64) object IDs, lower-case hex. */
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Unit and runtime directory names: lower case, digits and hyphens. */
const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Unix socket paths are limited to 108 bytes including the terminator. */
const maximumSocketPathBytes = 100;

/**
 * Refuse a path that systemd or a shell could interpret: it must be absolute,
 * already normalized (no `.`/`..` segments, doubled or trailing slashes) and
 * made only of safe characters.
 */
export function assertSafePath(label: string, path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw Error(`${label} must be an absolute path`);
  }
  if (!safePathPattern.test(path)) {
    throw Error(
      `${label} may contain only letters, digits and / . _ + - (no spaces, quotes, $ or %): ${JSON.stringify(path)}`,
    );
  }
  if (path.length > 1 && (normalize(path) !== path || path.endsWith('/'))) {
    throw Error(`${label} must be a normalized path without . or .. segments: ${path}`);
  }
}

/** The exact origin string: `https://` plus a lower-case host name, nothing else. */
export function assertOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw Error(`--origin is not a URL: ${JSON.stringify(origin)}`);
  }

  const exact = `https://${url.hostname}`;
  if (url.protocol !== 'https:' || origin !== exact || !hostnamePattern.test(url.hostname)) {
    throw Error(
      '--origin must be exactly https://HOST (the tailnet name, lower case, port 443, no path), ' +
        `for example https://desk.tailnet-name.ts.net; got ${JSON.stringify(origin)}`,
    );
  }
  return url.hostname;
}

/** Check every field; returns the config unchanged or throws. */
export function validateConfig(value: unknown): PhoneServiceConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Error('The phone service config must be a JSON object');
  }

  const config = value as Record<string, unknown>;
  const known = new Set([
    'version',
    'origin',
    'tailscaleLogin',
    'checkout',
    'revision',
    'nodeExecutable',
    'stateDirectory',
    'sessionsDirectory',
    'controlSocket',
    'unitName',
    'runtimeDirectoryName',
  ]);
  for (const key of Object.keys(config)) {
    if (!known.has(key)) {
      throw Error(`Unknown phone service setting: ${key}`);
    }
  }

  if (config.version !== configVersion) {
    throw Error(`Unsupported phone service config version: ${String(config.version)}`);
  }

  assertOrigin(String(config.origin));

  const login = config.tailscaleLogin;
  if (typeof login !== 'string' || login.length > 254 || !loginPattern.test(login)) {
    throw Error('--tailscale-login must look like name@github or name@example.com');
  }

  if (typeof config.revision !== 'string' || !revisionPattern.test(config.revision)) {
    throw Error('--revision must be a full lower-case commit ID (40 or 64 hex characters)');
  }

  assertSafePath('--checkout', config.checkout as string);
  assertSafePath('--node', config.nodeExecutable as string);
  assertSafePath('--state-directory', config.stateDirectory as string);
  assertSafePath('--sessions-directory', config.sessionsDirectory as string);
  assertSafePath('--control-socket', config.controlSocket as string);

  if (typeof config.unitName !== 'string' || !namePattern.test(config.unitName)) {
    throw Error('--unit-name may contain only lower-case letters, digits and hyphens');
  }
  if (
    typeof config.runtimeDirectoryName !== 'string' ||
    !namePattern.test(config.runtimeDirectoryName)
  ) {
    throw Error('--runtime-directory-name may contain only lower-case letters, digits and hyphens');
  }

  return config as unknown as PhoneServiceConfig;
}

/** The tailnet host name of a validated config. */
export function configHostname(config: PhoneServiceConfig): string {
  return new URL(config.origin).hostname;
}

/**
 * The runtime directory systemd uses for `RuntimeDirectory=` in the user
 * manager (`%t`). Transient unit properties do not expand `%t`, so the tool
 * computes the same path itself. If it ever differed, the gateway could not
 * create its socket there (the rest of /run is read-only in the sandbox) and
 * the start fails instead of serving somewhere unexpected.
 */
export function runtimeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.XDG_RUNTIME_DIR;
  if (!root) {
    throw Error('XDG_RUNTIME_DIR is not set; run this from your user session');
  }
  assertSafePath('XDG_RUNTIME_DIR', root);
  return root;
}

/** Absolute path of the gateway's Unix socket, which Tailscale Serve proxies to. */
export function gatewaySocketPath(config: PhoneServiceConfig, root: string): string {
  const path = join(root, config.runtimeDirectoryName, 'gateway.sock');
  if (Buffer.byteLength(path) > maximumSocketPathBytes) {
    throw Error(`Gateway socket path is too long for a Unix socket: ${path}`);
  }
  return path;
}

/** Defaults for `configure`, mirroring `companion-remote`'s own defaults. */
export function defaultStateDirectory(): string {
  return join(homedir(), 'companion', 'remote');
}

export function defaultSessionsDirectory(): string {
  return join(homedir(), 'companion', 'agents', '.companion-sessions');
}

export function defaultControlSocket(environment: NodeJS.ProcessEnv = process.env): string {
  return join(runtimeRoot(environment), 'companion', 'control.sock');
}

/**
 * Where the config lives: `--config`, else `$COMPANION_PHONE_CONFIG`, else
 * `$XDG_CONFIG_HOME/companion/phone-gateway.json` (`~/.config/...`).
 */
export function configPath(
  explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    explicit ??
    environment.COMPANION_PHONE_CONFIG ??
    join(
      environment.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'companion',
      'phone-gateway.json',
    );

  if (!isAbsolute(path)) {
    throw Error(`The config path must be absolute: ${path}`);
  }
  return path;
}

/**
 * Refuse a file or directory another user could have written: it must be
 * ours, not a symlink, and not writable by group or others. (It is not
 * secret, but whoever can edit it decides which code the service runs.)
 */
async function assertOwnedAndUnshared(path: string, kind: 'file' | 'directory'): Promise<void> {
  const info = await lstat(path);

  if (info.isSymbolicLink()) {
    throw Error(`${path} is a symbolic link; refusing to use it`);
  }
  if (kind === 'file' && !info.isFile()) {
    throw Error(`${path} is not a regular file`);
  }
  if (kind === 'directory' && !info.isDirectory()) {
    throw Error(`${path} is not a directory`);
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw Error(`${path} is not owned by the current user`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw Error(`${path} is writable by other users; refusing to use it`);
  }
}

/** Read and validate the config. A missing file is reported as `undefined`. */
export async function loadConfig(path: string): Promise<PhoneServiceConfig | undefined> {
  try {
    await assertOwnedAndUnshared(path, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  await assertOwnedAndUnshared(dirname(path), 'directory');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return validateConfig(parsed);
}

/**
 * Write the config 0600 by atomic rename. The final directory is created 0700
 * when missing; an existing one only has to be ours and not writable by others.
 */
export async function saveConfig(path: string, config: PhoneServiceConfig): Promise<void> {
  validateConfig(config);

  const directory = dirname(path);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await assertOwnedAndUnshared(directory, 'directory');

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
