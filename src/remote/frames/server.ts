/**
 * The frame origin: a second listener of the phone gateway process that
 * serves widget and session application pages to paired browsers.
 *
 *   browser ──GET /f/<handle>/ ──▶ frame origin ──Unix socket──▶ widget service
 *            (iframe in the shell)  (this file)    widgets.sock   (listener)
 *
 * Why a separate origin: a widget page runs authored JavaScript. On the
 * gateway's own origin it could read the device token in `localStorage` and
 * call the gateway API. On this origin it can reach only its own view's
 * operations, through a handle that names exactly one view.
 *
 * Inputs:  HTTP requests on `listen` (loopback TCP, TCP with the gateway's TLS
 *          certificate, or a private Unix socket behind Tailscale Serve).
 * Outputs: the forwarded widget service answer, with fixed security headers
 *          (./headers.ts), or a refusal.
 *
 * Order of checks for each request (src/remote/README.md, "Widget and
 * application frames"):
 *   1. Tailscale Funnel and the optional required login, as on the gateway.
 *   2. Host (on a Unix socket: X-Forwarded-Host) must be the frame origin's.
 *   3. Admission from the request line and headers alone (./admission.ts).
 *   4. The handle must be live (./handles.ts) and name a view of a kind that
 *      implements the operation. Unknown, ended and mismatched handles get
 *      the same answer as any unknown path.
 *   5. The device's request budget (429 when spent; nothing else changes).
 *   6. Concurrency bounds, then the body is read (bounded, with a deadline),
 *      forwarded with a fixed Host and only Content-Type/Content-Length, and
 *      the answer is read (bounded, with a deadline).
 *   7. Upstream redirects are never followed or passed on (502); an upstream
 *      404 ends the view's handles for every device (the view is gone).
 *
 * Resource bounds: at most 64 sockets, 10 s for request headers, 30 s for a
 * whole exchange including the client reading the answer; at most 16
 * forwarded requests at a time (8 per device); answers up to 4 MiB
 * (documents) or 1 MiB (JSON). These requests never count against the
 * gateway's phone connections or the listener's client slots: they use the
 * widget service socket, not the control socket.
 */

import { chmod } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';

import { privateSocketHost } from '../../widgets/socket.ts';
import { tailscaleRefusal } from '../tailscale-headers.ts';
import { claimUnixSocket, type UnixSocketClaim } from '../unix-socket-claim.ts';
import {
  admitFrameRequest,
  headerListRefusal,
  maximumHeaderFields,
  notFound,
} from './admission.ts';
import { FrameHandles, graceMilliseconds, type FrameConnection } from './handles.ts';
import { frameResponseHeaders, upstreamPolicies } from './headers.ts';

/** Where the frame origin listens: TCP (optionally TLS) or a Unix socket. */
export type FrameListenOptions =
  | { host: string; port: number; socketPath?: undefined }
  | { socketPath: string; host?: undefined; port?: undefined };

export interface FrameOriginOptions {
  listen: FrameListenOptions;
  /** Public origin of this listener, exactly scheme://host[:port]. */
  origin: string;
  /** The gateway's own origins: the only pages that may embed a frame. */
  gatewayOrigins: readonly string[];
  /** App proxy origins, which must differ from the frame origin. */
  appOrigins?: readonly string[];
  /** The listener's widget service socket (src/widgets/socket.ts). */
  widgetSocket: string;
  /** The gateway's certificate, when the gateway itself terminates TLS (TCP only). */
  tls?: { cert: string; key: string };
  /** Same meaning as the gateway's option; checked on every frame request. */
  requireTailscaleLogin?: string;
  log(message: string): void;
  /** Tests may shorten the 30-second grace period after the last connection. */
  graceMilliseconds?: number;
}

