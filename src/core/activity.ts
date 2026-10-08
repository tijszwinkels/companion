import type { CaptureAdmission } from '../capture-storage/policy.ts';
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

/**
 * Where a record's text came from when it is not this attempt's own ASR result.
 * `earlier-attempt`: the latest usable text of an earlier attempt of the same
 * spoken utterance, stored beside the combined audio; the final part of the
 * speech may be missing from it. `audio-only`: a continued utterance whose
 * final ASR failed and none of whose parts yielded usable text; the record has
 * the combined audio and an empty transcript, never invented words. Absent
 * means unspecified, not proof that the whole recording was transcribed.
 */
export type TranscriptSource = 'earlier-attempt' | 'audio-only';

/** Desktop observers receive text before classification, even if capture failed. */
export interface Transcript {
  id: number;
  observedAt: number;
  utterance: string;
  application?: { address: string; app: string; title: string };
  source?: TranscriptSource;
  /** Spoken (has audio) or typed Activity text (never has audio). */
  input?: 'speech' | 'typed';
  /**
   * Whether this observation's audio/screenshot may be archived (see
   * CaptureStoragePolicy). Absent means not admitted: nothing is saved.
   */
  storage?: CaptureAdmission;
}

/** A failed recognition attempt, without a transcript or associated screenshot. */
export interface EmptyAudioClip {
  id: number;
  observedAt: number;
  samples: Float32Array;
  diagnostic: TranscriptionDiagnostic;
  /** The attempt's capture-storage admission; absent means not admitted. */
  storage?: CaptureAdmission;
}

/** What a spoken "label previous" command did; skipped labels write nothing. */
export type LabelPreviousResult =
  { outcome: 'labeled'; id: string } | { outcome: 'skipped'; reason: string };

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
  /**
   * Decide whether a capture that began `capturedForMs` ago may be archived.
   * Called once per observation when it is admitted to the queue; a
   * continuation keeps the admission of the attempt that started it.
   */
  admitCapture?(capturedForMs: number): CaptureAdmission;
  /**
   * Persist the captured input before routing, if its admission allows it
   * (see `Transcript.storage`); shutdown waits for this write. Resolves
   * without writing when storage is off; rejects only on a real failure.
   */
  screenshotCaptured?(id: number, screenshot: Screenshot): Promise<void>;
  /** Persist the ASR input before the pipeline clears its owned sample buffer. */
  audioCaptured?(id: number, samples: Float32Array): Promise<void>;
  /**
   * Save qualified empty ASR input; return its UUID after both files are
   * published, or undefined when capture storage did not allow saving it.
   */
  emptyAudioCaptured?(clip: EmptyAudioClip): Promise<string | undefined>;
  /** Persist the finalized model request before transport; absent for shortcuts. */
  intentRequested?(id: number, serializedRequest: string): void;
  intentRecognized?(id: number, intent: string): void;
  /**
   * Exactly once per routed utterance: whether transcription cleanup was on
   * and, for a text route, the cleaned text or why the raw text was used.
   * Text routes report before dispatch; the raw transcript is `transcribed`.
   */
  transcriptionCleanup?(id: number, record: TranscriptionCleanupRecord): void;
  /**
   * Explicit spoken feedback on the preceding utterance. Skipped when there
   * is no eligible target, or when labeling is unavailable because capture
   * storage is off (see docs/capture-storage.md); a skip writes nothing.
   */
  labelPrevious?(id: number, correct: boolean): Promise<LabelPreviousResult>;
  outcome?(id: number, outcome: UtteranceOutcome, destination?: UtteranceDestination): void;
  /**
   * A provisional attempt was replaced by a continuation (it will report the
   * outcome `superseded`). Called once, at supersession, before its successor
   * is admitted. Only attempts named here belong to a continuation chain.
   */
  attemptSuperseded?(id: number): void;
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
