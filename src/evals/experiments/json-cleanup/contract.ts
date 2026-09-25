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
 * Percentages contract (variant json-cleanup-percentages-v1, inferred only):
 * the same object with a third key, "percentages", holding one SELF-REPORTED
 * integer percentage per offered intent:
 *
 *   {"intent":"IGNORE","parameters":{},"percentages":{"IGNORE":70,"SEND_TEXT_TO_APPLICATION":30}}
 *
 * Rules (see `validatePercentages`): exactly the offered intent names as keys
 * (order is not significant), every value an unsigned integer literal from 0
 * to 100 as written in the raw response (no decimals, signs, exponents or
 * leading zeros), a total of exactly 100, and the chosen intent must have the
 * highest value (ties allowed and flagged). Nothing is rounded, normalized or
 * repaired. These are the model's own estimates, not calibrated probabilities
 * or token log-probabilities.
 *
 * Optional-text contract (variant json-cleanup-percentages-optional-text-v1,
 * inferred only): the percentages contract, except that a TEXT ROUTE may also
 * answer with `"parameters": {}`, meaning "the transcript needs no change".
 * Only a missing `text` key counts as omission. `null`, `""`, whitespace-only,
 * surrounding whitespace, wrong types and extra parameter keys stay invalid
 * with their usual reasons. The deterministic fallback for an omitted text
 * (the recorded transcript, byte for byte) is `resolveEffectiveText`; this
 * module never invents or repairs text. Intents without text are unchanged:
 * `parameters` must be exactly `{}`.
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
  /**
   * True for the percentages contract (inferred only): the response must also
   * carry per-intent percentages. Absent or false is the unchanged v1 contract.
   */
  percentages?: boolean;
  /**
   * True for the optional-text contract (inferred only, always together with
   * `percentages`): a text route may omit `parameters.text` to keep the
   * recorded transcript unchanged. Absent or false: text routes require text.
   */
  optionalText?: boolean;
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
  // Percentages contract only; checked after everything above passed.
  'percentages-missing',
  'percentages-not-an-object',
  'percentages-keys-mismatch',
  'percentage-not-a-number',
  'percentage-not-integer-literal',
  'percentage-out-of-range',
  'percentages-sum-not-100',
  'chosen-intent-not-highest',
] as const;

export type InvalidReason = (typeof INVALID_REASONS)[number];

/** Reasons that only the percentages contract can produce. */
export const PERCENTAGE_REASONS: ReadonlySet<InvalidReason> = new Set<InvalidReason>([
  'percentages-missing',
  'percentages-not-an-object',
  'percentages-keys-mismatch',
  'percentage-not-a-number',
  'percentage-not-integer-literal',
  'percentage-out-of-range',
  'percentages-sum-not-100',
  'chosen-intent-not-highest',
]);

export type ParsedResponse =
  | {
      valid: true;
      intent: string;
      /**
       * Cleaned-up text for a text route; null for an intent without text, and
       * null for a text route that omitted its text (see `textOmitted`).
       */
      text: string | null;
      /**
       * Optional-text contract only: true when a text route answered with
       * `parameters: {}`, false otherwise. The caller then uses the recorded
       * transcript unchanged (`resolveEffectiveText`).
       */
      textOmitted?: boolean;
      /** Percentages contract only: the validated self-reported distribution. */
      percentages?: Readonly<Record<string, number>>;
      /** Percentages contract only: another intent shares the chosen intent's value. */
      chosenTied?: boolean;
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

  const allowedTopLevelKeys = expectation.percentages
    ? ['intent', 'parameters', 'percentages']
    : ['intent', 'parameters'];
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.some((key) => !allowedTopLevelKeys.includes(key))) {
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
    return withPercentages(value, responseText, expectation, intent, null, false);
  }

  if (parameterKeys.some((key) => key !== 'text')) {
    return invalid('unexpected-parameter');
  }
  if (!('text' in parameters)) {
    // Only the optional-text contract accepts a text route without text, and
    // only as exactly `{}` (other keys were refused just above). Every other
    // contract keeps requiring text.
    if (expectation.optionalText) {
      return withPercentages(value, responseText, expectation, intent, null, true);
    }
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

  return withPercentages(value, responseText, expectation, intent, text, false);
}

/**
 * Finish a response that satisfied the v1 contract (or, for the optional-text
 * contract, its parameters rules). For v1 this returns the unchanged
 * `{ valid, intent, text }` result; for the percentages contract it
 * additionally requires valid percentages. Only optional-text results carry
 * `textOmitted`, so the other contracts keep their exact result shape.
 */
