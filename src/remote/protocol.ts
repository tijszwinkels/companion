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
import type { CaptureStorageState } from '../capture-storage/policy.ts';

export type {
  ActivityHistoryEntry as ActivityEntry,
  ActivityHistoryRemoval as ActivityRemoval,
  AgentActions as RemoteAgentActions,
  HistoryEntry,
  IntentState,
};

/**
 * Largest WebSocket message the gateway accepts from an authenticated client,
 * in bytes. A `draft-set` of 16,000 UTF-16 units (`draftTextLimit`) may be
 * written with six JSON characters per unit (`\u0001`), 96,000 bytes plus its
 * other fields, so 128 KiB holds the largest draft with room to spare.
 */
export const maximumClientMessageBytes = 128 * 1024;

/**
 * Largest WebSocket message a socket may send before it is authenticated and
 * admitted, in bytes: the bound every message had before drafts. It also
 * holds while a refused socket is still closing, so an unauthenticated socket
 * never makes the gateway hold more than before (see message-limit.ts).
 */
export const maximumUnauthenticatedMessageBytes = 32 * 1024;

/**
 * Longest draft a remote draft host may write, in UTF-16 units: the
 * listener's editing bound (`draftEditLimit` in src/desktop/draft-store.ts).
 */
export const draftTextLimit = 16_000;

/**
 * Longest follow-up a remote client may send, in UTF-16 units: the desktop
 * composer's bound (`MAX_DIRECT_USER_MESSAGE_LENGTH` in
 * src/agents/message-limits.ts).
 */
export const sendTextLimit = 8000;

/**
 * Authenticated connections the gateway relays at once, in total and per
 * paired device. Draining connections (closed by the client, still waiting
 * for replies) count. Each uses one of the listener's 16 client slots.
 */
export const maximumRemoteConnections = 8;
export const maximumConnectionsPerDevice = 4;

/**
 * Close reason sent with close code 4429 when a new connection is refused:
 * `device` when its own device already has `maximumConnectionsPerDevice`,
 * `total` when the gateway already relays `maximumRemoteConnections`.
 * Connections that are already open are never closed to make room, and the
 * reason never names another device.
 */
export type OverloadedReason = 'device' | 'total';

/** Client request IDs are opaque, short and URL-safe so they can key receipts. */
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parameter shapes for every action a phone may send. Anything absent here is
 * refused before reaching the listener, including desktop-only actions such as
 * paste, submit-utterance, media-playback, composer-focus and draft replies.
 * `draft-set` and `panel-state`'s `pendingSend` exist only for a connection
 * that authenticated with `drafts: true` (a draft host, see AuthMessage);
 * every other connection is refused them exactly as before they existed.
 */
export interface RemoteActionParameters {
  /**
   * `visible`: the page showing `id` is visible (for example not a background
   * tab). Absent counts as not visible, so the conversation is not read.
   * `pendingSend` (draft hosts only): the conversation whose `send-agent`
   * this page is still waiting for, or empty; agents cannot propose a draft
   * for it meanwhile. Each report replaces the previous one.
   */
  'panel-state': { id: string; visible?: boolean; pendingSend?: string };
  /**
   * Draft hosts only: replace a conversation's unsent text. `editId` is the
   * client's own ID for this edit; it comes back only to this connection in
   * the `draft` event of this change. The last edit the listener receives
   * wins. Never repeated by the gateway and kept in no receipt.
   */
  'draft-set': { id: string; text: string; editId: string };
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
  'agent-history-page': {
    id: string;
    epoch: string;
    direction: 'before' | 'after';
    index: number;
    offset: number;
    anchor?: string;
  };
  'agent-tool-page': {
    id: string;
    epoch: string;
    groupId: string;
    revision: string;
    callRevision?: string;
    index: number;
    offset: number;
  };
  /**
   * Allow or stop the conversation's session application reading recent chat
   * text (`…-read`) or sending chat messages (`…-send`). The fields are the
   * ones the desktop sends: the application's `id` and code `version` and the
   * permission `revision` from the `chatAccess` this client was shown, and
   * `allowed`. The listener allows it only for the conversation this
   * connection shows: allowing needs it selected on a visible page, stopping
   * only selected (src/desktop/README.md, "Application chat access from a
   * paired device"). The result is the new `RemoteApplicationChatAccess`.
   */
  'set-application-chat-read': ApplicationChatPermissionChange;
  'set-application-chat-send': ApplicationChatPermissionChange;
}

