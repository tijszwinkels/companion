/**
 * Phone access to registered local apps: an HTTP + WebSocket reverse proxy.
 *
 *   phone browser ──HTTPS──▶ (TLS terminator) ──▶ AppProxy ──loopback──▶ app backend
 *   https://budget.example      configured by        this file    http://127.0.0.1:8123
 *                               the user, e.g. Tailscale
 *
 * The proxy is a separate listener from the Companion phone gateway and serves
 * only app origins, so app JavaScript never shares the gateway's origin or its
 * device token. It routes by the exact Host of explicitly configured origins
 * (see origins.ts) and forwards only to that app's registered loopback address:
 *
 * - The upstream address and port come from the registry, never the request.
 *   The request target is passed through as an opaque path; absolute-form
 *   targets (`GET http://other/`) and CONNECT are refused. Redirects are passed
 *   back to the browser, never followed. Nothing is resolved through DNS.
 * - Every request needs a phone app session (grants.ts) for that app, plus
 *   same-origin Fetch Metadata and, for unsafe methods and WebSockets, an exact
 *   Origin (headers.ts). Without one, nothing is sent upstream.
 * - Companion's session cookie and forwarding headers never reach the backend;
 *   the app's own cookies, Authorization, Host and Origin do, unchanged.
 * - No request is ever retried. If a backend fails after a request body was
 *   sent, the phone is told the outcome is uncertain.
 *
 * The proxy binds loopback only and speaks plain HTTP; TLS for a phone origin
 * is terminated in front of it by user-configured infrastructure. It never
 * starts, stops or restarts app backends: a stopped backend is shown as
 * unavailable.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import { GrantBook, type AppSession, type AuthorizationSources } from './grants.ts';
import {
  checkBrowserRequest,
  grantPath,
  isSafeMethod,
  phoneResponseHeaders,
  sessionCookieName,
  sessionCookieValues,
  upstreamRequestHeaders,
} from './headers.ts';
import { portAcceptsConnections } from './launcher.ts';
import { checkAppOrigins, isLoopbackHostname } from './origins.ts';
import { parseUpstream, type RegisteredApp } from './registry.ts';

export interface AppProxyOptions {
  /** Loopback bind address: 127.0.0.1, ::1 or localhost. */
  host: string;
  /** Port to bind; 0 picks a free port (tests). */
  port: number;
  /** Explicit public origin per app ID, e.g. budget → https://budget.example. */
  appOrigins: Iterable<[string, string]>;
  /** The phone gateway's origins; an app may not reuse one. */
  gatewayOrigins?: string[];
  sources: AuthorizationSources;
  log(message: string): void;
  /** How often open connections are rechecked; default 5 seconds. */
  sweepMilliseconds?: number;
  /** Largest request body forwarded (for example a CSV upload); default 64 MiB. */
  maximumRequestBodyBytes?: number;
  grantLifetimeMilliseconds?: number;
  sessionLifetimeMilliseconds?: number;
}

/** A phone-reachable app as the gateway lists it. */
export interface PhoneApp {
  id: string;
  name: string;
  origin: string;
  /** Whether its backend accepted a connection just now. */
  running: boolean;
}

const defaultMaximumBody = 64 * 1024 * 1024;

export class AppProxy {
  private server?: Server;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly grants: GrantBook;
  /** App ID → public origin, and public Host → app ID. */
  private readonly origins: Map<string, string>;
  private readonly appsByHost = new Map<string, string>();
  private readonly maximumBody: number;

  constructor(private readonly options: AppProxyOptions) {
    const bindName = options.host === '::1' ? '[::1]' : options.host;
    if (!isLoopbackHostname(bindName) || bindName.endsWith('.localhost')) {
      throw Error('The app proxy binds a loopback address only; put TLS/tailnet access in front');
    }

    this.origins = checkAppOrigins(options.appOrigins, options.gatewayOrigins);
    for (const [id, origin] of this.origins) {
      this.appsByHost.set(new URL(origin).host, id);
    }

    this.grants = new GrantBook(options.sources, {
      grantLifetimeMilliseconds: options.grantLifetimeMilliseconds,
      sessionLifetimeMilliseconds: options.sessionLifetimeMilliseconds,
    });
    this.maximumBody = options.maximumRequestBodyBytes ?? defaultMaximumBody;
  }

