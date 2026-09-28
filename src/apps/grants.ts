/**
 * App-scoped grants and sessions for opening a local app on a paired phone.
 *
 * The phone gateway authenticates the device with its bearer token (which only
 * ever travels to the gateway's own origin). It then asks this book for a grant:
 *
 *   grant    256-bit, single use, 60 seconds, bound to device + app registration
 *            (its never-reused registrationId) + revision.
 *            Travels once in the top-level URL the phone opens on the app origin.
 *   session  256-bit, stored by the browser only as an HttpOnly, Secure,
 *            SameSite=Strict, host-only cookie on that app origin. Bound to the
 *            same device + registration + revision, 8-hour absolute lifetime.
 *
 * Only SHA-256 hashes of both tokens are kept, in memory. A gateway restart
 * therefore ends every phone app session; the user opens the app again from
 * Companion. Authorization is rechecked on every request and periodically for
 * open connections: a revoked device, phone access turned off, a changed
 * registration (new revision) or a removed app ends the session and its live
 * HTTP streams and WebSockets.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

import type { RegisteredApp } from './registry.ts';

/** Where live registrations and paired devices are read from. */
export interface AuthorizationSources {
  /** Current registry; reread for each decision. */
  apps(): Promise<RegisteredApp[]>;
  /** IDs of devices that are currently paired; reread for each decision. */
  pairedDeviceIds(): Promise<Set<string>>;
  /**
   * Whether a value is a paired device's gateway bearer token. The proxy
   * refuses requests carrying one, so a Companion credential can never be
   * forwarded to an app backend even if a client mistakenly sends it there.
   */
  isDeviceCredential?(value: string): Promise<boolean>;
}

export interface GrantBookOptions {
  grantLifetimeMilliseconds?: number;
  sessionLifetimeMilliseconds?: number;
  now?(): number;
}

interface Binding {
  deviceId: string;
  appId: string;
  /** Distinguishes a removed and re-added app with the same id and revision. */
  registrationId: string;
  revision: number;
  expiresAt: number;
}

export interface AppSession extends Binding {
  /** Client and upstream sockets carrying this session's traffic right now. */
  readonly sockets: Set<Duplex>;
  createdAt: number;
  /**
   * Set once the session has lost authority. A request that was authorized
   * just before a sweep checks this after registering its sockets, so a
   * connection can never slip past the sweep that ended its session.
   */
  ended: boolean;
}

export type Authorization =
  | { ok: true; app: RegisteredApp }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'disabled' | 'changed' };

/** Unredeemed grants at once; a phone opens apps one tap at a time. */
const maximumGrants = 64;