/** Fields of `set-application-chat-read` and `set-application-chat-send`. */
export interface ApplicationChatPermissionChange {
  /** The conversation. */
  id: string;
  /** The session application's ID (`application.id`). */
  applicationId: string;
  /** The application's code version (`application.version`). */
  version: number;
  /** `application.chatAccess.revision` as this client last received it. */
  revision: string;
  allowed: boolean;
}

/**
 * A session application's chat permission state as a remote client receives
 * it: `application.chatAccess` in sessions, and the result of
 * `set-application-chat-read` / `set-application-chat-send`. The gateway
 * rebuilds it field by field from the listener's state (see chat-access.ts);
 * the listener's `send.grantId` never reaches a remote client.
 */
export interface RemoteApplicationChatAccess {
  /** What the application's code asks for: `chat.read`, `chat.send` or both. */
  requested: ('chat.read' | 'chat.send')[];
  /** The application may read recent chat text. */
  read: boolean;
  /** Absent from older listeners; absence never means sending is allowed. */
  send?: {
    allowed: boolean;
    /** Messages the current grant may still send (0 when not allowed). */
    remaining: number;
    /** One of its messages is waiting or running. */
    busy: boolean;
  };
  /** Changes with every permission change; a change must name the current one. */
  revision: string;
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
 *
 * `draft-set` changes state too but deliberately has no receipt: a client
 * never resends a draft edit (replaying an old edit over newer text would be
 * wrong), and one receipt per keystroke would fill the receipt book.
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
  // A repeat after a reconnect gets the first request's real outcome. Run
  // again, it would only be refused (the permission revision has changed).
  'set-application-chat-read',
  'set-application-chat-send',
]);

/** First message on a new socket. The token never travels in a URL. */
export interface AuthMessage {
  type: 'auth';
  token: string;
  /** Retain conversations from ordered agent events after the connect snapshot. */
  incrementalSessions?: true;
  /**
   * Make this connection a draft host: it receives `draft-snapshot` and
   * `draft` events and may send `draft-set` and `pendingSend`. Without it the
   * connection behaves exactly as before drafts were offered remotely.
   */
  drafts?: true;
}

/** Messages the gateway sends to the phone. */
export type GatewayMessage =
  | { type: 'pong' }
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
 * route; widget and session application view URLs are removed because they
 * only work on the desktop.
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
  | { type: 'history-deleted'; id: string; sessionId: string; removed?: ActivityHistoryRemoval }
  | ({ type: 'draft-snapshot' } & DraftSnapshot)
  | ({ type: 'draft' } & DraftChange);

/**
 * One conversation's unsent text as the listener holds it. `source` is empty
 * for text a person wrote; for an agent's proposal it names the proposer as
 * the desktop shows it ("external (unverified) · …" for external sessions).
 * `sequence` orders what is displayed; it is never used to refuse an edit.
 */
export interface DraftEntry {
  id: string;
  text: string;
  source: string;
  sequence: number;
}

/** Every nonempty draft, sent once when a connection becomes a draft host. */
export interface DraftSnapshot {
  sequence: number;
  drafts: DraftEntry[];
}

/**
 * One accepted draft change; empty `text` means the draft was cleared. `editId`
 * is present only on the connection that wrote the change.
 */
export interface DraftChange extends DraftEntry {
  editId?: string;
}