  /** Bound port (useful when started with port 0). */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : this.options.port;
  }

  /** Live phone app sessions (tests and diagnostics). */
  get sessionCount(): number {
    return this.grants.sessionCount;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.options.log(`App proxy error: ${String(error)}`);
        if (!response.headersSent) {
          sendPage(response, 500, 'Something went wrong', 'The app proxy hit an internal error.');
        } else {
          response.destroy();
        }
      });
    });

    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head).catch((error) => {
        this.options.log(`App proxy WebSocket error: ${String(error)}`);
        socket.destroy();
      });
    });
    // CONNECT would ask us to tunnel anywhere; this is not a forward proxy.
    this.server.on('connect', (_request, socket) => {
      socket.end(
        'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once('error', rejectListen);
      this.server!.listen(this.options.port, this.options.host, () => {
        this.server!.removeListener('error', rejectListen);
        resolveListen();
      });
    });

    this.sweepTimer = setInterval(() => {
      this.grants.sweep().catch((error) => this.options.log(String(error)));
    }, this.options.sweepMilliseconds ?? 5000);
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.grants.endAll();

    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    }
  }

  /**
   * Apps a paired phone may open: registered, phone access enabled, and with
   * an origin configured for this proxy.
   */
  async phoneApps(): Promise<PhoneApp[]> {
    const apps = await this.options.sources.apps();
    const result: PhoneApp[] = [];

    for (const app of apps) {
      const origin = this.origins.get(app.id);
      if (!app.phoneAccess || origin === undefined) {
        continue;
      }

      const running = await portAcceptsConnections(parseUpstream(app.upstream), 300);
      result.push({ id: app.id, name: app.name, origin, running });
    }

    return result;
  }

  /**
   * Called by the authenticated gateway for one device. Returns the top-level
   * URL the phone opens; its single-use grant becomes an app-origin cookie.
   */
  async openForDevice(
    deviceId: string,
    appId: string,
  ): Promise<{ url: string; expiresAt: number }> {
    const origin = this.origins.get(appId);
    if (origin === undefined) {
      throw Error('That app is not available on phones');
    }

    const { grant, expiresAt } = await this.grants.createGrant(deviceId, appId);
    const url = `${origin}${grantPath}?grant=${encodeURIComponent(grant)}`;
    return { url, expiresAt };
  }

  /** Force an immediate authorization recheck (tests; the timer does this routinely). */
  sweep(): Promise<void> {
    return this.grants.sweep();
  }

  // ---- HTTP -----------------------------------------------------------------

  private appForRequest(request: IncomingMessage): { id: string; origin: string } | undefined {
    const host = String(request.headers.host ?? '').toLowerCase();
    const id = this.appsByHost.get(host);
    if (id === undefined) {
      return undefined;
    }

    return { id, origin: this.origins.get(id)! };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = this.appForRequest(request);
    if (!target) {
      sendPage(response, 421, 'Unknown app', 'No app is configured for this address.');
      return;
    }

    // Only origin-form targets. An absolute-form target could otherwise make
    // the request line disagree with Host, and "*" has no meaning here.
    const path = request.url ?? '';
    if (!path.startsWith('/')) {
      sendPage(response, 400, 'Bad request', 'Unsupported request target.');
      return;
    }

    if (path === grantPath || path.startsWith(grantPath + '?')) {
      await this.redeemGrant(request, response, target.id, path);
      return;
    }

    const verdict = checkBrowserRequest(request.headers, request.method, target.origin, false);
    if (!verdict.allowed) {
      sendPage(response, 403, 'Blocked', 'This request did not come from the app itself.');
      return;
    }

    const authorized = await this.grants.authorize(
      sessionCookieValues(request.headers.cookie),
      target.id,
    );
    if (!authorized) {
      sendPage(
        response,
        401,
        'Open this app from Companion',
        'Your phone session for this app has ended or was never started. ' +
          'Open the app again from the Apps list in Companion.',
      );
      return;
    }

    this.forward(request, response, authorized.app, authorized.session, target.origin, path);
  }

  /**
   * GET /__companion_app_grant?grant=… : exchange the grant for the session
   * cookie, then continue to `/` with a same-origin refresh. A 3xx redirect is
   * not used because a SameSite=Strict cookie is withheld from a redirect chain
   * that began on another site (the gateway), which would bounce the first
   * load to the "open from Companion" page.
   */
  private async redeemGrant(
    request: IncomingMessage,
    response: ServerResponse,
    appId: string,
    path: string,
  ): Promise<void> {
    if (request.method !== 'GET') {
      sendPage(response, 405, 'Method not allowed', 'Open this link directly.');
      return;
    }

    const grant = new URL(path, 'http://app.invalid').searchParams.get('grant');
    const result = await this.grants.redeem(grant, appId);
    if (!result.ok) {
      sendPage(
        response,
        401,
        'This link has expired',
        'App links from Companion work once, for one minute. Open the app again from Companion.',
      );
      return;
    }

    const cookie =
      `${sessionCookieName}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; ` +
      `Max-Age=${this.grants.sessionMaxAgeSeconds}`;

    response.setHeader('Set-Cookie', cookie);
    response.setHeader('Refresh', '0; url=/');
    sendPage(response, 200, 'Opening app…', 'Opening the app.', '<a href="/">Continue</a>');
  }

  /** Stream one request to the backend and its response back. Never retried. */
  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    app: RegisteredApp,
    session: AppSession,
    publicOrigin: string,
    path: string,
  ): void {
    const endpoint = parseUpstream(app.upstream);
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (declaredLength > this.maximumBody) {
      sendPage(response, 413, 'Too large', 'The upload is larger than the app proxy allows.');
      return;
    }

    const upstream = httpRequest({
      host: endpoint.address,
      port: endpoint.port,
      method: request.method,
      path,
      headers: upstreamRequestHeaders(request.headers),
      // A fresh connection per request: nothing from one phone request can be
      // queued behind, or confused with, another request on a pooled socket.
      agent: false,
      setHost: false,
    });

    // Register this client's socket so revoking the session cuts a long
    // download or stream, then make sure the session did not end meanwhile.
    const clientSocket = request.socket;
    session.sockets.add(clientSocket);
    if (session.ended) {
      upstream.destroy();
      clientSocket.destroy();
      return;
    }

    let bodyBytes = 0;
    let bodySent = false;
    let finished = false;

    const release = () => {
      finished = true;
      session.sockets.delete(clientSocket);
    };
    response.once('close', () => {
      // The phone went away (or the response completed): stop the upstream
      // exchange too, rather than leaving it running unobserved.
      if (!response.writableFinished) {
        upstream.destroy();
      }
      release();
    });

    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      bodySent = true;
      if (bodyBytes > this.maximumBody) {
        upstream.destroy();
        if (!response.headersSent) {
          sendPage(response, 413, 'Too large', 'The upload is larger than the app proxy allows.');
        }
        request.destroy();
        return;
      }
      if (!upstream.write(chunk)) {
        request.pause();
      }
    });
    upstream.on('drain', () => request.resume());
    request.once('end', () => upstream.end());

    upstream.once('response', (upstreamResponse) => {
      if (finished) {
        upstreamResponse.destroy();
        return;
      }

      const headers = phoneResponseHeaders(
        upstreamResponse.rawHeaders,
        endpoint.origin,
        publicOrigin,
      );
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        headers,
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once('error', () => response.destroy());
    });

    upstream.once('error', () => {
      if (response.headersSent) {
        // Mid-response failure: the phone sees a truncated response.
        response.destroy();
        return;
      }

      if (bodySent || !isSafeMethod(request.method)) {
        sendPage(
          response,
          502,
          'Outcome unknown',
          'The app backend stopped before answering. This action may or may not have been ' +
            'applied; check the app before trying again.',
        );
      } else {
        sendPage(
          response,
          502,
          'App unavailable',
          `${app.name} is not running on this computer right now. Start it, then reload.`,
        );
      }
    });
  }

  // ---- WebSocket ------------------------------------------------------------

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    const target = this.appForRequest(request);
    if (!target) {
      refuse(421, 'Misdirected Request');
      return;
    }

    const path = request.url ?? '';
    if (!path.startsWith('/') || path.startsWith(grantPath)) {
      refuse(400, 'Bad Request');
      return;
    }
    if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      refuse(400, 'Bad Request');
      return;
    }

    const verdict = checkBrowserRequest(request.headers, request.method, target.origin, true);
    if (!verdict.allowed) {
      refuse(403, 'Forbidden');
      return;
    }

    const authorized = await this.grants.authorize(
      sessionCookieValues(request.headers.cookie),
      target.id,
    );
    if (!authorized) {
      refuse(401, 'Unauthorized');
      return;
    }

    const { session, app } = authorized;
    const endpoint = parseUpstream(app.upstream);
    const upstream = connect({ host: endpoint.address, port: endpoint.port });

    session.sockets.add(socket);
    session.sockets.add(upstream);
    const release = () => {
      session.sockets.delete(socket);
      session.sockets.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.once('close', release);
    upstream.once('close', release);
    socket.on('error', release);

    if (session.ended) {
      release();
      return;
    }

    let connected = false;
    upstream.once('error', () => {
      if (!connected) {
        refuse(502, 'Bad Gateway');
      }
      release();
    });

    upstream.once('connect', () => {
      connected = true;
      upstream.write(upgradeRequestHead(request, path));
      if (head.length > 0) {
        upstream.write(head);
      }
      // From here on both directions are opaque WebSocket bytes.
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }
}

/** The handshake request line and sanitized headers for the backend. */
function upgradeRequestHead(request: IncomingMessage, path: string): string {
  const headers = upstreamRequestHeaders(request.headers, true);
  const lines = [`GET ${path} HTTP/1.1`];

  for (const [name, value] of Object.entries(headers)) {
    for (const single of Array.isArray(value) ? value : [value]) {
      // Node's parser already rejected CR/LF in incoming header values.
      lines.push(`${name}: ${single}`);
    }
  }

  return lines.join('\r\n') + '\r\n\r\n';
}

/** A small self-contained HTML page for proxy-generated answers. */
function sendPage(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  extraHtml = '',
): void {
  const body =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title></head><body style="font-family: system-ui; padding: 1.5rem">` +
    `<h1 style="font-size: 1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
    `${extraHtml}</body></html>`;

  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