function withPercentages(
  value: Record<string, unknown>,
  responseText: string,
  expectation: ResponseExpectation,
  intent: string,
  text: string | null,
  textOmitted: boolean,
): ParsedResponse {
  const omission = expectation.optionalText ? { textOmitted } : {};

  if (!expectation.percentages) {
    return { valid: true, intent, text, ...omission };
  }

  const checked = validatePercentages(value, responseText, expectation, intent);
  if (!checked.valid) {
    return invalid(checked.reason);
  }
  return {
    valid: true,
    intent,
    text,
    ...omission,
    percentages: checked.percentages,
    chosenTied: checked.chosenTied,
  };
}

/** Where the effective text of a valid response comes from. */
export type TextSource = 'model' | 'transcript';

export const TEXT_SOURCES: readonly TextSource[] = ['model', 'transcript'];

/**
 * The text a later action would use for a VALID response, with the only
 * fallback this experiment has. Pure and deterministic:
 *
 * - An intent without text: no text (`{ text: null, source: null }`).
 * - A text route with model text: that text, exactly as returned.
 * - A text route that omitted its text (optional-text contract only): the
 *   recorded transcript, byte for byte. Nothing is trimmed, normalized or
 *   cleaned, so the result is exactly what was recorded.
 *
 * The fallback reflects only the model's claim that the transcript needs no
 * change. It does not prove that cleanup was unnecessary; only a manual
 * review of the private outputs can judge that.
 *
 * Only call this for valid responses. `transcript` must be the verified
 * recorded utterance of the same example.
 */
export function resolveEffectiveText(
  parsed: Extract<ParsedResponse, { valid: true }>,
  transcript: string,
): { text: string | null; source: TextSource | null } {
  if (!isTextRoute(parsed.intent)) {
    return { text: null, source: null };
  }
  if (parsed.textOmitted === true) {
    return { text: transcript, source: 'transcript' };
  }
  if (parsed.text === null) {
    // Not reachable for a valid response: text routes either carry text or
    // (optional-text contract only) were omitted.
    throw Error('A valid text-route response has neither text nor an omission');
  }
  return { text: parsed.text, source: 'model' };
}

/**
 * Every number literal outside strings in already-validated JSON text, exactly
 * as written. `JSON.parse` turns `50.0`, `5e1` and `50` into the same number,
 * so "zero decimal places" can only be checked on the raw text.
 */
