/**
 * Wire contract between the phone app and the remote gateway.
 *
 * The phone speaks JSON over one authenticated WebSocket. Its requests are a
 * strict subset of the desktop control protocol (see src/desktop/README.md),
 * validated here field by field before the gateway relays them to the
 * listener's Unix socket as a remote-role client. This module has no Node
 * imports so the browser bundle can share the same types and validation.
 */

// Type-only imports: erased from the browser bundle, so no Node code follows.
import type { AgentActions } from '../agents/choice-intents.ts';
import type { AgentSession, PreviousSession } from '../agents/types.ts';
import type { IntentState } from '../core/router.ts';
import type { ActivityHistoryEntry, ActivityHistoryRemoval } from '../desktop/activity-history.ts';
import type { HistoryEntry } from '../desktop/history.ts';

export type {
  ActivityHistoryEntry as ActivityEntry,
  ActivityHistoryRemoval as ActivityRemoval,
  AgentActions as RemoteAgentActions,
  HistoryEntry,
  IntentState,
};

/** Largest WebSocket message the gateway accepts from a phone, in bytes. */
export const maximumClientMessageBytes = 32 * 1024;

/** Client request IDs are opaque, short and URL-safe so they can key receipts. */
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parameter shapes for every action a phone may send. Anything absent here is
 * refused before reaching the listener, including desktop-only actions such as
 * paste, submit-utterance, media-playback, composer-focus and draft replies.
 */
export interface RemoteActionParameters {
  'panel-state': { id: string };
  'toggle-pause': Record<string, never>;
  'toggle-sounds': Record<string, never>;
  'set-intent-enabled': { name: string; mode: 'inference' | 'shortcut'; enabled: boolean };
  'activity-history': { sessionId: string; after: number; through: number };
  'label-history': { id: string; correct: boolean; actualIntent?: string | null };
  'delete-history': { id: string };
  'start-history-agent': { id: string };
  'start-agent': { text: string; profile: 'coding' | 'quickQuestion' };
  'send-agent': { id: string; text: string };
  'stop-agent': { id: string };
  'close-agent': { id: string };
  'reopen-agent': { id: string };
  'choose-agent': { id: string; revision: string; index: number };
  'stop-agent-run': { id: string; runId: string };
  'agent-models': Record<string, never>;
  'claude-models': Record<string, never>;
  'set-agent-model': { id: string; model: string };
  'set-agent-thinking': { id: string; thinking: string };
  'move-agent': { id: string; beforeId: string; revision: string };
  'agent-tool-page': {
    id: string;
    epoch: string;
    groupId: string;
    revision: string;
    callRevision?: string;
    index: number;
    offset: number;
  };
}

export type RemoteAction = keyof RemoteActionParameters;

export type RemoteRequest = {
  [Action in RemoteAction]: {
    type: 'request';
    requestId: string;
    action: Action;
  } & RemoteActionParameters[Action];
}[RemoteAction];

/**
 * Actions that change engine state. The gateway remembers their receipts per
 * device, so a request repeated after a reconnect is answered from the receipt
 * instead of being executed twice. Toggles make this essential: replaying
 * `toggle-pause` would silently undo the user's first tap.
 */
export const mutatingActions: ReadonlySet<RemoteAction> = new Set<RemoteAction>([
  'toggle-pause',
  'toggle-sounds',
  'set-intent-enabled',
  'label-history',
  'delete-history',
  'start-history-agent',
  'start-agent',
  'send-agent',
  'stop-agent',
  'close-agent',
  'reopen-agent',
  'choose-agent',
  'stop-agent-run',
  'set-agent-model',
  'set-agent-thinking',
  'move-agent',
]);

/** First message on a new socket. The token never travels in a URL. */
export interface AuthMessage {
  type: 'auth';
  token: string;
}

