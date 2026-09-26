import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InstanceLock } from '../system/instance-lock.ts';

/**
 * Accepted but unwritten ordered messages (events, replies, errors) a single
 * connection may accumulate while its socket waits for `drain`. A client that
 * falls this far behind is disconnected; it reconnects and hydrates from a
 * fresh snapshot. A single message is always written when the socket is idle,
 * so this does not cap the size of one reconnect snapshot or restored session.
 */
export const maximumBacklogBytes = 16 * 1024 * 1024;

/** A connection whose socket does not drain for this long is disconnected. */
export const maximumStallMilliseconds = 30_000;

/** Per-connection outbound bounds; tests use smaller values. */
export interface OutboundLimits {
  backlogBytes: number;
  stallMilliseconds: number;
}

/** Which parts of the state snapshot a state message must contain. */
export interface SnapshotOptions {
  /**
   * False for connections that maintain conversations from incremental agent
   * events; their routine state messages omit `sessions`, `previousSessions`
   * and `sessionOrderRevision`. Connect snapshots always include them.
   */
  sessions: boolean;
}

/** One serialized protocol line waiting for its connection's socket. */
interface OutboundLine {
  readonly line: string;
  /** Ordered messages count toward the backlog; state lines are coalesced. */
  readonly kind: 'ordered' | 'state';
  readonly bytes: number;
}

/**
 * Per-connection outbound queue. Node buffers everything passed to
 * `socket.write`, so a burst of large state snapshots used to grow the buffer
 * past the old 2 MiB limit and drop even a normally reading client. Instead we
 * hand the socket one batch at a time and hold the rest here until `drain`.
 */
interface Connection {
  readonly id: number;
  readonly socket: Socket;
  /** Lines in protocol order that are not yet written to the socket. */
  readonly queue: OutboundLine[];
  /** The queued state line, if any; at most one is ever pending. */
  pendingState?: OutboundLine;
  /** Sum of `bytes` over queued ordered lines (state lines are excluded). */
  backlogBytes: number;
  /** True after `write` returned false, until the socket emits `drain`. */
  waitingForDrain: boolean;
  stallTimer?: NodeJS.Timeout;
  /** Sticky: the client applies agent events and accepts state without sessions. */
  incrementalSessions: boolean;
}

/** Desktop integrations exchange newline-delimited JSON over a private socket. */
export class DesktopServer {
  private server?: Server;
  private readonly clients = new Set<Connection>();
  private readonly requests = new Set<Promise<void>>();
  private listening = false;
  private readonly lock: InstanceLock;
  private nextClientId = 0;
  private readonly clientIds = new Map<number, Connection>();

  constructor(
    private readonly path: string,
    private readonly snapshot: (options: SnapshotOptions) => unknown,
    private readonly handle: (request: unknown, clientId: number) => Promise<unknown>,
    private readonly disconnected: (clientId: number) => void = () => {},
    private readonly limits: OutboundLimits = {
      backlogBytes: maximumBacklogBytes,
      stallMilliseconds: maximumStallMilliseconds,
    },
  ) {
    this.lock = new InstanceLock(path + '.lock');
  }

