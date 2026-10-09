import type { WidgetAttachment } from '../widgets/types.ts';
import type { Screenshot } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import type { AgentChoice, AgentChoiceSet } from './choices.ts';
import type { HistoryWindow } from './history-pages.ts';

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
  /** Source tool group, when the outbound call was retained in the sender transcript. */
  sourceGroupId?: string;
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
  /**
   * False when the screenshot sent with this message was deliberately not
   * saved because capture storage was off. Such a message never shows the
   * conversation's saved PNG, which may belong to an earlier capture.
   * Absent on saved screenshots and older messages.
   */
  screenshotSaved?: false;
  /** Validated reference; its private view URL is regenerated when reopening. */
  widget?: WidgetAttachment;
  /** Display-only slice of an oversized message; never persisted. */
  historyFragment?: { start: number; end: number; total: number };
  /** Present only on user-kind messages written by another conversation's agent. */
  origin?: AgentMessageOrigin;
}

/** Selects a model configuration for the whole conversation, including reopening. */
export type AgentProfile = 'coding' | 'quickQuestion';

/**
 * The agent program that runs a conversation's turns. There are exactly two:
 * the headless Pi RPC process (which also serves OpenAI Codex models) and the
 * native Claude Code CLI. A conversation keeps its harness for its lifetime,
 * because each harness stores its own transcript that only it can resume.
 */
export const agentHarnesses = ['pi', 'claude-code'] as const;

export type AgentHarness = (typeof agentHarnesses)[number];

/** Effort levels accepted by `claude --effort` (verified against Claude Code 2.1.280). */
export const claudeCodeEffortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeCodeEffort = (typeof claudeCodeEffortLevels)[number];

/**
 * Settings for one Claude Code turn. `model` is the exact model ID that Claude
 * Code must report at startup; the backend fails the turn on any difference
 * and never configures a fallback model.
 */
export interface ClaudeCodeSettings {
  executable: string;
  model: string;
  effort: ClaudeCodeEffort;
}

/**
 * A Claude Code conversation's own model and effort. Both are captured from
 * the configuration (or an explicit start request) when the conversation is
 * created; later configuration edits never change them. The user can choose
 * another Claude model for the next turn from the footer picker, which
 * replaces `model` here; the effort stays fixed. The executable is still read
 * from the configuration for each turn.
 */
export type ClaudeCodeConversationSettings = Pick<ClaudeCodeSettings, 'model' | 'effort'>;

/**
 * The Claude picker's catalogue (`claude-models`): the allowlisted exact
 * model IDs plus the configured default, and that configured default model.
 * There is no effort field: a conversation's effort never changes.
 */
export interface ClaudeCodeModelCatalog {
  models: string[];
  model: string;
}

/**
 * Claude Code only: the latest name Companion gave this conversation, and
 * whether Claude Code confirmed it in its own session metadata (its native
 * `rename_session` control request, which writes Claude Code's `custom-title`
 * record). `pending` was not yet confirmed (for example, the turn ended first)
 * and is sent again at the next turn's start; `failed` was explicitly refused
 * by Claude Code and is not retried until the agent chooses a name again.
 */
export interface NativeTitleExport {
  title: string;
  state: 'pending' | 'published' | 'failed';
}

