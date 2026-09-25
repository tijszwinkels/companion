/**
 * Runtime schema and cross-field validation for the two report kinds that the
 * paired comparison consumes.
 *
 * Input: `unknown` values. They come either from report files (offline `pair`,
 * so they may be corrupted or hand-edited) or from the runners in the same
 * process (`compare`). Output: new, validated objects that contain only the
 * fields pairing needs, built from checked values. Nothing from the input is
 * passed through by reference or copied without validation.
 *
 * What is checked (review finding R3):
 * - Report identity and completeness. A report must say `state: "complete"`
 *   explicitly and must not carry `failed`/`interrupted` markers. A missing
 *   state never counts as complete. In-memory runner results go through
 *   `completedRunnerReport`, an explicit adapter used only after the runner's
 *   promise resolved successfully.
 * - Required metadata with exact types: hashes (64 lowercase hex), timestamps,
 *   targets, the variant ID, prompt hash, output budget and planned example lists.
 * - Every row of the SELECTED target: an exact key set, UUID example IDs,
 *   intent-name-shaped labels and predictions, real booleans, allowlisted
 *   statuses/reasons/literal-check statuses, bounded error strings, finite
 *   nonnegative latency/cost and nullable nonnegative integer token counts.
 * - Consistency. Stored scores must agree with what they summarize: exact
 *   replay is correct only with a prediction equal to the label and no error;
 *   a variant row is usable-correct only when valid with a prediction equal to
 *   the label; invalid and error rows can never be correct; the diagnostic
 *   fields must agree with the selected intent and label; a valid row has
 *   text exactly when its intent is a text route; and an invalid row's
 *   diagnostic intent must be possible for its reason
 *   (`DIAGNOSTIC_FOR_INVALID_REASON` in contract.ts).
 *
 * - Variants: the variant ID must be known and its prompt hash must equal the
 *   current prompt of that ID. json-cleanup-v1 rows keep their exact key set;
 *   json-cleanup-percentages-v1 rows have three more fields (chosen and
 *   labeled self-reported percentages, tie flag) with their own cross-field
 *   rules, and only percentages rows may carry percentage invalid reasons.
 *   json-cleanup-percentages-optional-text-v1 rows have the percentages
 *   fields plus two more (`textSource`, `modelTextMatchesTranscript`), which
 *   must agree with the status and intent; `text-missing` is impossible there.
 *
 * Refusals are SafeEvalError messages naming only a field, a side, and (once
 * validated) an example UUID. They never quote a value, so a malformed file
 * cannot move private text into stderr or a report. Error strings are
 * validated for type and length but never copied: pairing keeps only a fixed
 * error category.
 *
 * Rows of other, unselected targets must be objects with a string `target`
 * and are otherwise ignored.
 */
import { SafeEvalError } from '../../errors.ts';
import { LITERAL_CHECK_STATUSES } from './checks.ts';
import {
  diagnosticConsistentWithReason,
  INVALID_REASONS,
  isTextRoute,
  PERCENTAGE_REASONS,
  TEXT_SOURCES,
  type InvalidReason,
  type TextSource,
} from './contract.ts';
import {
  isVariantId,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  OPTIONAL_TEXT_VARIANT_ID,
  promptFingerprint,
  UNSUPPORTED_REASONS,
  usesPercentages,
  type VariantId,
} from './prompt.ts';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Registered intent names follow the router's identifier rule. */
const INTENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const MAX_ERROR_CHARACTERS = 600;
const MAX_TARGET_FIELD_CHARACTERS = 2_000;

/** The fixed message exact replay uses for a non-registered bare answer. */
const BASELINE_UNREGISTERED_NAME = 'Response is not a registered intent name';

export type BaselineErrorKind = 'unregistered-name' | 'request-error';
export type VariantStatus = 'valid' | 'invalid' | 'error';
export type LiteralCheckStatus = (typeof LITERAL_CHECK_STATUSES)[number];

/** Validated target identity, as recorded in the paired output. */
export interface TargetIdentity {
  name: string;
  model: string;
  baseUrl: string;
  concurrency: number;
  timeoutMs: number | null;
}

export interface ValidatedBaselineRow {
  id: string;
  expected: string;
  prediction: string | null;
  correct: boolean;
  errorKind: BaselineErrorKind | null;
  latencyMs: number;
  inputHash: string;
  outputTokens: number | null;
}

