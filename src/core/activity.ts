import type { DeliveryControl } from './delivery-control.ts';
import type { InteractionContext, Screenshot } from './frame.ts';
import type { TranscriptionDiagnostic } from '../sensors/audio/transcriber.ts';
import type { TranscriptionCleanupRecord } from './transcription-cleanup/record.ts';

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
  | 'interrupted'
  // Resumed speech replaced this provisional attempt before any action.
  | 'superseded';

/** Delivery feedback describes acceptance, not eventual agent-turn completion. */
export type UtteranceDestination = 'application' | 'agent-session' | 'new-agent-session';

/** Desktop observers receive text before classification, even if capture failed. */
export interface Transcript {
  id: number;
  observedAt: number;
  utterance: string;
  application?: { address: string; app: string; title: string };
}

/** A failed recognition attempt, without a transcript or associated screenshot. */
export interface EmptyAudioClip {
  id: number;
  observedAt: number;
  samples: Float32Array;
  diagnostic: TranscriptionDiagnostic;
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
  /** Save qualified empty ASR input; return its UUID after both files are published. */
  emptyAudioCaptured?(clip: EmptyAudioClip): Promise<string>;
  /** Persist the finalized model request before transport; absent for shortcuts. */
  intentRequested?(id: number, serializedRequest: string): void;
  intentRecognized?(id: number, intent: string): void;
  /**
   * Exactly once per routed utterance: whether transcription cleanup was on
   * and, for a text route, the cleaned text or why the raw text was used.
   * Text routes report before dispatch; the raw transcript is `transcribed`.
   */
  transcriptionCleanup?(id: number, record: TranscriptionCleanupRecord): void;
  /** Explicit feedback returns the labeled utterance UUID, or no eligible target. */
  labelPrevious?(id: number, correct: boolean): string | undefined;
  outcome?(id: number, outcome: UtteranceOutcome, destination?: UtteranceDestination): void;
  /**
   * The final attempt of a continued utterance has settled; `supersededIds`
   * are the attempts it replaced, oldest first. Called once per such chain,
   * immediately before `finished(finalId)`, whatever the final outcome. Every
   * superseded attempt has already reported `finished`, except one replaced
   * while still waiting in the queue, which never reached ASR and recorded
   * nothing. The desktop uses this to keep a single record per utterance.
   */
  continuationSettled?(finalId: number, supersededIds: readonly number[]): void;
  finished?(id: number): void;
}
