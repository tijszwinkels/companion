import { randomUUID } from 'node:crypto';
import type { WakeRecord, WakeRecurrence, WakeState } from './types.ts';

/**
 * Fixed-interval recurrence for self-wake timers.
 *
 * A repeating timer is a chain of ordinary one-shot occurrences that share a
 * `seriesId`. Companion, not the agent, creates each next occurrence, and only
 * when the previous one reaches a terminal state, in the same SQLite
 * transaction (see `WakeStore.finish`). That gives three guarantees:
 *
 * - At most one unstarted occurrence per series, so runs never overlap.
 * - A crash can never leave a finished occurrence without its successor, or
 *   create two successors.
 * - Missed slots are skipped: the successor goes to the first slot that is
 *   still at least the scheduling margin in the future, never a burst of
 *   catch-up runs after an outage.
 *
 * Slots are measured from the first due time (the anchor): slot `k` is due at
 * `anchorAt + k * everySeconds`. There are no calendar, timezone or DST rules.
 */

/** 45 minutes: the shortest interval the user allowed. */
export const minimumIntervalSeconds = 2700;

/** 30 days: the same as the longest one-shot delay. */
export const maximumIntervalSeconds = 30 * 86400;

/** The same minimum lead time a one-shot timer needs when it is scheduled. */
export const schedulingMarginMilliseconds = 60_000;

/** The longest one-shot delay, which is also the first occurrence's limit. */
export const maximumDelayMilliseconds = 30 * 86400_000;

/**
 * Terminal states after which a series moves on to its next slot. A failed,
 * blocked, expired (skipped) or delivery-uncertain occurrence is recorded and
 * never retried; the series simply continues. Cancelled and superseded
 * occurrences end their series.
 */
const continuingStates: readonly WakeState[] = [
  'completed',
  'failed',
  'blocked',
  'expired',
  'delivery-uncertain',
];

/** Throws a user-facing error unless `everySeconds` is an allowed interval. */
export function validateInterval(everySeconds: unknown): void {
  if (
    typeof everySeconds !== 'number' ||
    !Number.isInteger(everySeconds) ||
    everySeconds < minimumIntervalSeconds ||
    everySeconds > maximumIntervalSeconds
  ) {
    throw Error(
      'everySeconds must be a whole number of seconds from 2700 (45 minutes) to 2592000 (30 days)',
    );
  }
}

/**
 * Overdue grace when the caller gives none: one hour, as for one-shots, but
 * never more than half the interval. A repeating timer's grace must stay below
 * its interval so an occurrence cannot still be waiting when its next slot is due.
 */
export function defaultGraceSeconds(everySeconds: number | undefined): number {
  if (everySeconds === undefined) {
    return 3600;
  }
  return Math.min(3600, everySeconds / 2);
}

/** The due instant of one slot. Always computed the same way, so it compares exactly. */
export function slotDueAt(anchorAt: number, everySeconds: number, slot: number): number {
  return anchorAt + slot * everySeconds * 1000;
}

/**
 * The longest time between creating an occurrence and its due time. A
 * successor may need slightly more than 30 days when the interval is 30 days
 * and the next slot falls inside the scheduling margin.
 */
export function maximumLeadMilliseconds(recurrence: WakeRecurrence | undefined): number {
  if (!recurrence) {
    return maximumDelayMilliseconds;
  }
  const intervalLead = recurrence.everySeconds * 1000 + schedulingMarginMilliseconds;
  return Math.max(maximumDelayMilliseconds, intervalLead);
}

/** Structural check of a stored recurrence, including that the due time is on a slot. */
export function validRecurrence(record: WakeRecord, uuid: RegExp): boolean {
  const recurrence = record.recurrence;
  if (!recurrence || typeof recurrence !== 'object') {
    return false;
  }
  if (
    typeof recurrence.seriesId !== 'string' ||
    !uuid.test(recurrence.seriesId) ||
    !Number.isInteger(recurrence.everySeconds) ||
    recurrence.everySeconds < minimumIntervalSeconds ||
    recurrence.everySeconds > maximumIntervalSeconds ||
    !Number.isFinite(recurrence.anchorAt) ||
    !Number.isInteger(recurrence.slot) ||
    recurrence.slot < 0 ||
    !Number.isInteger(recurrence.occurrence) ||
    recurrence.occurrence < 1
  ) {
    return false;
  }
  const expectedDueAt = slotDueAt(recurrence.anchorAt, recurrence.everySeconds, recurrence.slot);
  const graceMilliseconds = record.expiresAt - record.dueAt;
  return record.dueAt === expectedDueAt && graceMilliseconds < recurrence.everySeconds * 1000;
}

