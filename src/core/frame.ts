import type { CaptureAdmission } from '../capture-storage/policy.ts';
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
  /**
   * Capture-storage admission of the observation. Pipeline frames always
   * carry one; an explicit history action has none, and agent sessions then
   * decide when the conversation starts. Never makes anything saveable alone.
   */
  storage?: CaptureAdmission;
}

export interface InteractionContext {
  /** Visible order and owning UI captured before ASR; never resolve numbers late. */
  readonly agentNavigation?: {
    readonly clientId: number;
    readonly token: string;
    readonly ids: readonly string[];
    readonly orderRevision: string;
    /** The owning UI can show a conversation in its own window ("pop out session N"). */
    readonly popoutHost?: boolean;
  };
  /** Empty when the panel is hidden or no agent conversation is selected. */
  readonly agentSessionId: string;
  readonly agentComposerFocused: boolean;
  /**
   * Which view supplied `agentSessionId`: the conversation just chosen by
   * voice navigation, an active pop-out window, the sidebar's visible
   * conversation, or a single pop-out beside the compact sidebar rail. For
   * logs and tests only; never sent to the model.
   */
  readonly agentTargetSource?: 'navigation' | 'popout' | 'panel' | 'popout-only' | 'browser';
  /**
   * Present only for speech a listening browser heard: the remote connection
   * whose view supplied `agentSessionId` and `agentNavigation`, and the
   * stream that heard it. Absent for the computer's microphone and typed
   * text, which follow the desktop as before (src/desktop/README.md,
   * "Speech follows the device that recorded it").
   */
  readonly agentView?: {
    readonly kind: 'browser';
    readonly clientId: number;
    readonly streamId: string;
  };
  /**
   * Local generation used to reject a target that changed while processing.
   * For a browser's speech (`agentView`) it is that connection's own view
   * revision, not the desktop's.
   */
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
