import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentDraftOutcome, AgentMessageOrigin, AgentProfile } from './types.ts';

/**
 * Agent-to-agent hops allowed after a human-originated turn. A human message
 * starts at depth 0; a message sent by that turn's agent arrives at depth 1.
 * Three hops allow "ask B, B answers A, A follows up" but stop ping-pong.
 */
export const maxAgentDepth = 3;

/** Start/reopen/close/send/draft calls admitted per agent turn, including failures. */
export const maxLifecycleActionsPerTurn = 6;

const sessionIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const maximumBodyBytes = 32 * 1024;
const maximumReceiptsPerTurn = 32;
const maximumTextLength = 4000;

/** A deliberate, explainable refusal. `code` is stable for tools and tests. */
export class SessionToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** The small public description of a conversation offered to agents. */
export interface SessionToolSummary {
  id: string;
  title: string;
  status: string;
  profile: AgentProfile;
  /** Current/last turn's model, or the explicit conversation override. */
  model: string;
  modelOverride?: string;
  updatedAt: number;
}

export interface OpenSessionToolSummary extends SessionToolSummary {
  /** A turn is starting, running, being saved, or queued work is waiting. */
  busy: boolean;
  queuedMessages: number;
  /** The calling agent's own conversation. */
  self: boolean;
}

export interface SessionDirectory {
  open: OpenSessionToolSummary[];
  previous: SessionToolSummary[];
  /** Saved conversations matching the query before the limit was applied. */
  previousMatches: number;
}

/**
 * Narrow lifecycle operations implemented by `AgentSessions`. The service owns
 * authentication, validation and the loop/duplicate guards; the host owns the
 * actual tabs, FIFO queues and persisted history.
 */
export interface SessionToolHost {
  title(id: string): string | undefined;
  sourceGroupId?(sender: string, toolCallId: string): string | undefined;
  directory(sender: string, query: string, limit: number): SessionDirectory;
  start(
    request: {
      text: string;
      profile: AgentProfile;
      model: string;
      focus: boolean;
      origin: AgentMessageOrigin;
    },
    signal: AbortSignal,
  ): Promise<SessionToolSummary>;
  reopen(
    id: string,
    focus: boolean,
    signal: AbortSignal,
  ): Promise<{
    outcome: 'reopened' | 'already-open';
    session: SessionToolSummary;
    messages: number;
  }>;
  close(
    id: string,
    sender: string,
    signal: AbortSignal,
  ): Promise<{
    outcome: 'closed' | 'closing-after-turn' | 'already-closed';
    session: SessionToolSummary;
  }>;
  send(
    id: string,
    text: string,
    origin: AgentMessageOrigin,
    signal: AbortSignal,
  ): { outcome: 'started' | 'queued'; queuePosition: number; session: SessionToolSummary };
  draft(
    request: {
      id: string;
      text: string;
      ifDraftExists: 'reject' | 'append';
      focus: boolean;
      origin: AgentMessageOrigin;
    },
    signal: AbortSignal,
  ): Promise<AgentDraftOutcome>;
}

interface ToolReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One agent turn's authority. It names the calling conversation and the depth
 * of the prompt that started the turn; the tool cannot claim another sender.
 */
interface Lease {
  token: string;
  owner: string;
  depth: number;
  signal: AbortSignal;
  actions: number;
  /** Content keys delivered (or possibly delivered) during this turn. */
  delivered: Set<string>;
  /** Replies by Pi tool-call ID, so a repeated call is answered only once. */
  receipts: Map<string, Promise<ToolReply>>;
  release(): void;
}

/**
 * Local authenticated endpoint for Pi's session lifecycle tools. Each agent turn
 * receives a random bearer token that expires with the turn. The endpoint only
 * accepts Companion session IDs, never file paths, and never exposes transcripts
 * or unsent user drafts. Requests are small bounded JSON objects.
 */
export class SessionToolService {
  private readonly leases = new Map<string, Lease>();
  private server?: Server;
  private starting?: Promise<string>;
  private origin = '';
  private closed = false;

  constructor(private readonly host: SessionToolHost) {}

