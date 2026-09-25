/**
 * Strict interpretation of json-cleanup-v1 responses for the live app.
 *
 * Input: a model's complete response text, exactly as received (not trimmed),
 * plus what the request offered. Output: a small decision the router can act
 * on without ever repairing the response.
 *
 * Validation is the offline experiment's parser, unchanged
 * (`parseExperimentResponse` in ./contract.ts, shared with the experiment;
 * a pure module without imports or I/O), used with the plain json-cleanup-v1
 * contract: no percentages and no optional text. So the live app accepts
 * exactly the responses the eval counted as valid: one bare JSON object, exact
 * keys, no duplicate keys, an offered intent, and for a text route a nonempty
 * `text` without leading or trailing whitespace (a trailing line break could
 * otherwise submit a chat message).
 *
 * This module decides only what a response means. It never quotes the
 * response in a result or error, because model output can echo private
 * dictation or screenshot text; results carry fixed reason codes.
 */
import {
  isTextRoute,
  parseExperimentResponse,
  type InvalidReason,
  type TextRoute,
} from './contract.ts';

/**
 * Invalid reasons that concern only `parameters.text` of a text route. The
 * parser checks them last, after the whole object, the intent and the
 * parameter keys were valid, so the chosen intent itself is trustworthy.
 */
const TEXT_ONLY_REASONS: ReadonlySet<InvalidReason> = new Set<InvalidReason>([
  'text-missing',
  'text-not-a-string',
  'text-empty',
  'text-surrounding-whitespace',
]);

/** What an inferred-route (intent + cleanup) response means for routing. */
export type InferredCleanupDecision =
  | {
      /** Fully valid. `text` is the cleaned text for a text route, else null. */
      kind: 'valid';
      intent: string;
      text: string | null;
    }
  | {
      /**
       * A valid object with an offered text route, but its text broke the
       * contract. Route to that intent with the raw ASR text; never use any
       * part of the invalid text.
       */
      kind: 'raw-text';
      intent: string;
      reason: InvalidReason;
    }
  | {
      /**
       * No usable intent: malformed JSON, duplicate or unexpected keys, an
       * unknown intent, wrong parameters, or text on an intent without text.
       * The router treats this exactly like today's detection failure.
       */
      kind: 'no-intent';
      reason: InvalidReason;
    };

/**
 * Interpret one inferred-route response. `offeredIntents` are exactly the
 * names in the prompt (permanent and contextual), so an answer can never
 * select a route that was not offered, such as the shortcut-only Enter route.
 */
export function interpretInferredResponse(
  responseText: string,
  offeredIntents: readonly string[],
): InferredCleanupDecision {
  const parsed = parseExperimentResponse(responseText, {
    allowedIntents: offeredIntents,
    fixedRoute: null,
  });

  if (parsed.valid) {
    return { kind: 'valid', intent: parsed.intent, text: parsed.text };
  }

  if (TEXT_ONLY_REASONS.has(parsed.reason)) {
    // Text-only reasons are reached only after the intent passed every other
    // check, so this re-read cannot fail. Stay defensive anyway: a result we
    // cannot confirm becomes a detection failure rather than a guess.
    const object = JSON.parse(responseText) as { intent?: unknown };
    const intent = object.intent;
    if (typeof intent === 'string' && offeredIntents.includes(intent) && isTextRoute(intent)) {
      return { kind: 'raw-text', intent, reason: parsed.reason };
    }
  }

  return { kind: 'no-intent', reason: parsed.reason };
}

/** What a fixed-route (explicit shortcut) cleanup response means. */
export type FixedRouteCleanupDecision =
  { kind: 'cleaned'; text: string } | { kind: 'raw-text'; reason: InvalidReason };

/**
 * Interpret one explicit-shortcut cleanup response. Any answer that does not
 * echo the fixed route exactly (`route-changed`), or breaks the contract in
 * any other way, keeps the raw ASR text. The route itself never changes: the
 * caller already chose the processor, and this result carries only text.
 */
export function interpretFixedRouteResponse(
  responseText: string,
  route: TextRoute,
): FixedRouteCleanupDecision {
  const parsed = parseExperimentResponse(responseText, {
    allowedIntents: [route],
    fixedRoute: route,
  });

  if (!parsed.valid) {
    return { kind: 'raw-text', reason: parsed.reason };
  }

  // A valid fixed-route answer is always this route with nonempty text.
  if (parsed.intent !== route || parsed.text === null) {
    throw Error('A valid fixed-route cleanup response must carry text for its route');
  }

  return { kind: 'cleaned', text: parsed.text };
}