/** Messages the gateway sends to the phone. */
export type GatewayMessage =
  | { type: 'authenticated'; deviceId: string; deviceName: string }
  | { type: 'engine'; message: EngineEvent }
  | {
      type: 'result';
      requestId: string;
      action: RemoteAction;
      result: unknown;
      /** True when answered from an earlier receipt rather than executed again. */
      duplicate?: boolean;
    }
  | {
      type: 'error';
      requestId?: string;
      action?: string;
      message: string;
      duplicate?: boolean;
    };

/**
 * Listener events relayed to the phone. Screenshot file URLs are replaced by
 * `screenshotId`, which the phone fetches through the authenticated image
 * route; widget view URLs are removed because they only work on the desktop.
 */
export type EngineEvent =
  | ({ type: 'state' } & EngineState)
  | { type: 'agent-session'; session: AgentSession }
  | { type: 'agent-removed'; id: string }
  | { type: 'agent-restored'; session: AgentSession; reveal?: boolean }
  | { type: 'agent-order'; ids: string[]; revision: string }
  | { type: 'agent-history'; sessions: PreviousSession[] }
  | { type: 'agent-turn-completed'; id: string; turnId: string }
  | { type: 'remote-agent-actions'; actions: AgentActions }
  | { type: 'activity-entry'; sessionId: string; entry: ActivityHistoryEntry }
  | { type: 'history-deleted'; id: string; sessionId: string; removed?: ActivityHistoryRemoval };

export interface EngineState {
  protocol: number;
  ready: boolean;
  paused: boolean;
  pauseReason: '' | 'manual' | 'media';
  speaking?: boolean;
  soundsEnabled: boolean;
  processing: number;
  preview: boolean;
  /** Always empty for phones: the gateway withholds the recent-utterance list. */
  history: HistoryEntry[];
  activitySessionId: string;
  activityHistoryCount: number;
  historyDeletionAvailable?: boolean;
  sessions: AgentSession[];
  sessionOrderRevision: string;
  sessionControlsAvailable: boolean;
  previousSessions: PreviousSession[];
  intents: IntentState[];
}

export interface ActivityPage {
  sessionId: string;
  entries: ActivityHistoryEntry[];
  removed: ActivityHistoryRemoval[];
  next: number | null;
  through: number;
}

export interface ModelCatalog {
  models: string[];
  pinned?: string[];
  warning?: string;
  thinkingLevels: Record<string, string[]>;
  coding: string;
  quickQuestion: string;
  codingThinking: string;
  quickQuestionThinking: string;
}

export interface ToolPage {
  text: string;
  state: string;
  callRevision: string;
  next: { index: number; offset: number } | null;
}

/** Messages the listener sends that the phone must never see or act on. */
export const desktopOnlyEvents: ReadonlySet<string> = new Set([
  // Controls for the desktop's selection, not the phone's.
  'agent-actions',
  // Composer drafts belong to desktop panels, which must acknowledge them.
  'agent-draft',
  // Spoken "go to session N" navigation for the desktop panel.
  'agent-select',
]);

/** Explicit event boundary: new desktop events are private until reviewed. */
export const remoteEvents: ReadonlySet<string> = new Set([
  'state',
  'agent-session',
  'agent-removed',
  'agent-restored',
  'agent-order',
  'agent-history',
  'agent-turn-completed',
  'remote-agent-actions',
  'activity-entry',
  'history-deleted',
]);

// ---------------------------------------------------------------------------
// Validation. Each action lists its exact fields and their types. Unknown
// fields are refused rather than silently forwarded.
// ---------------------------------------------------------------------------

type FieldCheck = (value: unknown) => boolean;

const text = (maximum: number): FieldCheck => {
  return (value) => typeof value === 'string' && value.length <= maximum;
};
const nonEmptyText = (maximum: number): FieldCheck => {
  return (value) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
};
const sessionId: FieldCheck = (value) => typeof value === 'string' && sessionIdPattern.test(value);
const optionalSessionId: FieldCheck = (value) => value === '' || sessionId(value);
const boolean: FieldCheck = (value) => typeof value === 'boolean';
const count: FieldCheck = (value) => Number.isSafeInteger(value) && (value as number) >= 0;

interface ActionShape {
  required: Record<string, FieldCheck>;
  optional?: Record<string, FieldCheck>;
}

