/**
 * Reports which Pi conversations are busy to a local agent-harness.
 *
 * Why: the agent-harness (and the Omarchy indicator that reads it) only sees
 * Pi transcript files. While Pi thinks or runs a long tool, nothing is
 * written, so after 30 seconds the harness shows a busy Companion
 * conversation as idle. Companion knows the truth: a conversation is busy
 * from the moment a turn starts until Pi has settled (`agent_settled`, after
 * any retry or compaction) and the turn's final save is done. This module
 * forwards exactly that flag.
 *
 * Input: `update(conversationId, busy, harnessSessionId)` from
 * `AgentSessions` on every session change. Output: `PUT
 * <harness>/v1/sessions/<harnessSessionId>/live-state` requests carrying only
 * metadata (`busy` or `idle`, a sequence number and a lease). No prompt,
 * transcript, title or path is sent. The harness accepts them only for
 * conversations whose transcript carries Companion's owner entry (written by
 * `live-state-owner-extension.ts`).
 *
 * Timing: `busy` is sent at once and renewed every `heartbeatMs` (15 s) with
 * a lease of `leaseSeconds` (45 s). If Companion stops renewing (crash,
 * shutdown, network trouble), the harness lets the lease expire and falls
 * back to its transcript rule, so nothing can stay "busy" forever.
 *
 * Final `idle`: owed as soon as any `busy` was attempted for the turn, even
 * when no `busy` was acknowledged. A `busy` response can be lost after the
 * harness applied it, and the harness may discover the conversation only
 * after the first `busy` (404 before Pi has written its transcript; 409 until
 * the owner entry is on disk). An undelivered `idle` is retried a few times
 * (`idleRetryDelaysMs`). The idle also tells the harness where the finished
 * turn's transcript ended, so those lines cannot make it look busy again.
 *
 * Failure handling: reporting must never slow down or break a conversation.
 * `update` is synchronous and only schedules work; every request has an
 * overall deadline (`requestTimeoutMs`); errors are logged once per outage.
 *
 * Concurrency: at most one request per conversation is in flight. Changes
 * that arrive meanwhile are coalesced: when the request finishes, the latest
 * state is sent once. Every request carries a fresh sequence number, so the
 * harness ignores an older request that arrives late.
 *
 * Shutdown: `close()` stops heartbeats and retries, but still delivers a
 * coalesced final `idle` and waits for requests in flight, within
 * `closeTimeoutMs`.
 *
 * Transport: plain `node:http` through a dedicated agent, so environment
 * proxy settings (`NODE_USE_ENV_PROXY`, `HTTP_PROXY`) are never consulted and
 * redirects are never followed: the request goes to the loopback URL or
 * nowhere.
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';

/** What `AgentSessions` tells a live-state reporter. */
export interface SessionLiveState {
  /**
   * Called on every change of a conversation. `harnessSessionId` is
   * undefined until the conversation is known to run on Pi.
   */
  update(conversationId: string, busy: boolean, harnessSessionId: string | undefined): void;

  /** The conversation was closed in this listener. */
  forget(conversationId: string): void;

  /** Stop heartbeats and deliver what is still owed, within a short budget. */
  close(): Promise<void>;
}

/**
 * Sends one PUT with a JSON body. Resolves to the HTTP status, or 0 when no
 * response arrived (connection error, timeout). Never rejects.
 */
export type LiveStateTransport = (url: string, body: string, timeoutMs: number) => Promise<number>;

type Log = (component: string, message: string) => void;

export interface HarnessLiveStateOptions {
  /** Loopback base URL, already checked by `parseAgentHarnessUrl`. */
  url: string;
  log: Log;
  heartbeatMs?: number;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
  /** Upper bound for `close()` waiting on owed and in-flight requests. */
  closeTimeoutMs?: number;
  /** Delays before re-sending an undelivered final `idle`. */
  idleRetryDelaysMs?: number[];
  /** Injectable for tests. */
  transport?: LiveStateTransport;
}

/** Per conversation: what we want the harness to know, and what it knows. */
interface ConversationReport {
  conversationId: string;
  harnessSessionId: string;
  busy: boolean;
  /** A `busy` was sent for the current turn, so an `idle` is owed. */
  idleOwed: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  inFlight: boolean;
  /** Something changed while a request was in flight; send again after it. */
  sendAgain: boolean;
  /** Undelivered final `idle` retries used so far, and the pending timer. */
  idleRetries: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Closed in Companion: drop the entry once nothing is owed any more. */
  forgotten: boolean;
}