export interface ValidatedVariantRow {
  id: string;
  expected: string;
  status: VariantStatus;
  prediction: string | null;
  correct: boolean;
  selectedIntent: string | null;
  intentSelectedCorrectly: boolean;
  invalidReason: InvalidReason | null;
  literalCheck: LiteralCheckStatus;
  latencyMs: number;
  inputHash: string;
  outputTokens: number | null;
  /** Percentages variants only; null for other rows and for non-valid responses. */
  percentages: ValidatedPercentages | null;
  /**
   * Optional-text variant only; null for other variants' rows. For its rows,
   * always present (with null fields unless valid on a text route).
   */
  optionalText: ValidatedOptionalText | null;
}

/** Validated text-source fields of one optional-text-variant row. */
export interface ValidatedOptionalText {
  /** Valid text-route rows only: model text or the transcript fallback. */
  textSource: TextSource | null;
  /** Only for `textSource: "model"`: the model's text equals the transcript. */
  modelTextMatchesTranscript: boolean | null;
}

/** Validated self-reported values of one valid percentages-variant row. */
export interface ValidatedPercentages {
  chosen: number;
  expected: number;
  chosenTied: boolean;
}

export interface ValidatedBaselineReport {
  startedAt: string;
  datasetHash: string;
  target: TargetIdentity;
  rows: ValidatedBaselineRow[];
}

export interface ValidatedVariantReport {
  startedAt: string;
  datasetHash: string;
  variantId: VariantId;
  promptHash: string;
  outputTokens: number;
  supportedIds: string[];
  exclusions: { id: string; reason: string }[];
  target: TargetIdentity;
  rows: ValidatedVariantRow[];
}

// ---------------------------------------------------------------------------
// Small checked readers. Messages name the field, never the value.
// ---------------------------------------------------------------------------

function refuse(message: string): never {
  throw new SafeEvalError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    refuse(`${field} must be an object`);
  }
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    refuse(`${field} must be an array`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    refuse(`${field} must be true or false`);
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    refuse(`${field} is missing or malformed`);
  }
  return value;
}

function nullableMatching(value: unknown, pattern: RegExp, field: string): string | null {
  if (value === null) {
    return null;
  }
  return matching(value, pattern, field);
}

function boundedString(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    refuse(`${field} must be a nonempty string of at most ${maximum} characters`);
  }
  return value;
}

function nullableBoundedString(value: unknown, maximum: number, field: string): string | null {
  if (value === null) {
    return null;
  }
  return boundedString(value, maximum, field);
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    refuse(`${field} must be an ISO timestamp`);
  }
  return value;
}

/** Finite and nonnegative; JSON cannot carry NaN/Infinity, but hand edits can use strings. */
function nonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    refuse(`${field} must be a finite nonnegative number`);
  }
  return value;
}

function nullableNonnegativeNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return nonnegativeNumber(value, field);
}

function nullableTokenCount(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    refuse(`${field} must be null or a nonnegative integer`);
  }
  return value;
}

function oneOf<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    refuse(`${field} is not an allowed value`);
  }
  return value as Value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    refuse(`${field} has missing or unexpected fields`);
  }
}

// ---------------------------------------------------------------------------
// Shared report parts
// ---------------------------------------------------------------------------

/**
 * Explicit completion: files must say so, and must not carry failure markers.
 * An absent `state` is refused rather than treated as complete.
 */
function requireComplete(report: Record<string, unknown>, side: string): void {
  if (report.state !== 'complete') {
    refuse(`${side} report is not explicitly marked "state": "complete"`);
  }
  if (report.failed !== undefined || report.interrupted !== undefined) {
    refuse(`${side} report carries a failure or interruption marker`);
  }
}

function selectTarget(report: Record<string, unknown>, name: string, side: string): TargetIdentity {
  const targets = array(report.targets, `${side} targets`);
  const matches = targets.filter((target) => isObject(target) && target.name === name);
  if (matches.length !== 1) {
    refuse(`${side} report has no single target with the selected name`);
  }

  const target = matches[0] as Record<string, unknown>;
  const field = `${side} selected target`;
  const concurrency = target.concurrency ?? 1;
  const timeoutMs = target.timeoutMs ?? null;
  if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1) {
    refuse(`${field} concurrency must be a positive integer`);
  }
  if (
    timeoutMs !== null &&
    (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  ) {
    refuse(`${field} timeoutMs must be a positive integer`);
  }

  return {
    name,
    model: boundedString(target.model, MAX_TARGET_FIELD_CHARACTERS, `${field} model`),
    baseUrl: boundedString(target.baseUrl, MAX_TARGET_FIELD_CHARACTERS, `${field} baseUrl`),
    concurrency,
    timeoutMs,
  };
}

