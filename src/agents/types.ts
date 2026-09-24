import type { WidgetAttachment } from '../widgets/types.ts';
import type { Screenshot } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import type { AgentChoice, AgentChoiceSet } from './choices.ts';

/**
 * Provenance of a message written by another Companion conversation's agent
 * through the session tools. The user did not type it; the UI labels it and Pi
 * receives an explicit header. `depth` counts agent-to-agent hops since the last
 * human-originated turn and bounds feedback loops between conversations.
 */
export type AgentMessageOrigin = InternalAgentOrigin | ExternalAgentOrigin;

/** Local same-user caller. Its label is supplied, never authenticated. */
export interface ExternalAgentOrigin {
  kind: 'external';
  title: string;
  requestId: string;
  depth: number;
}

export interface InternalAgentOrigin {
  kind: 'agent';
  /** Sender conversation ID. It may since have been closed or renamed. */
  sessionId: string;
  /** Sender title captured when the message was sent. */
  title: string;
  depth: number;
}

/** Portable chat data. Provider events and subprocess details stay in the backend. */
export interface AgentMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  toolName: string;
  input: string;
  state: 'queued' | 'running' | 'done' | 'error';
  screenshot: boolean;
  /** Consecutive tool calls; full inputs/results are stored and paged separately. */
  toolGroup?: { count: number; revision: string; legacy?: boolean; unavailable?: boolean };
  /** Local, private PNG attachment; omitted while saving or on older messages. */
  screenshotUrl?: string;
  /** Validated reference; its private view URL is regenerated when reopening. */
  widget?: WidgetAttachment;
  /** Present only on user-kind messages written by another conversation's agent. */
  origin?: AgentMessageOrigin;
}

/** Selects a model configuration for the whole conversation, including reopening. */
export type AgentProfile = 'coding' | 'quickQuestion';

export interface AgentSession {
  id: string;
  title: string;
  status: 'starting' | 'running' | 'completed' | 'cancelled' | 'error';
  model: string;
  /** Older saved conversations omit this and retain the coding configuration. */
  profile?: AgentProfile;
  /** Explicit conversation choice; absence reloads the profile default each turn. */
  modelOverride?: string;
  /** Requested effort for subsequent turns; Pi adapts it to the chosen model. */
  thinkingOverride?: AgentSettings['thinking'];
  error: string;
  messages: AgentMessage[];
  updatedAt: number;
  /** Live affordances are deliberately not restored from saved transcripts. */
  choices?: AgentChoiceSet;
  runId?: string;
  /** Fresh on reopening; rejects requests from a previous tab lifetime. */
  toolEpoch?: string;
  acceptsFollowUp?: boolean;
  /** Latest successful turn in this process; snapshots recover missed UI updates. */
  completedTurnId?: string;
  /**
   * Live-only: an agent tool opened this tab without requesting focus. Clients
   * add it to the rail without selecting it or revealing the panel.
   */
  openInBackground?: boolean;
}

export type PreviousSession = Omit<AgentSession, 'messages'>;

/** Updates contain changed messages only; a reconnect snapshot contains them all. */
export type SessionEvent =
  | { type: 'agent-order'; ids: string[]; revision: string }
  | { type: 'agent-session'; session: AgentSession }
  | { type: 'agent-removed'; id: string }
  | { type: 'agent-restored'; session: AgentSession; reveal?: boolean }
  | { type: 'agent-turn-completed'; id: string; turnId: string }
  | { type: 'agent-history'; sessions: PreviousSession[] };

export const agentThinkingLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export interface AgentSettings {
  executable: string;
  model: string;
  thinking: (typeof agentThinkingLevels)[number];
}

/** Safe metadata only: never expose provider credentials or endpoints to clients. */
export interface AgentModelCatalog {
  models: string[];
  /** Absent when scope metadata failed; the full catalogue remains usable. */
  pinned?: string[];
  warning?: string;
  thinkingLevels: Record<string, AgentSettings['thinking'][]>;
}

export interface AgentBackend extends InspectableModule {
  /** Discover authenticated/configured Pi models without starting a conversation. */
  models?(
    settings: AgentSettings,
    directory: string,
    signal: AbortSignal,
  ): Promise<AgentModelCatalog>;
  run(
    request: {
      id: string;
      directory: string;
      settings: AgentSettings;
      prompt: { text: string; screenshot?: Screenshot };
      resume: boolean;
      widgets?: { endpoint: string; token: string };
      /** Turn-scoped connection for the session lifecycle tools. */
      sessionTools?: { endpoint: string; token: string };
    },
    signal: AbortSignal,
    emit: (message: AgentMessage) => void,
    replaceChoices?: (options: readonly AgentChoice[]) => void,
    renameSession?: (title: string) => void,
  ): Promise<void>;
}

export function chatMessage(id: string, kind: AgentMessage['kind'], text: string): AgentMessage {
  return { id, kind, text, toolName: '', input: '', state: 'done', screenshot: false };
}

/**
 * An agent's proposal for another conversation's unsent composer text. Only a
 * connected UI owns drafts, so the listener forwards this and waits for its
 * explicit answer. A draft never submits a message or starts a turn.
 */
export interface AgentDraftRequest {
  /** Target conversation; it must be an open tab. */
  sessionId: string;
  text: string;
  /** `reject` never changes existing user text; `append` adds below it. */
  ifDraftExists: 'reject' | 'append';
  /** Select the target and reveal the panel only when explicitly requested. */
  focus: boolean;
  source: { sessionId: string; title: string } | { kind: 'external'; title: string };
}

/**
 * `inserted`/`appended` are confirmed changes. `conflict` and `unavailable` are
 * confirmed non-changes. `offline` means no UI could receive the draft.
 * `unconfirmed` means the UI may or may not have applied it (timeout or
 * disconnect after sending), so the caller must not blindly retry.
 */
export interface AgentDraftOutcome {
  outcome: 'inserted' | 'appended' | 'conflict' | 'unavailable' | 'offline' | 'unconfirmed';
  reason: string;
}

export type AgentDraftHost = (
  request: AgentDraftRequest,
  signal: AbortSignal,
) => Promise<AgentDraftOutcome>;