const LOG_COMPONENT = 'agent-harness-live-state';

export class HarnessLiveStateReporter implements SessionLiveState {
  // One producer id per listener process. The harness orders our updates by
  // (producer, sequence); a restarted Companion gets a new id.
  private readonly producer = randomUUID().replaceAll('-', '');
  private sequence = 0;

  private readonly conversations = new Map<string, ConversationReport>();
  private readonly pendingRequests = new Set<Promise<void>>();

  // Log a failure once, until a request succeeds again.
  private failing = false;
  private closed = false;

  private readonly heartbeatMs: number;
  private readonly leaseSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly idleRetryDelaysMs: number[];
  private readonly transport: LiveStateTransport;

  constructor(private readonly options: HarnessLiveStateOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.leaseSeconds = options.leaseSeconds ?? 45;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.idleRetryDelaysMs = options.idleRetryDelaysMs ?? [2_000, 5_000, 15_000];
    this.transport = options.transport ?? httpTransport;
  }

  update(conversationId: string, busy: boolean, harnessSessionId: string | undefined): void {
    if (this.closed) {
      return;
    }

    let report = this.conversations.get(conversationId);
    if (!report) {
      if (harnessSessionId === undefined || !busy) {
        // Not a Pi conversation (yet), or idle and never reported: nothing to say.
        return;
      }
      report = {
        conversationId,
        harnessSessionId,
        busy: false,
        idleOwed: false,
        heartbeat: undefined,
        inFlight: false,
        sendAgain: false,
        idleRetries: 0,
        retryTimer: undefined,
        forgotten: false,
      };
      this.conversations.set(conversationId, report);
    }

    if (report.busy === busy) {
      // Most session changes are new messages, not busy transitions.
      return;
    }
    report.busy = busy;
    this.cancelIdleRetry(report);

    if (busy) {
      this.startHeartbeat(report);
    } else {
      this.stopHeartbeat(report);
    }
    this.send(report);
  }

  forget(conversationId: string): void {
    const report = this.conversations.get(conversationId);
    if (!report) {
      return;
    }
    report.forgotten = true;
    this.update(conversationId, false, report.harnessSessionId);
    this.dropIfDone(report);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const report of this.conversations.values()) {
      this.stopHeartbeat(report);
      this.cancelIdleRetry(report);
    }

