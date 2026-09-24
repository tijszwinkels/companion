/**
 * Response contract for the offline JSON intent + spoken-text cleanup experiment.
 *
 * Input: the model's complete response text (already decoded from the wire by
 * the shared eval transport) and the expectation for that example: which intent
 * names were offered, which of them carry text, and, for explicit shortcuts, the
 * route that is already fixed.
 *
 * Output: either a valid `{ intent, text }` pair or a fixed invalid-reason code.
 *
 * The contract is a minimal discriminated shape. Every response is one JSON
 * object with exactly two keys:
 *
 *   {"intent":"CONTINUE_OPEN_AGENT_CONVERSATION","parameters":{"text":"Cleaned-up text."}}
 *   {"intent":"IGNORE","parameters":{}}
 *
 * The intent name is the discriminant. Text routes require `parameters` to be
 * exactly `{"text": <nonempty string>}`. Every other intent (IGNORE, choices,
 * labels, closing a session and so on) requires exactly `{}`: no text is
 * fabricated for an action that does not take any.
 *
 * Invalid reasons are fixed codes. They never quote the response, because model
 * output can echo private dictation, context or screenshot text.
 *
 * This module is pure: it has no I/O and imports no router, processor or
 * delivery code. Nothing here executes an action.
 */

/** The five routes whose action consumes spoken text. */
export const TEXT_ROUTES = [
  'SEND_TEXT_TO_APPLICATION',
  'START_CODING_AGENT_SESSION',
  'CONTINUE_OPEN_AGENT_CONVERSATION',
  'QUICK_QUESTION',
  'ENTER_TEXT_TO_APPLICATION',
] as const;

export type TextRoute = (typeof TEXT_ROUTES)[number];

/**
 * Routes that exist only as explicit voice shortcuts. The live router never
 * offers them to the classifier (in particular, inference must never be able
 * to press Enter), so the experiment never adds them to classifier eligibility
 * either. A recorded prompt that lists one is refused as unsupported.
 */
export const SHORTCUT_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'QUICK_QUESTION',
  'ENTER_TEXT_TO_APPLICATION',
]);

export function isTextRoute(name: string): name is TextRoute {
  return (TEXT_ROUTES as readonly string[]).includes(name);
}

/** What a valid response to one particular example must look like. */
export interface ResponseExpectation {
  /** Intent names the model may answer with, in prompt order. */
  allowedIntents: readonly string[];
  /** When set, the route was fixed by an explicit shortcut and must be echoed unchanged. */
  fixedRoute: TextRoute | null;
}

/** Fixed, content-free reasons why a response does not satisfy the contract. */
export const INVALID_REASONS = [
  'invalid-json',
  'duplicate-key',
  'not-an-object',
  'unexpected-top-level-key',
  'intent-not-a-string',
  'unknown-intent',
  'route-changed',
  'parameters-missing',
  'parameters-not-an-object',
  'unexpected-parameter',
  'text-missing',
  'text-not-a-string',
  'text-empty',
  'text-surrounding-whitespace',
  'text-on-no-text-intent',
] as const;

export type InvalidReason = (typeof INVALID_REASONS)[number];

export type ParsedResponse =
  | {
      valid: true;
      intent: string;
      /** Cleaned-up text for a text route; null for an intent without text. */
      text: string | null;
    }
  | {
      valid: false;
      reason: InvalidReason;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason: InvalidReason): ParsedResponse {
  return { valid: false, reason };
}

/**
 * Report whether any JSON object in already-validated JSON text repeats a key.
 *
 * `JSON.parse` silently keeps the last duplicate, so a response such as
 * `{"intent":"IGNORE","intent":"SEND_TEXT_TO_APPLICATION",…}` would otherwise be
 * accepted with an ambiguous meaning. The caller must only pass text that
 * `JSON.parse` accepted, so this scanner can assume well-formed input.
 */
