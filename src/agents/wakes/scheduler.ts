import { randomUUID } from 'node:crypto';
import type { AgentHarness, AgentMessageOrigin } from '../types.ts';
import { WakeStore } from './store.ts';
import {
  scheduleDeadline,
  unstarted,
  wakeSummary,
  type WakeRecord,
  type WakeSchedule,
  type WakeState,
} from './types.ts';

export interface WakeCaller {
  owner: string;
  turnId: string;
  callId: string;
  depth: number;
  ancestry?: AgentMessageOrigin;
  harness: AgentHarness;
  signal: AbortSignal;
}

/** Host preparation may await disk/model checks; admission must recheck all live state. */
export interface WakeHost {
  prepare(record: WakeRecord): Promise<'ready' | 'waiting' | string>;
  admit(record: WakeRecord, claim: () => WakeRecord | undefined): boolean;
  changed(record: WakeRecord): void;
  warning(text: string): void;
}

/** One listener owns timing. No provider polling or automatic turn retries. */
export class WakeScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private stopped = false;
  private opened = false;
  private faulted = false;

  constructor(
    readonly store: WakeStore,
    private readonly host: WakeHost,
    private readonly now = Date.now,
  ) {}

  open(): void {
    if (!this.opened) {
      this.store.open(this.now());
      this.opened = true;
    }
  }

  start(): void {
    if (this.stopped || this.faulted) {
      return;
    }
    this.open();
    if (!this.timer && !this.stopped) {
      // Node's timeout is monotonic; wall deadlines are reconciled every second,
      // including after suspend and forward/backward wall-clock changes.
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick()
          .catch(() => {})
          .finally(() => this.start());
      }, 1000);
      this.timer.unref();
    }
  }

  list(owner: string, recent = 0) {
    this.open();
    const records = this.store.all().filter((record) => record.owner === owner);
    const active = records.filter(
      (record) => unstarted(record) || record.state === 'dispatching' || record.state === 'started',
    );
    const terminal = records
      .filter((record) => !active.includes(record))
      .sort((a, b) => b.transitionedAt - a.transitionedAt)
      .slice(0, recent);
    return [...active, ...terminal].map(wakeSummary);
  }

  schedule(caller: WakeCaller, input: WakeSchedule): Record<string, unknown> {
    if (this.stopped || this.faulted) {
      throw Error('Wake scheduler is stopped');
    }
    this.open();
    caller.signal.throwIfAborted();
    const now = this.now();
    const receiptId = `${caller.owner}:${caller.turnId}:${caller.callId}`;
    const changed: WakeRecord[] = [];
    const result = this.store.transaction(() => {
      const oldReceipt = this.store.receipt(receiptId);
      if (oldReceipt) {
        return oldReceipt;
      }
      const deadline = scheduleDeadline(input, now);
      const pending = this.store.all().filter(unstarted);
      const replaced =
        input.key === undefined
          ? undefined
          : pending.find((record) => record.owner === caller.owner && record.key === input.key);
      if (
        pending.length - Number(!!replaced) >= 64 ||
        pending.filter((record) => record.owner === caller.owner).length - Number(!!replaced) >= 3
      ) {
        throw Error('Pending timer limit reached (3 per conversation, 64 per listener)');
      }
      if (replaced) {
        const record = this.transitionValue(
          replaced,
          'superseded',
          'Replaced by a new occurrence for this purpose',
        );
        this.store.put(record);
        changed.push(record);
      }
      const record: WakeRecord = {
        version: 1,
        id: randomUUID(),
        owner: caller.owner,
        receipt: receiptId,
        label: input.label,
        message: input.message,
        ...(input.key ? { key: input.key } : {}),
        harness: caller.harness,
        schedulingTurn: caller.turnId,
        depth: caller.depth,
        ...(caller.ancestry ? { ancestry: caller.ancestry } : {}),
        createdAt: now,
        ...deadline,
        state: 'scheduled',
        revision: 1,
        transitionedAt: now,
        reason: '',
      };
      this.store.put(record);
      changed.push(record);
      const receipt = {
        outcome: 'scheduled',
        timerId: record.id,
        dueAt: record.dueAt,
        expiresAt: record.expiresAt,
        state: record.state,
      };
      this.store.saveReceipt(receiptId, caller.owner, receipt);
      this.store.prune(caller.owner);
      return receipt;
    });
    for (const record of changed) {
      this.publish(record);
    }
    this.start();
    return result;
  }

  cancel(owner: string, id: string): Record<string, unknown> {
    try {
      this.open();
      const record = this.store.get(id);
      if (!record || record.owner !== owner) {
        return { outcome: 'unknown-or-not-owned' };
      }
      if (unstarted(record)) {
        this.transition(record, 'cancelled', 'Cancelled explicitly');
        return { outcome: 'cancelled', timerId: id };
      }
      if (record.state === 'dispatching' || record.state === 'started') {
        const cancelled = {
          ...record,
          cancellationRequested: true,
          revision: record.revision + 1,
          transitionedAt: this.now(),
          reason: 'Cancellation requested after dispatch began',
        };
        this.store.put(cancelled);
        this.publish(cancelled);
        return { outcome: 'dispatch-started', timerId: id };
      }
      return {
        outcome: record.state === 'cancelled' ? 'already-cancelled' : 'already-finished',
        timerId: id,
      };
    } catch (error) {
      // These reads/writes are synchronous: latch the fault before a suspended
      // preparation can resume. Repair and cancellation retry never clear it.
      this.haltAfterFailure();
      throw error;
    }
  }

  /** Deleted archives cannot retain instructions in the timer store. */
  deleteOwner(owner: string): void {
    this.open();
    this.store.deleteOwner(owner);
    this.host.warning('Deleted conversation timers and instruction text removed.');
  }

  cancelOwner(owner: string, reason: string): number {
    return this.settleOwner(owner, 'cancelled', reason);
  }

  blockOwner(owner: string, reason: string): void {
    if (this.opened) {
      this.settleOwner(owner, 'blocked', reason);
    }
  }

  private settleOwner(owner: string, state: 'cancelled' | 'blocked', reason: string): number {
    // Revoke admission before persistence, including an already suspended sweep.
    // Failure leaves this listener halted; it cannot silently retry stale work.
    const wasFaulted = this.faulted;
    this.faulted = true;
    try {
      this.open();
      const changed = this.store.transaction(() => {
        return this.store
          .all()
          .filter((record) => record.owner === owner && unstarted(record))
          .map((record) => {
            const next = this.transitionValue(record, state, reason);
            this.store.put(next);
            return next;
          });
      });
      this.faulted = wasFaulted;
      changed.forEach((record) => this.publish(record));
      return changed.length;
    } catch (error) {
      this.haltAfterFailure();
      throw error;
    }
  }

  /** A snapshot never grants authority to mutate a newer or terminal record. */
  transition(record: WakeRecord, state: WakeState, reason = ''): void {
    const current = this.store.get(record.id);
    if (!current || current.revision !== record.revision || current.state !== record.state) {
      return;
    }
    const allowed: Partial<Record<WakeState, WakeState[]>> = {
      scheduled: ['waiting', 'cancelled', 'superseded', 'expired', 'blocked'],
      waiting: ['cancelled', 'superseded', 'expired', 'blocked'],
      dispatching: ['started', 'failed', 'blocked'],
      started: ['completed', 'failed', 'blocked'],
    };
    if (!allowed[current.state]?.includes(state)) {
      return;
    }
    const next = this.transitionValue(current, state, reason);
    this.store.transaction(() => {
      this.store.put(next);
      if (!unstarted(next) && next.state !== 'dispatching' && next.state !== 'started') {
        this.store.prune(next.owner);
      }
    });
    this.publish(next);
  }

  /** The claimed attempt may finish after a cancellation-intent revision. */
  transitionAttempt(record: WakeRecord, state: WakeState, reason = ''): void {
    const current = this.store.get(record.id);
    if (
      !record.attemptId ||
      !current ||
      current.attemptId !== record.attemptId ||
      (current.state !== 'dispatching' && current.state !== 'started')
    ) {
      return;
    }
    this.transition(current, state, reason);
  }

  private haltAfterFailure(): void {
    this.faulted = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.host.warning(
      'Wake scheduling stopped after a storage or admission failure. No pending timers will dispatch in this listener. Failed writes are not durable: before restarting, inspect and cancel remaining timers once storage is writable, or they may become eligible again.',
    );
  }

  private publish(record: WakeRecord): void {
    try {
      this.host.changed(record);
    } catch {
      // A UI observer cannot turn a committed schedule/cancel into a refusal.
      // The canonical state and original receipt remain available on reconnect.
      try {
        this.host.warning('Timer state was saved, but its display update failed.');
      } catch {
        // Reporting must never undo or obscure the durable mutation result.
      }
    }
  }

  private transitionValue(record: WakeRecord, state: WakeState, reason: string): WakeRecord {
    return {
      ...record,
      state,
      reason: reason.slice(0, 600),
      revision: record.revision + 1,
      transitionedAt: this.now(),
    };
  }

  tick(): Promise<void> {
    if (this.stopped || this.faulted) {
      return Promise.resolve();
    }
    this.open();
    this.ticking ??= this.sweep()
      .catch((error) => {
        this.haltAfterFailure();
        throw error;
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private async sweep(): Promise<void> {
    for (const snapshot of this.store
      .all()
      .filter(unstarted)
      .sort((a, b) => a.dueAt - b.dueAt)) {
      if (this.stopped || this.faulted) {
        return;
      }
      const candidate = this.store.get(snapshot.id);
      if (!candidate || candidate.revision !== snapshot.revision || !unstarted(candidate)) {
        continue;
      }
      if (this.now() > candidate.expiresAt) {
        this.transition(candidate, 'expired', 'Overdue grace elapsed before dispatch');
        continue;
      }
      if (this.now() < candidate.dueAt) {
        continue;
      }
      if (candidate.state === 'scheduled') {
        this.transition(candidate, 'waiting', 'Waiting for conversation and listener capacity');
      }
      const record = this.store.get(candidate.id);
      if (this.stopped || this.faulted || !record || !unstarted(record)) {
        continue;
      }
      const readiness = await this.host.prepare(record);
      const current = this.store.get(record.id);
      // Async preparation grants no authority. Cancel/replacement/Stop may have won.
      if (
        this.stopped ||
        this.faulted ||
        !current ||
        current.revision !== record.revision ||
        !unstarted(current)
      ) {
        continue;
      }
      if (this.now() > current.expiresAt) {
        this.transition(current, 'expired', 'Overdue grace elapsed during preparation');
      } else if (readiness !== 'waiting' && readiness !== 'ready') {
        this.transition(current, 'blocked', readiness);
      } else if (readiness === 'ready') {
        this.host.admit(current, () => this.store.claim(current, this.now()));
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      await this.ticking;
    } catch {
      // tick already reported the failure; ownership must still be released.
    } finally {
      this.store.close();
    }
  }
}