/**
 * Whether a terminal occurrence hands over to a successor. `endSeries` is the
 * caller's explicit decision to stop the series (for example an owner that can
 * never be opened again). A cancellation requested while the occurrence ran
 * (cancel, Stop, close or a same-key schedule) also ends it.
 */
export function seriesContinues(record: WakeRecord, endSeries: boolean): boolean {
  if (!record.recurrence || endSeries || record.cancellationRequested) {
    return false;
  }
  return continuingStates.includes(record.state);
}

/**
 * The next occurrence after a terminal one, or undefined when no valid slot
 * exists (only possible after the wall clock moved far backwards).
 *
 * The slot is the smallest one after the finished occurrence's slot that is
 * still at least the scheduling margin away from `now`. Everything about the
 * occurrence is inherited except identity, timing and run state: same owner,
 * label, instruction, key, harness, ancestry, depth and grace. A successor
 * grants no more authority than the occurrence it follows.
 */
export function nextOccurrence(record: WakeRecord, now: number): WakeRecord | undefined {
  const recurrence = record.recurrence!;
  const intervalMilliseconds = recurrence.everySeconds * 1000;
  const earliestDueAt = now + schedulingMarginMilliseconds;

  // Skip every slot that is already past or too close; never catch up.
  const firstFutureSlot = Math.ceil((earliestDueAt - recurrence.anchorAt) / intervalMilliseconds);
  let slot = Math.max(recurrence.slot + 1, firstFutureSlot);
  let dueAt = slotDueAt(recurrence.anchorAt, recurrence.everySeconds, slot);

  // Floating-point division may land one slot short of the margin.
  if (dueAt < earliestDueAt) {
    slot += 1;
    dueAt = slotDueAt(recurrence.anchorAt, recurrence.everySeconds, slot);
  }

  // A backwards clock jump can push the next slot beyond what a stored record
  // may hold. End the series visibly instead of storing an invalid record.
  if (dueAt - now > maximumLeadMilliseconds(recurrence)) {
    return undefined;
  }

  const graceMilliseconds = record.expiresAt - record.dueAt;
  return {
    version: 2,
    id: randomUUID(),
    owner: record.owner,
    receipt: record.receipt,
    label: record.label,
    message: record.message,
    ...(record.key !== undefined ? { key: record.key } : {}),
    harness: record.harness,
    schedulingTurn: record.schedulingTurn,
    ...(record.ancestry ? { ancestry: record.ancestry } : {}),
    depth: record.depth,
    createdAt: now,
    dueAt,
    expiresAt: dueAt + graceMilliseconds,
    state: 'scheduled',
    revision: 1,
    transitionedAt: now,
    reason: '',
    recurrence: {
      seriesId: recurrence.seriesId,
      everySeconds: recurrence.everySeconds,
      anchorAt: recurrence.anchorAt,
      slot,
      occurrence: recurrence.occurrence + 1,
    },
  };
}

/** Appends a short clause to a reason, within the stored 600-character limit. */
export function withReason(reason: string, clause: string): string {
  const combined = reason ? `${reason}; ${clause}` : clause;
  return combined.slice(0, 600);
}

/** "45 min", "1 h 30 min", "2 d": the interval as people read it. */
export function intervalText(everySeconds: number): string {
  const units: [number, string][] = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'min'],
    [1, 's'],
  ];
  const parts: string[] = [];
  let remaining = everySeconds;
  for (const [size, name] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count} ${name}`);
      remaining -= count * size;
    }
  }
  return parts.join(' ');
}

/** Transcript and list wording: "repeats every 45 min · occurrence 3 · series <id>". */
export function describeRecurrence(recurrence: WakeRecurrence): string {
  const interval = intervalText(recurrence.everySeconds);
  return `repeats every ${interval} · occurrence ${recurrence.occurrence} · series ${recurrence.seriesId}`;
}