  async start(): Promise<void> {
    await this.lock.acquire();

    try {
      await this.bind();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async bind(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);

    this.server = createServer((socket) => this.connected(socket));

    // Ownership covers the entire probe/unlink/rebind sequence. Another starter
    // cannot remove a socket we just recovered. Keep the probe for older
    // Companion versions that did not acquire the process lock.
    try {
      await this.listen();
      await chmod(this.path, 0o600);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }

    // Never unlink a live process's socket: it owns capture and database updates.
    const alive = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(this.path);
      probe.setTimeout(1000);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('timeout', () => {
        probe.destroy();
        reject(Error('Companion socket did not respond'));
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          resolve(false);
        } else {
          reject(error);
        }
      });
    });

    if (alive) {
      throw Error('Companion is already running');
    }

    await rm(this.path, { force: true });
    await this.listen();
    await chmod(this.path, 0o600);
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.path, () => {
        this.server!.removeListener('error', reject);
        this.listening = true;
        resolve();
      });
    });
  }

  /**
   * Queue the current state for every connection. A state line that has not
   * reached a socket yet is superseded by this newer one, so bursts (speech,
   * processing, intent, cleanup, outcome, finish) cost one pending snapshot per
   * slow connection instead of one buffered copy each.
   */
  broadcast(): void {
    if (!this.clients.size) {
      return;
    }

    // Serialize each variant at most once per broadcast, and only if a
    // connection needs it: the full variant can be several hundred kilobytes.
    let fullLine: string | undefined;
    let incrementalLine: string | undefined;

    for (const connection of this.clients) {
      if (connection.incrementalSessions) {
        incrementalLine ??= this.stateLine({ sessions: false });
        this.enqueue(connection, incrementalLine, 'state');
      } else {
        fullLine ??= this.stateLine({ sessions: true });
        this.enqueue(connection, fullLine, 'state');
      }
    }
  }

  /** Incremental agent messages share the same ordered stream as snapshots. */
  publish(message: unknown): void {
    if (!this.clients.size) {
      return;
    }

    const line = JSON.stringify(message) + '\n';

    for (const connection of this.clients) {
      this.enqueue(connection, line, 'ordered');
    }
  }

  /**
   * Navigation belongs to the UI captured at speech end, not every observer.
   * True means the message was accepted into that live connection's ordered
   * stream; it is not an acknowledgement from the UI.
   */
  publishTo(clientId: number, message: unknown): boolean {
    const connection = this.clientIds.get(clientId);
    if (!connection || connection.socket.destroyed) {
      return false;
    }
    this.enqueue(connection, JSON.stringify(message) + '\n', 'ordered');
    return !connection.socket.destroyed;
  }

  /**
   * Record that this connection keeps conversations from incremental events.
   * It is never cleared for the connection: its later state messages omit the
   * session fields. A reconnect starts again from a full snapshot.
   */
  enableIncrementalSessions(clientId: number): void {
    const connection = this.clientIds.get(clientId);
    if (connection) {
      connection.incrementalSessions = true;
    }
  }

  private stateLine(options: SnapshotOptions): string {
    return JSON.stringify({ type: 'state', ...(this.snapshot(options) as object) }) + '\n';
  }

  private send(connection: Connection, message: unknown): void {
    this.enqueue(connection, JSON.stringify(message) + '\n', 'ordered');
  }

  /**
   * Write now if the socket is idle; otherwise keep the line in protocol order
   * until `drain`. The queue preserves ordering: a replacement state line goes
   * to the end, after every event it already reflects, never ahead of them.
   */
  private enqueue(connection: Connection, line: string, kind: OutboundLine['kind']): void {
    if (connection.socket.destroyed) {
      return;
    }

    if (!connection.waitingForDrain && !connection.queue.length) {
      this.write(connection, line);
      return;
    }

    const entry: OutboundLine = {
      line,
      kind,
      bytes: Buffer.byteLength(line),
    };

    if (kind === 'state') {
      // Remove (not just skip) the older state so a stalled connection holds
      // at most one snapshot string however many broadcasts it misses.
      if (connection.pendingState) {
        const index = connection.queue.indexOf(connection.pendingState);
        connection.queue.splice(index, 1);
      }
      connection.pendingState = entry;
    } else {
      connection.backlogBytes += entry.bytes;
    }

    connection.queue.push(entry);

    // Replies and events cannot be dropped individually without leaving the
    // client inconsistent. Disconnect instead: the UI reports the lost
    // connection, reconnects and receives a complete snapshot.
    if (connection.backlogBytes > this.limits.backlogBytes) {
      connection.socket.destroy();
    }
  }

  private write(connection: Connection, line: string): void {
    const accepted = connection.socket.write(line);

    if (!accepted && !connection.socket.destroyed) {
      connection.waitingForDrain = true;
      connection.stallTimer = setTimeout(() => {
        // Genuinely stalled (not reading at all): release its buffers.
        connection.socket.destroy();
      }, this.limits.stallMilliseconds);
      connection.stallTimer.unref();
    }
  }

  /** The socket accepted everything written so far; continue in order. */
  private drained(connection: Connection): void {
    clearTimeout(connection.stallTimer);
    connection.stallTimer = undefined;
    connection.waitingForDrain = false;

    while (connection.queue.length && !connection.waitingForDrain) {
      const entry = connection.queue.shift()!;

      if (entry.kind === 'state') {
        connection.pendingState = undefined;
      } else {
        connection.backlogBytes -= entry.bytes;
      }

      this.write(connection, entry.line);

      if (connection.socket.destroyed) {
        return;
      }
    }
  }

  private connected(socket: Socket): void {
    if (this.clients.size >= 8) {
      socket.destroy();
      return;
    }

    const clientId = ++this.nextClientId;
    const connection: Connection = {
      id: clientId,
      socket,
      queue: [],
      backlogBytes: 0,
      waitingForDrain: false,
      incrementalSessions: false,
    };
    this.clients.add(connection);
    this.clientIds.set(clientId, connection);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('drain', () => this.drained(connection));
    socket.once('close', () => {
      // Queued lines belong to this connection only; nothing is replayed to
      // a later connection, which instead starts from a fresh snapshot.
      clearTimeout(connection.stallTimer);
      connection.queue.length = 0;
      connection.pendingState = undefined;
      connection.backlogBytes = 0;
      this.clients.delete(connection);
      this.clientIds.delete(clientId);
      this.disconnected(clientId);
    });

    // The hydration snapshot is ordered, never coalesced: every later session
    // event and session-less state message builds on it.
    this.send(connection, { type: 'state', ...(this.snapshot({ sessions: true }) as object) });

    let buffered = '';
    let handling = false;
    let controlsInFlight = 0;

    socket.on('data', (chunk: string) => {
      buffered += chunk;

      // A 4000-character composer message may expand to six JSON characters
      // per code unit. Keep framing bounded without rejecting escaped text.
      if (buffered.length > 32768) {
        socket.destroy();
        return;
      }

      let newline: number;

      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);

        let value: unknown;

        try {
          value = JSON.parse(line);
        } catch {
          this.send(connection, { type: 'error', message: 'Invalid JSON request' });
          continue;
        }

        const action =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>).action
            : undefined;
        // Echo only a short opaque correlation ID, including admission errors.
        const requestId =
          action === 'agent-tool-page' &&
          value &&
          typeof value === 'object' &&
          typeof (value as Record<string, unknown>).requestId === 'string' &&
          ((value as Record<string, unknown>).requestId as string).length <= 128
            ? (value as Record<string, unknown>).requestId
            : undefined;
        const control =
          action === 'toggle-pause' ||
          action === 'media-playback' ||
          action === 'toggle-sounds' ||
          action === 'set-intent-enabled' ||
          action === 'set-transcription-cleanup' ||
          action === 'activity-history' ||
          action === 'agent-tool-page' ||
          action === 'agent-models' ||
          action === 'claude-models' ||
          action === 'set-agent-model' ||
          action === 'set-agent-thinking' ||
          action === 'move-agent' ||
          action === 'label-history' ||
          action === 'delete-history' ||
          action === 'stop-agent' ||
          action === 'send-agent' ||
          action === 'submit-utterance' ||
          action === 'choose-agent' ||
          action === 'stop-agent-run' ||
          action === 'composer-focus' ||
          action === 'panel-state' ||
          action === 'agent-draft-result' ||
          action === 'reopen-agent' ||
          action === 'close-agent';

        // Listening/sound controls run independently of slow keyboard delivery.
        // Bound both paths so a client cannot build an unbounded promise queue.
        if ((control && controlsInFlight >= 16) || (!control && handling)) {
          this.send(connection, {
            type: 'error',
            action,
            requestId,
            message: 'Previous request is still running',
          });
          continue;
        }

        if (control) {
          controlsInFlight++;
        } else {
          handling = true;
        }

        const request = Promise.resolve()
          .then(async () => {
            const result = await this.handle(value, clientId);
            this.send(connection, { type: 'result', action, requestId, result });
          })
          .catch((error) => {
            this.send(connection, { type: 'error', action, requestId, message: String(error) });
          })
          .finally(() => {
            if (control) {
              controlsInFlight--;
            } else {
              handling = false;
            }

            this.requests.delete(request);
          });

        this.requests.add(request);
      }
    });
  }

  async close(): Promise<void> {
    for (const connection of this.clients) {
      connection.socket.destroy();
    }

    if (this.listening) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      await rm(this.path, { force: true });
      this.listening = false;
    }

    // The owner cancels actions before closing; let them record their outcomes
    // before it closes SQLite or removes any other resources they reference.
    await Promise.all(this.requests);
    await this.lock.close();
  }
}
