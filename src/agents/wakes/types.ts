import type { AgentHarness, AgentMessageOrigin } from '../types.ts';

export const wakeStates = [
  'scheduled',
  'waiting',
  'dispatching',
  'started',
  'completed',
  'failed',
  'cancelled',
  'superseded',
  'expired',
  'blocked',
  'delivery-uncertain',
] as const;
export type WakeState = (typeof wakeStates)[number];

/** Durable occurrence, never an executable callback or a saved chat queue. */
export interface WakeRecord {
  version: 1;
  id: string;
  owner: string;
  receipt: string;
  label: string;
  message: string;
  key?: string;
  harness: AgentHarness;
  schedulingTurn: string;
  ancestry?: AgentMessageOrigin;
  depth: number;
  createdAt: number;
  dueAt: number;
  expiresAt: number;
  state: WakeState;
  revision: number;
  transitionedAt: number;
  reason: string;
  turnId?: string;
  attemptId?: string;
  cancellationRequested?: boolean;
}

export type WakeSummary = Omit<WakeRecord, 'message' | 'receipt' | 'ancestry'>;
export function wakeSummary({
  message: _message,
  receipt: _receipt,
  ancestry: _ancestry,
  ...summary
}: WakeRecord): WakeSummary {
  return summary;
}
export function unstarted(record: WakeRecord): boolean {
  return record.state === 'scheduled' || record.state === 'waiting';
}

export interface WakeSchedule {
  label: string;
  message: string;
  key?: string;
  afterSeconds?: number;
  at?: string;
  expiresAfterSeconds?: number;
}

/** Exact offset required. Date.parse alone accepts ambiguous local dates. */
export function scheduleDeadline(
  input: WakeSchedule,
  now: number,
): { dueAt: number; expiresAt: number } {
  if (
    typeof input.label !== 'string' ||
    !input.label.trim() ||
    input.label.length > 120 ||
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.length > 4000 ||
    (input.key !== undefined &&
      (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 120))
  ) {
    throw Error(
      'A timer needs a label (1–120), message (1–4000), and optional key (1–120 characters)',
    );
  }
  if ((input.afterSeconds === undefined) === (input.at === undefined)) {
    throw Error('Provide exactly one of afterSeconds or at');
  }
  if (
    input.at !== undefined &&
    (typeof input.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at))
  ) {
    throw Error('at must be RFC3339 with an explicit UTC offset');
  }
  if (input.at !== undefined) {
    const [year, month, day, hour, minute, second] = input.at
      .slice(0, 19)
      .split(/[-T:]/)
      .map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    const offset = input.at.match(/([+-])(\d{2}):(\d{2})$/);
    if (
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59))
    ) {
      throw Error('at must contain a valid calendar date and UTC offset');
    }
  }
  if (input.afterSeconds !== undefined && typeof input.afterSeconds !== 'number') {
    throw Error('afterSeconds must be a number');
  }
  const dueAt = input.at === undefined ? now + input.afterSeconds! * 1000 : Date.parse(input.at);
  const grace = input.expiresAfterSeconds ?? 3600;
  if (
    !Number.isFinite(dueAt) ||
    dueAt - now < 60_000 ||
    dueAt - now > 30 * 86400_000 ||
    typeof grace !== 'number' ||
    !Number.isFinite(grace) ||
    grace < 1 ||
    grace > 86400
  ) {
    throw Error('Delay must be 60 seconds–30 days; lateness must be 1 second–24 hours');
  }
  return { dueAt, expiresAt: dueAt + grace * 1000 };
}
