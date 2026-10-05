import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  agentHarnesses,
  type AgentBrowserOpenOutcome,
  type AgentDraftOutcome,
  type AgentHarness,
  type AgentMessageOrigin,
  type AgentProfile,
} from './types.ts';

/**
 * Agent-to-agent hops allowed after a human-originated turn. A human message
 * starts at depth 0; a message sent by that turn's agent arrives at depth 1.
 * Three hops allow "ask B, B answers A, A follows up" but stop ping-pong.
 */
export const maxAgentDepth = 3;

/** Start/reopen/close/send/draft/browser-open calls admitted per agent turn, including failures. */
export const maxLifecycleActionsPerTurn = 6;

import { sessionToolCapabilities, type SessionToolCapability } from './session-tools.ts';

const sessionIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const maximumBodyBytes = 32 * 1024;
const maximumReceiptsPerTurn = 32;
const maximumTextLength = 4000;
/** Longest address `companion_browser_open` accepts, in UTF-16 code units. */
export const maximumBrowserUrlLength = 2048;

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
  /** The agent program running this conversation, fixed for its lifetime. */
  harness: AgentHarness;
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
  /** Stored tool group of the sender's outbound call, if it was retained. */
  sourceGroupId?(sender: string, turnId: string, toolCallId: string): string | undefined;
  directory(sender: string | undefined, query: string, limit: number): SessionDirectory;
  start(
    request: {
      text: string;
      profile: AgentProfile;
      /** Absent: the configured coding default, or Pi for quick questions. */
      harness?: AgentHarness;
      /** Empty: the harness's configured default. Its form is checked by the host. */
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
    sender: string | undefined,
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
  /** Show `url` in the native panel browser for the calling conversation. */
  browserOpen(
    request: { sessionId: string; url: string },
    signal: AbortSignal,
  ): Promise<AgentBrowserOpenOutcome>;
}

export interface ToolReply {
  status: number;
  body: Record<string, unknown>;
}

/** External admission context: no conversation ownership, token or turn lease. */
export interface ExternalCaller {
  kind: 'external';
  label: string;
  requestId: string;
  signal: AbortSignal;
  delivered: Set<string>;
}

/** One internal turn's authority, with a server-established sender and depth. */
interface Lease {
  kind: 'internal';
  token: string;
  owner: string;
  /** Sender turn whose transcript stores this turn's tool calls. */
  turnId: string;
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
    turnId: string,
    depth: number,
    signal: AbortSignal,
  ): Promise<{
    endpoint: string;
    token: string;
    /** Optional tools this service supports; see `sessionToolCapabilities`. */
    capabilities: readonly SessionToolCapability[];
    release(): void;
  }> {
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
      kind: 'internal',
      token,
      owner,
      turnId,
      depth,
      signal: AbortSignal.any([signal, controller.signal]),
      actions: 0,
      delivered: new Set(),
      receipts: new Map(),
      release,
    });
    signal.addEventListener('abort', release, { once: true });
    return {
      endpoint: origin + '/session',
      token,
      capabilities: sessionToolCapabilities,
      release,
    };
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
      method !== 'draft' &&
      method !== 'browser-open'
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

    const action =
      method === 'browser-open'
        ? this.openBrowser(lease, command)
        : this.act(lease, method, command, requestId);
    const reply = action.catch((error) => this.failure(error));
    lease.receipts.set(receiptKey, reply);
    return reply;
  }

  /**
   * `companion_browser_open`: only an internal turn may ask, and only for its
   * own conversation, which the UI must currently show as selected. External
   * callers have no conversation of their own, so this is never offered to
   * them. The panel's confirmed outcome is reported as-is; a page that fails
   * to load is still a truthful, successful report of what the user now sees.
   */
  private async openBrowser(lease: Lease, command: Record<string, unknown>): Promise<ToolReply> {
    // Validate before consuming the turn's action budget.
    const url = browserUrl(command.url);

    this.assertLive(lease);
    if (lease.actions >= maxLifecycleActionsPerTurn) {
      throw new SessionToolError(
        'limit',
        `An agent turn can perform at most ${maxLifecycleActionsPerTurn} session actions`,
        429,
      );
    }
    lease.actions++;
    if (this.host.title(lease.owner) === undefined) {
      throw new SessionToolError('expired', 'The calling conversation is no longer open', 403);
    }

    const result = await this.host.browserOpen({ sessionId: lease.owner, url }, lease.signal);
    const shown =
      result.outcome === 'loaded' ||
      result.outcome === 'loading' ||
      result.outcome === 'load-failed' ||
      result.outcome === 'superseded';
    if (shown) {
      return { status: 200, body: { ...result } };
    }
    throw new SessionToolError(result.outcome, browserFailure(result));
  }

  private list(lease: Lease | undefined, command: Record<string, unknown>): ToolReply {
    const query = optionalString(command.query, 'query', 100) ?? '';
    const limit = command.limit ?? 20;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new SessionToolError('invalid', 'limit must be an integer from 1 to 50', 400);
    }
    const directory = this.host.directory(lease?.owner, query, limit);
    return { status: 200, body: { self: lease?.owner ?? null, ...directory } };
  }

  /** External transport owns its request receipts, deadline and global rate window.
   * It never obtains a turn lease or an internal bearer token. */
  async external(caller: ExternalCaller, command: Record<string, unknown>): Promise<ToolReply> {
    try {
      caller.signal.throwIfAborted();
      if (this.closed) {
        throw new SessionToolError('unavailable', 'Session tools are closed');
      }
      if (command.method === 'list') {
        return this.list(undefined, command);
      }
      if (!['start', 'reopen', 'close', 'send', 'draft'].includes(String(command.method))) {
        throw new SessionToolError('invalid', 'Unknown method', 400);
      }
      return await this.act(
        caller,
        command.method as 'start' | 'reopen' | 'close' | 'send' | 'draft',
        command,
      );
    } catch (error) {
      if (caller.signal.aborted) {
        return {
          status: 409,
          body: {
            code: 'unconfirmed',
            error:
              'Request cancelled or timed out; inspect the destination before another mutation.',
          },
        };
      }
      // Never return arbitrary filesystem/backend errors to external clients.
      if (!(error instanceof SessionToolError)) {
        return {
          status: 409,
          body: {
            code: 'unconfirmed',
            error:
              'Session outcome could not be confirmed; inspect the destination before another mutation.',
          },
        };
      }
      return this.failure(error);
    }
  }

  private async act(
    caller: Lease | ExternalCaller,
    method: 'start' | 'reopen' | 'close' | 'send' | 'draft',
    command: Record<string, unknown>,
    /** Pi's tool-call ID for internal calls; external requests have none. */
    toolCallId?: string,
  ): Promise<ToolReply> {
    // Validate before consuming the turn's action budget, so a malformed call
    // can be corrected without exhausting it.
    const focus = optionalBoolean(command.focus, 'focus') ?? false;
    const id = method === 'start' ? '' : sessionId(command.id);
    const text = method === 'reopen' || method === 'close' ? '' : messageText(command.text);

    // Commit point for every mutating method; hosts recheck the caller signal
    // across their own awaits before changing any conversation.
    if (caller.kind === 'internal') {
      this.assertLive(caller);
      if (caller.actions >= maxLifecycleActionsPerTurn) {
        throw new SessionToolError(
          'limit',
          `An agent turn can perform at most ${maxLifecycleActionsPerTurn} session actions`,
          429,
        );
      }
      caller.actions++;
    } else {
      caller.signal.throwIfAborted();
    }
    const owner = caller.kind === 'internal' ? caller.owner : undefined;

    if (method === 'reopen') {
      const result = await this.host.reopen(id, focus, caller.signal);
      return { status: 200, body: { ...result } };
    }

    // Closing never delivers content or starts a turn, so it has no depth or
    // duplicate-content check. The host defers closing the caller's own tab.
    if (method === 'close') {
      const result = await this.host.close(id, owner, caller.signal);
      return { status: 200, body: { ...result } };
    }

    if (method === 'send' && id === owner) {
      throw new SessionToolError(
        'self-target',
        'An agent cannot send a message to its own conversation',
      );
    }

    // Only messages that can start another agent turn extend the chain. A
    // draft waits for the user, so it cannot create an automatic loop.
    const depth = caller.kind === 'internal' ? caller.depth + 1 : 1;
    if ((method === 'start' || method === 'send') && depth > maxAgentDepth) {
      throw new SessionToolError(
        'loop-limit',
        `This turn was started by a chain of ${depth - 1} agent messages. ` +
          'Further agent-to-agent messages are blocked to prevent a feedback loop; ' +
          'report back to the user instead.',
      );
    }

    let origin: AgentMessageOrigin;
    if (caller.kind === 'external') {
      origin = { kind: 'external', title: caller.label, requestId: caller.requestId, depth };
    } else {
      const senderTitle = this.host.title(caller.owner);
      if (senderTitle === undefined) {
        throw new SessionToolError('expired', 'The calling conversation is no longer open', 403);
      }
      origin = {
        kind: 'agent',
        sessionId: caller.owner,
        title: [...senderTitle].slice(0, 80).join(''),
        depth,
      };

      // Anchor the recipient's heading link to the sender's stored tool group.
      // External callers have no sender transcript, so they never get one.
      const sourceGroupId =
        toolCallId === undefined
          ? undefined
          : this.host.sourceGroupId?.(caller.owner, caller.turnId, toolCallId);
      if (sourceGroupId) {
        origin.sourceGroupId = sourceGroupId;
      }
    }

    // Reserve the content before awaiting, so parallel identical calls in one
    // turn cannot both deliver. Only a definite non-delivery releases it.
    const deliveryKey = createHash('sha256').update(`${method}\0${id}\0${text}`).digest('hex');
    if (caller.delivered.has(deliveryKey)) {
      throw new SessionToolError(
        'duplicate',
        (caller.kind === 'internal'
          ? 'This exact content was already delivered to that destination in this turn. '
          : 'This exact content may already have been delivered to that destination within the duplicate-protection window. ') +
          'Do not resend it; inspect the destination with companion_sessions instead.',
      );
    }
    caller.delivered.add(deliveryKey);

    try {
      if (method === 'start') {
        const profile = command.profile ?? 'coding';
        if (profile !== 'coding' && profile !== 'quickQuestion') {
          throw new SessionToolError('invalid', 'profile must be coding or quickQuestion', 400);
        }
        const harness = command.harness;
        if (harness !== undefined && !agentHarnesses.includes(harness as AgentHarness)) {
          throw new SessionToolError('invalid', 'harness must be pi or claude-code', 400);
        }
        if (profile === 'quickQuestion' && harness === 'claude-code') {
          throw new SessionToolError(
            'invalid',
            'Quick questions always use Pi; omit harness or use the coding profile',
            400,
          );
        }
        // The model's form depends on the harness, which may be the configured
        // default, so the host checks it with `checkStartModel` after resolving.
        const model = optionalString(command.model, 'model', 300) ?? '';
        const session = await this.host.start(
          {
            text,
            profile,
            ...(harness !== undefined ? { harness: harness as AgentHarness } : {}),
            model,
            focus,
            origin,
          },
          caller.signal,
        );
        return { status: 200, body: { outcome: 'started', session } };
      }

      if (method === 'send') {
        const result = this.host.send(id, text, origin, caller.signal);
        return { status: 200, body: { ...result } };
      }

      const ifDraftExists = command.ifDraftExists ?? 'reject';
      if (ifDraftExists !== 'reject' && ifDraftExists !== 'append') {
        throw new SessionToolError('invalid', 'ifDraftExists must be reject or append', 400);
      }
      const result = await this.host.draft(
        { id, text, ifDraftExists, focus, origin },
        caller.signal,
      );
      if (result.outcome === 'inserted' || result.outcome === 'appended') {
        return { status: 200, body: { ...result, id } };
      }
      throw new SessionToolError(result.outcome, draftFailure(result));
    } catch (error) {
      // Keep uncertain drafts and unexpected external host failures reserved:
      // the host might have changed state before throwing. Only a known refusal
      // releases external content for a new attempt. Internal behavior is retained.
      const uncertain =
        (error instanceof SessionToolError && error.code === 'unconfirmed') ||
        (caller.kind === 'external' && !(error instanceof SessionToolError));
      if (!uncertain) {
        caller.delivered.delete(deliveryKey);
      }
      throw error;
    }
  }
}

