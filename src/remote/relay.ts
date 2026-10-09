/**
 * One authenticated phone connection, relayed to the listener.
 *
 * Inputs:  JSON messages from the phone's WebSocket (after authentication).
 * Outputs: validated requests on a private Unix socket connection to the
 *          listener, declared as a remote-role client; filtered and rewritten
 *          listener events and replies back to the phone.
 *
 * Each phone connection owns exactly one upstream socket, so the listener's
 * per-connection state (the remote selection, outstanding-request limits)
 * maps one-to-one onto phone connections.
 *
 * Lifetime: the relay starts when a phone authenticates. If the phone goes
 * away while requests are still executing, the upstream socket stays open
 * until they answer (bounded by `drainMilliseconds`), so their receipts record
 * the real outcome for a reconnecting phone. If the listener goes away, the
 * phone connection is closed with an "engine unavailable" code.
 */

import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import type { WebSocket } from 'ws';

import {
  remoteEvents,
  mutatingActions,
  parseRemoteRequest,
  type GatewayMessage,
  type RemoteRequest,
} from './protocol.ts';
import { requestFingerprint, type ReceiptBook } from './receipts.ts';
import { PhoneOutput } from './outbound.ts';

/** WebSocket close codes the phone app understands. */
export const closeCodes = {
  engineUnavailable: 4503,
  unauthorized: 4401,
  revoked: 4403,
  overloaded: 4429,
  slowConsumer: 4408,
  shutdown: 4001,
} as const;

/** Most time the upstream stays open after the phone leaves, for replies. */
const drainMilliseconds = 15_000;

/** Bound role negotiation and requests even when the Unix peer stops replying. */
const roleMilliseconds = 5000;
const requestMilliseconds = 15_000;
const maximumPendingRequests = 32;

/** Listener lines larger than this are refused (a full snapshot is far below). */
const maximumUpstreamLineCharacters = 64 * 1024 * 1024;

/** Token bucket for phone requests: short bursts, steady 10 per second. */
const requestBurst = 30;
const requestsPerSecond = 10;

const screenshotName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/;

type Reply = Extract<GatewayMessage, { type: 'result' | 'error' }>;

interface PendingRequest {
  request: RemoteRequest;
  timer: ReturnType<typeof setTimeout>;
  finish(reply: Reply): void;
}

export interface RelayOptions {
  controlSocket: string;
  /** Directory holding saved session screenshots, `<uuid>.png`. */
  sessionsDirectory: string;
  deviceId: string;
  receipts: ReceiptBook;
  /** Negotiated by the gateway, never forwarded as a desktop panel request. */
  incrementalSessions?: boolean;
  /** Remember that this device may fetch a session's screenshot. */
  allowScreenshot(deviceId: string, sessionId: string): void;
  /** The gateway retains draining relays until their upstream is really closed. */
  onClosed(): void;
  log(message: string): void;
}

export class Relay {
  private readonly upstream: Socket;
  private readonly output: PhoneOutput;
  private sentSnapshot = false;
  private readonly pending = new Map<string, PendingRequest>();
  private nextUpstreamId = 0;
  private buffered = '';
  private ready = false;
  /** Upstream IDs accepted before the listener confirmed the remote role. */
  private readonly queued: string[] = [];
  private readonly initialEvents: Record<string, unknown>[] = [];
  private initialEventCharacters = 0;
  private readonly duplicateWaiters = new Set<() => void>();
  private readonly roleTimer: ReturnType<typeof setTimeout>;
  private terminated = false;
  private phoneOpen = true;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private tokens = requestBurst;
  private tokensUpdatedAt = Date.now();

