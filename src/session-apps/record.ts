/**
 * The durable record of one conversation's session application.
 *
 * One JSON file per conversation (`applications/<conversation id>.json` under
 * the widget state directory) holds the current code reference, state, retry
 * receipts and the user-edit event outbox. Every change rewrites the whole
 * file atomically (temporary file + rename), so a state change and its event
 * are committed together or not at all.
 *
 * Bundles themselves are retained separately by WidgetRegistry under their
 * SHA-256 hash; this record only references them.
 */

import { boundedJson, object, type JsonObject } from '../widgets/types.ts';
import {
  sessionApplicationEventModes,
  sessionApplicationLimits,
  type SessionApplicationEventMode,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const bundleName = /^[a-z][a-z0-9-]{0,47}$/;
const operationName = /^[a-z][a-z0-9_]{0,47}$/;

/** One committed user edit, as recorded in the outbox. */
export interface ApplicationEdit {
  /** Stable host-assigned event ID (UUID). */
  eventId: string;
  /** The mutation's request ID; a retried request never records a second edit. */
  requestId: string;
  action: string;
  /** Bounded copies; replaced by `{ elided: true, bytes }` when too large. */
  args: JsonObject;
  result: JsonObject;
  /** State revision after this edit. */
  revision: number;
  /** Code version that executed the edit. */
  version: number;
  /** Milliseconds since the Unix epoch. */
  at: number;
}

/**
 * A group of coalesced user edits on its way to the agent.
 *
 * Durable states: `pending` (never admitted to a model turn), `delivering`
 * (frozen into a turn that started) and `failed` (terminal). Delivered batches
 * are removed. "Queued behind another turn" is a live overlay kept by the
 * service, because a queued placeholder turn does not survive a restart.
 */
export interface ApplicationBatch {
  id: string;
  state: 'pending' | 'delivering' | 'failed';
  /** Revision before the first edit and after the last edit. */
  fromRevision: number;
  toRevision: number;
  /** All edits in this batch, including those not detailed in `edits`. */
  count: number;
  /** The first edits in detail, at most `detailedEditsPerBatch`. */
  edits: ApplicationEdit[];
  /** Reason for `failed`, or the latest admission refusal while `pending`. */
  failure?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApplicationRecord {
  format: 1;
  id: string;
  /** Owning conversation ID. */
  owner: string;
  name: string;
  /** SHA-256 of the retained bundle. */
  bundle: string;
  version: number;
  revision: number;
  data: JsonObject;
  text: string;
  eventMode: SessionApplicationEventMode;
  receipts: { id: string; result: JsonObject }[];
  batches: ApplicationBatch[];
  /** The code this version replaced, kept for diagnosis and recovery. */
  previous?: { name: string; bundle: string; version: number };
  updatedAt: number;
}

function positiveInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw Error('Invalid saved application number');
  }
  return Number(value);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw Error('Invalid saved application text');
  }
  return value;
}

function parseEdit(value: unknown): ApplicationEdit {
  const input = object(value);
  if (
    typeof input.eventId !== 'string' ||
    !uuid.test(input.eventId) ||
    typeof input.action !== 'string' ||
    !operationName.test(input.action)
  ) {
    throw Error('Invalid saved application edit');
  }
  return {
    eventId: input.eventId,
    requestId: boundedText(input.requestId, 200),
    action: input.action,
    args: object(input.args),
    result: object(input.result),
    revision: positiveInteger(input.revision, 1),
    version: positiveInteger(input.version, 1),
    at: positiveInteger(input.at),
  };
}

function parseBatch(value: unknown): ApplicationBatch {
  const input = object(value);
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    !['pending', 'delivering', 'failed'].includes(String(input.state)) ||
    !Array.isArray(input.edits) ||
    input.edits.length > sessionApplicationLimits.detailedEditsPerBatch
  ) {
    throw Error('Invalid saved application event batch');
  }
  const batch: ApplicationBatch = {
    id: input.id,
    state: input.state as ApplicationBatch['state'],
    fromRevision: positiveInteger(input.fromRevision),
    toRevision: positiveInteger(input.toRevision, 1),
    count: positiveInteger(input.count, 1),
    edits: input.edits.map(parseEdit),
    createdAt: positiveInteger(input.createdAt),
    updatedAt: positiveInteger(input.updatedAt),
  };
  if (input.failure !== undefined) {
    batch.failure = boundedText(input.failure, 500);
  }
  return batch;
}

/**
 * Validate a saved record's structure. The state is validated separately
 * against the retained bundle's schema, which needs the registry.
 */
export function parseApplicationRecord(value: unknown, owner: string): ApplicationRecord {
  const input = object(value);
  if (
    input.format !== 1 ||
    input.owner !== owner ||
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    typeof input.name !== 'string' ||
    !bundleName.test(input.name) ||
    typeof input.bundle !== 'string' ||
    !hash.test(input.bundle) ||
    !sessionApplicationEventModes.includes(input.eventMode as SessionApplicationEventMode) ||
    !Array.isArray(input.receipts) ||
    input.receipts.length > sessionApplicationLimits.receipts ||
    !Array.isArray(input.batches) ||
    input.batches.length > sessionApplicationLimits.failedBatches + 2
  ) {
    throw Error('Invalid saved application');
  }
  const receipts = input.receipts.map((entry) => {
    const receipt = object(entry);
    return { id: boundedText(receipt.id, 200), result: object(receipt.result) };
  });
  boundedJson(receipts, sessionApplicationLimits.receiptBytes);
  const text = boundedText(input.text, 4000);
  if (!text.trim()) {
    throw Error('Invalid saved application text');
  }
  const record: ApplicationRecord = {
    format: 1,
    id: input.id,
    owner,
    name: input.name,
    bundle: input.bundle,
    version: positiveInteger(input.version, 1),
    revision: positiveInteger(input.revision, 1),
    data: object(input.data),
    text,
    eventMode: input.eventMode as SessionApplicationEventMode,
    receipts,
    batches: input.batches.map(parseBatch),
    updatedAt: positiveInteger(input.updatedAt),
  };
  if (input.previous !== undefined) {
    const previous = object(input.previous);
    if (
      typeof previous.name !== 'string' ||
      !bundleName.test(previous.name) ||
      typeof previous.bundle !== 'string' ||
      !hash.test(previous.bundle)
    ) {
      throw Error('Invalid saved application history');
    }
    record.previous = {
      name: previous.name,
      bundle: previous.bundle,
      version: positiveInteger(previous.version, 1),
    };
  }
  return record;
}
