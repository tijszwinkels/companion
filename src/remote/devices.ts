/**
 * Paired phones and one-time pairing codes for the remote gateway.
 *
 * Files (inside the private state directory, 0700):
 *   devices.json  — paired devices; each token is stored only as a SHA-256 hash.
 *   pairing.json  — at most one pending pairing code, also stored as a hash,
 *                   with an expiry time and a remaining attempt count.
 *
 * Both are written 0600 by atomic rename. The `companion-remote pair` command
 * and a running gateway share these files; the gateway rereads them for each
 * decision, so a code created or a device revoked from another terminal takes
 * effect without restarting the gateway. Every read-modify-write transaction
 * holds a kernel lock shared by CLI and gateway processes, including consuming
 * a pairing code and issuing its token. Reads see an atomic old or new file.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assertPrivateDirectory } from './private-directory.ts';
import { withStateLock } from './state-lock.ts';

/** How long a newly printed pairing code remains valid. */
export const pairingLifetimeMilliseconds = 10 * 60 * 1000;

/** Wrong guesses allowed for one code before it is discarded. */
export const pairingAttempts = 5;

/**
 * Crockford-style alphabet without I, L, O and U: no confusable characters
 * when reading the code from the desktop terminal to the phone keyboard.
 */
const codeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Ten characters of a 32-symbol alphabet: 50 bits, with 5 guesses per code. */
const codeLength = 10;

export interface PairedDevice {
  id: string;
  name: string;
  /** Hex SHA-256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: number;
}

interface DeviceFile {
  version: 1;
  devices: PairedDevice[];
}

interface PairingFile {
  version: 1;
  codeHash: string;
  expiresAt: number;
  attemptsLeft: number;
}

export type PairingResult =
  | { ok: true; device: PairedDevice; token: string }
  | { ok: false; reason: 'no-code' | 'expired' | 'wrong-code' };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Compare two equal-length hex hashes without leaking the matching prefix. */
function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Normalize what a person types: case, spaces and hyphens do not matter. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

function newPairingCode(): string {
  const bytes = randomBytes(codeLength);
  let code = '';

  // 256 is a multiple of 32, so taking each byte modulo 32 is unbiased.
  for (const byte of bytes) {
    code += codeAlphabet[byte % codeAlphabet.length];
  }

  return code;
}

/** Device names are display labels only; keep them short and printable. */
export function cleanDeviceName(name: unknown): string {
  if (typeof name !== 'string') {
    return 'Phone';
  }

  const printable = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
  return printable.slice(0, 60) || 'Phone';
}

export class DeviceStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private get devicesPath(): string {
    return join(this.directory, 'devices.json');
  }

  private get pairingPath(): string {
    return join(this.directory, 'pairing.json');
  }

  /**
   * Create the private state directory. An existing directory must already be
   * private and must not be a symbolic link; we refuse rather than silently
   * chmod a directory someone else may have made readable on purpose.
   */
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
  }

  /** Queue local writers, then lock against every other gateway/CLI process. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const locked = async () => {
      await this.prepare();
      return withStateLock(join(this.directory, 'state.lock'), operation);
    };
    const result = this.writes.then(locked, locked);
    this.writes = result.catch(() => {});
    return result;
  }

  private async writePrivate(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async devices(): Promise<PairedDevice[]> {
    let text: string;

    try {
      text = await readFile(this.devicesPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(text) as DeviceFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
      throw Error('Unsupported devices.json format');
    }
    return parsed.devices;
  }

  /** Find the device owning a bearer token, or undefined. */
  async authenticate(token: unknown): Promise<PairedDevice | undefined> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      return undefined;
    }

    const hash = sha256(token);
    const devices = await this.devices();
    return devices.find((device) => sameHash(device.tokenHash, hash));
  }

  /** Print-once code for the host terminal. Replaces any earlier pending code. */
  createPairingCode(now = Date.now()): Promise<{ code: string; expiresAt: number }> {
    return this.exclusive(async () => {
      const code = newPairingCode();
      const expiresAt = now + pairingLifetimeMilliseconds;
      const file: PairingFile = {
        version: 1,
        codeHash: sha256(code),
        expiresAt,
        attemptsLeft: pairingAttempts,
      };
      await this.writePrivate(this.pairingPath, file);
      return { code, expiresAt };
    });
  }

  /**
   * Exchange a pairing code for a new device token. A correct code is single
   * use; wrong guesses consume attempts and the code is deleted at zero.
   */
  redeemPairingCode(code: unknown, name: unknown, now = Date.now()): Promise<PairingResult> {
    return this.exclusive(async () => {
      let pairing: PairingFile;

      try {
        pairing = JSON.parse(await readFile(this.pairingPath, 'utf8')) as PairingFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, reason: 'no-code' };
        }
        throw error;
      }

      if (pairing.version !== 1 || now >= pairing.expiresAt || pairing.attemptsLeft <= 0) {
        await rm(this.pairingPath, { force: true });
        return { ok: false, reason: 'expired' };
      }

      const typed = typeof code === 'string' ? normalizePairingCode(code) : '';
      if (typed.length !== codeLength || !sameHash(pairing.codeHash, sha256(typed))) {
        const attemptsLeft = pairing.attemptsLeft - 1;
        if (attemptsLeft <= 0) {
          await rm(this.pairingPath, { force: true });
        } else {
          await this.writePrivate(this.pairingPath, { ...pairing, attemptsLeft });
        }
        return { ok: false, reason: 'wrong-code' };
      }

      // Consume the code before issuing the token: a crash between the two
      // steps loses a pairing, never lets the same code pair twice.
      await rm(this.pairingPath, { force: true });

      const token = randomBytes(32).toString('base64url');
      const device: PairedDevice = {
        id: randomUUID(),
        name: cleanDeviceName(name),
        tokenHash: sha256(token),
        createdAt: now,
      };
      const devices = await this.devices();
      await this.writePrivate(this.devicesPath, {
        version: 1,
        devices: [...devices, device],
      } satisfies DeviceFile);

      return { ok: true, device, token };
    });
  }

  /** Remove a device; its token stops working for new and existing connections. */
  revoke(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const devices = await this.devices();
      const remaining = devices.filter((device) => device.id !== id);

      if (remaining.length === devices.length) {
        return false;
      }

      await this.writePrivate(this.devicesPath, {
        version: 1,
        devices: remaining,
      } satisfies DeviceFile);
      return true;
    });
  }
}
