/**
 * Versioned prompt variant for the JSON intent + spoken-text cleanup experiment.
 *
 * This is NOT exact replay. The exact-replay eval (src/evals/runner.ts) sends a
 * recorded provider body with only `model` changed; this module deliberately
 * changes the prompt and the output budget, and every report says so.
 *
 * Two request builders:
 *
 * 1. Inferred routes (frozen recorded requests). `transformRecordedRequest`
 *    copies the recorded body and changes exactly three things:
 *    - In the single system message, two sentences that demand a bare intent
 *      name are replaced, and a response-format/cleanup section is appended.
 *    - `max_tokens` is replaced by the explicit experimental output budget.
 *    - `model` is replaced by the target model (done by the runner).
 *    The user message (utterance, application metadata, conversation context),
 *    the screenshot, temperature, streaming and provider flags stay unchanged.
 *    The offered intents are the recorded `Name:` lines; nothing is added.
 *
 * 2. Fixed routes (explicit shortcuts). `buildFixedRouteRequest` builds a new
 *    cleanup-only request from a user-supplied fixture. The route is fixed by
 *    the shortcut and the model may only echo it. Application-aware formatting,
 *    the screenshot and application metadata are used only for
 *    SEND_TEXT_TO_APPLICATION, the one route for which the user approved it.
 *
 * The json-cleanup-v1 wording (cleanup and SEND formatting instructions, the
 * v1 response section and the fixed-route prompt) is shared with the live app
 * and lives in src/core/transcription-cleanup/prompt.ts. Any wording change
 * must bump VARIANT_ID.
 */
import { createHash } from 'node:crypto';

import { recordedIntents } from '../../dataset.ts';
import { SafeEvalError } from '../../errors.ts';
import type { IntentRequestRecord } from '../../../core/intent-request.ts';
import { isTextRoute, SHORTCUT_ONLY_ROUTES, TEXT_ROUTES, type TextRoute } from './contract.ts';
import {
  CLEANUP_INSTRUCTION,
  CLEANUP_PROMPT_VARIANT,
  cleanupResponseSection,
  fixedRouteSystemPrompt,
  RECORDED_ANSWER_SENTENCE,
  RECORDED_IGNORE_SENTENCE,
  SEND_FORMATTING_INSTRUCTION,
  VARIANT_ANSWER_SENTENCE,
  VARIANT_IGNORE_SENTENCE,
} from '../../../core/transcription-cleanup/prompt.ts';

// The json-cleanup-v1 wording is shared with the live app and lives in
// src/core/transcription-cleanup/prompt.ts. Re-exported here unchanged so the
// experiment's modules and tests keep one import location.
export {
  CLEANUP_INSTRUCTION,
  fixedRouteSystemPrompt,
  RECORDED_ANSWER_SENTENCE,
  RECORDED_IGNORE_SENTENCE,
  SEND_FORMATTING_INSTRUCTION,
  VARIANT_ANSWER_SENTENCE,
  VARIANT_IGNORE_SENTENCE,
};

/** Changes to any instruction text, transformation or contract require a new ID. */
export const VARIANT_ID = CLEANUP_PROMPT_VARIANT;

/** Bounds for the explicit experimental output budget, in tokens. */
export const MIN_OUTPUT_TOKENS = 64;
export const MAX_OUTPUT_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Instruction text
// ---------------------------------------------------------------------------

/** The json-cleanup-v1 section appended to recorded prompts; shared with the live app. */
function inferredResponseSection(textIntents: readonly string[]): string {
  return cleanupResponseSection(textIntents);
}

/**
 * Fingerprint of every instruction template and the variant ID. Reports carry
 * it so two runs can be checked for identical prompt wording without copying
 * the prompt (or any private data) into the report.
 */
export function promptFingerprint(): string {
  const templates = {
    variant: VARIANT_ID,
    replacements: [
      [RECORDED_ANSWER_SENTENCE, VARIANT_ANSWER_SENTENCE],
      [RECORDED_IGNORE_SENTENCE, VARIANT_IGNORE_SENTENCE],
    ],
    inferredAllTextRoutes: inferredResponseSection([
      'SEND_TEXT_TO_APPLICATION',
      'START_CODING_AGENT_SESSION',
      'CONTINUE_OPEN_AGENT_CONVERSATION',
    ]),
    fixedRoutes: TEXT_ROUTES.map((route) => fixedRouteSystemPrompt(route)),
  };
  return createHash('sha256').update(JSON.stringify(templates)).digest('hex');
}

// ---------------------------------------------------------------------------
// Inferred routes: transformation of a recorded request
// ---------------------------------------------------------------------------

/** Fixed reasons why a recorded request cannot be used for this variant. */
export const UNSUPPORTED_REASONS = [
  'recorded-prompt-not-single-system-message',
  'recorded-prompt-template-mismatch',
  'recorded-prompt-offers-shortcut-only-intent',
  'recorded-output-limit-missing',
] as const;

export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

/** A recorded example this variant refuses to transform; never sent. */
export class UnsupportedExampleError extends SafeEvalError {
  constructor(readonly reason: UnsupportedReason) {
    super(`Unsupported for ${VARIANT_ID}: ${reason}`);
  }
}