  /** Grant the calling turn access until `signal` aborts or `release` runs. */
  async lease(
    owner: string,
    depth: number,
    signal: AbortSignal,
  ): Promise<{ endpoint: string; token: string; release(): void }> {
    signal.throwIfAborted();
    const origin = await this.start();
    signal.throwIfAborted();

    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    const release = () => {
      this.leases.delete(token);
      controller.abort();
      signal.removeEventListener('abort', release);
    };

    this.leases.set(token, {
      token,
      owner,
      depth,
      signal: AbortSignal.any([signal, controller.signal]),
      actions: 0,
      delivered: new Set(),
      receipts: new Map(),
      release,
    });
    signal.addEventListener('abort', release, { once: true });
    return { endpoint: origin + '/session', token, release };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const lease of this.leases.values()) {
      lease.release();
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  private start(): Promise<string> {
    if (this.closed) {
      return Promise.reject(Error('Session tools are closed'));
    }
    this.starting ??= new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        void this.receive(request, response).catch((error) => {
          this.reply(response, this.failure(error));
        });
      });
      this.server.once('error', reject);
      this.server.unref();
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') {
          reject(Error('Session tools failed to bind'));
          return;
        }
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve(this.origin);
      });
    });
    return this.starting;
  }

  private reply(response: ServerResponse, reply: ToolReply): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(reply.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(reply.body));
  }

  private failure(error: unknown): ToolReply {
    if (error instanceof SessionToolError) {
      return { status: error.status, body: { error: error.message, code: error.code } };
    }
    // A host observed the turn's cancellation across one of its own awaits.
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 403,
        body: {
          error: 'This agent turn has ended; the action was not performed',
          code: 'expired',
        },
      };
    }
    // Ordinary lifecycle errors (queue full, capacity, closing) keep their
    // existing user-facing wording and are reported as explicit refusals.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 409, body: { error: message, code: 'rejected' } };
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > maximumBodyBytes) {
        throw new SessionToolError('invalid', 'Session tool request is too large', 413);
      }
      chunks.push(chunk as Buffer);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SessionToolError('invalid', 'Expected a JSON object', 400);
    }
    return value as Record<string, unknown>;
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Loopback plus an exact Host header rejects DNS rebinding and browsers.
    if (
      this.closed ||
      request.method !== 'POST' ||
      request.url !== '/session' ||
      request.headers.host !== this.origin.slice('http://'.length) ||
      (request.headers.origin !== undefined && request.headers.origin !== this.origin)
    ) {
      this.reply(response, { status: 403, body: { error: 'Request rejected', code: 'forbidden' } });
      return;
    }

    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const lease = token ? this.leases.get(token) : undefined;
    if (!lease || lease.signal.aborted) {
      this.reply(response, {
        status: 403,
        body: {
          error: 'This agent turn has ended; session tools are no longer available',
          code: 'expired',
        },
      });
      return;
    }

    const command = await this.body(request);
    // Authority is checked again after the body arrives: the turn may have
    // ended while an authenticated request was still being received.
    this.assertLive(lease);
    this.reply(response, await this.dispatch(lease, command));
  }

  /** Refuse work for a lease that was released or whose turn was cancelled. */
  private assertLive(lease: Lease): void {
    if (lease.signal.aborted || !this.leases.has(lease.token)) {
      throw new SessionToolError(
        'expired',
        'This agent turn has ended; session tools are no longer available',
        403,
      );
    }
  }

  private async dispatch(lease: Lease, command: Record<string, unknown>): Promise<ToolReply> {
    const method = command.method;
    if (method === 'list') {
      return this.list(lease, command);
    }
    if (
      method !== 'start' &&
      method !== 'reopen' &&
      method !== 'close' &&
      method !== 'send' &&
      method !== 'draft'
    ) {
      throw new SessionToolError('invalid', 'Unknown session tool method', 400);
    }

    // Pi supplies its tool-call ID. A repeated delivery of the same call gets
    // the original reply instead of acting twice.
    const requestId = command.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
      throw new SessionToolError('invalid', 'Missing tool call identity', 400);
    }
    const receiptKey = `${method}:${requestId}`;
    const previous = lease.receipts.get(receiptKey);
    if (previous) {
      return previous;
    }
    if (lease.receipts.size >= maximumReceiptsPerTurn) {
      throw new SessionToolError('limit', 'Too many session tool calls in this turn', 429);
    }

    const reply = this.act(lease, method, command, requestId).catch((error) => this.failure(error));
    lease.receipts.set(receiptKey, reply);
    return reply;
  }

  private list(lease: Lease, command: Record<string, unknown>): ToolReply {
    const query = optionalString(command.query, 'query', 100) ?? '';
    const limit = command.limit ?? 20;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new SessionToolError('invalid', 'limit must be an integer from 1 to 50', 400);
    }
    const directory = this.host.directory(lease.owner, query, limit);
    return { status: 200, body: { self: lease.owner, ...directory } };
  }

  private async act(
    lease: Lease,
    method: 'start' | 'reopen' | 'close' | 'send' | 'draft',
    command: Record<string, unknown>,
    toolCallId: string,
  ): Promise<ToolReply> {
    // Validate before consuming the turn's action budget, so a malformed call
    // can be corrected without exhausting it.
    const focus = optionalBoolean(command.focus, 'focus') ?? false;
    const id = method === 'start' ? '' : sessionId(command.id);
    const text = method === 'reopen' || method === 'close' ? '' : messageText(command.text);

    // Commit point for every mutating method; hosts recheck the lease signal
    // across their own awaits before changing any conversation.
    this.assertLive(lease);
    if (lease.actions >= maxLifecycleActionsPerTurn) {
      throw new SessionToolError(
        'limit',
        `An agent turn can perform at most ${maxLifecycleActionsPerTurn} session actions`,
        429,
      );
    }
    lease.actions++;

    if (method === 'reopen') {
      const result = await this.host.reopen(id, focus, lease.signal);
      return { status: 200, body: { ...result } };
    }

    // Closing never delivers content or starts a turn, so it has no depth or
    // duplicate-content check. The host defers closing the caller's own tab.
    if (method === 'close') {
      const result = await this.host.close(id, lease.owner, lease.signal);
      return { status: 200, body: { ...result } };
    }

    if (method === 'send' && id === lease.owner) {
      throw new SessionToolError(
        'self-target',
        'An agent cannot send a message to its own conversation',
      );
    }

    // Only messages that can start another agent turn extend the chain. A
    // draft waits for the user, so it cannot create an automatic loop.
    const depth = lease.depth + 1;
    if ((method === 'start' || method === 'send') && depth > maxAgentDepth) {
      throw new SessionToolError(
        'loop-limit',
        `This turn was started by a chain of ${lease.depth} agent messages. ` +
          'Further agent-to-agent messages are blocked to prevent a feedback loop; ' +
          'report back to the user instead.',
      );
    }

    const senderTitle = this.host.title(lease.owner);
    if (senderTitle === undefined) {
      throw new SessionToolError('expired', 'The calling conversation is no longer open', 403);
    }
    const origin: AgentMessageOrigin = {
      kind: 'agent',
      sessionId: lease.owner,
      title: [...senderTitle].slice(0, 80).join(''),
      depth,
    };
    const sourceGroupId = this.host.sourceGroupId?.(lease.owner, toolCallId);
    if (sourceGroupId) {
      origin.sourceGroupId = sourceGroupId;
    }

    // Reserve the content before awaiting, so parallel identical calls in one
    // turn cannot both deliver. Only a definite non-delivery releases it.
    const deliveryKey = createHash('sha256').update(`${method}\0${id}\0${text}`).digest('hex');
    if (lease.delivered.has(deliveryKey)) {
      throw new SessionToolError(
        'duplicate',
        'This exact content was already delivered to that destination in this turn. ' +
          'Do not resend it; inspect the destination with companion_sessions instead.',
      );
    }
    lease.delivered.add(deliveryKey);

    try {
      if (method === 'start') {
        const profile = command.profile ?? 'coding';
        if (profile !== 'coding' && profile !== 'quickQuestion') {
          throw new SessionToolError('invalid', 'profile must be coding or quickQuestion', 400);
        }
        const model = optionalString(command.model, 'model', 300) ?? '';
        if (model && !model.includes('/')) {
          throw new SessionToolError('invalid', 'model must be a provider/model identifier', 400);
        }
        const session = await this.host.start(
          { text, profile, model, focus, origin },
          lease.signal,
        );
        return { status: 200, body: { outcome: 'started', session } };
      }

      if (method === 'send') {
        const result = this.host.send(id, text, origin, lease.signal);
        return { status: 200, body: { ...result } };
      }

      const ifDraftExists = command.ifDraftExists ?? 'reject';
      if (ifDraftExists !== 'reject' && ifDraftExists !== 'append') {
        throw new SessionToolError('invalid', 'ifDraftExists must be reject or append', 400);
      }
      const result = await this.host.draft(
        { id, text, ifDraftExists, focus, origin },
        lease.signal,
      );
      if (result.outcome === 'inserted' || result.outcome === 'appended') {
        return { status: 200, body: { ...result, id } };
      }
      throw new SessionToolError(result.outcome, draftFailure(result));
    } catch (error) {
      // A draft's uncertain outcome must keep its reservation. Every other
      // thrown path happened before the host accepted the content.
      if (!(error instanceof SessionToolError && error.code === 'unconfirmed')) {
        lease.delivered.delete(deliveryKey);
      }
      throw error;
    }
  }
}