/** Live sessions at once; at capacity the oldest session is ended. */
const maximumSessions = 256;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are exactly 43 base64url characters; anything else is not ours. */
function plausibleToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export class GrantBook {
  private readonly grants = new Map<string, Binding>();
  private readonly sessions = new Map<string, AppSession>();
  private readonly grantLifetime: number;
  private readonly sessionLifetime: number;
  private readonly now: () => number;

  constructor(
    private readonly sources: AuthorizationSources,
    options: GrantBookOptions = {},
  ) {
    this.grantLifetime = options.grantLifetimeMilliseconds ?? 60_000;
    this.sessionLifetime = options.sessionLifetimeMilliseconds ?? 8 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Number of live sessions (tests and diagnostics). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Issue a grant for an already authenticated device. Throws when the app is
   * not registered, not enabled for phones or the device is no longer paired.
   */
  async createGrant(
    deviceId: string,
    appId: string,
  ): Promise<{ grant: string; expiresAt: number }> {
    const app = (await this.sources.apps()).find((candidate) => candidate.id === appId);
    if (!app || !app.phoneAccess) {
      throw Error('That app is not available on phones');
    }

    const paired = await this.sources.pairedDeviceIds();
    if (!paired.has(deviceId)) {
      throw Error('This device is no longer paired');
    }

    this.pruneGrants();
    if (this.grants.size >= maximumGrants) {
      throw Error('Too many pending app openings; wait a minute and try again');
    }

    const grant = newToken();
    const expiresAt = this.now() + this.grantLifetime;
    this.grants.set(hashToken(grant), {
      deviceId,
      appId,
      registrationId: app.registrationId,
      revision: app.revision,
      expiresAt,
    });
    return { grant, expiresAt };
  }

  /**
   * Exchange a grant for a session on the app it was issued for. The grant is
   * consumed even when the exchange then fails, so it can never be replayed.
   */
  async redeem(
    grant: unknown,
    appId: string,
  ): Promise<{ ok: true; token: string; session: AppSession } | { ok: false; reason: string }> {
    if (!plausibleToken(grant)) {
      return { ok: false, reason: 'unknown' };
    }

    const key = hashToken(grant);
    const binding = this.grants.get(key);
    this.grants.delete(key);

    if (!binding || binding.appId !== appId) {
      return { ok: false, reason: 'unknown' };
    }
    if (binding.expiresAt <= this.now()) {
      return { ok: false, reason: 'expired' };
    }

    const check = await this.checkBinding(binding);
    if (!check.ok) {
      return check;
    }

    if (this.sessions.size >= maximumSessions) {
      this.endOldestSession();
    }

    const token = newToken();
    const now = this.now();
    const session: AppSession = {
      deviceId: binding.deviceId,
      appId: binding.appId,
      registrationId: binding.registrationId,
      revision: binding.revision,
      createdAt: now,
      expiresAt: now + this.sessionLifetime,
      sockets: new Set(),
      ended: false,
    };
    this.sessions.set(hashToken(token), session);
    return { ok: true, token, session };
  }

  /** Session lifetime in whole seconds, for the cookie's Max-Age. */
  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.sessionLifetime / 1000);
  }

  /**
   * Find a live session for this app among the offered cookie values and
   * recheck its authority. Invalid sessions are ended as a side effect.
   */
  async authorize(
    tokens: string[],
    appId: string,
  ): Promise<{ session: AppSession; app: RegisteredApp } | undefined> {
    for (const token of tokens) {
      if (!plausibleToken(token)) {
        continue;
      }

      const key = hashToken(token);
      const session = this.sessions.get(key);
      if (!session || session.appId !== appId) {
        continue;
      }

      const check = await this.checkBinding(session);
      if (!check.ok) {
        this.endSession(key);
        continue;
      }

      return { session, app: check.app };
    }

    return undefined;
  }

  /**
   * Recheck every session against current storage and end those that lost
   * authority, closing their live connections. If storage cannot be read,
   * every session ends: continuing without a readable authorization source
   * would turn a storage failure into indefinite access.
   */
  async sweep(): Promise<void> {
    this.pruneGrants();

    let apps: RegisteredApp[];
    let paired: Set<string>;
    try {
      apps = await this.sources.apps();
      paired = await this.sources.pairedDeviceIds();
    } catch {
      for (const key of [...this.sessions.keys()]) {
        this.endSession(key);
      }
      throw Error('App or device authorization is unavailable; ended all phone app sessions');
    }

    for (const [key, session] of [...this.sessions]) {
      const verdict = judge(session, apps, paired, this.now());
      if (!verdict.ok) {
        this.endSession(key);
      }
    }
  }

  /** End every session (proxy shutdown). */
  endAll(): void {
    this.grants.clear();
    for (const key of [...this.sessions.keys()]) {
      this.endSession(key);
    }
  }

  private async checkBinding(binding: Binding): Promise<Authorization> {
    const apps = await this.sources.apps();
    const paired = await this.sources.pairedDeviceIds();
    return judge(binding, apps, paired, this.now());
  }

  private endSession(key: string): void {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (!session) {
      return;
    }

    session.ended = true;
    for (const socket of session.sockets) {
      socket.destroy();
    }
    session.sockets.clear();
  }

  private endOldestSession(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, session] of this.sessions) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.endSession(oldestKey);
    }
  }

  private pruneGrants(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(key);
      }
    }
  }
}

/** The single authorization rule shared by redemption, requests and sweeps. */
function judge(
  binding: Binding,
  apps: RegisteredApp[],
  paired: Set<string>,
  now: number,
): Authorization {
  if (binding.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (!paired.has(binding.deviceId)) {
    return { ok: false, reason: 'revoked' };
  }

  const app = apps.find((candidate) => candidate.id === binding.appId);
  if (!app || app.registrationId !== binding.registrationId) {
    return { ok: false, reason: 'unknown' };
  }
  if (!app.phoneAccess) {
    return { ok: false, reason: 'disabled' };
  }
  if (app.revision !== binding.revision) {
    return { ok: false, reason: 'changed' };
  }

  return { ok: true, app };
}