/** All rows must be objects with a string target; only the selected ones are returned. */
function selectedRows(
  report: Record<string, unknown>,
  targetName: string,
  side: string,
): Record<string, unknown>[] {
  const rows = array(report.results, `${side} results`);
  const selected: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.target !== 'string') {
      refuse(`${side} results contain a row without an object shape or target`);
    }
    if (row.target === targetName) {
      selected.push(row);
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Exact-replay baseline (`eval:intents run`, report version 2)
// ---------------------------------------------------------------------------

const BASELINE_ROW_KEYS = [
  'id',
  'target',
  'expected',
  'originalPrediction',
  'prediction',
  'correct',
  'error',
  'latencyMs',
  'inputHash',
  'requestHash',
  'inputTokens',
  'outputTokens',
  'estimatedCost',
] as const;

function validateBaselineRow(value: Record<string, unknown>): ValidatedBaselineRow {
  const id = matching(value.id, UUID, 'Baseline row id');
  const field = `Baseline row ${id}`;

  exactKeys(value, BASELINE_ROW_KEYS, field);
  const expected = matching(value.expected, INTENT_NAME, `${field} expected label`);
  nullableMatching(value.originalPrediction, INTENT_NAME, `${field} originalPrediction`);
  const prediction = nullableMatching(value.prediction, INTENT_NAME, `${field} prediction`);
  const correct = boolean(value.correct, `${field} correct`);
  const error = nullableBoundedString(value.error, MAX_ERROR_CHARACTERS, `${field} error`);
  const latencyMs = nonnegativeNumber(value.latencyMs, `${field} latencyMs`);
  const inputHash = matching(value.inputHash, HASH, `${field} inputHash`);
  matching(value.requestHash, HASH, `${field} requestHash`);
  nullableTokenCount(value.inputTokens, `${field} inputTokens`);
  const outputTokens = nullableTokenCount(value.outputTokens, `${field} outputTokens`);
  nullableNonnegativeNumber(value.estimatedCost, `${field} estimatedCost`);

  // Exact replay records either a registered prediction or an error, never both.
  if ((prediction === null) === (error === null)) {
    refuse(`${field} must have exactly one of prediction and error`);
  }
  if (correct !== (prediction !== null && prediction === expected)) {
    refuse(`${field} correct does not match its prediction and label`);
  }

  let errorKind: BaselineErrorKind | null = null;
  if (error !== null) {
    errorKind = error === BASELINE_UNREGISTERED_NAME ? 'unregistered-name' : 'request-error';
  }

  return { id, expected, prediction, correct, errorKind, latencyMs, inputHash, outputTokens };
}

export function validateBaselineReport(
  value: unknown,
  targetName: string,
): ValidatedBaselineReport {
  const report = object(value, 'Baseline report');
  if (report.version !== 2) {
    refuse('Baseline must be an exact-replay (version 2) report');
  }
  requireComplete(report, 'Baseline');

  return {
    startedAt: timestamp(report.startedAt, 'Baseline startedAt'),
    datasetHash: matching(report.datasetHash, HASH, 'Baseline datasetHash'),
    target: selectTarget(report, targetName, 'Baseline'),
    rows: selectedRows(report, targetName, 'Baseline').map((row) => validateBaselineRow(row)),
  };
}

// ---------------------------------------------------------------------------
// JSON-cleanup variant (`eval:intent-cleanup run --dataset`, report version 1)
// ---------------------------------------------------------------------------

const VARIANT_ROW_KEYS = [
  'id',
  'target',
  'expected',
  'originalPrediction',
  'fixedRoute',
  'status',
  'prediction',
  'correct',
  'selectedIntent',
  'intentSelectedCorrectly',
  'hasText',
  'invalidReason',
  'literalCheck',
  'error',
  'latencyMs',
  'inputHash',
  'variantInputHash',
  'requestHash',
  'inputTokens',
  'outputTokens',
  'estimatedCost',
] as const;

/** Percentages-variant rows carry exactly three more fields. */
const PERCENTAGES_VARIANT_ROW_KEYS = [
  ...VARIANT_ROW_KEYS,
  'chosenPercentage',
  'expectedPercentage',
  'chosenTied',
] as const;

/** Optional-text rows: the percentages rows plus the two text-source fields. */
const OPTIONAL_TEXT_VARIANT_ROW_KEYS = [
  ...PERCENTAGES_VARIANT_ROW_KEYS,
  'textSource',
  'modelTextMatchesTranscript',
] as const;

function rowKeysFor(variant: VariantId): readonly string[] {
  if (variant === OPTIONAL_TEXT_VARIANT_ID) {
    return OPTIONAL_TEXT_VARIANT_ROW_KEYS;
  }
  if (usesPercentages(variant)) {
    return PERCENTAGES_VARIANT_ROW_KEYS;
  }
  return VARIANT_ROW_KEYS;
}

/**
 * Cross-field rules for the text-source fields of an optional-text row:
 * - a valid text-route row has `textSource` "model" or "transcript" (and
 *   `hasText` true, checked by the caller);
 * - every other row (no-text intent, invalid, error) has `textSource` null;
 * - `modelTextMatchesTranscript` is a boolean exactly when `textSource` is
 *   "model", and null otherwise.
 */
function validateRowOptionalText(
  value: Record<string, unknown>,
  status: VariantStatus,
  prediction: string | null,
  field: string,
): ValidatedOptionalText {
  const textSource =
    value.textSource === null ? null : oneOf(value.textSource, TEXT_SOURCES, `${field} textSource`);

  const validTextRoute = status === 'valid' && prediction !== null && isTextRoute(prediction);
  if (validTextRoute !== (textSource !== null)) {
    refuse(`${field} textSource must be set exactly for a valid text-route response`);
  }

  let modelTextMatchesTranscript: boolean | null = null;
  if (textSource === 'model') {
    modelTextMatchesTranscript = boolean(
      value.modelTextMatchesTranscript,
      `${field} modelTextMatchesTranscript`,
    );
  } else if (value.modelTextMatchesTranscript !== null) {
    refuse(`${field} modelTextMatchesTranscript must be null unless the model returned text`);
  }

  return { textSource, modelTextMatchesTranscript };
}

function percentage(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) {
    refuse(`${field} must be an integer from 0 to 100`);
  }
  return value;
}

