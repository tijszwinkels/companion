import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InstanceLock } from '../system/instance-lock.ts';

/** Desktop integrations exchange newline-delimited JSON over a private socket. */
export class DesktopServer {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly requests = new Set<Promise<void>>();
  private listening = false;
  private readonly lock: InstanceLock;
  private nextClientId = 0;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly handle: (request: unknown, clientId: number) => Promise<unknown>,
    private readonly disconnected: (clientId: number) => void = () => {},
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

  broadcast(): void {
    if (!this.clients.size) {
      return;
    }

    this.publish({ type: 'state', ...(this.snapshot() as object) });
  }

  /** Incremental agent messages share the same ordered stream as snapshots. */
  publish(message: unknown): void {
    for (const socket of this.clients) {
      this.send(socket, message);
    }
  }

  private send(socket: Socket, message: unknown): void {
    if (socket.destroyed) {
      return;
    }

    if (socket.writableLength > 2 * 1024 * 1024) {
      socket.destroy();
      return;
    }

    socket.write(JSON.stringify(message) + '\n');
  }

  private connected(socket: Socket): void {
    if (this.clients.size >= 8) {
      socket.destroy();
      return;
    }

    this.clients.add(socket);
    const clientId = ++this.nextClientId;
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      this.clients.delete(socket);
      this.disconnected(clientId);
    });
    this.send(socket, { type: 'state', ...(this.snapshot() as object) });

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
          this.send(socket, { type: 'error', message: 'Invalid JSON request' });
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
          action === 'activity-history' ||
          action === 'agent-tool-page' ||
          action === 'label-history' ||
          action === 'delete-history' ||
          action === 'stop-agent' ||
          action === 'send-agent' ||
          action === 'submit-utterance' ||
          action === 'choose-agent' ||
          action === 'stop-agent-run' ||
          action === 'composer-focus' ||
          action === 'panel-state' ||
          action === 'reopen-agent' ||
          action === 'close-agent';

        // Listening/sound controls run independently of slow keyboard delivery.
        // Bound both paths so a client cannot build an unbounded promise queue.
        if ((control && controlsInFlight >= 16) || (!control && handling)) {
          this.send(socket, {
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
            this.send(socket, { type: 'result', action, requestId, result });
          })
          .catch((error) => {
            this.send(socket, { type: 'error', action, requestId, message: String(error) });
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
    for (const socket of this.clients) {
      socket.destroy();
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