const maximumSockets = 64;
const headersTimeoutMilliseconds = 10_000;
/** How often Node enforces the header deadline (its default is 30 s). */
const connectionsCheckingMilliseconds = 1000;
const exchangeMilliseconds = 30_000;
const keepAliveMilliseconds = 5000;
const upstreamMilliseconds = 15_000;
const maximumForwarded = 16;
const maximumForwardedPerDevice = 8;
const maximumDocumentBytes = 4 * 1024 * 1024;
const maximumJsonBytes = 1024 * 1024;

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Validate the frame options against the gateway's; throws a usage error. */
export function checkFrameOptions(options: FrameOriginOptions): void {
  let parsed: URL;
  try {
    parsed = new URL(options.origin);
  } catch {
    throw Error(`The frame origin is not a URL: ${options.origin}`);
  }
  if (parsed.origin !== options.origin) {
    throw Error(`The frame origin must be exactly scheme://host[:port]: ${options.origin}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(hostname))) {
    throw Error(`The frame origin must use https, or http on loopback: ${options.origin}`);
  }
  if (options.gatewayOrigins.includes(options.origin)) {
    throw Error('The frame origin must differ from every gateway origin (--origin)');
  }
  if (options.appOrigins?.includes(options.origin)) {
    throw Error('The frame origin must differ from every app origin (--app-origin)');
  }

  const listen = options.listen;
  if (listen.socketPath !== undefined) {
    if (!listen.socketPath.startsWith('/')) {
      throw Error(`The frame socket path must be absolute: ${listen.socketPath}`);
    }
    if (parsed.protocol !== 'https:') {
      throw Error('A frame origin on a Unix socket must be https (Tailscale Serve terminates TLS)');
    }
    if (options.tls) {
      throw Error('A frame origin on a Unix socket takes no TLS certificate');
    }
    return;
  }

  if (listen.host !== 'localhost' && !isIP(listen.host)) {
    throw Error('Bind the frame origin to a literal IP address or localhost');
  }
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535) {
    throw Error('The frame port must be 0–65535');
  }
  if (listen.host === '0.0.0.0' || listen.host === '::') {
    throw Error('Bind the frame origin to a specific address, not every interface');
  }
  if (options.tls && parsed.protocol !== 'https:') {
    throw Error('The frame listener uses the gateway TLS certificate, so its origin must be https');
  }
  if (!isLoopback(listen.host) && !options.tls) {
    throw Error('A non-loopback frame address needs the gateway TLS certificate (--tls-cert)');
  }
}

export class FrameOrigin {
  readonly handles: FrameHandles;
  private server?: Server;
  private socketClaim?: UnixSocketClaim;
  private readonly frameHost: string;
  private forwarded = 0;
  private readonly forwardedByDevice = new Map<string, number>();

  constructor(private readonly options: FrameOriginOptions) {
    checkFrameOptions(options);
    this.frameHost = new URL(options.origin).host;
    this.handles = new FrameHandles(
      options.origin,
      Date.now,
      options.graceMilliseconds ?? graceMilliseconds,
    );
  }

  get origin(): string {
    return this.options.origin;
  }

  /** Bound TCP port (tests start on port 0); 0 on a Unix socket. */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  /** Human-readable listening address for logs. */
  get address(): string {
    const listen = this.options.listen;
    if (listen.socketPath !== undefined) {
      return `unix:${listen.socketPath}`;
    }
    const scheme = this.options.tls ? 'https' : 'http';
    const host = isIP(listen.host) === 6 ? `[${listen.host}]` : listen.host;
    return `${scheme}://${host}:${this.port}`;
  }

  /** Register one authenticated phone connection (see FrameHandles.connect). */
  connect(deviceId: string): FrameConnection {
    return this.handles.connect(deviceId);
  }

  async start(): Promise<void> {
    const handler = (
      request: IncomingMessage,
      response: ServerResponse,
      expectsContinue = false,
    ) => {
      this.handle(request, response, expectsContinue).catch((error) => {
        this.options.log(`Frame request error: ${String(error)}`);
        if (!response.headersSent) {
          this.refuse(response, 500, 'Internal error');
        } else {
          response.destroy();
        }
      });
    };

    // Over TCP the frame origin uses TLS exactly when the gateway does, with
    // the same certificate. On a Unix socket Tailscale Serve terminates TLS.
    const listen = this.options.listen;
    const serverOptions = { connectionsCheckingInterval: connectionsCheckingMilliseconds };
    const server =
      listen.socketPath === undefined && this.options.tls
        ? createHttpsServer(
            { ...serverOptions, cert: this.options.tls.cert, key: this.options.tls.key },
            handler,
          )
        : createHttpServer(serverOptions, handler);
    this.server = server;
    server.maxConnections = maximumSockets;
    server.maxHeadersCount = maximumHeaderFields;
    server.headersTimeout = headersTimeoutMilliseconds;
    server.requestTimeout = exchangeMilliseconds;
    server.keepAliveTimeout = keepAliveMilliseconds;

    // `Expect: 100-continue` is answered only after admission (see handle());
    // any other expectation is refused with the usual headers.
    server.on('checkContinue', (request, response) => handler(request, response, true));
    server.on('checkExpectation', (_request, response) => {
      this.refuse(response, 417, 'Expectation not supported');
    });

    // No WebSockets and no tunnels on this origin. The socket is ours once
    // either event fires; answer with the usual refusal and destroy it.
    const refuseSocket = (socket: Duplex) => {
      socket.end(this.rawRefusal(400, 'Bad Request', 'Upgrades are not accepted here'), () =>
        socket.destroy(),
      );
    };
    server.on('upgrade', (_request, socket) => refuseSocket(socket));
    server.on('connect', (_request, socket) => refuseSocket(socket));

    try {
      if (listen.socketPath !== undefined) {
        this.socketClaim = await claimUnixSocket(listen.socketPath);
        await bind(server, (callback) => {
          const previousUmask = process.umask(0o177);
          try {
            server.listen(listen.socketPath, callback);
          } finally {
            process.umask(previousUmask);
          }
        });
        await chmod(listen.socketPath, 0o600);
      } else {
        await bind(server, (callback) => server.listen(listen.port, listen.host, callback));
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Stop listening and end every handle (they live in memory only). */
  async close(): Promise<void> {
    this.handles.clear();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    const claim = this.socketClaim;
    this.socketClaim = undefined;
    await claim?.release();
  }

  // ---- Requests -------------------------------------------------------------

  /** The host the browser addressed; X-Forwarded-Host behind Serve's unix: target. */
  private requestHost(request: IncomingMessage): string | undefined {
    const host =
      this.options.listen.socketPath !== undefined
        ? request.headers['x-forwarded-host']
        : request.headers.host;
    return typeof host === 'string' ? host : undefined;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    expectsContinue: boolean,
  ): Promise<void> {
    // The whole exchange, including a client that reads the answer slowly,
    // has one hard deadline. 'close' fires when the answer is complete or
    // the connection went away.
    const deadline = setTimeout(() => response.destroy(), exchangeMilliseconds);
    let responseClosed = false;
    const cancel = new AbortController();
    response.once('close', () => {
      responseClosed = true;
      clearTimeout(deadline);
      cancel.abort();
    });

    // Before anything reads request.headers: a possibly truncated header
    // list, or a repeated Host/Origin/…, is refused rather than interpreted.
    const headerRefusal = headerListRefusal(request.rawHeaders);
    if (headerRefusal) {
      this.refuse(response, headerRefusal.status, headerRefusal.error);
      return;
    }

    const refusal = tailscaleRefusal(request.headers, this.options.requireTailscaleLogin);
    if (refusal !== undefined) {
      this.refuse(
        response,
        403,
        refusal === 'funnel' ? 'Public requests are not allowed' : 'Not allowed',
      );
      return;
    }
    if (this.requestHost(request) !== this.frameHost) {
      this.refuse(response, 421, 'Unknown host');
      return;
    }

    const admission = admitFrameRequest(
      request.method,
      request.url,
      request.headers,
      this.options.origin,
    );
    if (!admission.ok) {
      this.refuse(response, admission.status, admission.error);
      return;
    }

    const target = this.handles.lookup(admission.handle);
    if (!target || !admission.definition.kinds.includes(target.kind)) {
      this.refuse(response, notFound.status, notFound.error);
      return;
    }
    if (!this.handles.takeRequest(target.deviceId)) {
      this.refuse(response, 429, 'Too many requests');
      return;
    }

    const deviceForwarded = this.forwardedByDevice.get(target.deviceId) ?? 0;
    if (this.forwarded >= maximumForwarded || deviceForwarded >= maximumForwardedPerDevice) {
      this.refuse(response, 503, 'Busy; try again');
      return;
    }

    // The slot is held until BOTH the client has the whole answer (or is
    // gone) and the upstream request has settled: stalled readers count
    // against the bound, and a closed tab cannot free a slot while its
    // request still runs in the listener.
    this.forwarded++;
    this.forwardedByDevice.set(target.deviceId, deviceForwarded + 1);
    let upstreamSettled = true;
    let released = false;
    const release = () => {
      if (released || !responseClosed || !upstreamSettled) {
        return;
      }
      released = true;
      this.forwarded--;
      const remaining = (this.forwardedByDevice.get(target.deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.forwardedByDevice.set(target.deviceId, remaining);
      } else {
        this.forwardedByDevice.delete(target.deviceId);
      }
    };
    response.once('close', release);

    let body: Buffer | undefined;
    if (admission.definition.method === 'POST') {
      // Admitted: only now may the client send the body it announced.
      if (expectsContinue) {
        response.writeContinue();
      }
      body = await readExactly(request, admission.bodyBytes);
      if (!body) {
        this.refuse(response, 400, 'Incomplete request body');
        return;
      }
    }

    // Reading the body took time: the handle may have ended meanwhile
    // (revocation, conversation closed). Nothing is forwarded for it then.
    const current = this.handles.lookup(admission.handle);
    if (!current || current.capability !== target.capability || responseClosed) {
      if (!responseClosed) {
        this.refuse(response, notFound.status, notFound.error);
      }
      return;
    }

    const path = `/view/${target.capability}${admission.operation ? '/' + admission.operation : ''}`;
    upstreamSettled = false;
    const answer = await this.forward(
      admission.definition.method,
      path,
      body,
      admission.operation === '' ? maximumDocumentBytes : maximumJsonBytes,
      cancel.signal,
    );
    upstreamSettled = true;
    release();
    if (responseClosed) {
      return;
    }

    if (answer.kind === 'unavailable') {
      this.refuse(response, 503, 'Companion is not available');
      return;
    }
    if (answer.kind === 'timeout') {
      this.refuse(response, 504, 'Companion did not answer in time');
      return;
    }
    if (answer.kind === 'too-large') {
      this.refuse(response, 502, 'Unexpected answer');
      return;
    }

    const status = answer.status;
    if (status === 404) {
      // The widget service no longer knows this view: the conversation closed
      // or the application was removed. End it for every device.
      this.handles.viewEnded(target.capability);
      this.refuse(response, notFound.status, notFound.error);
      return;
    }
    const contentType = singleHeader(answer.headers['content-type']);
    const expected =
      admission.operation === '' && status === 200 ? 'text/html' : 'application/json';
    if (
      status < 200 ||
      (status >= 300 && status < 400) ||
      contentType?.split(';')[0].trim().toLowerCase() !== expected
    ) {
      this.options.log(`Refused an unexpected widget service answer (status ${status})`);
      this.refuse(response, 502, 'Unexpected answer');
      return;
    }

    response.writeHead(status, {
      ...frameResponseHeaders(this.options.gatewayOrigins, upstreamPolicies(answer.headers)),
      'Content-Type': contentType,
      'Content-Length': answer.body.length,
    });
    response.end(answer.body);
  }

  /**
   * One request to the widget service socket. Only a fixed Host and, for a
   * POST, the JSON content type and length are sent: no cookie, origin,
   * credential or other client header reaches the listener.
   */
  private forward(
    method: 'GET' | 'POST',
    path: string,
    body: Buffer | undefined,
    maximumBytes: number,
    cancelled: AbortSignal,
  ): Promise<UpstreamAnswer> {
    return new Promise((resolveAnswer) => {
      // Settles once the upstream exchange is over: answered, failed, timed
      // out, or cancelled because the client left. Cancelling destroys the
      // upstream socket; the result is then settled when that socket closes.
      let settled = false;
      let pendingAnswer: UpstreamAnswer | undefined;
      const settle = (answer: UpstreamAnswer) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cancelled.removeEventListener('abort', onCancel);
          resolveAnswer(answer);
        }
      };

      const headers: Record<string, string | number> = { Host: privateSocketHost };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = body.length;
      }
      const upstream = httpRequest({
        socketPath: this.options.widgetSocket,
        method,
        path,
        headers,
        agent: false,
      });
      const timer = setTimeout(() => {
        pendingAnswer = { kind: 'timeout' };
        upstream.destroy();
      }, upstreamMilliseconds);
      const onCancel = () => {
        pendingAnswer ??= { kind: 'unavailable' };
        upstream.destroy();
      };
      cancelled.addEventListener('abort', onCancel, { once: true });
      if (cancelled.aborted) {
        onCancel();
      }

      upstream.on('error', () => {
        pendingAnswer ??= { kind: 'unavailable' };
      });
      upstream.on('close', () => settle(pendingAnswer ?? { kind: 'unavailable' }));
      upstream.on('response', (answer) => {
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumBytes) {
            pendingAnswer ??= { kind: 'too-large' };
            upstream.destroy();
            return;
          }
          chunks.push(chunk);
        });
        answer.on('end', () => {
          pendingAnswer ??= {
            kind: 'answer',
            status: answer.statusCode ?? 502,
            headers: answer.headers,
            body: Buffer.concat(chunks),
          };
          // agent: false: the socket closes right after the answer.
          upstream.destroy();
        });
        answer.on('error', () => {
          pendingAnswer ??= { kind: 'unavailable' };
        });
      });
      upstream.end(body);
    });
  }

  /** The same refusal as refuse(), as raw bytes for a socket outside HTTP handling. */
  private rawRefusal(status: number, reason: string, error: string): string {
    const body = JSON.stringify({ error });
    const lines = [`HTTP/1.1 ${status} ${reason}`];
    for (const [name, value] of Object.entries(frameResponseHeaders(this.options.gatewayOrigins))) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${String(entry)}`);
      }
    }
    lines.push('Content-Type: application/json; charset=utf-8');
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    lines.push('Connection: close');
    return lines.join('\r\n') + '\r\n\r\n' + body;
  }

  private refuse(response: ServerResponse, status: number, error: string): void {
    const body = JSON.stringify({ error });
    response.writeHead(status, {
      ...frameResponseHeaders(this.options.gatewayOrigins),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }
}

type UpstreamAnswer =
  | { kind: 'answer'; status: number; headers: IncomingHttpHeaders; body: Buffer }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'too-large' };

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a body of exactly `length` bytes (the admitted Content-Length; Node's
 * parser enforces it). Undefined if the client goes away first. The
 * exchange deadline (response.setTimeout) bounds a client that stalls.
 */
async function readExactly(request: IncomingMessage, length: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > length) {
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    return undefined;
  }
  return size === length ? Buffer.concat(chunks) : undefined;
}

/** Listen and resolve once bound; reject on a bind error such as EADDRINUSE. */
function bind(server: Server, listen: (callback: () => void) => void): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    listen(() => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
}