  constructor(
    private readonly phone: WebSocket,
    private readonly options: RelayOptions,
  ) {
    this.output = new PhoneOutput(phone, () => {
      this.options.log('Closing a phone connection that stopped reading');
      this.terminate(closeCodes.slowConsumer, 'Connection too slow');
    });
    this.upstream = createConnection(options.controlSocket);
    this.upstream.setEncoding('utf8');
    this.roleTimer = setTimeout(
      () => this.terminate(closeCodes.engineUnavailable, 'Companion did not confirm remote access'),
      roleMilliseconds,
    );

    this.upstream.on('connect', () => {
      // Declare the role before anything else so this connection can never
      // become the desktop's selection, navigation owner or draft host.
      this.writeUpstream({ action: 'client-role', role: 'remote', requestId: 'role' });
    });
    this.upstream.on('data', (chunk: string) => this.upstreamData(chunk));
    this.upstream.on('error', () => this.upstream.destroy());
    this.upstream.on('close', () => this.upstreamClosed());

    phone.on('message', (data, isBinary) => this.phoneMessage(data, isBinary));
    phone.on('close', () => this.phoneClosed());
  }

  /** Close both sides, for revocation or gateway shutdown. */
  terminate(code: number, reason: string): void {
    this.terminated = true;
    this.phoneOpen = false;
    this.output.close();
    clearTimeout(this.roleTimer);
    if (this.phone.readyState === this.phone.OPEN) {
      this.phone.close(code, reason);
    }
    this.upstream.destroy();
  }

  // ---- Phone side ---------------------------------------------------------

