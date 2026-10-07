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
 * transcript, title or path is sent.
 *
 * Timing: `busy` is sent at once and renewed every `heartbeatMs` (15 s) with
 * a lease of `leaseSeconds` (45 s). If Companion stops renewing (crash,
 * shutdown, network trouble), the harness lets the lease expire and falls
 * back to its transcript rule, so nothing can stay "busy" forever. `idle` is
 * sent once when the turn has ended.
 *
 * Failure handling: reporting must never slow down or break a conversation.
 * `update` is synchronous and only schedules work; requests time out after
 * `requestTimeoutMs`; errors are logged once per outage and otherwise
 * ignored. A 404 is expected right after a conversation starts, before the
 * harness has seen Pi's transcript; the next heartbeat simply retries.
 *
 * Concurrency: at most one request per conversation is in flight. Changes
 * that arrive meanwhile are coalesced: when the request finishes, the latest
 * state is sent once. Every request carries a fresh sequence number, so the
 * harness ignores an older request that arrives late.
 */

import { randomUUID } from 'node:crypto';

/** What `AgentSessions` tells a live-state reporter. */
export interface SessionLiveState {
  /**
   * Called on every change of a conversation. `harnessSessionId` is
   * undefined until the conversation is known to run on Pi.
   */
  update(conversationId: string, busy: boolean, harnessSessionId: string | undefined): void;

  /** The conversation was closed in this listener. */
  forget(conversationId: string): void;

  /** Stop heartbeats and wait (briefly) for requests already sent. */
  close(): Promise<void>;
}

type Log = (component: string, message: string) => void;

export interface HarnessLiveStateOptions {
  /** Loopback base URL, already checked by `parseAgentHarnessUrl`. */
  url: string;
  log: Log;
  heartbeatMs?: number;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
  /** Upper bound for `close()` waiting on in-flight requests. */
  closeTimeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** Per conversation: what we want the harness to know, and what it knows. */
interface ConversationReport {
  conversationId: string;
  harnessSessionId: string;
  busy: boolean;
  /** The last state the harness accepted from us, if any. */
  announced: 'busy' | 'idle' | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  inFlight: boolean;
  /** Something changed while a request was in flight; send again after it. */
  sendAgain: boolean;
  /** Closed in Companion: drop the entry once the final request is done. */
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
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HarnessLiveStateOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.leaseSeconds = options.leaseSeconds ?? 45;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.fetchImplementation = options.fetch ?? fetch;
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
        announced: undefined,
        heartbeat: undefined,
        inFlight: false,
        sendAgain: false,
        forgotten: false,
      };
      this.conversations.set(conversationId, report);
    }

    if (report.busy === busy) {
      // Most session changes are new messages, not busy transitions.
      return;
    }
    report.busy = busy;

    if (busy) {
      this.startHeartbeat(report);
      this.send(report);
      return;
    }

    this.stopHeartbeat(report);
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
    }

    // Requests already on their way (typically the final `idle` of turns
    // that Companion just aborted) get a short grace period, no more.
    const pending = Promise.allSettled([...this.pendingRequests]);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, this.closeTimeoutMs).unref();
    });
    await Promise.race([pending, timeout]);
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

  /** Send the conversation's current state, coalescing with a request in flight. */
  private send(report: ConversationReport): void {
    if (report.inFlight) {
      report.sendAgain = true;
      return;
    }

    const state: 'busy' | 'idle' = report.busy ? 'busy' : 'idle';
    if (state === 'idle' && report.announced !== 'busy') {
      // The harness never accepted `busy` from us, so there is nothing to end.
      return;
    }

    report.inFlight = true;
    report.sendAgain = false;
    this.sequence += 1;
    const body = {
      source: 'companion',
      producer: this.producer,
      sequence: this.sequence,
      state,
      lease_seconds: this.leaseSeconds,
    };

    const request = this.put(report.harnessSessionId, body)
      .then((status) => this.recordResult(report, state, status))
      .finally(() => {
        report.inFlight = false;
        this.pendingRequests.delete(request);

        if (report.sendAgain && !this.closed) {
          this.send(report);
          return;
        }
        this.dropIfDone(report);
      });
    this.pendingRequests.add(request);
  }

  /** One HTTP request; resolves to the status code, or 0 when it failed. */
  private async put(harnessSessionId: string, body: object): Promise<number> {
    const url = `${this.options.url}/v1/sessions/${encodeURIComponent(harnessSessionId)}/live-state`;
    try {
      const response = await this.fetchImplementation(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      // The body is small and not needed; release the connection.
      await response.body?.cancel();
      return response.status;
    } catch (error) {
      this.logFailure(`agent-harness unreachable: ${String(error)}`);
      return 0;
    }
  }

  private recordResult(report: ConversationReport, state: 'busy' | 'idle', status: number): void {
    if (status === 200) {
      report.announced = state;
      if (this.failing) {
        this.failing = false;
        this.options.log(LOG_COMPONENT, 'agent-harness accepts live state again');
      }
      return;
    }

    if (status === 404) {
      // The harness has not seen this conversation's transcript yet. The next
      // heartbeat retries; an `idle` for an unknown session needs no retry.
      return;
    }

    if (status !== 0) {
      this.logFailure(`agent-harness refused live state (HTTP ${status})`);
    }
  }

  private dropIfDone(report: ConversationReport): void {
    if (report.forgotten && !report.busy && !report.inFlight) {
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