export interface EngineState {
  protocol: number;
  /**
   * The listener's clock when it built this state message, in milliseconds
   * since the Unix epoch. Absent from older listeners. Relayed unchanged.
   */
  listenerTime?: number;
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
  /** Connect snapshots include these; negotiated routine state omits them. */
  sessions?: AgentSession[];
  sessionOrderRevision?: string;
  sessionControlsAvailable: boolean;
  previousSessions?: PreviousSession[];
  intents: IntentState[];
  /**
   * Read-only capture-storage state. Absent from older listeners, which
   * means unknown, not off. The phone cannot change it (no remote action).
   */
  captureStorage?: CaptureStorageState;
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
  // Controls for the conversations one desktop connection shows.
  'agent-view-actions',
  // Superseded agent-draft requests that desktop panels had to acknowledge.
  // Agents' drafts now reach draft hosts as ordinary `draft` events.
  'agent-draft',
  // An agent's draft with `focus` moves only the desktop panel.
  'agent-draft-focus',
  // Spoken "go to session N" navigation for the desktop panel.
  'agent-select',
  // Pop-out conversation windows are native desktop windows.
  'agent-present',
  // Manual recording appends to the desktop panel that started it.
  'recording-append',
  'recording-finished',
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

/**
 * Listener draft events, relayed only to a connection that authenticated
 * with `drafts: true`. The listener sends them only to draft hosts anyway;
 * this keeps the boundary in the gateway too.
 */
export const draftEvents: ReadonlySet<string> = new Set(['draft-snapshot', 'draft']);

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
/** Application IDs and permission revisions are lowercase UUIDs like conversation IDs. */
const uuid: FieldCheck = sessionId;
const optionalSessionId: FieldCheck = (value) => value === '' || sessionId(value);
const boolean: FieldCheck = (value) => typeof value === 'boolean';
const count: FieldCheck = (value) => Number.isSafeInteger(value) && (value as number) >= 0;

interface ActionShape {
  required: Record<string, FieldCheck>;
  optional?: Record<string, FieldCheck>;
}

const shapes: Record<RemoteAction, ActionShape> = {
  'panel-state': { required: { id: optionalSessionId }, optional: { visible: boolean } },
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
      text: (value) =>
        typeof value === 'string' && value.trim() !== '' && value.length <= sendTextLimit,
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
  'agent-history-page': {
    required: {
      id: sessionId,
      epoch: nonEmptyText(64),
      direction: (value) => value === 'before' || value === 'after',
      index: count,
      offset: count,
    },
    optional: { anchor: nonEmptyText(200) },
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
  'draft-set': {
    required: { id: sessionId, text: text(draftTextLimit), editId: nonEmptyText(100) },
  },
  'set-application-chat-read': { required: applicationChatPermissionFields() },
  'set-application-chat-send': { required: applicationChatPermissionFields() },
};

/** Exactly the fields the desktop sends for an application chat permission. */
function applicationChatPermissionFields(): Record<string, FieldCheck> {
  return {
    id: sessionId,
    applicationId: uuid,
    version: count,
    revision: uuid,
    allowed: boolean,
  };
}

/**
 * What a draft host may send beyond `shapes`. A connection that did not ask
 * for drafts is validated against `shapes` alone, where `draft-set` is
 * missing and `pendingSend` is an unknown field, exactly as before.
 */
const draftHostShapes: Partial<Record<RemoteAction, ActionShape>> = {
  'panel-state': {
    required: { id: optionalSessionId },
    optional: { visible: boolean, pendingSend: optionalSessionId },
  },
  'draft-set': shapes['draft-set'],
};

/** Actions only a draft host may send. */
const draftHostOnlyActions: ReadonlySet<RemoteAction> = new Set<RemoteAction>(['draft-set']);

/** What one connection negotiated when it authenticated. */
export interface RemoteCapabilities {
  /** The connection authenticated with `drafts: true`. */
  drafts: boolean;
}

export function isRemoteAction(value: unknown): value is RemoteAction {
  return typeof value === 'string' && Object.hasOwn(shapes, value);
}

export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

/**
 * Parse one phone message into a request, or explain why it is refused.
 * The returned request contains only the declared fields. `capabilities`
 * are the connection's own (default: not a draft host).
 */
export function parseRemoteRequest(
  value: unknown,
  capabilities: RemoteCapabilities = { drafts: false },
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
  // The same answer as for an unknown action, so a connection that did not
  // ask for drafts sees no difference from before they existed.
  if (draftHostOnlyActions.has(fields.action) && !capabilities.drafts) {
    return { ok: false, requestId, message: 'This action is not available remotely' };
  }

  let shape = shapes[fields.action];
  if (capabilities.drafts) {
    shape = draftHostShapes[fields.action] ?? shape;
  }
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
