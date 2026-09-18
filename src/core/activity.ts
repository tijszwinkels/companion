import type { DeliveryControl } from './delivery-control.ts';
import type { InteractionContext } from './frame.ts';

/** Results describe actual delivery, rather than just the model's chosen intent. */
export type UtteranceOutcome =
  'sent' | 'started' | 'ignored' | 'skipped' | 'preview' | 'error' | 'cancelled' | 'interrupted';

/** Desktop observers receive text before classification, even if capture failed. */
export interface Transcript {
  id: number;
  observedAt: number;
  utterance: string;
  application?: { address: string; app: string; title: string };
}

/** Optional feedback keeps the sensor pipeline independent of desktop services. */
export interface Activity {
  /** Snapshot interaction state at speech end, alongside screen capture. */
  interactionContext?(): InteractionContext;
  /** Recheck that the captured target still represents the same interaction. */
  interactionCurrent?(context: InteractionContext): boolean;

  /** Live VAD state, independent of work already queued for transcription. */
  speechChanged?(speaking: boolean): void;

  /** Shared output ownership keeps explicit recovery and automatic sends atomic. */
  delivery?: DeliveryControl;
  /** An explicit manual recovery may supersede a still-pending automatic send. */
  deliveryAllowed?(id: number): boolean;
  deliveryStarted?(id: number): void;
  processing?(id: number): void;
  transcribed?(transcript: Transcript): void;
  intentRecognized?(id: number, intent: string): void;
  outcome?(id: number, outcome: UtteranceOutcome): void;
  finished?(id: number): void;
}