const shapes: Record<RemoteAction, ActionShape> = {
  'panel-state': { required: { id: optionalSessionId } },
  'toggle-pause': { required: {} },
  'toggle-sounds': { required: {} },
  'set-intent-enabled': {
    required: {
      name: nonEmptyText(100),
      mode: (value) => value === 'inference' || value === 'shortcut',
      enabled: boolean,
    },
  },
  'activity-history': { required: { sessionId: nonEmptyText(64), after: count, through: count } },
  'label-history': {
    required: { id: nonEmptyText(64), correct: boolean },
    optional: { actualIntent: (value) => value === null || nonEmptyText(100)(value) },
  },
  'delete-history': { required: { id: nonEmptyText(64) } },
  'start-history-agent': { required: { id: nonEmptyText(64) } },
  'start-agent': {
    required: {
      text: (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 4000,
      profile: (value) => value === 'coding' || value === 'quickQuestion',
    },
  },
  'send-agent': {
    required: {
      id: sessionId,
      text: (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 4000,
    },
  },
  'stop-agent': { required: { id: sessionId } },
  'close-agent': { required: { id: sessionId } },
  'reopen-agent': { required: { id: sessionId } },
  'choose-agent': {
    required: {
      id: sessionId,
      revision: nonEmptyText(64),
      index: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 64,
    },
  },
  'stop-agent-run': { required: { id: sessionId, runId: nonEmptyText(64) } },
  'agent-models': { required: {} },
  'claude-models': { required: {} },
  'set-agent-model': { required: { id: sessionId, model: text(300) } },
  'set-agent-thinking': { required: { id: sessionId, thinking: text(20) } },
  'move-agent': {
    required: { id: sessionId, beforeId: optionalSessionId, revision: nonEmptyText(64) },
  },
  'agent-tool-page': {
    required: {
      id: sessionId,
      epoch: nonEmptyText(64),
      groupId: nonEmptyText(64),
      revision: nonEmptyText(64),
      index: count,
      offset: count,
    },
    optional: { callRevision: nonEmptyText(36) },
  },
};

export function isRemoteAction(value: unknown): value is RemoteAction {
  return typeof value === 'string' && Object.hasOwn(shapes, value);
}

export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

/**
 * Parse one phone message into a request, or explain why it is refused.
 * The returned request contains only the declared fields.
 */
export function parseRemoteRequest(
  value: unknown,
): { ok: true; request: RemoteRequest } | { ok: false; requestId?: string; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'Expected a JSON object' };
  }

  const fields = value as Record<string, unknown>;
  const requestId = validRequestId(fields.requestId) ? fields.requestId : undefined;

  if (fields.type !== 'request') {
    return { ok: false, requestId, message: 'Expected a request message' };
  }
  if (!requestId) {
    return { ok: false, message: 'Expected a request ID of 1–64 letters, digits, - or _' };
  }
  if (!isRemoteAction(fields.action)) {
    return { ok: false, requestId, message: 'This action is not available remotely' };
  }

  const shape = shapes[fields.action];
  const request: Record<string, unknown> = {
    type: 'request',
    requestId,
    action: fields.action,
  };

  for (const [name, check] of Object.entries(shape.required)) {
    if (!check(fields[name])) {
      return { ok: false, requestId, message: `Invalid or missing field: ${name}` };
    }
    request[name] = fields[name];
  }

  for (const [name, check] of Object.entries(shape.optional ?? {})) {
    if (fields[name] === undefined) {
      continue;
    }
    if (!check(fields[name])) {
      return { ok: false, requestId, message: `Invalid field: ${name}` };
    }
    request[name] = fields[name];
  }

  for (const name of Object.keys(fields)) {
    if (
      name !== 'type' &&
      name !== 'requestId' &&
      name !== 'action' &&
      !Object.hasOwn(request, name)
    ) {
      return { ok: false, requestId, message: `Unknown field: ${name}` };
    }
  }

  return { ok: true, request: request as RemoteRequest };
}
