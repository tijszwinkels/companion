/**
 * Opt-in network gateway that lets a paired phone use the Companion panel.
 *
 * The listener itself never opens a network port. This separate process
 * connects to the listener's private Unix socket on behalf of each paired
 * phone and serves:
 *
 *   GET  /                      the phone app (static files, strict CSP)
 *   POST /api/pair              exchange a one-time code for a device token
 *   GET  /api/screenshots/:id   a conversation's saved screenshot (bearer token)
 *   GET  /api/apps              local apps this phone may open (bearer token)
 *   POST /api/apps/:id/open     one-time top-level URL for an app (bearer token)
 *   GET  /api/socket            WebSocket; first message authenticates
 *
 * Local apps themselves are never served from this origin: an optional
 * separate AppProxy listener (src/apps/proxy.ts) serves each app on its own
 * configured host name, so app JavaScript cannot reach the device token.
 *
 * Security model (see README.md in this directory):
 * - Transport: HTTPS with a user-supplied certificate for any non-loopback
 *   address. Plain HTTP is only allowed on loopback, for local tests or for a
 *   user-configured `tailscale serve` that terminates TLS in front of it, or
 *   on a Unix socket in a private directory (`socketPath`), which only this
 *   user and root (tailscaled) can connect to. See unix-socket-claim.ts.
 * - Behind Tailscale Serve: requests marked as Funnel (public internet) are
 *   refused, and an optional required Tailscale login must match. See
 *   tailscale-headers.ts.
 * - Tailscale limits who can reach the port, but every request still needs a
 *   device token issued through pairing. Tokens are stored hashed and can be
 *   revoked; revocation also closes live connections.
 * - Browser-origin checks: the WebSocket and pairing endpoints require an
 *   `Origin` from the configured allowlist, and every request requires a
 *   matching `Host`, which blocks cross-site WebSocket hijacking and DNS
 *   rebinding from web pages the phone happens to visit.
 * - No third-party requests: the app is self-contained, and CSP forbids any
 *   other origin.
 */

import { chmod, readFile, type FileHandle } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { AppProxy } from '../apps/proxy.ts';
import { AppRegistry } from '../apps/registry.ts';
import { DeviceStore, type PairedDevice } from './devices.ts';
import { maximumClientMessageBytes } from './protocol.ts';
import { ReceiptBook } from './receipts.ts';
import { closeCodes, Relay } from './relay.ts';
import { tailscaleRefusal } from './tailscale-headers.ts';
import { acquireLifetimeLock, claimUnixSocket, type UnixSocketClaim } from './unix-socket-claim.ts';

/**
 * Where the gateway accepts connections: either a TCP address and port, or a
 * Unix socket path (for Tailscale Serve's `unix:` target). Never both.
 */
export type GatewayListenOptions =
  | {
      /** Address to bind, e.g. 127.0.0.1 or the host's Tailscale 100.x address. */
      host: string;
      port: number;
      /** PEM certificate and key; required for any non-loopback host. */
      tls?: { cert: string; key: string };
      socketPath?: undefined;
    }
  | {
      /**
       * Absolute Unix socket path. Its directory must be private to this
       * user; the socket is created 0600. TLS is terminated by Tailscale Serve.
       */
      socketPath: string;
      host?: undefined;
      port?: undefined;
      tls?: undefined;
    };

/** Everything except the listening address. */
export interface GatewayServiceOptions {
  /**
   * Exact origins the phone app is loaded from, e.g.
   * `https://desk.tailnet-name.ts.net:8443`. Loopback HTTP defaults to the
   * gateway's own loopback origins when omitted. Unix socket mode accepts
   * https origins only.
   */
  origins: string[];
  /**
   * When set, every request must carry this exact `Tailscale-User-Login`
   * header, as added by Tailscale Serve for a tailnet user's device.
   */
  requireTailscaleLogin?: string;
  stateDirectory: string;
  controlSocket: string;
  sessionsDirectory: string;
  /** Built phone app (index.html and assets). */
  appDirectory: string;
  log(message: string): void;
  /** How often device revocations are checked for live connections. */
  revocationCheckMilliseconds?: number;
  /** Protocol ping interval; clients missing the next pong are disconnected. */
  heartbeatMilliseconds?: number;
  /** Optional phone access to registered local apps; off when omitted. */
  apps?: GatewayAppOptions;
}