export function numberLiterals(json: string): string[] {
  const literals: string[] = [];

  let index = 0;
  while (index < json.length) {
    const character = json[index]!;

    if (character === '"') {
      // Skip the whole string, including escaped characters.
      index += 1;
      while (json[index] !== '"') {
        index += json[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }

    if (character === '-' || (character >= '0' && character <= '9')) {
      let end = index + 1;
      while (end < json.length && /[0-9eE.+-]/.test(json[end]!)) {
        end += 1;
      }
      literals.push(json.slice(index, end));
      index = end;
      continue;
    }

    index += 1;
  }

  return literals;
}

/** An unsigned integer literal without leading zeros: `0`, `7`, `100`, never `07`, `7.0`, `-7`, `7e0`. */
const INTEGER_LITERAL = /^(?:0|[1-9][0-9]*)$/;

/**
 * Check the percentages object of a response that already satisfied the v1
 * contract. Order of checks, each with its own reason:
 *
 * 1. present (`percentages-missing`) and a plain object (`percentages-not-an-object`);
 * 2. exactly the offered intent names as keys, in any order (`percentages-keys-mismatch`);
 * 3. every value a JSON number (`percentage-not-a-number`);
 * 4. every number written as an unsigned integer literal (`percentage-not-integer-literal`).
 *    In this contract the percentages are the only numbers a valid response
 *    can contain (intent and text are strings), so every number literal in
 *    the raw text is checked;
 * 5. every value from 0 to 100 (`percentage-out-of-range`);
 * 6. a total of exactly 100 (`percentages-sum-not-100`). No rounding
 *    tolerance: the prompt tells the model how to make the total exact;
 * 7. the chosen intent has the highest value (`chosen-intent-not-highest`).
 *    Ties at the top are allowed when the chosen intent is one of them, and
 *    reported as `chosenTied`.
 */
function validatePercentages(
  value: Record<string, unknown>,
  responseText: string,
  expectation: ResponseExpectation,
  intent: string,
):
  | { valid: true; percentages: Readonly<Record<string, number>>; chosenTied: boolean }
  | { valid: false; reason: InvalidReason } {
  if (!('percentages' in value)) {
    return { valid: false, reason: 'percentages-missing' };
  }
  const percentages = value.percentages;
  if (!isPlainObject(percentages)) {
    return { valid: false, reason: 'percentages-not-an-object' };
  }

  const keys = Object.keys(percentages);
  const offered = expectation.allowedIntents;
  if (keys.length !== offered.length || offered.some((name) => !keys.includes(name))) {
    return { valid: false, reason: 'percentages-keys-mismatch' };
  }

  for (const name of offered) {
    if (typeof percentages[name] !== 'number') {
      return { valid: false, reason: 'percentage-not-a-number' };
    }
  }
  if (numberLiterals(responseText).some((literal) => !INTEGER_LITERAL.test(literal))) {
    return { valid: false, reason: 'percentage-not-integer-literal' };
  }

  // Copy in offered order into a null-prototype object: names are data.
  const distribution: Record<string, number> = Object.create(null);
  let total = 0;
  for (const name of offered) {
    const percentage = percentages[name] as number;
    if (percentage < 0 || percentage > 100) {
      return { valid: false, reason: 'percentage-out-of-range' };
    }
    distribution[name] = percentage;
    total += percentage;
  }
  if (total !== 100) {
    return { valid: false, reason: 'percentages-sum-not-100' };
  }

  const chosen = distribution[intent]!;
  let chosenTied = false;
  for (const name of offered) {
    if (name === intent) {
      continue;
    }
    if (distribution[name]! > chosen) {
      return { valid: false, reason: 'chosen-intent-not-highest' };
    }
    if (distribution[name] === chosen) {
      chosenTied = true;
    }
  }

  return { valid: true, percentages: distribution, chosenTied };
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

/**
 * What `diagnosticIntentSelection` can return for a response rejected with a
 * given reason. Derived from the order of checks in `parseExperimentResponse`:
 *
 * 1. invalid-json, not-an-object, duplicate-key: the diagnostic applies the
 *    same JSON, object and duplicate-key tests, so it finds no intent.
 * 2. unexpected-top-level-key: checked before the intent, so the intent may or
 *    may not be an allowed string.
 * 3. intent-not-a-string, unknown-intent, route-changed: no allowed intent
 *    (for a fixed route the only allowed name is the route itself).
 * 4. Every later reason is reached only with valid, duplicate-free JSON and an
 *    allowed intent string, so the diagnostic always finds it:
 *    - text-missing, text-not-a-string, text-empty, text-surrounding-whitespace
 *      are text-route checks;
 *    - text-on-no-text-intent is a no-text-intent check;
 *    - parameters-missing, parameters-not-an-object and unexpected-parameter
 *      can occur for either kind of intent.
 *
 * Report validation uses this to refuse rows whose diagnostic fields could not
 * have been produced by the parser. A unit test checks it against both parsers.
 */
export type DiagnosticForReason = 'none' | 'optional' | 'present' | 'text-route' | 'no-text-intent';

export const DIAGNOSTIC_FOR_INVALID_REASON: Readonly<Record<InvalidReason, DiagnosticForReason>> = {
  'invalid-json': 'none',
  'not-an-object': 'none',
  'duplicate-key': 'none',
  'unexpected-top-level-key': 'optional',
  'intent-not-a-string': 'none',
  'unknown-intent': 'none',
  'route-changed': 'none',
  'parameters-missing': 'present',
  'parameters-not-an-object': 'present',
  'unexpected-parameter': 'present',
  'text-missing': 'text-route',
  'text-not-a-string': 'text-route',
  'text-empty': 'text-route',
  'text-surrounding-whitespace': 'text-route',
  'text-on-no-text-intent': 'no-text-intent',
  // Percentage checks run only after the whole v1 contract passed, so the
  // diagnostic always finds the (allowed) intent.
  'percentages-missing': 'present',
  'percentages-not-an-object': 'present',
  'percentages-keys-mismatch': 'present',
  'percentage-not-a-number': 'present',
  'percentage-not-integer-literal': 'present',
  'percentage-out-of-range': 'present',
  'percentages-sum-not-100': 'present',
  'chosen-intent-not-highest': 'present',
};

/** Whether an invalid row's diagnostic intent is possible for its reason. */
export function diagnosticConsistentWithReason(
  reason: InvalidReason,
  selectedIntent: string | null,
): boolean {
  const expectation = DIAGNOSTIC_FOR_INVALID_REASON[reason];

  if (expectation === 'none') {
    return selectedIntent === null;
  }
  if (expectation === 'optional') {
    return true;
  }
  if (selectedIntent === null) {
    return false;
  }
  if (expectation === 'text-route') {
    return isTextRoute(selectedIntent);
  }
  if (expectation === 'no-text-intent') {
    return !isTextRoute(selectedIntent);
  }
  return true;
}
