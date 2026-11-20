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
  draftEvents,
  remoteEvents,
  mutatingActions,
  parseRemoteRequest,
  type GatewayMessage,
  type RemoteRequest,
} from './protocol.ts';
import { requestFingerprint, type ReceiptBook } from './receipts.ts';
import { PhoneOutput } from './outbound.ts';
import { draftEditBurst } from './request-rate.ts';
import { remoteChatAccess } from './chat-access.ts';
import type { RelayFrames } from './frames/handles.ts';

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

/**
 * Draft edits waiting for the listener's answer, per connection, counted
 * apart from the 32 other requests. Keystrokes that a stalled network
 * delivers all at once arrive together; the device's draft-edit burst (120)
 * must fit, or ordinary typing would be refused as unfinished requests. The
 * listener answers each edit at once (it never waits), so they are held only
 * for that round trip; each holds at most 16,000 UTF-16 units of text.
 */
const maximumPendingDraftEdits = draftEditBurst;

/** The answer to a draft edit refused by its rate or the pending bound. */
const draftEditRefusal = 'Too many draft edits; this edit was not saved';

/** Upstream request ID of the visibility withdrawal (see withdrawVisibility). */
const withdrawalRequestId = 'withdraw';

/**
 * Upstream request ID of a report the gateway writes itself (see
 * reportNothingShown). Before role confirmation it also marks that report's
 * place among the queued requests.
 */
const nothingShownRequestId = 'nothing-shown';

