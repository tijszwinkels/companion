/**
 * Ephemeral admission policy for app-origin chat, owned by one open conversation.
 *
 * This module does not grant from authored input, enqueue messages, start agents,
 * or persist anything. The native ingress controls permission; the application
 * service validates its view capability and exact code before using this policy.
 * The session layer must reserve -> enqueue -> attach synchronously, call begin
 * at the last pre-model boundary, and finish at the terminal outcome.
 *
 * Quota is consumed before admission and never refunded: a failed/uncertain
 * handoff cannot become an automatic retry. Old grant IDs cannot admit again,
 * even after their bounded receipt records have been evicted. Replacing code
 * withdraws unstarted work but keeps an already-running send busy until it ends.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MAX_RELAYED_MESSAGE_LENGTH } from '../agents/message-limits.ts';
import type { JsonObject } from '../widgets/types.ts';
import { SessionApplicationError } from './errors.ts';
import type { ApplicationSendAccess } from './types.ts';
export type { ApplicationSendAccess } from './types.ts';

export const applicationSendLimits = {
  messagesPerGrant: 5,
  intervalMilliseconds: 2000,
  textLength: MAX_RELAYED_MESSAGE_LENGTH,
  retainedReceipts: 64,
  requestBytes: 32 * 1024,
  receiptRequestBytes: 1024,
  responseBytes: 4096,
} as const;

export interface ApplicationSendIdentity {
  applicationId: string;
  name: string;
  version: number;
  bundle: string;
}

export type ApplicationSendState =
  'reserved' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type ApplicationSendWithdrawal = 'revoked' | 'replaced' | 'stopped' | 'closed';

/** Host-generated identity and outcome, never a claim that a person typed it. */
export interface ApplicationSendReceipt extends ApplicationSendIdentity {
  receiptId: string;
  grantId: string;
  requestId: string;
  state: ApplicationSendState;
  messageId?: string;
  reason?: ApplicationSendWithdrawal | 'admission-unconfirmed' | 'queue-cancelled';
}

interface RetainedReceipt {
  receipt: ApplicationSendReceipt;
  /** Exact UTF-16 text fingerprint; do not retain another plaintext copy. */
  fingerprint: string;
}