  private phoneMessage(data: unknown, isBinary: boolean): void {
    if (this.terminated || !this.phoneOpen) {
      return;
    }
    if (isBinary) {
      this.sendPhone({ type: 'error', message: 'Expected a text message' });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(String(data));
    } catch {
      this.sendPhone({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    // Browser WebSockets cannot send protocol ping frames. An authenticated
    // application heartbeat detects silent network loss without touching the
    // listener or replaying any operation. It shares the request rate limit.
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'ping') {
      if (Object.keys(value).length === 1 && this.takeToken()) {
        this.sendPhone({ type: 'pong' });
      }
      return;
    }

    const parsed = parseRemoteRequest(value);
    if (!parsed.ok) {
      this.sendPhone({ type: 'error', requestId: parsed.requestId, message: parsed.message });
      return;
    }

    if (!this.takeToken()) {
      this.sendPhone({
        type: 'error',
        requestId: parsed.request.requestId,
        action: parsed.request.action,
        message: 'Too many requests; slow down',
      });
      return;
    }

    this.accept(parsed.request);
  }

  private accept(request: RemoteRequest): void {
    const reply = (message: Reply) => this.sendPhone(message);

    if (!mutatingActions.has(request.action)) {
      this.forward(request, reply);
      return;
    }

    const fingerprint = requestFingerprint(request as unknown as Record<string, unknown>);
    const receipt = this.options.receipts.claim(
      this.options.deviceId,
      request.requestId,
      fingerprint,
    );

    if (receipt.kind === 'replay') {
      reply({ ...receipt.reply, duplicate: true });
      return;
    }
    if (receipt.kind === 'pending') {
      const cancel = receipt.wait((settled) => {
        this.duplicateWaiters.delete(cancel);
        reply({ ...settled, duplicate: true });
      });
      this.duplicateWaiters.add(cancel);
      return;
    }
    if (receipt.kind === 'conflict') {
      reply({
        type: 'error',
        requestId: request.requestId,
        action: request.action,
        message: 'This request ID was already used for a different request',
      });
      return;
    }
    if (receipt.kind === 'full') {
      reply({
        type: 'error',
        requestId: request.requestId,
        action: request.action,
        message: 'Request receipt capacity reached; wait before sending another change',
      });
      return;
    }

    // The receipt is settled even if the phone has gone, so a reconnecting
    // phone that asks again learns the real outcome.
    this.forward(request, (message) => {
      receipt.settle(message);
      reply(message);
    });
  }

  private forward(request: RemoteRequest, finish: (reply: Reply) => void): void {
    if (this.pending.size >= maximumPendingRequests) {
      finish({
        type: 'error',
        requestId: request.requestId,
        action: request.action,
        message: 'Too many unfinished requests; wait for earlier ones',
      });
      return;
    }

    const upstreamId = `r${++this.nextUpstreamId}`;
    // Do not merely expire a receipt: the underlying operation may still run.
    // Closing upstream settles every outstanding mutation as uncertain instead.
    const timer = setTimeout(
      () => this.terminate(closeCodes.engineUnavailable, 'Companion did not answer in time'),
      requestMilliseconds,
    );
    this.pending.set(upstreamId, { request, finish, timer });

    if (this.ready) {
      this.sendRequest(upstreamId, request);
    } else {
      this.queued.push(upstreamId);
    }
  }

  private sendRequest(upstreamId: string, request: RemoteRequest): void {
    const { type: _type, requestId: _requestId, ...fields } = request;
    this.writeUpstream({ ...fields, requestId: upstreamId });
  }

  private takeToken(): boolean {
    const now = Date.now();
    const refill = ((now - this.tokensUpdatedAt) / 1000) * requestsPerSecond;
    this.tokens = Math.min(requestBurst, this.tokens + refill);
    this.tokensUpdatedAt = now;

    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private sendPhone(message: GatewayMessage, replaceable = false): void {
    if (!this.phoneOpen || this.phone.readyState !== this.phone.OPEN) {
      return;
    }

    this.output.send(message, replaceable);
  }

  private phoneClosed(): void {
    this.phoneOpen = false;
    this.output.close();
    for (const cancel of this.duplicateWaiters) {
      cancel();
    }
    this.duplicateWaiters.clear();

    if (this.pending.size === 0) {
      this.upstream.destroy();
      return;
    }

    // Let executing requests answer so their receipts hold real outcomes.
    this.drainTimer = setTimeout(() => this.upstream.destroy(), drainMilliseconds);
  }

  // ---- Listener side ------------------------------------------------------

  private writeUpstream(message: object): void {
    if (!this.upstream.destroyed) {
      this.upstream.write(JSON.stringify(message) + '\n');
    }
  }

  private upstreamData(chunk: string): void {
    this.buffered += chunk;

    if (this.buffered.length > maximumUpstreamLineCharacters) {
      this.options.log('Listener sent an oversized line; closing the relay');
      this.upstream.destroy();
      return;
    }

    let newline: number;
    while ((newline = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        continue;
      }
      this.upstreamMessage(message);
    }
  }

  private upstreamMessage(message: Record<string, unknown>): void {
    if (this.terminated) {
      return;
    }
    const isReply = message.type === 'result' || message.type === 'error';

    if (isReply && message.requestId === 'role') {
      this.roleAnswered(message);
      return;
    }

    if (isReply && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.finish(this.replyFor(pending.request, message));
      this.drainedIfDone();
      return;
    }

    if (isReply || typeof message.type !== 'string' || !remoteEvents.has(message.type)) {
      return;
    }

    if (!this.ready) {
      // The listener sends its snapshot immediately on connect, before role
      // negotiation. Hold it locally until the boundary is confirmed.
      this.initialEventCharacters += JSON.stringify(message).length;
      if (
        this.initialEvents.length >= 32 ||
        this.initialEventCharacters > maximumUpstreamLineCharacters
      ) {
        this.terminate(closeCodes.engineUnavailable, 'Too much data before remote access');
        return;
      }
      this.initialEvents.push(message);
      return;
    }

    const routineState = message.type === 'state' && this.sentSnapshot;
    if (routineState && this.options.incrementalSessions) {
      // The existing listener already emits ordered message deltas, removals,
      // restores, history and tab-order events. Repeating every transcript on
      // speech/settings broadcasts wastes cellular bandwidth. Keep the first
      // full snapshot on EVERY socket, then omit only those event-owned fields.
      // Old phone clients that did not negotiate this still receive full state.
      delete message.sessions;
      delete message.previousSessions;
      delete message.sessionOrderRevision;
    }
    this.rewriteEvent(message);
    if (message.type === 'state') {
      this.sentSnapshot = true;
    }
    this.sendPhone({ type: 'engine', message: message as never }, routineState);
  }

  private roleAnswered(message: Record<string, unknown>): void {
    clearTimeout(this.roleTimer);
    if (message.type !== 'result' || message.result !== 'role-recorded') {
      // An older listener without the remote role would treat this phone as
      // a desktop panel. Refuse to relay rather than weaken that boundary.
      this.options.log(`Listener refused the remote role: ${String(message.message)}`);
      this.terminate(closeCodes.engineUnavailable, 'Listener lacks remote panel support');
      return;
    }

    this.ready = true;

    for (const event of this.initialEvents.splice(0)) {
      this.upstreamMessage(event);
    }
    this.initialEventCharacters = 0;

    // Requests sent while the role was being declared keep their order.
    for (const upstreamId of this.queued.splice(0)) {
      const pending = this.pending.get(upstreamId);
      if (pending) {
        this.sendRequest(upstreamId, pending.request);
      }
    }
  }

  private replyFor(request: RemoteRequest, message: Record<string, unknown>): Reply {
    if (message.type === 'result') {
      if (
        request.action === 'agent-history-page' &&
        message.result &&
        typeof message.result === 'object'
      ) {
        this.rewriteSession(message.result as { id?: unknown; messages?: unknown });
      }
      return {
        type: 'result',
        requestId: request.requestId,
        action: request.action,
        result: message.result,
      };
    }
    return {
      type: 'error',
      requestId: request.requestId,
      action: request.action,
      message: String(message.message ?? 'Request failed').slice(0, 600),
    };
  }

  private drainedIfDone(): void {
    if (!this.phoneOpen && this.pending.size === 0) {
      clearTimeout(this.drainTimer);
      this.upstream.destroy();
    }
  }

  private upstreamClosed(): void {
    clearTimeout(this.roleTimer);
    clearTimeout(this.drainTimer);

    // Requests that never answered have an unknown outcome. Record that in
    // their receipts: a repeat must not execute them a second time.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.finish({
        type: 'error',
        requestId: pending.request.requestId,
        action: pending.request.action,
        message:
          'Connection to Companion was lost before it answered; check the current state before trying again',
      });
    }
    this.pending.clear();
    this.initialEvents.length = 0;
    this.queued.length = 0;

    if (this.phoneOpen) {
      this.terminate(closeCodes.engineUnavailable, 'Companion is not running');
    }
    this.options.onClosed();
  }

