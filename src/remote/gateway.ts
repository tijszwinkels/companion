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
 *   user-configured `tailscale serve` that terminates TLS in front of it.
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

import { readFile } from 'node:fs/promises';
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

export interface GatewayOptions {
  /** Address to bind, e.g. 127.0.0.1 or the host's Tailscale 100.x address. */
  host: string;
  port: number;
  /** PEM certificate and key; required for any non-loopback host. */
  tls?: { cert: string; key: string };
  /**
   * Exact origins the phone app is loaded from, e.g.
   * `https://desk.tailnet-name.ts.net:8443`. Loopback HTTP defaults to the
   * gateway's own loopback origins when omitted.
   */
  origins: string[];
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
  if (options.origins.length === 0) {
    throw Error('At least one allowed origin is required (--origin)');
  }
  for (const origin of options.origins) {
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

  /** Bound port (useful when started with port 0 in tests). */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : this.options.port;
  }

  async start(): Promise<void> {
    await this.devices.prepare();

    // Start the app proxy first: if its port is unavailable the gateway
    // refuses to start rather than silently serving without it.
    await this.apps?.start();

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

    try {
      await this.apps?.close();
    } catch (error) {
      this.options.log(`App proxy cleanup after failed start: ${String(error)}`);
    }
  }

  /** Create and bind the gateway's own HTTP(S) server and its timers. */
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

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.options.port, this.options.host, () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });

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

  async close(): Promise<void> {
    clearInterval(this.revocationTimer);
    clearInterval(this.heartbeatTimer);
    await this.apps?.close();

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
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
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

  // ---- HTTP routes ----------------------------------------------------------

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

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