const requestIdPattern = /^[a-zA-Z0-9_-]{16,128}$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export class ApplicationSending {
  private identity: ApplicationSendIdentity;
  private grantId: string = randomUUID();
  private allowed = false;
  private remaining = 0;
  private lastAdmission = -Infinity;
  private active: RetainedReceipt | undefined;
  private readonly receipts = new Map<string, RetainedReceipt>();

  constructor(
    identity: ApplicationSendIdentity,
    private readonly now = () => performance.now(),
  ) {
    this.identity = { ...identity };
  }

  access(): ApplicationSendAccess {
    return {
      grantId: this.grantId,
      allowed: this.allowed,
      remaining: this.remaining,
      busy: this.active !== undefined,
    };
  }

  /** Explicit trusted consent only. Renewal is a new grant, not a replay. */
  permit(): ApplicationSendReceipt[] {
    const withdrawn = this.revoke('revoked');
    this.allowed = true;
    this.remaining = applicationSendLimits.messagesPerGrant;
    return withdrawn;
  }

  /** Return identities for the caller to remove from its pending queue. */
  revoke(reason: ApplicationSendWithdrawal): ApplicationSendReceipt[] {
    this.grantId = randomUUID();
    this.allowed = false;
    this.remaining = 0;
    if (!this.active || this.active.receipt.state === 'running') {
      return [];
    }
    this.active.receipt.state = 'cancelled';
    this.active.receipt.reason = reason;
    const withdrawn = { ...this.active.receipt };
    this.active = undefined;
    return [withdrawn];
  }

  replace(identity: ApplicationSendIdentity): ApplicationSendReceipt[] {
    const withdrawn = this.revoke('replaced');
    this.identity = { ...identity };
    return withdrawn;
  }

  /**
   * Called only after view/code/owner checks. Repeated exact requests return
   * their old receipt before quota/rate/permission checks, never new work.
   */
  reserve(command: JsonObject): { duplicate: boolean; receipt: ApplicationSendReceipt } {
    if (
      Object.keys(command).some(
        (key) => !['version', 'grantId', 'requestId', 'text'].includes(key),
      ) ||
      command.version !== this.identity.version ||
      typeof command.grantId !== 'string' ||
      !uuidPattern.test(command.grantId) ||
      typeof command.requestId !== 'string' ||
      !requestIdPattern.test(command.requestId) ||
      typeof command.text !== 'string' ||
      !command.text.trim() ||
      command.text.length > applicationSendLimits.textLength
    ) {
      throw new SessionApplicationError(
        'Expected current code, grant, request ID and bounded text',
      );
    }
    const key = this.key(command.grantId, command.requestId);
    const fingerprint = createHash('sha256').update(command.text, 'utf16le').digest('hex');
    const previous = this.receipts.get(key);
    if (previous && this.current(previous.receipt)) {
      if (previous.fingerprint !== fingerprint) {
        throw new SessionApplicationError('This request ID already names different text', 409);
      }
      return { duplicate: true, receipt: { ...previous.receipt } };
    }
    if (!this.allowed || command.grantId !== this.grantId) {
      throw new SessionApplicationError('Chat sending needs current trusted consent', 403);
    }
    if (this.remaining === 0) {
      throw new SessionApplicationError('This send grant is exhausted; review a new grant', 403);
    }
    if (this.active) {
      throw new SessionApplicationError(
        'An application message is already pending or running',
        409,
      );
    }
    const now = this.now();
    if (now - this.lastAdmission < applicationSendLimits.intervalMilliseconds) {
      throw new SessionApplicationError('Wait two seconds between application messages', 429);
    }

    this.trimReceipts();
    const receipt: ApplicationSendReceipt = {
      ...this.identity,
      receiptId: randomUUID(),
      grantId: this.grantId,
      requestId: command.requestId,
      state: 'reserved',
    };
    const retained = { receipt, fingerprint };
    this.receipts.set(key, retained);
    this.active = retained;
    this.remaining--;
    this.lastAdmission = now;
    return { duplicate: false, receipt: { ...receipt } };
  }

  /** Attach the canonical message only after synchronous FIFO admission. */
  attach(receiptId: string, messageId: string): void {
    const receipt = this.active?.receipt;
    if (!receipt || receipt.receiptId !== receiptId || receipt.state !== 'reserved') {
      throw new SessionApplicationError('Application admission is no longer current', 409);
    }
    receipt.messageId = messageId;
    receipt.state = 'queued';
  }

  /** A thrown handoff is ambiguous, not permission to refund or resubmit. */
  unconfirmed(receiptId: string): void {
    const receipt = this.active?.receipt;
    if (receipt?.receiptId === receiptId && receipt.state === 'reserved') {
      receipt.state = 'unknown';
      receipt.reason = 'admission-unconfirmed';
    }
  }

  /** A preceding failed turn or queue withdrawal can cancel an unstarted send. */
  cancelUnstarted(receiptId: string): boolean {
    const receipt = this.active?.receipt;
    if (!receipt || receipt.receiptId !== receiptId || receipt.state === 'running') {
      return false;
    }
    receipt.state = 'cancelled';
    receipt.reason = 'queue-cancelled';
    this.active = undefined;
    return true;
  }

  /** Recheck at the last pre-model boundary, including after asynchronous waits. */
  begin(receiptId: string): boolean {
    const receipt = this.active?.receipt;
    if (
      !receipt ||
      receipt.receiptId !== receiptId ||
      receipt.state !== 'queued' ||
      !this.allowed ||
      receipt.grantId !== this.grantId ||
      !this.current(receipt)
    ) {
      return false;
    }
    receipt.state = 'running';
    return true;
  }

  /** Old-code running work may finish after replacement; it cannot release a successor. */
  finish(receiptId: string, state: 'completed' | 'failed' | 'cancelled'): boolean {
    const receipt = this.active?.receipt;
    if (!receipt || receipt.receiptId !== receiptId || receipt.state !== 'running') {
      return false;
    }
    receipt.state = state;
    this.active = undefined;
    return true;
  }

  /** Read-only receipt lookup, scoped by the service to this app/code/view. */
  receipt(grantId: string, requestId: string): ApplicationSendReceipt | undefined {
    const retained = this.receipts.get(this.key(grantId, requestId));
    return retained && this.current(retained.receipt) ? { ...retained.receipt } : undefined;
  }

  private current(receipt: ApplicationSendIdentity): boolean {
    return (
      receipt.applicationId === this.identity.applicationId &&
      receipt.bundle === this.identity.bundle &&
      receipt.version === this.identity.version &&
      receipt.name === this.identity.name
    );
  }

  private key(grantId: string, requestId: string): string {
    return grantId + ':' + requestId;
  }

  private trimReceipts(): void {
    for (const [key, value] of this.receipts) {
      if (this.receipts.size < applicationSendLimits.retainedReceipts) {
        return;
      }
      // The current grant can have at most five records. Never evict one that
      // could still be replayed under that grant, or the running receipt.
      if (value.receipt.grantId !== this.grantId && value !== this.active) {
        this.receipts.delete(key);
      }
    }
    if (this.receipts.size >= applicationSendLimits.retainedReceipts) {
      throw new SessionApplicationError('Application receipt capacity is full', 429);
    }
  }
}
