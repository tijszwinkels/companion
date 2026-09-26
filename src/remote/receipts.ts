/**
 * Per-device receipts for state-changing phone requests.
 *
 * Phones lose connections constantly (sleep, network handover, tunnels). A
 * request whose reply was lost must not run twice when the phone reconnects:
 * repeating `toggle-pause` would undo the first tap, and repeating `send-agent`
 * would queue the same message twice. Each mutating request ID is therefore
 * remembered per device for ten minutes. A repeat with identical arguments is
 * answered from the receipt (or waits for the original to finish); a repeat
 * with different arguments is refused. Receipts live in gateway memory only,
 * so a gateway restart forgets them — the phone app never resends unconfirmed
 * mutations automatically, which is the primary guard.
 */

import type { GatewayMessage } from './protocol.ts';

export const receiptLifetimeMilliseconds = 10 * 60 * 1000;

/** Refuse admission at capacity; never discard still-valid replay protection. */
const maximumReceiptsPerDevice = 512;

type Reply = Extract<GatewayMessage, { type: 'result' | 'error' }>;

interface Receipt {
  fingerprint: string;
  createdAt: number;
  reply?: Reply;
  waiters: ((reply: Reply) => void)[];
}

export type ReceiptLookup =
  | { kind: 'new'; settle(reply: Reply): void }
  | { kind: 'replay'; reply: Reply }
  | { kind: 'pending'; wait(listener: (reply: Reply) => void): () => void }
  | { kind: 'conflict' }
  | { kind: 'full' };

export class ReceiptBook {
  private readonly devices = new Map<string, Map<string, Receipt>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Look up or reserve a request ID. `fingerprint` is the canonical request
   * without its ID; only an identical request may reuse the receipt.
   */
  claim(deviceId: string, requestId: string, fingerprint: string): ReceiptLookup {
    const receipts = this.receiptsFor(deviceId);
    this.expire(receipts);

    const existing = receipts.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { kind: 'conflict' };
      }
      if (existing.reply) {
        return { kind: 'replay', reply: existing.reply };
      }
      if (existing.waiters.length >= 32) {
        return { kind: 'full' };
      }
      return {
        kind: 'pending',
        wait: (listener) => {
          existing.waiters.push(listener);
          return () => {
            existing.waiters = existing.waiters.filter((waiter) => waiter !== listener);
          };
        },
      };
    }

    if (receipts.size >= maximumReceiptsPerDevice) {
      return { kind: 'full' };
    }

    const receipt: Receipt = { fingerprint, createdAt: this.now(), waiters: [] };
    receipts.set(requestId, receipt);

    return {
      kind: 'new',
      settle: (reply) => {
        if (receipt.reply) {
          return;
        }
        receipt.reply = reply;
        const waiters = receipt.waiters.splice(0);
        for (const waiter of waiters) {
          waiter(reply);
        }
      },
    };
  }

  /** Forget everything for a revoked device. */
  forget(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  private receiptsFor(deviceId: string): Map<string, Receipt> {
    let receipts = this.devices.get(deviceId);
    if (!receipts) {
      receipts = new Map();
      this.devices.set(deviceId, receipts);
    }
    return receipts;
  }

  private expire(receipts: Map<string, Receipt>): void {
    const cutoff = this.now() - receiptLifetimeMilliseconds;

    // Maps iterate in insertion order, so expired receipts are at the front.
    for (const [id, receipt] of receipts) {
      if (receipt.createdAt >= cutoff) {
        break;
      }
      // Never drop a pending receipt: its request may still execute.
      if (receipt.reply) {
        receipts.delete(id);
      }
    }
  }

  /** Periodic collection also covers devices that never reconnect. */
  prune(currentDevices: ReadonlySet<string>): void {
    for (const [id, receipts] of this.devices) {
      this.expire(receipts);
      if (!currentDevices.has(id) || receipts.size === 0) {
        this.devices.delete(id);
      }
    }
  }
}

/** Stable text for comparing two requests, ignoring key order and the ID. */
export function requestFingerprint(request: Record<string, unknown>): string {
  const { requestId: _ignored, ...rest } = request;
  const keys = Object.keys(rest).sort();
  return JSON.stringify(keys.map((key) => [key, rest[key]]));
}