/**
 * Cross-field rules for the self-reported values of a valid row, implied by
 * the contract (integers 0-100, total exactly 100, chosen intent highest,
 * ties flagged). The full distribution is private, so only these are checkable.
 */
function validateRowPercentages(
  value: Record<string, unknown>,
  status: VariantStatus,
  correct: boolean,
  field: string,
): ValidatedPercentages | null {
  if (status !== 'valid') {
    if (
      value.chosenPercentage !== null ||
      value.expectedPercentage !== null ||
      value.chosenTied !== null
    ) {
      refuse(`${field} percentages must be null unless the response was valid`);
    }
    return null;
  }

  const chosen = percentage(value.chosenPercentage, `${field} chosenPercentage`);
  const expected = percentage(value.expectedPercentage, `${field} expectedPercentage`);
  const chosenTied = boolean(value.chosenTied, `${field} chosenTied`);

  // The highest of values summing to 100 is at least 1.
  if (chosen < 1) {
    refuse(`${field} chosenPercentage cannot be the highest of a total of 100`);
  }
  if (correct && expected !== chosen) {
    refuse(`${field} expectedPercentage must equal chosenPercentage when correct`);
  }
  if (!correct && expected > chosen) {
    refuse(`${field} expectedPercentage cannot exceed the chosen (highest) percentage`);
  }
  // Another intent at the same value as a wrong choice is a tie by definition.
  if (!correct && expected === chosen && !chosenTied) {
    refuse(`${field} chosenTied must be true when the labeled intent shares the highest value`);
  }

  // Joint mass: the values that these three fields prove to exist on DISTINCT
  // intents must fit in a total of 100. Only logically necessary values are
  // counted; unknown other intents are never guessed (they can be 0).
  // - Correct: the chosen (= labeled) intent, plus one more intent at the same
  //   value when tied.
  // - Wrong: the chosen and the labeled intent are different intents. When
  //   tied and the labeled value is lower, the tie partner is a third intent at
  //   the chosen value; when the labeled value equals the chosen value, the
  //   labeled intent itself can be the tie partner.
  let necessaryTotal = chosen;
  if (correct) {
    if (chosenTied) {
      necessaryTotal += chosen;
    }
  } else {
    necessaryTotal += expected;
    if (chosenTied && expected < chosen) {
      necessaryTotal += chosen;
    }
  }
  if (necessaryTotal > 100) {
    refuse(`${field} percentages on distinct intents would total more than 100`);
  }
  // An untied highest value of 1 forces every other intent to 0, so the total
  // would be 1. Other lower bounds depend on how many intents were offered,
  // which the row does not record, so they are not guessed.
  if (chosen === 1 && !chosenTied) {
    refuse(`${field} an untied highest percentage of 1 cannot total 100`);
  }

  return { chosen, expected, chosenTied };
}

