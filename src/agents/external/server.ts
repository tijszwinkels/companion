/** One bounded JSON request/response per Unix connection; no internal tokens. */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { SessionToolService, type ToolReply } from '../session-tools-service.ts';
import { SocketOwnership } from './paths.ts';

export const maximumRequestBytes = 32 * 1024;
export const receiptLifetimeMs = 10 * 60 * 1000;
const windowMs = 60 * 1000;
const maximumReceipts = 1024;
const allowedFields = new Set([
  'method',
  'requestId',
  'label',
  'id',
  'text',
  'profile',
  'model',
  'focus',
  'ifDraftExists',
  'query',
  'limit',
]);

interface Receipt {
  fingerprint: string;
  expires: number;
  reply: Promise<ToolReply>;
}

export class ExternalSessionServer {
  readonly epoch = randomUUID();
  private readonly ownership: SocketOwnership;
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly controllers = new Set<AbortController>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly deliveries = new Set<string>();
  private windowStarted = Date.now();
  private actions = 0;
  private closing = false;
  private starting = false;

  constructor(
    private readonly service: SessionToolService,
    path: string,
    private readonly deadlineMs = 15_000,
  ) {
    this.ownership = new SocketOwnership(path);
  }

  async start(): Promise<void> {
    if (this.starting || this.server || this.closing) {
      throw Error('External server already started or closed');
    }
    this.starting = true;
    await this.ownership.acquire();
    try {
      this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.ownership.bindPath, resolve);
      });
      await this.ownership.publish();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.closing || this.sockets.size >= 32) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const controller = new AbortController();
    let received = Buffer.alloc(0);
    let dispatched = false;
    socket.on('error', () => {});
    socket.once('close', () => {
      this.sockets.delete(socket);
      controller.abort();
    });
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (dispatched) {
        socket.destroy();
        return;
      }
      if (received.length + chunk.length > maximumRequestBytes) {
        dispatched = true;
        this.reply(socket, {
          status: 400,
          body: { code: 'invalid', error: 'Request exceeds 32 KiB' },
        });
        return;
      }
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(10);
      if (end < 0) {
        return;
      }
      dispatched = true;
      socket.setTimeout(this.deadlineMs + 1000, () => socket.destroy());
      let command: unknown;
      try {
        if (end !== received.length - 1) {
          throw Error('Trailing bytes');
        }
        command = JSON.parse(received.subarray(0, end).toString('utf8'));
      } catch {
        this.reply(socket, {
          status: 400,
          body: { code: 'invalid', error: 'Expected one JSON object and newline' },
        });
        return;
      }
      void this.dispatch(command, controller)
        .then((result) => this.reply(socket, result))
        .catch(() => {
          this.reply(socket, {
            status: 500,
            body: { code: 'unconfirmed', error: 'Outcome unavailable; inspect before retrying' },
          });
        });
    });
    socket.on('end', () => {
      controller.abort();
      if (!dispatched) {
        socket.destroy();
      }
    });
  }

  private reply(socket: Socket, reply: ToolReply): void {
    if (socket.destroyed) {
      return;
    }
    const data = JSON.stringify({ ok: reply.status === 200, ...reply.body }) + '\n';
    if (Buffer.byteLength(data) > 256 * 1024) {
      socket.end(
        JSON.stringify({ ok: false, code: 'unconfirmed', error: 'Result exceeds response bound' }) +
          '\n',
      );
    } else {
      socket.end(data);
    }
  }

  private async dispatch(value: unknown, controller: AbortController): Promise<ToolReply> {
    const invalid = (code: string, error: string): ToolReply => ({
      status: 400,
      body: { code, error },
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid('invalid', 'Expected an object');
    }
    const command = value as Record<string, unknown>;
    if (Object.keys(command).some((key) => !allowedFields.has(key))) {
      return invalid('invalid', 'Unknown request field');
    }
    if (command.method === 'info') {
      return {
        status: 200,
        body: { protocol: 1, epoch: this.epoch, receiptLifetimeMs, deadlineMs: this.deadlineMs },
      };
    }
    const { requestId, label } = command;
    if (
      typeof requestId !== 'string' ||
      requestId.length > 128 ||
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 80 ||
      /[\x00-\x1f\x7f]/.test(label)
    ) {
      return invalid('invalid', 'Supply a requestId and a single-line label of 1–80 characters');
    }
    const parts = requestId.split('_');
    const created = Number(parts[1]);
    const now = Date.now();
    if (parts.length !== 3 || !/^[0-9a-f-]{36}$/.test(parts[2]) || !/^\d{13}$/.test(parts[1])) {
      return invalid('invalid', 'Request identity must be epoch_timestamp_uuid');
    }
    if (parts[0] !== this.epoch || created > now + 2000 || now - created >= receiptLifetimeMs) {
      return invalid(
        'expired-request',
        'Request belongs to another listener or has expired; inspect state before creating a new mutation',
      );
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    const previous = this.receipts.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return invalid('request-conflict', 'Request ID was already used with different arguments');
      }
      return previous.reply;
    }
    for (const [id, receipt] of this.receipts) {
      if (receipt.expires <= now) {
        this.receipts.delete(id);
      }
    }
    if (this.receipts.size >= maximumReceipts || this.controllers.size >= 16) {
      return invalid('limit', 'External request capacity reached');
    }
    if (now - this.windowStarted >= windowMs && this.controllers.size === 0) {
      this.windowStarted = now;
      this.actions = 0;
      this.deliveries.clear();
    }
    if (command.method !== 'list' && this.actions++ >= 60) {
      return invalid('limit', 'External mutation limit reached (60 per minute across all labels)');
    }
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    // The response deadline never promises rollback. Hosts check cancellation
    // before committing; an accepted turn/FIFO entry belongs to AgentSessions.
    const timeout = new Promise<ToolReply>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          invalid(
            'unconfirmed',
            'Request deadline elapsed; inspect the destination before another mutation',
          ),
        );
      }, this.deadlineMs);
    });
    const execution = this.service.external(
      { kind: 'external', label, requestId, signal: controller.signal, delivered: this.deliveries },
      command,
    );
    const reply = Promise.race([execution, timeout])
      .then((result) => ({
        ...result,
        body: {
          ...result.body,
          requestId,
          error:
            typeof result.body.error === 'string' ? result.body.error.slice(0, 600) : undefined,
        },
      }))
      .finally(() => clearTimeout(timer));
    this.receipts.set(requestId, { fingerprint, expires: created + receiptLifetimeMs, reply });
    void execution.finally(() => this.controllers.delete(controller));
    return reply;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (this.server?.listening) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await this.ownership.release();
  }
}