export interface AgentSession {
  id: string;
  title: string;
  status: 'starting' | 'running' | 'completed' | 'cancelled' | 'error';
  model: string;
  /** Older saved conversations omit this and retain the coding configuration. */
  profile?: AgentProfile;
  /** Absent in older archives and in every Pi conversation; absence means `pi`. */
  harness?: AgentHarness;
  /**
   * Present only when `harness` is `claude-code`. `model` is the model for the
   * next turn (the picker may change it); `effort` is fixed at creation.
   */
  claudeCode?: ClaudeCodeConversationSettings;
  /**
   * Claude Code only, and only after Companion named the conversation: the
   * export of that name to Claude Code's own session. Absent in older
   * archives, whose titles are never exported retroactively.
   */
  nativeTitle?: NativeTitleExport;
  /** Explicit conversation choice; absence reloads the profile default each turn. */
  modelOverride?: string;
  /** Requested effort for subsequent turns; Pi adapts it to the chosen model. */
  thinkingOverride?: AgentSettings['thinking'];
  error: string;
  messages: AgentMessage[];
  /** Display-only bounded window; absence means the legacy full transcript. */
  history?: HistoryWindow;
  /** Canonical pin independent of the transcript page (body omitted). */
  pinnedMessage?: AgentMessage | null;
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

/**
 * One agent turn. `Settings` is the harness's own settings type: Pi receives
 * `AgentSettings`, Claude Code receives `ClaudeCodeSettings`.
 */
export interface AgentRunRequest<Settings = AgentSettings> {
  /** Companion conversation ID; both harnesses use it as their own session ID. */
  id: string;
  directory: string;
  settings: Settings;
  prompt: { text: string; screenshot?: Screenshot };
  /** False only for a conversation's first turn. A missing transcript then fails. */
  resume: boolean;
  /**
   * Claude Code only: the model Companion requested for this conversation's
   * previous turn (`AgentSession.model`, even if that turn failed), when the
   * user has since chosen another one. The backend announces the switch once
   * Claude Code has confirmed the new model. Pi ignores it.
   */
  previousModel?: string;
  /**
   * Claude Code only: the conversation's native name export. A `pending`
   * name is sent again once this turn's session is verified. Pi ignores it.
   */
  nativeTitle?: NativeTitleExport;
  widgets?: { endpoint: string; token: string };
  /**
   * Turn-scoped connection for the session lifecycle tools, with the optional
   * tools this listener supports (announced to Pi and the Claude bridge).
   */
  sessionTools?: { endpoint: string; token: string; capabilities?: readonly string[] };
}

export interface AgentBackend<Settings = AgentSettings> extends InspectableModule {
  /** Discover authenticated/configured models without starting a conversation. */
  models?(settings: Settings, directory: string, signal: AbortSignal): Promise<AgentModelCatalog>;
  run(
    request: AgentRunRequest<Settings>,
    signal: AbortSignal,
    emit: (message: AgentMessage) => void,
    replaceChoices?: (options: readonly AgentChoice[]) => void,
    renameSession?: (title: string) => void,
    /** Claude Code only: progress of exporting a name to the native session. */
    exportTitle?: (title: NativeTitleExport) => void,
  ): Promise<void>;
}

/**
 * The Claude Code adapter. It has no `models()`: the Claude picker uses the
 * fixed allowlist in `claude/models.ts`, not a discovery process.
 */
export type ClaudeCodeAgentBackend = AgentBackend<ClaudeCodeSettings>;

/**
 * The backends available to the session layer, selected by a conversation's
 * harness. Claude Code is optional so that tests and older wiring can supply
 * only Pi; selecting `claude-code` without a backend must then fail visibly.
 */
export interface AgentHarnessBackends {
  pi: AgentBackend;
  'claude-code'?: ClaudeCodeAgentBackend;
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

/**
 * An agent's request to show a web page in the native panel's built-in
 * browser. Only the calling conversation's own turn can make it, and the UI
 * opens the page only while that conversation is the one selected there.
 */
export interface AgentBrowserOpenRequest {
  /** The calling conversation, established by its turn lease. */
  sessionId: string;
  /** Absolute https:// URL, or http:// on a loopback host. */
  url: string;
}

/**
 * What happened, as confirmed by the panel:
 * - `loaded`, `loading` and `load-failed`: the browser now shows the address;
 *   the page finished loading, was still loading when the panel answered, or
 *   failed to load (reason says why, e.g. an invalid certificate).
 * - `superseded`: a newer navigation replaced it before it finished.
 * - `cancelled`: the page asked before leaving and the user chose to stay.
 * - `refused`, `not-selected`, `busy`, `panel-hidden`, `unsupported`:
 *   confirmed non-changes. A hidden panel is never shown for an agent, and
 *   opening a page the user cannot see is not reported as success.
 * - `offline`: no panel could receive the request.
 * - `unconfirmed`: sent, but the panel did not answer in time; it may or may
 *   not have opened the page, so the caller must not blindly retry.
 */
export interface AgentBrowserOpenOutcome {
  outcome:
    | 'loaded'
    | 'loading'
    | 'load-failed'
    | 'superseded'
    | 'cancelled'
    | 'refused'
    | 'not-selected'
    | 'busy'
    | 'panel-hidden'
    | 'unsupported'
    | 'offline'
    | 'unconfirmed';
  reason: string;
  /**
   * Address the browser shows, when it shows one (after redirects). No page
   * content, not even its title, is returned to the agent.
   */
  url?: string;
}

export type AgentBrowserHost = (
  request: AgentBrowserOpenRequest,
  signal: AbortSignal,
) => Promise<AgentBrowserOpenOutcome>;
