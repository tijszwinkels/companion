import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Desktop integrations exchange newline-delimited JSON over a private socket. */
export class DesktopServer {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly requests = new Set<Promise<void>>();
  private listening = false;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly handle: (request: unknown) => Promise<unknown>,
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);

    this.server = createServer((socket) => this.connected(socket));

    // Bind first: two simultaneous startups cannot both claim a missing socket.
    // Only EADDRINUSE warrants checking for a stale socket from an old process.
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

    const message = { type: 'state', ...(this.snapshot() as object) };

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
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.clients.delete(socket));
    this.send(socket, { type: 'state', ...(this.snapshot() as object) });

    let buffered = '';
    let handling = false;

    socket.on('data', (chunk: string) => {
      buffered += chunk;

      if (buffered.length > 8192) {
        socket.destroy();
        return;
      }

      let newline: number;

      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);

        // A slow paste must not create an unbounded queue of repeated requests.
        if (handling) {
          this.send(socket, { type: 'error', message: 'Previous request is still running' });
          continue;
        }

        handling = true;
        const request = Promise.resolve()
          .then(async () => {
            const result = await this.handle(JSON.parse(line));
            this.send(socket, { type: 'result', result });
          })
          .catch((error) => {
            this.send(socket, { type: 'error', message: String(error) });
          })
          .finally(() => {
            handling = false;
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
  }
}