export interface TransformedRequest {
  /** New body; the recorded record is never mutated. `model` is still the recorded one. */
  body: Record<string, unknown>;
  /** Recorded `Name:` lines, unchanged: the captured classifier eligibility. */
  allowedIntents: string[];
  /** The subset of allowed intents that carries cleaned-up text. */
  textIntents: string[];
  /** The recorded output limit, reported next to the experimental budget. */
  recordedOutputTokens: number;
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

export function validateOutputTokens(outputTokens: number): void {
  if (
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < MIN_OUTPUT_TOKENS ||
    outputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw new SafeEvalError(
      `Output token budget must be an integer from ${MIN_OUTPUT_TOKENS} to ${MAX_OUTPUT_TOKENS}`,
    );
  }
}

/**
 * Apply the variant to a restored recorded request.
 *
 * Refuses (UnsupportedExampleError) instead of guessing when the recording does
 * not have exactly the expected template sentences: an older or edited prompt is
 * never rewritten into something the recording did not contain, and a missing
 * request is never reconstructed from today's instructions.
 */
export function transformRecordedRequest(
  record: IntentRequestRecord,
  outputTokens: number,
): TransformedRequest {
  validateOutputTokens(outputTokens);

  const messages = record.body.messages;
  if (!Array.isArray(messages)) {
    throw new UnsupportedExampleError('recorded-prompt-not-single-system-message');
  }

  const systemIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as { role?: unknown } | null;
    if (message && message.role === 'system') {
      systemIndexes.push(index);
    }
  }
  if (systemIndexes.length !== 1) {
    throw new UnsupportedExampleError('recorded-prompt-not-single-system-message');
  }

  const systemIndex = systemIndexes[0]!;
  const systemMessage = messages[systemIndex] as Record<string, unknown>;
  const recordedPrompt = systemMessage.content;
  if (typeof recordedPrompt !== 'string') {
    throw new UnsupportedExampleError('recorded-prompt-not-single-system-message');
  }

  if (
    countOccurrences(recordedPrompt, RECORDED_ANSWER_SENTENCE) !== 1 ||
    countOccurrences(recordedPrompt, RECORDED_IGNORE_SENTENCE) !== 1
  ) {
    throw new UnsupportedExampleError('recorded-prompt-template-mismatch');
  }

  // Eligibility is exactly what the live router offered at capture time.
  const allowedIntents = recordedIntents(record);
  if (allowedIntents.some((name) => SHORTCUT_ONLY_ROUTES.has(name))) {
    throw new UnsupportedExampleError('recorded-prompt-offers-shortcut-only-intent');
  }
  const textIntents = allowedIntents.filter((name) => isTextRoute(name));

  const recordedOutputTokens = record.body.max_tokens;
  if (
    typeof recordedOutputTokens !== 'number' ||
    !Number.isSafeInteger(recordedOutputTokens) ||
    'max_completion_tokens' in record.body
  ) {
    throw new UnsupportedExampleError('recorded-output-limit-missing');
  }

  const variantPrompt =
    recordedPrompt
      .replace(RECORDED_ANSWER_SENTENCE, VARIANT_ANSWER_SENTENCE)
      .replace(RECORDED_IGNORE_SENTENCE, VARIANT_IGNORE_SENTENCE) +
    '\n' +
    inferredResponseSection(textIntents);

  // Shallow copies along the changed path only. The other messages, including
  // the user message with its screenshot, are shared by reference, unchanged.
  const variantMessages = [...messages];
  variantMessages[systemIndex] = { ...systemMessage, content: variantPrompt };

  const body: Record<string, unknown> = {
    ...record.body,
    messages: variantMessages,
    max_tokens: outputTokens,
  };

  return { body, allowedIntents, textIntents, recordedOutputTokens };
}

// ---------------------------------------------------------------------------
// Fixed routes: new cleanup-only request from an explicit fixture
// ---------------------------------------------------------------------------

/** Explicit, allowlisted request settings for fixed-route fixtures. */
export interface FixedRouteRequestSettings {
  stream: boolean;
  temperature: number;
  /**
   * Adds `chat_template_kwargs: {enable_thinking: false}`, the flag the live
   * detector's Qwen-style template sends. Only set it for servers that accept it.
   */
  disableThinking: boolean;
}

export interface FixedRouteInput {
  route: TextRoute;
  text: string;
  /** Captured application metadata; only for SEND_TEXT_TO_APPLICATION. */
  application: Record<string, unknown> | null;
  /** Screenshot PNG; required for SEND_TEXT_TO_APPLICATION, absent otherwise. */
  screenshot: Buffer | null;
}

/** Build the request body (still without a target model) for one fixed-route example. */
export function buildFixedRouteRequest(
  input: FixedRouteInput,
  settings: FixedRouteRequestSettings,
  outputTokens: number,
): Record<string, unknown> {
  validateOutputTokens(outputTokens);

  const withContext = input.route === 'SEND_TEXT_TO_APPLICATION';
  if (withContext !== (input.screenshot !== null)) {
    throw new SafeEvalError('Only SEND_TEXT_TO_APPLICATION fixtures carry a screenshot');
  }
  if (!withContext && input.application !== null) {
    throw new SafeEvalError('Only SEND_TEXT_TO_APPLICATION fixtures carry application metadata');
  }

  const userData: Record<string, unknown> = { utterance: input.text };
  if (withContext && input.application !== null) {
    userData.application = input.application;
  }

  const content: unknown[] = [{ type: 'text', text: JSON.stringify(userData) }];
  if (input.screenshot !== null) {
    content.push({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,' + input.screenshot.toString('base64') },
    });
  }

  const body: Record<string, unknown> = {
    model: null,
    messages: [
      { role: 'system', content: fixedRouteSystemPrompt(input.route) },
      { role: 'user', content },
    ],
    temperature: settings.temperature,
    max_tokens: outputTokens,
    stream: settings.stream,
  };
  if (settings.disableThinking) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  return body;
}