function validateVariantRow(
  value: Record<string, unknown>,
  variant: VariantId,
): ValidatedVariantRow {
  const id = matching(value.id, UUID, 'Variant row id');
  const field = `Variant row ${id}`;
  const withPercentages = usesPercentages(variant);
  const withOptionalText = variant === OPTIONAL_TEXT_VARIANT_ID;

  exactKeys(value, rowKeysFor(variant), field);
  const expected = matching(value.expected, INTENT_NAME, `${field} expected label`);
  nullableMatching(value.originalPrediction, INTENT_NAME, `${field} originalPrediction`);
  if (value.fixedRoute !== null) {
    refuse(`${field} fixedRoute must be null in an inferred run`);
  }
  const status = oneOf(value.status, ['valid', 'invalid', 'error'] as const, `${field} status`);
  const prediction = nullableMatching(value.prediction, INTENT_NAME, `${field} prediction`);
  const correct = boolean(value.correct, `${field} correct`);
  const selectedIntent = nullableMatching(
    value.selectedIntent,
    INTENT_NAME,
    `${field} selectedIntent`,
  );
  const intentSelectedCorrectly = boolean(
    value.intentSelectedCorrectly,
    `${field} intentSelectedCorrectly`,
  );
  const hasText = boolean(value.hasText, `${field} hasText`);
  const invalidReason =
    value.invalidReason === null
      ? null
      : oneOf(value.invalidReason, INVALID_REASONS, `${field} invalidReason`);
  const literalCheck = oneOf(value.literalCheck, LITERAL_CHECK_STATUSES, `${field} literalCheck`);
  const error = nullableBoundedString(value.error, MAX_ERROR_CHARACTERS, `${field} error`);
  const latencyMs = nonnegativeNumber(value.latencyMs, `${field} latencyMs`);
  const inputHash = matching(value.inputHash, HASH, `${field} inputHash`);
  matching(value.variantInputHash, HASH, `${field} variantInputHash`);
  matching(value.requestHash, HASH, `${field} requestHash`);
  nullableTokenCount(value.inputTokens, `${field} inputTokens`);
  const outputTokens = nullableTokenCount(value.outputTokens, `${field} outputTokens`);
  nullableNonnegativeNumber(value.estimatedCost, `${field} estimatedCost`);

  // Each status has exactly one consistent shape. Invalid and error rows can
  // never be usable-correct, whatever the stored boolean says.
  if (status === 'valid') {
    if (prediction === null || invalidReason !== null || error !== null) {
      refuse(`${field} valid row must have a prediction and no reason or error`);
    }
    if (selectedIntent !== prediction) {
      refuse(`${field} selectedIntent must equal the prediction of a valid row`);
    }
    // The contract requires text exactly for text routes, and none otherwise.
    if (hasText !== isTextRoute(prediction)) {
      refuse(`${field} hasText does not match whether its intent takes text`);
    }
  } else if (status === 'invalid') {
    if (prediction !== null || invalidReason === null || error !== null || hasText) {
      refuse(`${field} invalid row must have a reason and no prediction, text or error`);
    }
    // Inferred runs have no fixed route, so the parser cannot report a route change.
    if (invalidReason === 'route-changed') {
      refuse(`${field} route-changed cannot occur in an inferred run`);
    }
    // Only the percentages contracts can fail on a percentage rule, and the
    // optional-text contract accepts a text route without text.
    if (PERCENTAGE_REASONS.has(invalidReason) && !withPercentages) {
      refuse(`${field} invalidReason is not possible for this variant`);
    }
    if (invalidReason === 'text-missing' && withOptionalText) {
      refuse(`${field} invalidReason is not possible for this variant`);
    }
    // The diagnostic must be one the parser could have produced for this reason.
    if (!diagnosticConsistentWithReason(invalidReason, selectedIntent)) {
      refuse(`${field} selectedIntent is impossible for its invalid reason`);
    }
  } else {
    if (prediction !== null || invalidReason !== null || error === null) {
      refuse(`${field} error row must have an error and no prediction or reason`);
    }
    if (selectedIntent !== null || hasText) {
      refuse(`${field} error row cannot select an intent or carry text`);
    }
  }

  if (correct !== (status === 'valid' && prediction === expected)) {
    refuse(`${field} correct does not match its status, prediction and label`);
  }
  if (intentSelectedCorrectly !== (selectedIntent !== null && selectedIntent === expected)) {
    refuse(`${field} intentSelectedCorrectly does not match its selected intent and label`);
  }
  // Literal checks only run on valid cleaned text.
  if (
    (literalCheck === 'passed' || literalCheck === 'failed') &&
    !(status === 'valid' && hasText)
  ) {
    refuse(`${field} literalCheck cannot be evaluated without valid cleaned text`);
  }

  const percentages = withPercentages
    ? validateRowPercentages(value, status, correct, field)
    : null;
  const optionalText = withOptionalText
    ? validateRowOptionalText(value, status, prediction, field)
    : null;

  return {
    id,
    expected,
    status,
    prediction,
    correct,
    selectedIntent,
    intentSelectedCorrectly,
    invalidReason,
    literalCheck,
    latencyMs,
    inputHash,
    outputTokens,
    percentages,
    optionalText,
  };
}

