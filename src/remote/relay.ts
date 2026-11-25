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
 *
 * Audio: a connection may open one audio stream ("Listen here"); its binary
 * messages then go to the listener as `audio-chunk` lines on this same
 * upstream socket. See "Audio streams" below and src/remote/README.md.
 */

import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import type { WebSocket } from 'ws';

import {
  draftEvents,
  remoteEvents,
  maximumAudioChunkBytes,
  maximumAudioStreams,
  mutatingActions,
  parseRemoteRequest,
  type AgentSelectMessage,
  type AudioEndedMessage,
  type AudioEndReason,
  type GatewayMessage,
  type RemoteRequest,
} from './protocol.ts';
import type { AudioRate, AudioStreamHolder, AudioStreamRegistry } from './audio-streams.ts';
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

/** Upstream request ID of the gateway's `report-refused` notices (see reportRefused). */
const reportRefusedRequestId = 'report-refused';

/**
 * Before role confirmation, a refused report's place among the queued
 * requests is kept as this prefix plus the conversation it named (a UUID or
 * empty). Upstream request IDs are `r<number>`, so the two never collide.
 */
const refusedReportMarker = 'refused:';

/** Upstream request ID of the gateway's own `audio-stop` lines (see endAudio). */
const audioStopRequestId = 'audio-stop';

/**
 * Bytes waiting to be written to the listener above which an audio stream
 * ends as `slow-listener`: about six seconds of sound as base64 lines. The
 * listener reads requests as they come, so only a listener that has stopped
 * reading lets this grow.
 */
const maximumUpstreamAudioBacklogBytes = 256 * 1024;

/** What the client is told with each `audio-ended`. */
const audioEndMessages: Record<AudioEndReason, string> = {
  'taken-over': 'Listening moved to another tab or window of this device',
  'too-large': 'A piece of sound was empty, too large or not whole 16-bit samples',
  'too-fast': 'Sound arrived faster than real time allows',
  'slow-listener': 'Companion did not keep up with the sound',
  paused: 'Listening is paused',
  stalled: 'Too little sound arrived from this browser',
  slow: 'Companion did not keep up with the sound',
  failed: 'Listening here failed on the computer',
  shutdown: 'Companion is stopping',
  replaced: 'A newer stream of this connection replaced it',
};

/** Reasons the listener may give in its `audio-ended` event (src/desktop/runtime.ts). */
const listenerAudioEndReasons = new Set<AudioEndReason>([
  'paused',
  'stalled',
  'slow',
  'failed',
  'shutdown',
  'replaced',
]);

const streamIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A conversation ID (a UUID), as the listener creates them. */
const sessionIdPattern = streamIdPattern;

/**
 * This connection's audio stream: none; starting (its `audio-start` waits
 * for the listener; `token` tells a stale answer from the current one, and
 * `ended` keeps an `audio-ended` event the listener sent before its answer);
 * or open, with the listener's stream ID and the device's rate budget.
 */
