import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { parseChoices, type AgentChoice } from '../choices.ts';
import { parseSessionName } from '../session-name.ts';

/** Largest accepted request body. Eight choices with full descriptions fit easily. */
const maximumBodyBytes = 64 * 1024;

/** Tool-use IDs are Claude's `toolu_…` identifiers; bound them like session-tool request IDs. */
const maximumToolUseIdLength = 200;

/** Results remembered per turn. A turn offering this many choices or names is misbehaving. */
const maximumResultsPerTurn = 64;

/** What the MCP bridge reports, keyed by the Claude tool-use ID that produced it. */
export type TurnResult =
  { kind: 'choices'; options: readonly AgentChoice[] } | { kind: 'name'; title: string };

/** Where the bridge sends results for this turn. Both values are secret to the turn. */
export interface TurnResultConnection {
  endpoint: string;
  token: string;
}

/**
 * The per-turn loopback route through which Companion's MCP bridge reports
 * `companion_choices` and `companion_name_session` results to the Claude
 * backend.
 *
 * Pi carries these results on its own RPC stream. Claude Code's stream only
 * contains the model-visible tool result text, so the bridge posts the
 * structured value here before returning its tool result. The backend then
 * publishes the value only when the matching tool call completes successfully
 * on Claude's stream: an uncorrelated, failed or late report is never shown.
 *
 * Ownership and lifetime: the backend opens one route per turn and closes it
 * in its cleanup, which also runs on cancellation and failure. Closing stops
 * the listener, so the endpoint and token are useless after the turn. The
 * listener is `unref`ed and never keeps the listener process alive.
 *
 * Security: it listens on 127.0.0.1 only, requires the exact Host header
 * (rejecting DNS rebinding and browsers), a POST to `/results`, and a random
 * 256-bit bearer token compared in constant time. Values are validated here
 * with the same parsers as Pi's tools, and again by the backend when used.
 */
export class TurnResultRoute {
  private readonly results = new Map<string, TurnResult>();
  private readonly tokenBytes: Buffer;
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly origin: string,
    readonly token: string,
  ) {
    this.tokenBytes = Buffer.from(token, 'utf8');
  }

  /** Start listening on an ephemeral loopback port. */
  static async open(): Promise<TurnResultRoute> {
    const token = randomBytes(32).toString('hex');
    const server = createServer();
    server.unref();

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(Error('The Claude result route failed to bind'));
          return;
        }
        resolve(address.port);
      });
    });

    const route = new TurnResultRoute(server, `http://127.0.0.1:${port}`, token);
    server.on('request', (request, response) => {
      route.receive(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        route.reply(response, 400, { error: message });
      });
    });
    return route;
  }

  get connection(): TurnResultConnection {
    return { endpoint: `${this.origin}/results`, token: this.token };
  }

  /**
   * Remove and return the result reported for a tool call. Each result is
   * used at most once, when its tool call completes.
   */
  take(toolUseId: string): TurnResult | undefined {
    const result = this.results.get(toolUseId);
    this.results.delete(toolUseId);
    return result;
  }

  /** Stop accepting reports and forget any unused ones. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.results.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      this.closed ||
      request.method !== 'POST' ||
      request.url !== '/results' ||
      request.headers.host !== this.origin.slice('http://'.length) ||
      request.headers.origin !== undefined
    ) {
      this.reply(response, 403, { error: 'Request rejected' });
      return;
    }

    if (!this.authorized(request.headers.authorization)) {
      this.reply(response, 403, { error: 'This agent turn has ended' });
      return;
    }

    const body = await this.body(request);

    // The turn may have ended while the body was arriving.
    if (this.closed) {
      this.reply(response, 403, { error: 'This agent turn has ended' });
      return;
    }

    const toolUseId = body.toolUseId;
    if (typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > maximumToolUseIdLength) {
      this.reply(response, 400, { error: 'Missing Claude tool-use ID' });
      return;
    }

    if (!this.results.has(toolUseId) && this.results.size >= maximumResultsPerTurn) {
      this.reply(response, 429, { error: 'Too many results in this turn' });
      return;
    }

    if (body.kind === 'choices') {
      const options = parseChoices(body.options);
      this.results.set(toolUseId, { kind: 'choices', options });
      this.reply(response, 200, { ok: true });
      return;
    }

    if (body.kind === 'name') {
      const title = parseSessionName(body.title);
      this.results.set(toolUseId, { kind: 'name', title });
      this.reply(response, 200, { ok: true });
      return;
    }

    this.reply(response, 400, { error: 'Unknown result kind' });
  }

  private authorized(header: string | undefined): boolean {
    if (header === undefined || !header.startsWith('Bearer ')) {
      return false;
    }

    const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
    if (presented.length !== this.tokenBytes.length) {
      return false;
    }

    return timingSafeEqual(presented, this.tokenBytes);
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maximumBodyBytes) {
        throw Error('Result is too large');
      }
      chunks.push(buffer);
    }

    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error('Expected a JSON object');
    }

    return value as Record<string, unknown>;
  }

  private reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }

    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }
}