function uuidList(value: unknown, field: string): string[] {
  return array(value, field).map((id) => matching(id, UUID, `${field} entry`));
}

export function validateVariantReport(value: unknown, targetName: string): ValidatedVariantReport {
  const report = object(value, 'Variant report');
  if (report.kind !== 'intent-json-cleanup-experiment' || report.version !== 1) {
    refuse('Variant must be an intent-json-cleanup-experiment (version 1) report');
  }
  requireComplete(report, 'Variant');
  if (report.mode !== 'inferred') {
    refuse('Only inferred variant runs have an exact-replay baseline to pair');
  }

  const variant = object(report.variant, 'Variant metadata');
  if (variant.exactReplay !== false) {
    refuse('Variant metadata must declare exactReplay false');
  }
  // A known variant ID with its exact prompt hash: a changed prompt must use a new ID.
  if (!isVariantId(variant.id)) {
    refuse('Variant id is not a known experiment variant');
  }
  const variantId = variant.id;
  if (variant.promptHash !== promptFingerprint(variantId)) {
    refuse('Variant promptHash does not match the prompt of its variant id');
  }
  const outputTokens = object(variant.outputTokens, 'Variant outputTokens').experimental;
  if (
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < MIN_OUTPUT_TOKENS ||
    outputTokens > MAX_OUTPUT_TOKENS
  ) {
    refuse('Variant output token budget is missing or out of range');
  }

  const examples = object(report.examples, 'Variant examples');
  const exclusions = array(examples.unsupported, 'Variant unsupported examples').map((entry) => {
    const exclusion = object(entry, 'Variant unsupported example');
    exactKeys(exclusion, ['id', 'reason'], 'Variant unsupported example');
    return {
      id: matching(exclusion.id, UUID, 'Variant unsupported example id'),
      reason: oneOf(exclusion.reason, UNSUPPORTED_REASONS, 'Variant unsupported example reason'),
    };
  });

  return {
    startedAt: timestamp(report.startedAt, 'Variant startedAt'),
    datasetHash: matching(report.datasetHash, HASH, 'Variant datasetHash'),
    variantId,
    promptHash: variant.promptHash as string,
    outputTokens,
    supportedIds: uuidList(examples.supportedIds, 'Variant supportedIds'),
    exclusions,
    target: selectTarget(report, targetName, 'Variant'),
    rows: selectedRows(report, targetName, 'Variant').map((row) =>
      validateVariantRow(row, variantId),
    ),
  };
}

/**
 * Explicit adapter for reports returned in-process by `runEvaluation` or
 * `runExperiment`. Only call it after the runner's promise resolved: a
 * resolved runner means the run completed. The copy still goes through the
 * same validation as a file.
 */
export function completedRunnerReport<Report extends object>(
  report: Report,
): Report & { state: 'complete' } {
  return { ...report, state: 'complete' };
}
