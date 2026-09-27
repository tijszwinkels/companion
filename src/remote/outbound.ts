/**
 * Bounded, ordered output for one phone. Only routine state snapshots may be
 * replaced while a write is outstanding; events and request receipts retain
 * their order. A replacement goes at the end, after the events it reflects.
 * Reconnect hydration is always ordered, even for an incremental phone.
 */
import type { WebSocket } from 'ws';
import type { GatewayMessage } from './protocol.ts';

export interface PhoneOutputLimits {
  queuedBytes: number;
  queuedMessages: number;
  stallMilliseconds: number;
}

interface OutputLine {
  text: string;
  bytes: number;
  replaceable: boolean;
}

export class PhoneOutput {
  private readonly queue: OutputLine[] = [];
  private pendingState?: OutputLine;
  private queuedBytes = 0;
  private writing = false;
  private closed = false;
  private stallTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly phone: Pick<WebSocket, 'send'>,
    private readonly stalled: () => void,
    private readonly limits: PhoneOutputLimits = {
      queuedBytes: 16 * 1024 * 1024,
      queuedMessages: 256,
      stallMilliseconds: 30_000,
    },
  ) {}

  send(message: GatewayMessage, replaceable = false): void {
    if (this.closed) {
      return;
    }
    const text = JSON.stringify(message);
    const line = { text, bytes: Buffer.byteLength(text), replaceable };
    if (!this.writing) {
      this.write(line);
      return;
    }

    if (replaceable && this.pendingState) {
      this.queue.splice(this.queue.indexOf(this.pendingState), 1);
      this.queuedBytes -= this.pendingState.bytes;
    }
    this.queue.push(line);
    this.queuedBytes += line.bytes;
    if (replaceable) {
      this.pendingState = line;
    }
    if (
      this.queuedBytes > this.limits.queuedBytes ||
      this.queue.length > this.limits.queuedMessages
    ) {
      this.fail();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.stallTimer);
    this.queue.length = 0;
    this.pendingState = undefined;
    this.queuedBytes = 0;
  }

  private fail(): void {
    this.close();
    this.stalled();
  }

  private write(line: OutputLine): void {
    this.writing = true;
    this.stallTimer = setTimeout(() => this.fail(), this.limits.stallMilliseconds);
    this.stallTimer.unref();
    // ws invokes the callback once this write leaves its output buffer. Keep
    // later messages here instead of adding an unbounded stream to that buffer.
    this.phone.send(line.text, (error) => {
      if (this.closed) {
        return;
      }
      clearTimeout(this.stallTimer);
      if (error) {
        this.fail();
        return;
      }
      this.writing = false;
      const next = this.queue.shift();
      if (next) {
        this.queuedBytes -= next.bytes;
        if (next === this.pendingState) {
          this.pendingState = undefined;
        }
        this.write(next);
      }
    });
  }
}