export type GatewayOptions = GatewayListenOptions & GatewayServiceOptions;

/**
 * The separate loopback listener that serves local apps to paired phones.
 * Each app needs an explicit origin whose host name differs from every other
 * app and from this gateway (see src/apps/origins.ts). Only apps whose
 * registration has phone access turned on are offered.
 */
export interface GatewayAppOptions {
  /** Loopback address and port for the app proxy, e.g. 127.0.0.1:8790. */
  host: string;
  port: number;
  /** `[app id, public origin]` pairs, e.g. `['budget', 'https://budget.example']`. */
  origins: Array<[string, string]>;
  /** Registry directory (default ~/companion/apps). */
  registryDirectory: string;
}

/** Concurrent authenticated phones and not-yet-authenticated sockets. */
// Include draining relays: at most two of the listener's eight client slots
// belong to this gateway, leaving room for desktop panels during reconnects.
const maximumPhones = 2;
const maximumUnauthenticated = 8;

/** How long a failed start waits for the app proxy to close before reporting. */
const failedStartCleanupMilliseconds = 2000;

/** A new socket must authenticate within this time. */
const authenticationMilliseconds = 5000;

/** Pairing attempts across all clients per minute (codes also allow 5 guesses). */
const pairingRequestsPerMinute = 10;

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Validate options once, before binding anything. */
export function checkGatewayOptions(options: GatewayOptions): void {
  if (options.socketPath !== undefined) {
    checkUnixSocketOptions(options);
  } else {
    checkTcpOptions(options);
  }
  checkOrigins(options.origins);

  if (options.requireTailscaleLogin !== undefined) {
    // A login is an e-mail-like name (e.g. `user@github`); refuse blanks and
    // anything with whitespace or control characters, which could never match.
    if (!/^[^\s\p{Cc}]+$/u.test(options.requireTailscaleLogin)) {
      throw Error('The required Tailscale login must be a non-empty name without spaces');
    }
  }
}

/**
 * Unix socket mode: an absolute path and https origins only. There are no
 * loopback defaults; the only expected client is Tailscale Serve, which
 * forwards the tailnet HTTPS name.
 */
function checkUnixSocketOptions(options: GatewayOptions & { socketPath: string }): void {
  if (!options.socketPath.startsWith('/')) {
    throw Error(`The Unix socket path must be absolute: ${options.socketPath}`);
  }
  if (options.host !== undefined || options.port !== undefined || options.tls !== undefined) {
    throw Error('A Unix socket gateway takes no host, port or TLS certificate');
  }
  if (options.origins.length === 0) {
    throw Error('A Unix socket gateway needs at least one https origin (--origin)');
  }
  for (const origin of options.origins) {
    if (!origin.startsWith('https://')) {
      throw Error(`A Unix socket gateway accepts https origins only: ${origin}`);
    }
  }
}

function checkTcpOptions(options: GatewayOptions & { host: string }): void {
  if (!isLoopbackHost(options.host) && !options.tls) {
    throw Error(
      'Refusing plain HTTP on a non-loopback address. Provide --tls-cert/--tls-key ' +
        '(for example from `tailscale cert`), or bind 127.0.0.1 behind `tailscale serve`.',
    );
  }
  if (options.host !== 'localhost' && !isIP(options.host)) {
    throw Error('Bind a literal IP address or localhost, not a hostname or numeric alias');
  }
  const normalizedHost =
    isIP(options.host) === 6 ? new URL(`http://[${options.host}]`).hostname : options.host;
  if (
    normalizedHost === '0.0.0.0' ||
    normalizedHost === '[::]' ||
    normalizedHost === '[::ffff:0:0]'
  ) {
    throw Error('Bind a specific address (such as the Tailscale IP), not every interface');
  }
}