  // ---- Rewriting ----------------------------------------------------------

  /**
   * Replace desktop-only URLs in session messages. Screenshots become an
   * authenticated gateway path for the phone; widget view URLs (loopback on
   * the desktop) are removed and the phone shows a placeholder instead.
   */
  private rewriteEvent(message: Record<string, unknown>): void {
    // The recent-utterance list (latest 100, across earlier runs) feeds the
    // desktop's paste-recovery picker. The phone shows only this run's
    // Activity, so that text never needs to leave the computer.
    if (message.type === 'state') {
      message.history = [];
      // Snapshot controls are global desktop selection just like the
      // agent-actions event. The phone receives its own controls separately.
      delete message.agentActions;
    }

    const sessions: unknown[] = [];

    if (message.type === 'state' && Array.isArray(message.sessions)) {
      sessions.push(...message.sessions);
    }
    if (message.type === 'agent-session' || message.type === 'agent-restored') {
      sessions.push(message.session);
    }

    for (const session of sessions) {
      const value = session as { id?: unknown; messages?: unknown; pinnedMessage?: unknown };
      this.rewriteSession(value);
      if (value.pinnedMessage) {
        this.rewriteSession({ id: value.id, messages: [value.pinnedMessage] });
      }
    }
  }

  private rewriteSession(session: { id?: unknown; messages?: unknown }): void {
    if (!Array.isArray(session.messages)) {
      return;
    }

    for (const message of session.messages as Record<string, unknown>[]) {
      if (typeof message.screenshotUrl === 'string') {
        const sessionId = this.screenshotSession(message.screenshotUrl);
        if (sessionId && sessionId === session.id) {
          this.options.allowScreenshot(this.options.deviceId, sessionId);
          message.screenshotUrl = `api/screenshots/${sessionId}`;
        } else {
          delete message.screenshotUrl;
        }
      }

      const widget = message.widget as Record<string, unknown> | undefined;
      if (widget && typeof widget === 'object') {
        delete widget.viewUrl;
      }
    }
  }

  /** Accept only `<sessions directory>/<uuid>.png` file URLs. */
  private screenshotSession(url: string): string | undefined {
    let path: string;
    try {
      path = fileURLToPath(url);
    } catch {
      return undefined;
    }

    if (dirname(path) !== resolve(this.options.sessionsDirectory)) {
      return undefined;
    }
    return screenshotName.exec(basename(path))?.[1];
  }
}