/** Listener lines larger than this are refused (a full snapshot is far below). */
const maximumUpstreamLineCharacters = 64 * 1024 * 1024;

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
  /**
   * Take one request token from this device's shared rate limit (see
   * request-rate.ts); false means refuse the message.
   */
  takeToken(): boolean;
  /**
   * Take one token from this device's separate draft-edit rate limit, for a
   * `draft-set`; false means refuse that edit. Only called for draft hosts.
   */
  takeDraftToken(): boolean;
  /** Negotiated by the gateway, never forwarded as a desktop panel request. */
  incrementalSessions?: boolean;
  /**
   * The client authenticated with `drafts: true`: this connection is a draft
   * host. See `drafts` in the Relay class.
   */
  drafts?: boolean;
  /** Remember that this device may fetch a session's screenshot. */
  allowScreenshot(deviceId: string, sessionId: string): void;
  /** Frame addresses for this device's views; absent when no frame origin is configured. */
  frames?: RelayFrames;
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
  /**
   * `wanted`: the phone left while requests still drain and the withdrawal
   * of its page's visibility waits for role confirmation; `sent`: written
   * upstream. See withdrawVisibility.
   */
  private withdrawal: 'none' | 'wanted' | 'sent' = 'none';
  /**
   * The fields of the last `panel-state` written upstream (without its
   * request ID): what the listener believes this connection shows. See
   * reportNothingShown.
   */
  private lastReport?: Record<string, unknown>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  /**
   * Whether this connection is a draft host (the client asked with
   * `drafts: true`). Only then are `draft-set` and `pendingSend` accepted,
   * `draftHost: true` added to every `panel-state` forwarded to the listener,
   * and the listener's `draft-snapshot` and `draft` events relayed. Fixed for
   * the connection's lifetime.
   */
  private readonly drafts: boolean;

  constructor(
    private readonly phone: WebSocket,
    private readonly options: RelayOptions,
  ) {
    this.drafts = options.drafts === true;
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
      // become the desktop's selection or navigation owner. It becomes a
      // draft host only through its panel reports (sendRequest).
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

    const parsed = parseRemoteRequest(value, { drafts: this.drafts });
    if (!parsed.ok) {
      this.sendPhone({ type: 'error', requestId: parsed.requestId, message: parsed.message });
      return;
    }

    // Draft edits arrive once per keystroke. They draw from their own
    // per-device bucket, so typing never uses up the request bucket. A
    // refused edit is answered (the client shows it as not saved) and never
    // closes the connection.
    if (parsed.request.action === 'draft-set') {
      if (!this.options.takeDraftToken()) {
        this.sendPhone({
          type: 'error',
          requestId: parsed.request.requestId,
          action: parsed.request.action,
          message: draftEditRefusal,
        });
        return;
      }
      this.accept(parsed.request);
      return;
    }

    if (!this.takeToken()) {
      this.sendPhone({
        type: 'error',
        requestId: parsed.request.requestId,
        action: parsed.request.action,
        message: 'Too many requests; slow down',
      });
      if (parsed.request.action === 'panel-state') {
        this.reportNothingShown();
      }
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
    const isDraftEdit = request.action === 'draft-set';
    const pendingDraftEdits = this.pendingDraftEdits();
    const full = isDraftEdit
      ? pendingDraftEdits >= maximumPendingDraftEdits
      : this.pending.size - pendingDraftEdits >= maximumPendingRequests;
    if (full) {
      // A refused draft edit is reported like one refused by its rate, so
      // the client shows it as not saved.
      finish({
        type: 'error',
        requestId: request.requestId,
        action: request.action,
        message: isDraftEdit
          ? draftEditRefusal
          : 'Too many unfinished requests; wait for earlier ones',
      });
      if (request.action === 'panel-state') {
        this.reportNothingShown();
      }
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

  /** How many of the pending requests are draft edits. */
  private pendingDraftEdits(): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.request.action === 'draft-set') {
        count++;
      }
    }
    return count;
  }

  private sendRequest(upstreamId: string, request: RemoteRequest): void {
    const { type: _type, requestId: _requestId, ...fields } = request;

    // The listener knows a remote draft host by `draftHost: true` in each of
    // its panel reports, as it knows a desktop editor. The client cannot
    // send this field (protocol.ts); the gateway adds it to every report of
    // a connection that asked for drafts, and to no other.
    const draftHost = request.action === 'panel-state' && this.drafts ? { draftHost: true } : {};

    // A report that waited for role confirmation while the phone left (or
    // started closing) describes a page nobody sees any more: keep its
    // selection and order, but never let it count as visible.
    if (request.action === 'panel-state' && !this.phoneIsOpen()) {
      this.lastReport = { ...fields, ...draftHost, visible: false };
      this.writeUpstream({ ...this.lastReport, requestId: upstreamId });
      return;
    }
    if (request.action === 'panel-state') {
      this.lastReport = { ...fields, ...draftHost };
    }
    this.writeUpstream({ ...fields, ...draftHost, requestId: upstreamId });
  }

  /**
   * The gateway refused one of the client's `panel-state` reports (request
   * rate or pending bound). That report may have hidden the page, or moved
   * it to another conversation or to none, so the listener must stop
   * counting what the last forwarded report recorded: an application chat
   * permission waiting in the listener's queue would otherwise be allowed,
   * or stopped, for a conversation the person may have left, and the unread
   * mark would keep clearing. The gateway therefore reports that the page
   * shows nothing (`id: ""`, `visible: false`), keeping the last report's
   * draft-host fields. It never repeats a selection: a cached one could even
   * select a conversation that has since been closed and reopened.
   *
   * Before the role is confirmed, requests wait in `queued`; this report
   * takes its place there among them, so it follows exactly the requests
   * admitted before the refusal and precedes those admitted after it.
   *
   * At most one such report follows each forwarded report that showed
   * something, so a flood of refused reports never becomes a flood upstream.
   * The listener never waits on a report and takes no slot for it; nobody
   * waits for its reply. The client's next accepted report replaces it.
   */
  private reportNothingShown(): void {
    if (!this.ready) {
      if (this.queued[this.queued.length - 1] !== nothingShownRequestId) {
        this.queued.push(nothingShownRequestId);
      }
      return;
    }
    if (this.upstream.destroyed || !this.lastReport) {
      return;
    }
    if (this.lastReport.id === '' && this.lastReport.visible !== true) {
      return;
    }

    this.lastReport = { ...this.lastReport, id: '', visible: false };
    this.writeUpstream({ ...this.lastReport, requestId: nothingShownRequestId });
  }

  /** The device's rate limit is shared by all its connections. */
  private takeToken(): boolean {
    return this.options.takeToken();
  }

  /** False from the moment the phone's socket starts closing. */
  private phoneIsOpen(): boolean {
    return this.phoneOpen && this.phone.readyState === this.phone.OPEN;
  }

  private sendPhone(message: GatewayMessage, replaceable = false): void {
    if (!this.phoneIsOpen()) {
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

    // The upstream stays open while it drains, but nobody sees the page any
    // more: it must not keep reading conversations (the unread mark). It may
    // already have been withdrawn when the role was confirmed while closing.
    if (this.withdrawal === 'none') {
      this.withdrawal = 'wanted';
    }
    this.withdrawVisibility();
  }

  /**
   * Tell the listener that this phone's page is no longer visible, with the
   * remote-only `withdraw-visibility` action: the connection stops showing
   * any conversation for the unread mark, while its selection stays so
   * draining requests that act on it still answer. It names no conversation
   * and is idempotent, so it can neither fail nor select anything. Sent
   * only after the role is confirmed and after every queued request. The
   * listener admits it even while this connection's other requests fill
   * its slots (src/desktop/server.ts). Its reply is not relayed to anyone.
   */
  private withdrawVisibility(): void {
    if (this.withdrawal !== 'wanted' || !this.ready || this.upstream.destroyed) {
      return;
    }

    this.withdrawal = 'sent';
    this.writeUpstream({ action: 'withdraw-visibility', requestId: withdrawalRequestId });
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

    if (isReply && message.requestId === withdrawalRequestId) {
      // Nobody waits for this reply: the phone has left.
      return;
    }

    if (isReply && message.requestId === nothingShownRequestId) {
      // Nobody waits for the gateway's own report either.
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

    if (isReply || typeof message.type !== 'string') {
      return;
    }
    const relayed =
      remoteEvents.has(message.type) || (this.drafts && draftEvents.has(message.type));
    if (!relayed) {
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
      if (upstreamId === nothingShownRequestId) {
        // A report refused while the role was being declared (in its place).
        this.reportNothingShown();
        continue;
      }
      const pending = this.pending.get(upstreamId);
      if (pending) {
        this.sendRequest(upstreamId, pending.request);
      }
    }

    // A phone that left during role negotiation, or whose socket is already
    // closing: withdraw after its queued reports, edits and sends, which the
    // listener handles in order. Its forwarded reports said `visible: false`
    // but may still have declared it a draft host with a pending send; the
    // withdrawal ends both without waiting for the `close` event.
    if (!this.phoneIsOpen() && this.withdrawal === 'none') {
      this.withdrawal = 'wanted';
    }
    this.withdrawVisibility();
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
      if (
        request.action === 'set-application-chat-read' ||
        request.action === 'set-application-chat-send'
      ) {
        return {
          type: 'result',
          requestId: request.requestId,
          action: request.action,
          result: this.permissionResult(message.result),
        };
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

  /**
   * The result of an accepted permission change: `"preview"` in preview mode,
   * otherwise the new permission state as for sessions (chat-access.ts), or
   * null if the listener's answer is malformed. The change itself was made,
   * and the listener published the conversation's new state before it
   * answered, so the client keeps the latest `chatAccess` it received.
   */
  private permissionResult(result: unknown): unknown {
    if (result === 'preview') {
      return result;
    }
    return remoteChatAccess(result) ?? null;
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
      // Manual recording uses the desktop microphone and composer; the phone
      // can neither start it nor hold its draft.
      delete message.recordingAvailable;
      delete message.recording;
    }

    const sessions: unknown[] = [];

    if (message.type === 'state' && Array.isArray(message.sessions)) {
      sessions.push(...message.sessions);
    }
    if (message.type === 'agent-session' || message.type === 'agent-restored') {
      sessions.push(message.session);
    }
    if (message.type === 'agent-removed') {
      this.options.frames?.conversationRemoved(message.id);
    }

    for (const session of sessions) {
      const value = session as {
        id?: unknown;
        messages?: unknown;
        pinnedMessage?: unknown;
        application?: unknown;
      };
      // A session application's view capability is a desktop loopback URL,
      // like a widget's. The phone keeps the descriptor's metadata only.
      const application = value.application as Record<string, unknown> | undefined;
      if (application && typeof application === 'object') {
        const applicationFrame = this.options.frames?.application(value.id, application.viewUrl);
        delete application.viewUrl;
        if (applicationFrame) {
          application.frameUrl = applicationFrame;
        }

        // The permission state, rebuilt field by field without the send
        // grant's ID (chat-access.ts), so a client can show and change it.
        // Malformed state is not sent at all.
        const chatAccess = remoteChatAccess(application.chatAccess);
        if (chatAccess) {
          application.chatAccess = chatAccess;
        } else {
          delete application.chatAccess;
        }
      }
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
        const widgetFrame = this.options.frames?.widget(session.id, widget.viewUrl);
        delete widget.viewUrl;
        if (widgetFrame) {
          widget.frameUrl = widgetFrame;
        }
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