function draftFailure(result: AgentDraftOutcome): string {
  const reason = result.reason ? ` ${result.reason}` : '';
  if (result.outcome === 'conflict') {
    return (
      'Draft not inserted: the user already has unsent text there, which was left unchanged.' +
      reason +
      ' Use ifDraftExists "append" only if adding below their text is appropriate.'
    );
  }
  if (result.outcome === 'unavailable') {
    return 'Draft not inserted: the conversation is not available in the Companion UI.' + reason;
  }
  if (result.outcome === 'offline') {
    return 'Draft not inserted: no Companion panel is connected to hold it.' + reason;
  }
  return (
    'The Companion UI did not confirm the draft; it may or may not have been inserted.' +
    reason +
    ' Do not resend it; ask the user to check that conversation.'
  );
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !sessionIdPattern.test(value)) {
    throw new SessionToolError(
      'invalid',
      'id must be a lowercase session UUID from companion_sessions',
      400,
    );
  }
  return value;
}

function messageText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumTextLength) {
    throw new SessionToolError('invalid', 'text requires 1–4000 characters', 400);
  }
  return value;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximum) {
    throw new SessionToolError('invalid', `${name} must be at most ${maximum} characters`, 400);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new SessionToolError('invalid', `${name} must be a boolean`, 400);
  }
  return value;
}