    // Requests on their way, and final `idle`s coalesced behind them, get
    // a short grace period together, no more.
    const deadline = Date.now() + this.closeTimeoutMs;
    while (this.pendingRequests.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, remaining).unref();
      });
      await Promise.race([Promise.allSettled([...this.pendingRequests]), timeout]);
    }
    this.conversations.clear();
  }

  private startHeartbeat(report: ConversationReport): void {
    this.stopHeartbeat(report);
    report.heartbeat = setInterval(() => this.send(report), this.heartbeatMs);
    // A heartbeat alone must never keep the listener process alive.
    report.heartbeat.unref();
  }

  private stopHeartbeat(report: ConversationReport): void {
    if (report.heartbeat !== undefined) {
      clearInterval(report.heartbeat);
      report.heartbeat = undefined;
    }
  }

  private cancelIdleRetry(report: ConversationReport): void {
    if (report.retryTimer !== undefined) {
      clearTimeout(report.retryTimer);
      report.retryTimer = undefined;
    }
    report.idleRetries = 0;
  }

  /** Send the conversation's current state, coalescing with a request in flight. */
  private send(report: ConversationReport): void {
    if (report.inFlight) {
      report.sendAgain = true;
      return;
    }

    const state: 'busy' | 'idle' = report.busy ? 'busy' : 'idle';
    if (state === 'idle' && !report.idleOwed) {
      // No `busy` was sent for this turn, so there is nothing to end.
      this.dropIfDone(report);
      return;
    }
    if (state === 'busy') {
      report.idleOwed = true;
    }

    report.inFlight = true;
    report.sendAgain = false;
    this.sequence += 1;
    const body = JSON.stringify({
      source: 'companion',
      producer: this.producer,
      sequence: this.sequence,
      state,
      lease_seconds: this.leaseSeconds,
    });
    const url = `${this.options.url}/v1/sessions/${encodeURIComponent(report.harnessSessionId)}/live-state`;

    const request = this.transport(url, body, this.requestTimeoutMs)
      .then((status) => this.recordResult(report, state, status))
      .finally(() => {
        report.inFlight = false;
        this.pendingRequests.delete(request);

        // A coalesced change is delivered even during close(): it is usually
        // the final `idle` of a turn that Companion just stopped.
        if (report.sendAgain) {
          this.send(report);
          return;
        }
        this.dropIfDone(report);
      });
    this.pendingRequests.add(request);
  }

  private recordResult(report: ConversationReport, state: 'busy' | 'idle', status: number): void {
    if (status === 200) {
      if (state === 'idle') {
        report.idleOwed = false;
        report.idleRetries = 0;
      }
      if (this.failing) {
        this.failing = false;
        this.options.log(LOG_COMPONENT, 'agent-harness accepts live state again');
      }
      return;
    }

    // 404: the harness has not seen this conversation's transcript yet.
    // 409: it has, but not yet Companion's owner entry. Both are expected
    // right after a conversation starts; a heartbeat retries `busy`.
    const notYetKnown = status === 404 || status === 409;
    if (status === 0) {
      this.logFailure('agent-harness unreachable');
    } else if (!notYetKnown) {
      this.logFailure(`agent-harness refused live state (HTTP ${status})`);
    }

    // An undelivered final `idle` is retried a few times when the outcome is
    // uncertain (transport) or may change soon (discovery, owner entry).
    const retryable = status === 0 || notYetKnown || status >= 500;
    if (state === 'idle' && retryable) {
      this.scheduleIdleRetry(report);
    } else if (state === 'idle') {
      // A definite refusal: give up on this turn's idle.
      report.idleOwed = false;
    }
  }

  private scheduleIdleRetry(report: ConversationReport): void {
    if (this.closed || report.busy) {
      return;
    }
    const delay = this.idleRetryDelaysMs[report.idleRetries];
    if (delay === undefined) {
      // Retries exhausted; the harness's lease and transcript rule take over.
      report.idleOwed = false;
      return;
    }
    report.idleRetries += 1;
    report.retryTimer = setTimeout(() => {
      report.retryTimer = undefined;
      this.send(report);
    }, delay);
    report.retryTimer.unref();
  }

  private dropIfDone(report: ConversationReport): void {
    const owesNothing = !report.idleOwed && report.retryTimer === undefined;
    if (report.forgotten && !report.busy && !report.inFlight && owesNothing) {
      this.stopHeartbeat(report);
      this.conversations.delete(report.conversationId);
    }
  }

  private logFailure(message: string): void {
    if (this.failing) {
      return;
    }
    this.failing = true;
    this.options.log(LOG_COMPONENT, `${message}; conversations keep running, retrying quietly`);
  }
}

// A private agent: unlike Node's global agent it never picks up proxy
// settings from the environment, and it does not keep idle sockets open.
const directAgent = new http.Agent({ keepAlive: false });

/** `LiveStateTransport` over plain HTTP to the configured loopback address. */
export const httpTransport: LiveStateTransport = (url, body, timeoutMs) =>
  new Promise<number>((resolve) => {
    const target = new URL(url);
    let settled = false;
    const finish = (status: number) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(status);
      }
    };

    const request = http.request(
      {
        agent: directAgent,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        path: target.pathname,
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        // The small response body is not needed; drain it to free the socket.
        response.resume();
        finish(response.statusCode ?? 0);
      },
    );

    // One overall deadline, covering connect, headers and a slow server.
    const deadline = setTimeout(() => {
      request.destroy(Error('timeout'));
      finish(0);
    }, timeoutMs);
    deadline.unref();

    request.on('error', () => finish(0));
    request.end(body);
  });

/**
 * Accept only a loopback `http://` base URL without credentials or path, so a
 * typo can never send conversation state off this machine. Returns the
 * normalized base URL; throws a message suitable for the command line.
 */
export function parseAgentHarnessUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Error('--agent-harness-url must be a URL such as http://127.0.0.1:8877');
  }

  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (parsed.protocol !== 'http:' || !loopbackHosts.includes(parsed.hostname)) {
    throw Error('--agent-harness-url must be a loopback http:// URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw Error('--agent-harness-url must not contain credentials');
  }
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw Error('--agent-harness-url must not contain a path or query');
  }

  return `http://${parsed.host}`;
}