type AudioState =
  | { phase: 'none' }
  | { phase: 'starting'; token: number; ended?: { streamId: string; reason: AudioEndReason } }
  | { phase: 'open'; streamId: string; rate: AudioRate };

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
  /** The paired device's name, given to the listener with `audio-start`. */
  deviceName?: string;
  /**
   * The gateway's audio streams: one per device, `maximumAudioStreams` in
   * total. Without it this connection is never offered an audio stream.
   */
  audioStreams?: AudioStreamRegistry;
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
   * What the listener may still hold for this connection, from the reports
   * written upstream and the notices since: the selected conversation, and
   * whether the page may count as visible. Only used to skip notices that
   * would change nothing (see reportRefused); the listener only ever lowers
   * its state on a notice, so a needless one is harmless.
   */
  private reportedSelection = '';
  private reportedVisible = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  /**
   * Whether this connection is a draft host (the client asked with
   * `drafts: true`). Only then are `draft-set` and `pendingSend` accepted,
   * `draftHost: true` added to every `panel-state` forwarded to the listener,
   * and the listener's `draft-snapshot` and `draft` events relayed. Fixed for
   * the connection's lifetime.
   */
  private readonly drafts: boolean;
  /**
   * Whether the listener offers audio streams: its latest state said
   * `microphones.streams: true`. An older listener never does, and then
   * `audio-start` is answered here without reaching it.
   */
  private audioAvailable = false;
  private audio: AudioState = { phase: 'none' };
  private audioStarts = 0;
  /**
   * Starts abandoned while their answer was still on its way (the client
   * stopped, or another connection of the device took over), by token, with
   * the reason the client is given when the answer arrives.
   */
  private readonly abandonedStarts = new Map<number, AudioEndReason | undefined>();
  /**
   * One deadline per flush marker not yet flushed, oldest first (see
   * awaitUpstreamFlush). Each closes the connection if its marker is not
   * flushed in time.
   */
  private readonly flushDeadlines = new Set<ReturnType<typeof setTimeout>>();
  /** This relay as the registry sees it; taken over by another connection of the device. */
  private readonly audioHolder: AudioStreamHolder = {
    takenOver: () => this.endAudio('taken-over'),
  };

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
    // The listener ends the stream when the upstream connection closes; the
    // gateway's slot is free at once.
    this.endAudio(undefined);
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
      // Binary messages are sound, and only within an open audio stream.
      // Without one they are refused exactly as before audio existed.
      if (this.audio.phase !== 'open') {
        this.sendPhone({ type: 'error', message: 'Expected a text message' });
        return;
      }
      this.audioPiece(binaryBytes(data));
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

    // Ending a stream only ever frees resources: it never waits for the
    // request rate, so a client can always stop listening.
    if (parsed.request.action === 'audio-stop') {
      this.stopAudio(parsed.request.requestId);
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
        this.reportRefused(parsed.request.id);
      }
      return;
    }

    this.accept(parsed.request);
  }

  private accept(request: RemoteRequest): void {
    const reply = (message: Reply) => this.sendPhone(message);

    // A stream belongs to its connection: never answered from a receipt.
    if (request.action === 'audio-start') {
      this.startAudio(request);
      return;
    }

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
        this.reportRefused(request.id);
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

    // The listener names a listening browser after its paired device. The
    // client cannot send this field (protocol.ts); the gateway adds it.
    if (request.action === 'audio-start') {
      const deviceName = this.options.deviceName ?? 'Paired device';
      this.writeUpstream({ ...fields, deviceName, requestId: upstreamId });
      return;
    }

    // A report that waited for role confirmation while the phone left (or
    // started closing) describes a page nobody sees any more: keep its
    // selection and order, but never let it count as visible.
    if (request.action === 'panel-state' && !this.phoneIsOpen()) {
      this.reportedSelection = request.id;
      this.reportedVisible = false;
      this.writeUpstream({ ...fields, ...draftHost, visible: false, requestId: upstreamId });
      return;
    }
    if (request.action === 'panel-state') {
      this.reportedSelection = request.id;
      this.reportedVisible = request.visible === true;
    }
    this.writeUpstream({ ...fields, ...draftHost, requestId: upstreamId });
  }

  /**
   * The gateway refused one of the client's `panel-state` reports (request
   * rate or pending bound), which named conversation `id`. That report may
   * have hidden the page or moved it, so the listener must not keep counting
   * what the last forwarded report recorded: an application chat permission
   * waiting in the listener's queue could otherwise be allowed on a page
   * nobody sees, and the unread mark would keep clearing. The gateway sends
   * the listener `{"action":"report-refused","id":…}`: the connection stops
   * counting as visible, and its selection ends unless it is `id` (a hide of
   * the same conversation keeps it, so a waiting Stop still runs). The
   * listener never selects anything or changes draft fields for it.
   *
   * Before the role is confirmed, requests wait in `queued`; the notice takes
   * its place there among them, so it follows exactly the requests admitted
   * before the refusal and precedes those admitted after it.
   *
   * A notice is written only when it can change something, so a flood of
   * refused reports becomes at most two notices per forwarded report. The
   * listener never waits on it and takes no slot for it; nobody waits for its
   * reply. The client's next accepted report replaces its effect.
   */
  private reportRefused(id: string): void {
    if (!this.ready) {
      const marker = refusedReportMarker + id;
      const last = this.queued[this.queued.length - 1];
      if (last === marker) {
        return;
      }
      if (last?.startsWith(refusedReportMarker)) {
        // Two refusals in a row naming different conversations: together
        // they keep no selection. One notice for no conversation says so.
        this.queued[this.queued.length - 1] = refusedReportMarker;
        return;
      }
      this.queued.push(marker);
      return;
    }
    if (this.upstream.destroyed) {
      return;
    }

    const endsSelection = this.reportedSelection !== '' && this.reportedSelection !== id;
    if (!this.reportedVisible && !endsSelection) {
      return;
    }
    this.reportedVisible = false;
    if (endsSelection) {
      this.reportedSelection = '';
    }
    this.writeUpstream({ action: 'report-refused', id, requestId: reportRefusedRequestId });
  }

  /** The device's rate limit is shared by all its connections. */
  private takeToken(): boolean {
    return this.options.takeToken();
  }

  /** False from the moment the phone's socket starts closing. */
  private phoneIsOpen(): boolean {
    return this.phoneOpen && this.phone.readyState === this.phone.OPEN;
  }

  private sendPhone(
    message: GatewayMessage | AudioEndedMessage | AgentSelectMessage,
    replaceable = false,
  ): void {
    if (!this.phoneIsOpen()) {
      return;
    }

    this.output.send(message, replaceable);
  }

  private phoneClosed(): void {
    // A closed page stops listening at once, even while requests drain.
    this.endAudio(undefined);
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

  // ---- Audio streams ------------------------------------------------------
  //
  // Rules (src/remote/README.md, "Listening browsers"): binary messages are
  // sound and are accepted only between this connection's `audio-start`
  // result and the stream's end. One stream per paired device, at most
  // `maximumAudioStreams` in total (AudioStreamRegistry); each piece at most
  // `maximumAudioChunkBytes` of whole 16-bit samples, at most 1.5 times real
  // time (AudioRate), counted apart from the request rate. A violation, a
  // takeover, a listener that falls behind, a closed page, revocation and a
  // lost connection end the stream, never the connection.

  /** The client asked to listen here (`audio-start`). */
  private startAudio(request: RemoteRequest): void {
    const requestId = request.requestId;
    const streams = this.options.audioStreams;
    const refuse = (message: string) => {
      this.sendPhone({ type: 'error', requestId, action: 'audio-start', message });
    };

    if (this.audio.phase !== 'none') {
      refuse('An audio stream is already open on this connection');
      return;
    }
    if (!this.audioAvailable || !streams) {
      refuse('Listening here is not available on this computer');
      return;
    }
    // Checked before the claim, which takes the stream from another tab of
    // this device: a start that `forward` would refuse must not do that.
    if (this.pending.size - this.pendingDraftEdits() >= maximumPendingRequests) {
      refuse('Too many unfinished requests; wait for earlier ones');
      return;
    }
    if (streams.claim(this.options.deviceId, this.audioHolder) === 'total') {
      refuse(`Too many browsers are listening (at most ${maximumAudioStreams})`);
      return;
    }

    const token = ++this.audioStarts;
    this.audio = { phase: 'starting', token };
    this.forward(request, (reply) => this.audioStartAnswered(token, requestId, reply));
  }

  /** The listener answered an `audio-start` (or the relay gave up on it). */
  private audioStartAnswered(token: number, requestId: string, reply: Reply): void {
    const current = this.audio.phase === 'starting' && this.audio.token === token;
    const streamId = reply.type === 'result' ? streamIdOf(reply.result) : undefined;

    if (!current) {
      // Stopped or taken over while starting: the listener's new stream
      // must not stay open with nobody sending to it.
      const reason = this.abandonedStarts.get(token);
      this.abandonedStarts.delete(token);
      if (streamId) {
        this.writeUpstream({ action: 'audio-stop', streamId, requestId: audioStopRequestId });
      }
      this.sendPhone({
        type: 'error',
        requestId,
        action: 'audio-start',
        message: reason ? audioEndMessages[reason] : 'The audio stream ended before it started',
      });
      return;
    }

    if (!streamId) {
      // Refused by the listener (for example while paused), or lost.
      this.audio = { phase: 'none' };
      this.options.audioStreams?.release(this.audioHolder);
      const message = reply.type === 'error' ? reply.message : 'Listening here failed';
      this.sendPhone({ type: 'error', requestId, action: 'audio-start', message });
      return;
    }

    // The listener may already have ended this stream (for example Pause in
    // the same moment) and said so before its answer: report both, in order,
    // and keep nothing open.
    const endedEarly = this.audio.phase === 'starting' ? this.audio.ended : undefined;
    if (endedEarly && endedEarly.streamId === streamId) {
      this.audio = { phase: 'none' };
      this.options.audioStreams?.release(this.audioHolder);
      // As for every end the listener reports: what is still buffered for
      // it must be flushed in time.
      this.awaitUpstreamFlush();
      this.sendPhone({ type: 'result', requestId, action: 'audio-start', result: { streamId } });
      this.sendAudioEnded(streamId, endedEarly.reason);
      return;
    }

    const rate = this.options.audioStreams!.rate(this.options.deviceId);
    this.audio = { phase: 'open', streamId, rate };
    this.sendPhone({ type: 'result', requestId, action: 'audio-start', result: { streamId } });
  }

  /**
   * When a stream ends (its stop written, or the listener ended it), sound
   * may still wait in the upstream socket's buffer. A listener that never
   * reads again would keep it there for as long as the connection lives, so
   * the connection is closed as "engine unavailable" if that buffer has not
   * been flushed within the request timeout, as for a request the listener
   * never answers.
   *
   * An empty write with a callback marks the end of what is buffered now:
   * writes are flushed in order, so its callback runs once everything before
   * it has reached the operating system. This covers every backlog, also one
   * small enough that the socket never asked for `drain`. Every marker has
   * its own deadline, counted from when it was written, so a later stream's
   * end never inherits an earlier one's nearly expired deadline.
   *
   * Documented limit: Node may write a marker in one batch with requests
   * written after it, and calls the marker's callback when that whole batch
   * is written. A batch still pending near the deadline can therefore close
   * a connection whose listener received the stop itself in time.
   */
  private awaitUpstreamFlush(): void {
    if (this.upstream.destroyed || this.upstream.writableLength === 0) {
      return;
    }

    const deadline = setTimeout(() => {
      this.flushDeadlines.delete(deadline);
      this.terminate(closeCodes.engineUnavailable, 'Companion did not keep up');
    }, requestMilliseconds);
    this.flushDeadlines.add(deadline);

    this.upstream.write('', () => {
      clearTimeout(deadline);
      this.flushDeadlines.delete(deadline);
    });
  }

  /** The client asked to stop listening (`audio-stop`). */
  private stopAudio(requestId: string): void {
    const streaming = this.audio.phase !== 'none';
    this.endAudio(undefined);
    this.sendPhone({
      type: 'result',
      requestId,
      action: 'audio-stop',
      result: streaming ? 'stopped' : 'not-streaming',
    });
  }

  /** One binary message of the open stream: check it and pass it on. */
  private audioPiece(bytes: Buffer): void {
    if (this.audio.phase !== 'open') {
      return;
    }

    if (bytes.length === 0 || bytes.length > maximumAudioChunkBytes || bytes.length % 2 !== 0) {
      this.endAudio('too-large');
      return;
    }
    if (!this.audio.rate.take(bytes.length)) {
      this.endAudio('too-fast');
      return;
    }
    if (this.upstream.writableLength > maximumUpstreamAudioBacklogBytes) {
      // Ending the stream also starts the flush deadline (endAudio).
      this.endAudio('slow-listener');
      return;
    }

    this.writeUpstream({ action: 'audio-chunk', data: bytes.toString('base64') });
  }

  /**
   * End this connection's stream, if any: the listener stops it (unless the
   * upstream is gone), the gateway's slot is freed, and with a `reason` the
   * client is told. A start still waiting for its answer is abandoned; its
   * answer then stops the listener's stream (audioStartAnswered).
   */
  private endAudio(reason: AudioEndReason | undefined): void {
    const audio = this.audio;
    if (audio.phase === 'none') {
      return;
    }

    this.audio = { phase: 'none' };
    this.options.audioStreams?.release(this.audioHolder);

    if (audio.phase === 'starting') {
      // Its answer will stop the listener's stream by ID (audioStartAnswered).
      // A start already written upstream is also stopped at once, without an
      // ID: on this ordered socket the stop follows exactly that start, so the
      // listener never keeps the period while the answer is on its way.
      this.abandonedStarts.set(audio.token, reason);
      if (this.ready) {
        this.writeUpstream({ action: 'audio-stop', requestId: audioStopRequestId });
        this.awaitUpstreamFlush();
      }
      return;
    }

    this.writeUpstream({
      action: 'audio-stop',
      streamId: audio.streamId,
      requestId: audioStopRequestId,
    });
    // Sound still queued for a listener that stopped reading is released
    // within the request timeout, not only when the connection closes.
    this.awaitUpstreamFlush();
    if (reason) {
      this.sendAudioEnded(audio.streamId, reason);
    }
  }

  /** The listener ended this connection's stream (`audio-ended` event). */
  private listenerEndedAudio(message: Record<string, unknown>): void {
    const audio = this.audio;
    const reason = listenerAudioEndReasons.has(message.reason as AudioEndReason)
      ? (message.reason as AudioEndReason)
      : 'failed';

    if (audio.phase === 'starting' && typeof message.streamId === 'string') {
      // Before the answer to this connection's start: it may be about the
      // stream that answer will name (audioStartAnswered decides).
      audio.ended = { streamId: message.streamId, reason };
      return;
    }
    if (audio.phase !== 'open' || message.streamId !== audio.streamId) {
      // An earlier stream of this connection; already ended here.
      return;
    }

    this.audio = { phase: 'none' };
    this.options.audioStreams?.release(this.audioHolder);
    // Sound sent before the listener's end may still be buffered for it.
    this.awaitUpstreamFlush();
    this.sendAudioEnded(audio.streamId, reason);
  }

  /**
   * The listener asks this connection to show a conversation, because its
   * own stream heard "go to session N" or started a conversation
   * (src/remote/README.md, "Speech follows the device that recorded it").
   * Passed on only while that stream is this connection's open stream and
   * every field is well formed; otherwise dropped, so a connection that
   * never streams, an ended stream or another device's stream never
   * reaches the client. The stream ID itself is not passed on.
   */
  private listenerSelected(message: Record<string, unknown>): void {
    const audio = this.audio;
    if (!this.ready || audio.phase !== 'open' || message.streamId !== audio.streamId) {
      return;
    }

    const id = message.id;
    const from = message.from;
    if (typeof id !== 'string' || !sessionIdPattern.test(id)) {
      return;
    }
    if (typeof from !== 'string' || (from !== '' && !sessionIdPattern.test(from))) {
      return;
    }

    if (message.started === true && message.orderRevision === undefined) {
      this.sendPhone({ type: 'agent-select', id, from, started: true });
      return;
    }
    const orderRevision = message.orderRevision;
    if (
      message.started === undefined &&
      message.presentation === undefined &&
      typeof orderRevision === 'string' &&
      orderRevision.length > 0 &&
      orderRevision.length <= 128
    ) {
      this.sendPhone({ type: 'agent-select', id, from, orderRevision });
    }
  }

  private sendAudioEnded(streamId: string, reason: AudioEndReason): void {
    const ended: AudioEndedMessage = {
      type: 'audio-ended',
      streamId,
      reason,
      message: audioEndMessages[reason],
    };
    this.sendPhone(ended);
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

    if (isReply && message.requestId === reportRefusedRequestId) {
      // Nobody waits for the gateway's own report either.
      return;
    }

    if (isReply && (message.requestId === audioStopRequestId || message.requestId === undefined)) {
      // The gateway's own `audio-stop`, or a refused `audio-chunk` (pieces
      // carry no request ID). A refused piece means the listener's stream
      // has ended; its `audio-ended` event says why.
      return;
    }

    if (message.type === 'audio-ended') {
      this.listenerEndedAudio(message);
      return;
    }

    if (message.type === 'agent-select') {
      // Desktop navigation, never relayed as an engine event. Only the
      // navigation of speech this connection's own open stream heard
      // passes, as a gateway message of its own.
      this.listenerSelected(message);
      return;
    }

    // Only once the remote role is confirmed: the snapshot that arrives
    // before is held and handled again then (roleAnswered), so a start can
    // never be admitted while requests still wait for the role.
    if (message.type === 'state' && this.ready) {
      const microphones = message.microphones as { streams?: unknown } | undefined;
      this.audioAvailable =
        typeof microphones === 'object' && microphones !== null && microphones.streams === true;
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
      if (upstreamId.startsWith(refusedReportMarker)) {
        // A report refused while the role was being declared (in its place).
        this.reportRefused(upstreamId.slice(refusedReportMarker.length));
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
    for (const deadline of this.flushDeadlines) {
      clearTimeout(deadline);
    }
    this.flushDeadlines.clear();

    // The listener's stream ended with its connection.
    this.endAudio(this.phoneOpen ? 'failed' : undefined);

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

/** A binary WebSocket message as one buffer (`ws` may deliver fragments or an ArrayBuffer). */
function binaryBytes(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]);
  }
  return Buffer.from(data as ArrayBuffer);
}

/** The listener's stream ID in an `audio-start` result, if it is well formed. */
function streamIdOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') {
    return undefined;
  }
  const streamId = (result as { streamId?: unknown }).streamId;
  return typeof streamId === 'string' && streamIdPattern.test(streamId) ? streamId : undefined;
}
