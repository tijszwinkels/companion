import type { WidgetAttachment } from '../widgets/types.ts';
import type { Screenshot } from '../core/frame.ts';
import type { InspectableModule } from '../core/module.ts';
import type { AgentChoice, AgentChoiceSet } from './choices.ts';

/** Portable chat data. Provider events and subprocess details stay in the backend. */
export interface AgentMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  toolName: string;
  input: string;
  state: 'queued' | 'running' | 'done' | 'error';
  screenshot: boolean;
  /** Local, private PNG attachment; omitted while saving or on older messages. */
  screenshotUrl?: string;
  /** Validated reference; its private view URL is regenerated when reopening. */
  widget?: WidgetAttachment;
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
  error: string;
  messages: AgentMessage[];
  updatedAt: number;
  /** Live affordances are deliberately not restored from saved transcripts. */
  choices?: AgentChoiceSet;
  runId?: string;
  acceptsFollowUp?: boolean;
  /** Latest successful turn in this process; snapshots recover missed UI updates. */
  completedTurnId?: string;
}

export type PreviousSession = Omit<AgentSession, 'messages'>;

/** Updates contain changed messages only; a reconnect snapshot contains them all. */
export type SessionEvent =
  | { type: 'agent-session'; session: AgentSession }
  | { type: 'agent-removed'; id: string }
  | { type: 'agent-restored'; session: AgentSession }
  | { type: 'agent-turn-completed'; id: string; turnId: string }
  | { type: 'agent-history'; sessions: PreviousSession[] };

export interface AgentSettings {
  executable: string;
  model: string;
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface AgentBackend extends InspectableModule {
  run(
    request: {
      id: string;
      directory: string;
      settings: AgentSettings;
      prompt: { text: string; screenshot?: Screenshot };
      resume: boolean;
      widgets?: { endpoint: string; token: string };
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
