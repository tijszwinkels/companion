import type { DeliveryControl } from './delivery-control.ts';
import type { InteractionContext, Screenshot } from './frame.ts';

/** Results describe actual delivery, rather than just the model's chosen intent. */
export type UtteranceOutcome =
  | 'sent'
  | 'started'
  | 'labeled'
  | 'closed'
  | 'selected'
  | 'ignored'
  | 'skipped'
  | 'preview'
  | 'error'
  | 'cancelled'
  | 'interrupted';

/** Delivery feedback describes acceptance, not eventual agent-turn completion. */
export type UtteranceDestination = 'application' | 'agent-session' | 'new-agent-session';

/** Desktop observers receive text before classification, even if capture failed. */
export interface Transcript {
  id: number;
  observedAt: number;
  utterance: string;
  application?: { address: string; app: string; title: string };
}

/** Optional feedback keeps the sensor pipeline independent of desktop services. */
export interface Activity {
  /** Copy interaction state and bounded conversation text at speech end. */
  interactionContext?(): InteractionContext;
  /** Recheck that the captured target still represents the same interaction. */
  interactionCurrent?(context: InteractionContext): boolean;
  /** Select a captured visible conversation only while its UI/order are current. */
  selectSession?(context: InteractionContext, index: number): boolean;

  /** Live VAD state, independent of work already queued for transcription. */
  speechChanged?(speaking: boolean): void;

  /** Shared output ownership keeps explicit recovery and automatic sends atomic. */
  delivery?: DeliveryControl;
  /** An explicit manual recovery may supersede a still-pending automatic send. */
  deliveryAllowed?(id: number): boolean;
  deliveryStarted?(id: number): void;
  processing?(id: number): void;
  transcribed?(transcript: Transcript): void;
  /** Persist the captured input before routing; shutdown waits for this write. */
  screenshotCaptured?(id: number, screenshot: Screenshot): Promise<void>;
  /** Persist the ASR input before the pipeline clears its owned sample buffer. */
  audioCaptured?(id: number, samples: Float32Array): Promise<void>;
  /** Persist the finalized model request before transport; absent for shortcuts. */
  intentRequested?(id: number, serializedRequest: string): void;
  intentRecognized?(id: number, intent: string): void;
  /** Explicit feedback returns the labeled utterance UUID, or no eligible target. */
  labelPrevious?(id: number, correct: boolean): string | undefined;
  outcome?(id: number, outcome: UtteranceOutcome, destination?: UtteranceDestination): void;
  finished?(id: number): void;
}