/**
 * Check the form of a requested start model once the harness is known. An
 * empty model selects the harness's configured default. Pi models name their
 * provider; availability is then checked against Pi's catalog. Claude models
 * follow the same rules as `claudeCode.model` in companion-agent.json (see
 * settings.ts); the Claude Code backend then checks the exact model at startup.
 */
export function checkStartModel(harness: AgentHarness, model: string): void {
  if (!model) {
    return;
  }

  if (harness === 'pi' && !model.includes('/')) {
    throw new SessionToolError('invalid', 'model must be a provider/model identifier', 400);
  }

  if (
    harness === 'claude-code' &&
    (model.startsWith('-') || /\s/u.test(model) || model.includes('/'))
  ) {
    throw new SessionToolError(
      'invalid',
      'model must be a Claude model ID such as claude-opus-5-5, without a provider',
      400,
    );
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

function browserFailure(result: AgentBrowserOpenOutcome): string {
  const reason = result.reason ? ` ${result.reason}` : '';
  if (result.outcome === 'not-selected') {
    return (
      'Not opened: the browser opens only for the conversation the user has selected in the ' +
      'Companion panel.' +
      reason
    );
  }
  if (result.outcome === 'cancelled') {
    return (
      'Not opened: the current page asked whether to leave it, and the user chose to stay.' + reason
    );
  }
  if (result.outcome === 'panel-hidden') {
    return (
      'Not opened: the Companion panel is hidden, so the user could not see the page. ' +
      'Ask the user to open Companion, then try again.' +
      reason
    );
  }
  if (result.outcome === 'busy') {
    return 'Not opened: the user is busy in the panel browser.' + reason;
  }
  if (result.outcome === 'unsupported') {
    return 'Not opened: this Companion panel has no built-in browser.' + reason;
  }
  if (result.outcome === 'refused') {
    return 'Not opened: the panel browser refused this address.' + reason;
  }
  if (result.outcome === 'offline') {
    return 'Not opened: no Companion panel is connected.' + reason;
  }
  return (
    'The Companion panel did not confirm the request; the page may or may not be showing.' +
    reason +
    ' Do not retry; ask the user to check.'
  );
}

/**
 * The same top-level rule as the panel browser (PanelBrowserPolicy.mjs):
 * https:// on any host, http:// only on loopback. Only absolute addresses are
 * accepted from agents; the panel checks the address again before loading.
 */
function browserUrl(value: unknown): string {
  const invalid = new SessionToolError(
    'invalid',
    'url must be an absolute https:// address, or http:// on this computer (localhost), ' +
      `of at most ${maximumBrowserUrlLength} characters`,
    400,
  );
  if (typeof value !== 'string' || !value || value.length > maximumBrowserUrlLength) {
    throw invalid;
  }
  if (/\s/u.test(value)) {
    throw invalid;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }

  const secure = url.protocol === 'https:' && url.hostname !== '';
  const local = url.protocol === 'http:' && loopbackHost(url.hostname);
  if (!secure && !local) {
    throw invalid;
  }
  return url.href;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