function checkOrigins(origins: string[]): void {
  if (origins.length === 0) {
    throw Error('At least one allowed origin is required (--origin)');
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) {
      throw Error(`Origin must be exactly scheme://host[:port]: ${origin}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw Error(`Origins must use https or loopback http: ${origin}`);
    }
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''))) {
      throw Error(`Non-loopback origins must use https: ${origin}`);
    }
  }
}

/** Default origins for a loopback-only HTTP gateway. */
export function loopbackOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

export class Gateway {
  private server?: Server;
  /** Held while listening on a Unix socket; see unix-socket-claim.ts. */
  private socketClaim?: UnixSocketClaim;
  /** Lifetime lock on the pairing state directory (see start()). */
  private stateClaim?: FileHandle;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: maximumClientMessageBytes,
    // Compression of attacker-influenced text next to secrets invites
    // CRIME-style attacks, and phones gain little from it here.
    perMessageDeflate: false,
  });
  private readonly devices: DeviceStore;
  private readonly receipts = new ReceiptBook();
  private readonly relays = new Map<Relay, string>();
  private readonly screenshots = new Map<string, Set<string>>();
  private readonly allowedHosts: Set<string>;
  private unauthenticated = 0;
  private pairingWindowStart = 0;
  private pairingRequests = 0;
  private revocationTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly alive = new Map<WebSocket, boolean>();
  /** Serves local apps on their own origins; undefined when not configured. */
  readonly apps?: AppProxy;

  constructor(private readonly options: GatewayOptions) {
    checkGatewayOptions(options);
    this.devices = new DeviceStore(options.stateDirectory);
    this.allowedHosts = new Set(options.origins.map((origin) => new URL(origin).host));

    if (options.apps) {
      const registry = new AppRegistry(options.apps.registryDirectory);
      this.apps = new AppProxy({
        host: options.apps.host,
        port: options.apps.port,
        appOrigins: options.apps.origins,
        gatewayOrigins: options.origins,
        sources: {
          apps: () => registry.list(),
          pairedDeviceIds: async () => new Set((await this.devices.devices()).map((d) => d.id)),
          isDeviceCredential: async (value) =>
            (await this.devices.authenticate(value)) !== undefined,
        },
        log: options.log,
        sweepMilliseconds: options.revocationCheckMilliseconds,
      });
    }
  }

  /** Bound port (useful when started with port 0 in tests); 0 on a Unix socket. */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : (this.options.port ?? 0);
  }

  /** Human-readable listening address for logs, e.g. `unix:/run/…/gateway.sock`. */
  get address(): string {
    if (this.options.socketPath !== undefined) {
      return `unix:${this.options.socketPath}`;
    }
    const scheme = this.options.tls ? 'https' : 'http';
    const host = isIP(this.options.host) === 6 ? `[${this.options.host}]` : this.options.host;
    return `${scheme}://${host}:${this.port}`;
  }

  async start(): Promise<void> {
    await this.devices.prepare();

    // Exactly one gateway may serve a pairing state directory at a time,
    // whatever it listens on (TCP port or Unix socket). state.lock only
    // serializes single transactions; this lock is held for the gateway's
    // whole lifetime, so a second gateway on the same pairing state (for
    // example a terminal TCP gateway next to the supervised socket one)
    // refuses to start instead of both admitting and revoking phones.
    // Gateways older than this lock do not take it; stop them explicitly.
    this.stateClaim = await acquireLifetimeLock(
      join(this.options.stateDirectory, 'gateway.lock'),
      'Another phone gateway serving this pairing state',
    );

    // Start the app proxy first: if its port is unavailable the gateway
    // refuses to start rather than silently serving without it.
    try {
      await this.apps?.start();
    } catch (error) {
      await this.releaseStateClaim();
      throw error;
    }

    // Any later failure (occupied port, unreadable TLS material) must not
    // leave the app proxy listening or timers running in a process whose
    // gateway never started. Release what was started, then report the
    // original error.
    try {
      await this.startServer();
    } catch (error) {
      await this.releaseFailedStart();
      throw error;
    }
  }

  /** Undo a partial start; never masks the original startup error. */
  private async releaseFailedStart(): Promise<void> {
    clearInterval(this.revocationTimer);
    clearInterval(this.heartbeatTimer);
    this.revocationTimer = undefined;
    this.heartbeatTimer = undefined;

    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    await this.releaseSocketClaim();

    // The app proxy's close() waits for its connections to end, and a local
    // peer can hold one open. Do not let that keep the startup error from
    // being reported: wait a bounded time, then give up (the CLI then exits).
    if (this.apps) {
      try {
        const finished = await settlesWithin(this.apps.close(), failedStartCleanupMilliseconds);
        if (!finished) {
          this.options.log('App proxy did not finish closing after the failed start');
        }
      } catch (error) {
        this.options.log(`App proxy cleanup after failed start: ${String(error)}`);
      }
    }
    await this.releaseStateClaim();
  }

  /** Give up the pairing state's lifetime lock, once nothing serves it any more. */
  private async releaseStateClaim(): Promise<void> {
    const claim = this.stateClaim;
    this.stateClaim = undefined;
    await claim?.close();
  }

  /** Create and bind the gateway's own HTTP(S) server (TCP or Unix socket) and its timers. */
  private async startServer(): Promise<void> {
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      this.handleHttp(request, response).catch((error) => {
        this.options.log(`HTTP error: ${String(error)}`);
        if (!response.headersSent) {
          this.sendJson(response, 500, { error: 'Internal error' });
        } else {
          response.destroy();
        }
      });
    };

    const server = this.options.tls
      ? createHttpsServer({ cert: this.options.tls.cert, key: this.options.tls.key }, handler)
      : createHttpServer(handler);
    this.server = server;

    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));

    if (this.options.socketPath !== undefined) {
      await this.listenOnUnixSocket(server, this.options.socketPath);
    } else {
      const { host, port } = this.options;
      await listen(server, (callback) => server.listen(port, host, callback));
    }

    this.revocationTimer = setInterval(
      () => void this.closeRevoked(),
      this.options.revocationCheckMilliseconds ?? 5000,
    );
    this.heartbeatTimer = setInterval(() => {
      for (const [phone, answered] of this.alive) {
        if (phone.readyState !== phone.OPEN) {
          continue;
        }
        if (!answered) {
          phone.terminate();
          continue;
        }
        this.alive.set(phone, false);
        phone.ping();
      }
    }, this.options.heartbeatMilliseconds ?? 20_000);
  }

  /**
   * Claim the socket path (private directory, lifetime lock, stale-socket
   * cleanup), then bind with a 0177 umask so the socket is created 0600, and
   * chmod it again in case the platform ignored the umask for sockets.
   *
   * The claim is recorded before binding, so a failure anywhere after this
   * point is undone by releaseFailedStart(): it closes the server (which
   * unlinks the socket) and then releases the lock.
   *
   * process.umask() is process-wide; the bind happens synchronously inside
   * listen(), so the restrictive umask is in effect only for that call.
   */
  private async listenOnUnixSocket(server: Server, socketPath: string): Promise<void> {
    this.socketClaim = await claimUnixSocket(socketPath);

    await listen(server, (callback) => {
      const previousUmask = process.umask(0o177);
      try {
        server.listen(socketPath, callback);
      } finally {
        process.umask(previousUmask);
      }
    });
    await chmod(socketPath, 0o600);
  }

  /**
   * Give up the socket's lifetime lock. Call only after the server has
   * closed, so a new gateway never finds our socket still answering.
   */
  private async releaseSocketClaim(): Promise<void> {
    const claim = this.socketClaim;
    this.socketClaim = undefined;
    await claim?.release();
  }

  /**
   * Stop serving. The gateway's own listener closes first (which also
   * unlinks a Unix socket) and its lock is released; only then do we wait for
   * the optional app proxy, so a slow app-proxy shutdown can never keep the
   * gateway itself reachable.
   */
  async close(): Promise<void> {
    clearInterval(this.revocationTimer);
    clearInterval(this.heartbeatTimer);

    for (const relay of this.relays.keys()) {
      relay.terminate(closeCodes.shutdown, 'Gateway stopped');
    }
    for (const client of this.sockets.clients) {
      client.terminate();
    }

    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      server.closeAllConnections();
      // Closing a Unix socket server also unlinks the socket file.
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    await this.releaseSocketClaim();

    await this.apps?.close();
    await this.releaseStateClaim();
  }

  // ---- Request guards -------------------------------------------------------

  /** Every request must name one of our hosts; defeats DNS rebinding. */
  private hostAllowed(request: IncomingMessage): boolean {
    return typeof request.headers.host === 'string' && this.allowedHosts.has(request.headers.host);
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return (
      typeof origin === 'string' &&
      this.options.origins.includes(origin) &&
      new URL(origin).host === request.headers.host
    );
  }

  private bearerToken(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return undefined;
    }
    return header.slice('Bearer '.length).trim();
  }

  private securityHeaders(response: ServerResponse): void {
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob:",
        "connect-src 'self'",
        "manifest-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    this.securityHeaders(response);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }

  /**
   * Funnel and Tailscale-login checks (see tailscale-headers.ts). Returns the
   * refusal message, or undefined when the request may continue. The offered
   * login is not logged: it is personal data and says nothing an operator
   * could not see in Tailscale itself.
   */
  private tailscaleRefusalMessage(request: IncomingMessage): string | undefined {
    const refusal = tailscaleRefusal(request.headers, this.options.requireTailscaleLogin);
    if (refusal === 'funnel') {
      this.options.log('Refused a request that arrived through Tailscale Funnel');
      return 'Public (Funnel) requests are not allowed';
    }
    if (refusal === 'login') {
      this.options.log('Refused a request without the required Tailscale login');
      return 'Tailscale user not allowed';
    }
    return undefined;
  }

  // ---- HTTP routes ----------------------------------------------------------

  /**
   * Every route, including pairing, screenshots, the app list/open endpoints
   * and static files, passes the Tailscale checks first, then the Host check.
   */
  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refusal = this.tailscaleRefusalMessage(request);
    if (refusal !== undefined) {
      this.sendJson(response, 403, { error: refusal });
      return;
    }
    if (!this.hostAllowed(request)) {
      this.sendJson(response, 421, { error: 'Unknown host' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://gateway.invalid');

    if (url.pathname === '/api/pair') {
      await this.handlePair(request, response);
      return;
    }

    const screenshot = /^\/api\/screenshots\/([^/]+)$/.exec(url.pathname);
    if (screenshot) {
      await this.handleScreenshot(request, response, screenshot[1]);
      return;
    }

    if (url.pathname === '/api/apps') {
      await this.handleAppList(request, response);
      return;
    }

    const openApp = /^\/api\/apps\/([a-z0-9-]{1,32})\/open$/.exec(url.pathname);
    if (openApp) {
      await this.handleAppOpen(request, response, openApp[1]);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    await this.serveStatic(url.pathname, response);
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!this.originAllowed(request)) {
      this.sendJson(response, 403, { error: 'Origin not allowed' });
      return;
    }
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      this.sendJson(response, 415, { error: 'Expected JSON' });
      return;
    }

    const now = Date.now();
    if (now - this.pairingWindowStart > 60_000) {
      this.pairingWindowStart = now;
      this.pairingRequests = 0;
    }
    if (++this.pairingRequests > pairingRequestsPerMinute) {
      this.sendJson(response, 429, { error: 'Too many pairing attempts; wait a minute' });
      return;
    }

    let body: { code?: unknown; name?: unknown };
    try {
      body = JSON.parse(await readBody(request, 2048));
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw Error('Expected an object');
      }
    } catch {
      this.sendJson(response, 400, { error: 'Invalid request' });
      return;
    }

    const result = await this.devices.redeemPairingCode(body.code, body.name);
    if (!result.ok) {
      const messages = {
        'no-code': 'No pairing code is active. Run `companion-remote pair` on the computer.',
        expired: 'That pairing code has expired or run out of attempts. Create a new one.',
        'wrong-code': 'That code is not correct.',
      };
      this.sendJson(response, 401, { error: messages[result.reason] });
      return;
    }

    this.options.log(`Paired device ${result.device.name} (${result.device.id})`);
    this.sendJson(response, 200, {
      token: result.token,
      deviceId: result.device.id,
      deviceName: result.device.name,
    });
  }

  private async handleScreenshot(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (request.method !== 'GET') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    const device = await this.devices.authenticate(this.bearerToken(request));
    if (!device) {
      this.sendJson(response, 401, { error: 'Not paired' });
      return;
    }

    // Only screenshots of conversations this device was shown, by UUID only;
    // the path is derived here, never taken from the request.
    const allowed = this.screenshots.get(device.id);
    if (!sessionIdPattern.test(sessionId) || !allowed?.has(sessionId)) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    let image: Buffer;
    try {
      image = await readFile(join(this.options.sessionsDirectory, `${sessionId}.png`));
    } catch {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    this.securityHeaders(response);
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'Content-Length': image.length,
    });
    response.end(image);
  }

  /** The apps this phone may open; empty when app access is not configured. */
  private async handleAppList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    const device = await this.devices.authenticate(this.bearerToken(request));
    if (!device) {
      this.sendJson(response, 401, { error: 'Not paired' });
      return;
    }

    const apps = this.apps ? await this.apps.phoneApps() : [];
    this.sendJson(response, 200, { apps });
  }

  /**
   * Mint a one-time grant for this device and app. The phone opens the
   * returned URL as a top-level page on the app's own origin; the device
   * token itself never leaves this origin. The exact-Origin check keeps other
   * pages from using a stolen or ambient credential path to mint grants.
   */
  private async handleAppOpen(
    request: IncomingMessage,
    response: ServerResponse,
    appId: string,
  ): Promise<void> {
    if (request.method !== 'POST') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!this.originAllowed(request)) {
      this.sendJson(response, 403, { error: 'Origin not allowed' });
      return;
    }

    const device = await this.devices.authenticate(this.bearerToken(request));
    if (!device) {
      this.sendJson(response, 401, { error: 'Not paired' });
      return;
    }
    if (!this.apps) {
      this.sendJson(response, 404, { error: 'Apps are not available on this gateway' });
      return;
    }

    try {
      const opened = await this.apps.openForDevice(device.id, appId);
      this.sendJson(response, 200, opened);
    } catch (error) {
      this.sendJson(response, 404, { error: error instanceof Error ? error.message : 'Not found' });
    }
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const root = resolve(this.options.appDirectory);
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const path = normalize(join(root, relative));

    // No traversal outside the app directory and no dotfiles.
    if (!path.startsWith(root + sep) || relative.split('/').some((part) => part.startsWith('.'))) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const type = contentTypes[extname(path)];
    if (!type) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      if (relative === 'index.html') {
        this.securityHeaders(response);
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('The phone app is not built. Run `npm run mobile:build` in the checkout.\n');
        return;
      }
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    this.securityHeaders(response);
    response.writeHead(200, {
      'Content-Type': type,
      // The shell must always be fresh; hashed assets could be cached longer,
      // but the app is small and correctness after an update matters more.
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  }

  // ---- WebSocket ------------------------------------------------------------

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // After an upgrade request the socket belongs to us, not to the HTTP
    // server: closeAllConnections() no longer sees it. Destroy it once the
    // refusal is written, so a peer that never closes its side cannot keep
    // the server (and a shutdown waiting for it) open.
    const reject = (status: number, text: string) => {
      const refusal = `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
      socket.end(refusal, () => socket.destroy());
    };

    // Funnel/login refusals come first, as for plain HTTP, so every upgrade
    // path answers them with the same 403.
    if (this.tailscaleRefusalMessage(request) !== undefined) {
      reject(403, 'Forbidden');
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://gateway.invalid');
    } catch {
      reject(400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/api/socket') {
      reject(404, 'Not Found');
      return;
    }
    if (!this.hostAllowed(request)) {
      reject(421, 'Misdirected Request');
      return;
    }
    if (!this.originAllowed(request)) {
      reject(403, 'Forbidden');
      return;
    }
    if (
      this.unauthenticated >= maximumUnauthenticated ||
      this.sockets.clients.size >= maximumPhones + maximumUnauthenticated
    ) {
      reject(503, 'Service Unavailable');
      return;
    }

    this.sockets.handleUpgrade(request, socket, head, (phone) => this.authenticate(phone));
  }

  /** Wait for the first message: it must carry a valid device token. */
  private authenticate(phone: WebSocket): void {
    // Protocol errors (oversized payload, invalid UTF-8, bad frame) are emitted
    // on the WebSocket even before authentication. Contain them to this client.
    phone.on('error', () => phone.terminate());
    this.alive.set(phone, true);
    phone.on('pong', () => this.alive.set(phone, true));
    phone.once('close', () => this.alive.delete(phone));
    this.unauthenticated++;
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        this.unauthenticated--;
        clearTimeout(timer);
      }
    };

    const timer = setTimeout(() => {
      finish();
      // Slow transport is not evidence that the stored credential is invalid.
      phone.close(closeCodes.slowConsumer, 'Authentication timed out');
    }, authenticationMilliseconds);

    phone.once('close', finish);
    phone.once('message', async (data, isBinary) => {
      let token: unknown;
      let incrementalSessions = false;
      try {
        const message = JSON.parse(String(data));
        token = !isBinary && message?.type === 'auth' ? message.token : undefined;
        incrementalSessions = !isBinary && message?.incrementalSessions === true;
      } catch {
        token = undefined;
      }

      let device: PairedDevice | undefined;
      try {
        device = await this.devices.authenticate(token);
      } catch (error) {
        this.options.log(`Device store error: ${String(error)}`);
        finish();
        phone.close(closeCodes.engineUnavailable, 'Device authorization is unavailable');
        return;
      }
      finish();

      if (!device) {
        phone.close(closeCodes.unauthorized, 'Not paired');
        return;
      }
      if (this.relays.size >= maximumPhones) {
        phone.close(closeCodes.overloaded, 'Too many phones connected');
        return;
      }
      if (phone.readyState !== phone.OPEN) {
        return;
      }

      this.startRelay(phone, device, incrementalSessions);
    });
  }

  private startRelay(phone: WebSocket, device: PairedDevice, incrementalSessions: boolean): void {
    phone.send(
      JSON.stringify({ type: 'authenticated', deviceId: device.id, deviceName: device.name }),
    );

    const relay = new Relay(phone, {
      controlSocket: this.options.controlSocket,
      sessionsDirectory: this.options.sessionsDirectory,
      deviceId: device.id,
      receipts: this.receipts,
      incrementalSessions,
      allowScreenshot: (deviceId, sessionId) => {
        let allowed = this.screenshots.get(deviceId);
        if (!allowed) {
          allowed = new Set();
          this.screenshots.set(deviceId, allowed);
        }
        allowed.add(sessionId);
      },
      onClosed: () => this.relays.delete(relay),
      log: this.options.log,
    });

    this.relays.set(relay, device.id);
  }

  /** Close live connections whose device has since been revoked. */
  private async closeRevoked(): Promise<void> {
    let current: Set<string>;
    try {
      current = new Set((await this.devices.devices()).map((device) => device.id));
    } catch (error) {
      this.options.log(`Device store error: ${String(error)}`);
      // Continuing authenticated control without a readable authorization
      // source would turn a storage failure into indefinite access.
      for (const relay of this.relays.keys()) {
        relay.terminate(closeCodes.engineUnavailable, 'Device authorization is unavailable');
      }
      return;
    }

    for (const [relay, deviceId] of this.relays) {
      if (!current.has(deviceId)) {
        relay.terminate(closeCodes.revoked, 'Device revoked');
      }
    }
    this.receipts.prune(current);
    for (const deviceId of this.screenshots.keys()) {
      if (!current.has(deviceId)) {
        this.screenshots.delete(deviceId);
      }
    }
  }
}

/**
 * Resolve true when `work` settles within `milliseconds`, false when it is
 * still pending then (it keeps running). A rejection of `work` propagates.
 */
async function settlesWithin(work: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), milliseconds);
  });

  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start listening and resolve once bound; reject on a bind error such as
 * EADDRINUSE. `bind` must call `server.listen(..., callback)`.
 */
function listen(server: Server, bind: (callback: () => void) => void): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    bind(() => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}
