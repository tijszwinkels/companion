import type { IntentMode, UserSensorRouter } from './router.ts';
import type { InspectableModule } from './module.ts';
import type { AgentChoiceSet } from '../agents/choices.ts';
import type { AgentConversationContext } from '../agents/conversation-context.ts';

/** A window image and the identity needed to check focus before text delivery. */
export interface Screenshot {
  /** PNG bytes; the detector and question backend encode them at their boundaries. */
  png: Buffer;

  /** Unix time in milliseconds, recorded after the capture has been checked. */
  capturedAt: number;

  window: {
    /** Hyprland's window identity. App name/title alone cannot identify a window. */
    address: string;
    app: string;
    title: string;
  };

  /** Dimensions of the resulting image, after clipping and scaling. */
  width: number;
  height: number;
}

/**
 * The message that flows from the sensors through the router to a processor.
 * Its screenshot is captured at speech end, before transcription can delay it.
 */
export interface UserSensorFrame {
  /** Session-local sequence number, also used to correlate CLI log messages. */
  id: number;

  /** Unix time in milliseconds when this observation entered the pipeline. */
  observedAt: number;

  utterance: string;
  screenshot: Screenshot;
  /** Sidebar state captured with the screenshot, before transcription/inference. */
  interaction?: InteractionContext;
}

export interface InteractionContext {
  /** Visible order and owning UI captured before ASR; never resolve numbers late. */
  readonly agentNavigation?: {
    readonly clientId: number;
    readonly token: string;
    readonly ids: readonly string[];
    readonly orderRevision: string;
  };
  /** Empty when the panel is hidden or no agent conversation is selected. */
  readonly agentSessionId: string;
  readonly agentComposerFocused: boolean;
  /** Local generation used to reject a target that changed while processing. */
  readonly revision: number;
  /** Capture choices and the running turn before ASR can outlive either one. */
  readonly agentChoices?: AgentChoiceSet;
  readonly agentRunId?: string;
  readonly agentAcceptsFollowUp?: boolean;
  readonly agentFollowUpUnavailableReason?: string;
  /** Bounded text copied at speech end; omitted from ordinary UI state reads. */
  readonly agentConversation?: AgentConversationContext;
}

/** The part of a processor's registration that the LLM needs to see. */
export interface Intent {
  name: string;
  instruction: string;
}

/** Context available both during routing and before speech, for the live UI. */
export type IntentContext = Pick<UserSensorFrame, 'interaction'>;

/** A processor can be selected by the LLM, by a spoken prefix, or by both. */
export interface UserSensorProcessor extends InspectableModule {
  name: string;

  /** Omit this for commands that must only run when explicitly requested. */
  instruction?: string;

  /**
   * Optional wording for this observation, resolved only when inference is
   * available. Requires a default instruction; never changes intent identity.
   */
  instructionForInference?(context: IntentContext): string;

  /** Optional per-frame eligibility; explicit prefixes still reach process(). */
  availableForInference?(context: IntentContext): boolean;

  /** Optional context requirement shared by prefix routing and shortcut labels. */
  availableForPrefix?(context: IntentContext): boolean;

  /** Case-insensitive command prefixes, removed before process receives a frame. */
  prefixes?: readonly string[];

  /** Standalone commands can run without dictated text after their prefix. */
  acceptsEmptyPrefix?: boolean;

  subscribe(router: UserSensorRouter): void;

  /**
   * LLM routing preserves the frame; prefix routing copies it with the remaining
   * text. The router names the route; direct callers may omit it.
   */
  process(frame: UserSensorFrame, signal: AbortSignal, route?: IntentMode): Promise<void>;
}

/** Logging is injected so the modules do not depend on terminal presentation. */
export type Log = (stage: string, detail: string, frameId?: number) => void;