export function hasDuplicateKey(json: string): boolean {
  // One entry per open container. Arrays have no keys; objects track the keys
  // seen so far and whether the next string at this level is a key.
  const containers: (
    { kind: 'array' } | { kind: 'object'; keys: Set<string>; expectKey: boolean }
  )[] = [];

  let index = 0;
  while (index < json.length) {
    const character = json[index]!;

    if (character === '"') {
      // Find the closing quote, skipping escaped characters.
      let end = index + 1;
      while (json[end] !== '"') {
        if (json[end] === '\\') {
          end += 2;
        } else {
          end += 1;
        }
      }

      const top = containers.at(-1);
      if (top?.kind === 'object' && top.expectKey) {
        // Decode escapes so "a" and "\u0061" count as the same key.
        const key = JSON.parse(json.slice(index, end + 1)) as string;
        if (top.keys.has(key)) {
          return true;
        }
        top.keys.add(key);
        top.expectKey = false;
      }

      index = end + 1;
      continue;
    }

    if (character === '{') {
      containers.push({ kind: 'object', keys: new Set(), expectKey: true });
    } else if (character === '[') {
      containers.push({ kind: 'array' });
    } else if (character === '}' || character === ']') {
      containers.pop();
    } else if (character === ',') {
      const top = containers.at(-1);
      if (top?.kind === 'object') {
        top.expectKey = true;
      }
    }

    index += 1;
  }

  return false;
}

/**
 * Validate one complete model response against the experiment contract.
 *
 * Strictness is deliberate: no code fences, no surrounding prose, no extra keys,
 * no type coercion and no guessing. An experiment that silently repaired output
 * would overstate how usable the format is for a later live integration.
 */
export function parseExperimentResponse(
  responseText: string,
  expectation: ResponseExpectation,
): ParsedResponse {
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    return invalid('invalid-json');
  }

  if (!isPlainObject(value)) {
    return invalid('not-an-object');
  }
  if (hasDuplicateKey(responseText)) {
    return invalid('duplicate-key');
  }

  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.some((key) => key !== 'intent' && key !== 'parameters')) {
    return invalid('unexpected-top-level-key');
  }

  const intent = value.intent;
  if (typeof intent !== 'string') {
    return invalid('intent-not-a-string');
  }

  // Check the fixed route first: for a shortcut, answering with any other name,
  // even an otherwise registered one, is a route change and never allowed.
  if (expectation.fixedRoute !== null && intent !== expectation.fixedRoute) {
    return invalid('route-changed');
  }
  if (!expectation.allowedIntents.includes(intent)) {
    return invalid('unknown-intent');
  }

  if (!('parameters' in value)) {
    return invalid('parameters-missing');
  }
  const parameters = value.parameters;
  if (!isPlainObject(parameters)) {
    return invalid('parameters-not-an-object');
  }
  const parameterKeys = Object.keys(parameters);

  // No-text intents have exactly one valid shape: an empty parameters object.
  if (!isTextRoute(intent)) {
    if (parameterKeys.includes('text')) {
      return invalid('text-on-no-text-intent');
    }
    if (parameterKeys.length > 0) {
      return invalid('unexpected-parameter');
    }
    return { valid: true, intent, text: null };
  }

  if (parameterKeys.some((key) => key !== 'text')) {
    return invalid('unexpected-parameter');
  }
  if (!('text' in parameters)) {
    return invalid('text-missing');
  }

  const text = parameters.text;
  if (typeof text !== 'string') {
    return invalid('text-not-a-string');
  }
  if (text.trim() === '') {
    return invalid('text-empty');
  }

  // Leading/trailing whitespace is refused rather than trimmed. A trailing line
  // break typed into a chat field can submit the message, which would be an
  // action the user never asked for.
  if (text !== text.trim()) {
    return invalid('text-surrounding-whitespace');
  }

  return { valid: true, intent, text };
}

/**
 * Diagnostic only: the intent a response selects, judged independently of the
 * rest of the contract.
 *
 * Returns the intent when the response is syntactically valid JSON (as
 * received, without trimming), a single object with no duplicate key anywhere,
 * and has an `intent` string that is an allowed name. Otherwise returns null.
 *
 * This never repairs or promotes a response: an invalid response stays
 * invalid, and it keeps counting as wrong in the primary (usable) score. It
 * only lets reports separate "the model picked a different intent" from "the
 * model picked the right intent but broke the parameters contract". Malformed
 * JSON, duplicate keys, unknown or non-string names never get a guessed intent.
 */
export function diagnosticIntentSelection(
  responseText: string,
  expectation: ResponseExpectation,
): string | null {
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    return null;
  }

  if (!isPlainObject(value) || hasDuplicateKey(responseText)) {
    return null;
  }

  const intent = value.intent;
  if (typeof intent !== 'string' || !expectation.allowedIntents.includes(intent)) {
    return null;
  }
  return intent;
}
