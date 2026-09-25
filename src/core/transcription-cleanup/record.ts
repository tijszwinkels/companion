/**
 * What happened to transcription cleanup for one routed utterance. The router
 * reports exactly one record per routed frame (Activity.transcriptionCleanup),
 * and desktop history stores it next to the raw ASR transcript so raw and
 * cleaned text can be compared later.
 *
 * Records carry fixed reason codes only, never model output or error text.
 */
import type { InvalidReason } from '../../evals/experiments/json-cleanup/contract.ts';

/**
 * Why the raw ASR text was delivered instead of cleaned text:
 *
 * - a json-cleanup-v1 contract violation (for example `invalid-json`,
 *   `route-changed` or `text-surrounding-whitespace`);
 * - `timeout`: the explicit-shortcut cleanup call exceeded its time limit;
 * - `request-failed`: that call failed (transport, HTTP status, truncated
 *   output, reasoning or tool output).
 */
export type CleanupFallbackReason = InvalidReason | 'timeout' | 'request-failed';

export type TranscriptionCleanupRecord =
  /** The switch was off for this utterance; the raw text was used as before. */
  | { enabled: false }
  /** A text route received this cleaned text instead of the raw text. */
  | { enabled: true; status: 'cleaned'; text: string }
  /** A text route received the raw text because cleanup failed. */
  | { enabled: true; status: 'fallback'; reason: CleanupFallbackReason }
  /**
   * No text was delivered anywhere: the utterance was skipped, chose an
   * intent that takes no text (IGNORE, a choice, a label…), or detection
   * failed.
   */
  | { enabled: true; status: 'no-text' };

/** Stored cleanup statuses, as written to history. */
export type TranscriptionCleanupStatus = 'cleaned' | 'fallback' | 'no-text';
