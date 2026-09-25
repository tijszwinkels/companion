/**
 * Runner for the offline JSON intent + spoken-text cleanup experiment.
 *
 * Input: either a frozen exact-replay dataset (inferred routes) or an explicit
 * fixed-route fixture file, validated targets, an explicit output token budget
 * and a cancellation signal.
 *
 * Output: two separate objects.
 * - A shareable report: hashes, variant ID, settings, classification accuracy,
 *   JSON validity, fixed invalid-reason codes, latency and throughput. It never
 *   contains dictated text, cleaned text, raw model output or prompts.
 * - Private outputs for human review: original spoken text, cleaned text and
 *   the raw text of invalid responses. The CLI writes them to a separate 0600 file.
 *
 * Scheduling, timeouts and cancellation follow the exact-replay runner: targets
 * run one after another in isolated batches, each with at most
 * `target.concurrency` requests in flight (shared bounded pool). A request's
 * timeout starts when it is sent. Cancellation stops scheduling, aborts active
 * requests and drains them before rejecting; partial results are not returned.
 * Examples are re-read from disk (checksum verified) just before sending, so at
 * most `concurrency` screenshots per target are held in memory.
 *
 * The request transport, decoder, target validation and error descriptions are
 * reused unchanged from the exact-replay eval. Nothing here imports sensors,
 * routing, processors, delivery or UI code, and no response is ever executed.
 */
import { performance } from 'node:perf_hooks';

import { fingerprint, loadDataset, restoreExample, type EvalExample } from '../../dataset.ts';
import { describeRequestError, SafeEvalError } from '../../errors.ts';
import { runBounded } from '../../pool.ts';
import { complete, validateTargets, type EvalTarget } from '../../transport.ts';
import type { IntentRequestRecord } from '../../../core/intent-request.ts';
import {
  assertChecksMatchExamples,
  evaluateLiteralCheck,
  type LiteralCheck,
  type LiteralCheckOutcome,
  type LiteralChecks,
} from './checks.ts';
import {
  diagnosticIntentSelection,
  hasDuplicateKey,
  isTextRoute,
  parseExperimentResponse,
  PERCENTAGE_REASONS,
  resolveEffectiveText,
  type InvalidReason,
  type ResponseExpectation,
  type TextRoute,
  type TextSource,
} from './contract.ts';
import {
  loadFixedRouteDataset,
  restoreFixedRouteExample,
  type FixedRouteDataset,
  type FixedRouteExample,
} from './fixed-routes.ts';
import {
  buildFixedRouteRequest,
  isInferredOnly,
  OPTIONAL_TEXT_VARIANT_ID,
  promptFingerprint,
  transformRecordedRequest,
  UnsupportedExampleError,
  usesPercentages,
  validateOutputTokens,
  VARIANT_ID,
  type UnsupportedReason,
  type VariantId,
} from './prompt.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 1;

export type ExperimentMode = 'inferred' | 'fixed-route';

export interface ExperimentSource {
  mode: ExperimentMode;
  /** `dataset.json` from an exact-replay export, or a fixed-route fixture file. */
  datasetPath: string;
  /**
   * Prompt/contract variant; defaults to json-cleanup-v1. The percentages and
   * optional-text variants are inferred-only: fixed shortcut routes do not
   * classify, so no per-intent percentages are requested or accepted for them.
   */
  variant?: VariantId;
}

/** One example's request, prepared just before sending; the model is set per target. */
interface PreparedRequest {
  body: Record<string, unknown>;
  /** Same hash as the exact-replay report's inputHash (recorded body without model). */
  inputHash: string | null;
  /** Variant body without model: identical across targets, differs from inputHash. */
  variantInputHash: string;
  expectation: ResponseExpectation;
  /**
   * The recorded utterance. For the private review file, and for the
   * optional-text variant also the byte-exact fallback text (verified when
   * preparing, so never null there).
   */
  spokenText: string | null;
}

/** A dataset example after preflight. Supported examples can be prepared again later. */
interface PlannedExample {
  id: string;
  /** Explicit label of an inferred example; null for fixed routes. */
  expected: string | null;
  originalPrediction: string | null;
  fixedRoute: TextRoute | null;
  prepare(): Promise<PreparedRequest>;
}

export interface ExperimentPlan {
  mode: ExperimentMode;
  variant: VariantId;
  datasetHash: string;
  outputTokens: number;
  /** Recorded max_tokens values and their counts (inferred only). */
  recordedOutputTokens: Record<string, number> | null;
  requestSettings: FixedRouteDataset['requestSettings'] | null;
  supported: PlannedExample[];
  unsupported: { id: string; reason: UnsupportedReason }[];
  /** Supported example counts per offered text route or fixed route. */
  routeCounts: Record<string, number>;
}

export type ResultStatus = 'valid' | 'invalid' | 'error';

/** Shareable per-request record. Contains no text. */
export interface ExperimentResult {
  id: string;
  target: string;
  expected: string | null;
  originalPrediction: string | null;
  fixedRoute: TextRoute | null;
  status: ResultStatus;
  /** Intent of a fully contract-valid response; null otherwise. */
  prediction: string | null;
  /**
   * Inferred only, PRIMARY usable score: contract-valid and equal to the
   * explicit label. Invalid responses and errors are false. Null for fixed routes.
   */
  correct: boolean | null;
  /**
   * DIAGNOSTIC: the intent selected by a syntactically valid, duplicate-free
   * JSON object, even if other contract rules failed. Never a repair: the
   * response keeps its status and `correct` value. Null when there is no
   * unambiguous allowed intent (malformed, duplicate keys, unknown name, error).
   */
  selectedIntent: string | null;
  /** Inferred only: `selectedIntent` equals the explicit label. Null for fixed routes. */
  intentSelectedCorrectly: boolean | null;
  hasText: boolean;
  invalidReason: InvalidReason | null;
  /** Outcome of fixture-specified literal checks; the literals stay private. */
  literalCheck: LiteralCheckOutcome['status'];
  error: string | null;
  latencyMs: number;
  inputHash: string | null;
  variantInputHash: string;
  requestHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  /**
   * json-cleanup-percentages-v1 and the optional-text variant only (absent in
   * v1 rows). SELF-REPORTED integer percentages from a fully contract-valid
   * response, null otherwise:
   * the chosen intent's value, the labeled intent's value, and whether another
   * intent shares the chosen intent's (highest) value. Not calibrated
   * probabilities; invalid distributions stay private.
   */
  chosenPercentage?: number | null;
  expectedPercentage?: number | null;
  chosenTied?: boolean | null;
  /**
   * Optional-text variant only (absent in other rows). For a valid text-route
   * response: whether the effective text is the model's text or the recorded
   * transcript (text omitted); null for every other row. `hasText` means the
   * valid response has effective text from either source.
   */
  textSource?: TextSource | null;
  /**
   * Optional-text variant only: for `textSource: "model"`, whether the model's
   * text is identical to the transcript (text returned although nothing
   * changed); null otherwise. A content-free flag; the texts stay private.
   */
  modelTextMatchesTranscript?: boolean | null;
}

/** Private per-request record for human review of cleanup quality. */
export interface PrivateOutput {
  id: string;
  target: string;
  fixedRoute: TextRoute | null;
  expected: string | null;
  spokenText: string | null;
  intent: string | null;
  cleanedText: string | null;
  /** Raw model text, kept only for invalid responses to diagnose the failure. */
  invalidResponseText: string | null;
  /** Full literal-check outcome, including which private literals failed. */
  literalCheck: LiteralCheckOutcome;
  /** Percentages variant only: the full validated distribution of a valid response. */
  percentages?: Readonly<Record<string, number>> | null;
  /** Optional-text variant only: where `effectiveText` came from (see ExperimentResult). */
  textSource?: TextSource | null;
  /**
   * Optional-text variant only: the text a later action would use. The
   * model's `cleanedText`, or the recorded transcript byte for byte when the
   * model left out the text. Null without a valid text-route response.
   */
  effectiveText?: string | null;
}

interface BatchTiming {
  target: string;
  concurrency: number;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
}

// ---------------------------------------------------------------------------
// Planning (shared by dry-run and run; makes no network calls)
// ---------------------------------------------------------------------------

/**
 * Every `utterance` string of a frame part in the recorded request, in order:
 * user text parts whose JSON has a string `utterance`. Other parts are skipped
 * without reporting their contents.
 */
function frameUtterances(record: IntentRequestRecord): string[] {
  const found: string[] = [];

  const messages = record.body.messages;
  if (!Array.isArray(messages)) {
    return found;
  }

  for (const message of messages) {
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') {
        continue;
      }
      try {
        const data = JSON.parse(part.text) as { utterance?: unknown } | null;
        if (typeof data?.utterance === 'string') {
          found.push(data.utterance);
        }
      } catch {
        // Not the frame JSON; keep looking without reporting its contents.
      }
    }
  }
  return found;
}

/** The recorded utterance, for the private review file. Null if not recognizable. */
function recordedUtterance(record: IntentRequestRecord): string | null {
  return frameUtterances(record)[0] ?? null;
}

/**
 * The recorded utterance of the optional-text variant, which is also its
 * fallback text, so it must be unambiguous. Stricter than the best-effort
 * lookup above (which old variants keep unchanged):
 *
 * - A candidate is any user text part whose JSON is an object with its own
 *   `utterance` key, whatever the value.
 * - A candidate with a duplicate key anywhere is refused: `JSON.parse` keeps
 *   the last duplicate, while the model sees both values, so the fallback
 *   would be a guess (review finding: `{"utterance":"a","utterance":"b"}`,
 *   also with escaped keys such as `"utter\u0061nce"`).
 * - Every candidate must have a nonempty string utterance, so a malformed
 *   second frame is refused rather than skipped.
 * - There must be exactly one candidate in the whole request.
 *
 * Anything else aborts planning before any call, with a content-free message.
 */
function verifiedTranscript(record: IntentRequestRecord, exampleId: string): string {
  const refusal = new SafeEvalError(
    `Example ${exampleId}: ${OPTIONAL_TEXT_VARIANT_ID} needs exactly one unambiguous, nonempty recorded utterance as its fallback text`,
  );

  const candidates: string[] = [];
  const messages = record.body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || message.role !== 'user' || !Array.isArray(message.content)) {
        continue;
      }
      for (const part of message.content) {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') {
          continue;
        }

        let data: unknown;
        try {
          data = JSON.parse(part.text);
        } catch {
          // Not JSON, so not a frame; its contents are never reported.
          continue;
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          continue;
        }
        if (!Object.hasOwn(data, 'utterance')) {
          continue;
        }

        // A frame candidate: it must be unambiguous and well formed.
        const utterance = (data as { utterance: unknown }).utterance;
        if (hasDuplicateKey(part.text) || typeof utterance !== 'string' || utterance === '') {
          throw refusal;
        }
        candidates.push(utterance);
      }
    }
  }

  if (candidates.length !== 1) {
    throw refusal;
  }
  return candidates[0]!;
}

async function prepareInferred(
  datasetPath: string,
  example: EvalExample,
  outputTokens: number,
  variant: VariantId,
): Promise<PreparedRequest & { recordedOutputTokens: number; textIntents: string[] }> {
  const record = await restoreExample(datasetPath, example);
  const transformed = transformRecordedRequest(record, outputTokens, variant);

  const { model: _recordedModel, ...recordedInputs } = record.body;
  const { model: _variantModel, ...variantInputs } = transformed.body;

  // The optional-text fallback must be the one recorded utterance; other
  // variants keep the earlier best-effort lookup for the private file.
  const optionalText = variant === OPTIONAL_TEXT_VARIANT_ID;
  const spokenText = optionalText
    ? verifiedTranscript(record, example.id)
    : recordedUtterance(record);

  return {
    body: transformed.body,
    inputHash: fingerprint(recordedInputs),
    variantInputHash: fingerprint(variantInputs),
    expectation: {
      allowedIntents: transformed.allowedIntents,
      fixedRoute: null,
      ...(usesPercentages(variant) ? { percentages: true } : {}),
      ...(optionalText ? { optionalText: true } : {}),
    },
    spokenText,
    recordedOutputTokens: transformed.recordedOutputTokens,
    textIntents: transformed.textIntents,
  };
}

async function prepareFixedRoute(
  datasetPath: string,
  dataset: FixedRouteDataset,
  example: FixedRouteExample,
  outputTokens: number,
): Promise<PreparedRequest> {
  const input = await restoreFixedRouteExample(datasetPath, example);
  const body = buildFixedRouteRequest(input, dataset.requestSettings, outputTokens);
  const { model: _placeholder, ...variantInputs } = body;

  return {
    body,
    inputHash: null,
    variantInputHash: fingerprint(variantInputs),
    // A fixed route is the only allowed answer; anything else is a route change.
    expectation: { allowedIntents: [example.route], fixedRoute: example.route },
    spokenText: example.text,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Validate every example and artifact before any network call, so a broken
 * fixture cannot produce a partially comparable run. Unsupported recorded
 * prompts are listed with a fixed reason and never sent; other failures
 * (missing/modified screenshot, unknown label) abort the whole plan.
 */
export async function planExperiment(
  source: ExperimentSource,
  outputTokens: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExperimentPlan> {
  validateOutputTokens(outputTokens);

  const variant = source.variant ?? VARIANT_ID;
  if (isInferredOnly(variant) && source.mode !== 'inferred') {
    // Shortcuts fix the action without classification: there is nothing to
    // estimate, and no percentage may ever influence a fixed route.
    throw new SafeEvalError(
      `${variant} applies only to inferred --dataset runs; fixed-route shortcuts stay on ${VARIANT_ID}`,
    );
  }

  const supported: PlannedExample[] = [];
  const unsupported: { id: string; reason: UnsupportedReason }[] = [];
  const routeCounts: Record<string, number> = Object.create(null);

  if (source.mode === 'inferred') {
    const dataset = await loadDataset(source.datasetPath);
    const recordedOutputTokens: Record<string, number> = Object.create(null);

    for (const example of dataset.examples) {
      signal.throwIfAborted();
      try {
        const prepared = await prepareInferred(source.datasetPath, example, outputTokens, variant);
        increment(recordedOutputTokens, String(prepared.recordedOutputTokens));
        for (const name of prepared.textIntents) {
          increment(routeCounts, name);
        }
      } catch (error) {
        if (error instanceof UnsupportedExampleError) {
          unsupported.push({ id: example.id, reason: error.reason });
          continue;
        }
        throw error;
      }

      supported.push({
        id: example.id,
        expected: example.expected,
        originalPrediction: example.originalPrediction,
        fixedRoute: null,
        prepare: () => prepareInferred(source.datasetPath, example, outputTokens, variant),
      });
    }

    return {
      mode: 'inferred',
      variant,
      datasetHash: fingerprint(dataset),
      outputTokens,
      recordedOutputTokens,
      requestSettings: null,
      supported,
      unsupported,
      routeCounts,
    };
  }

  const dataset = await loadFixedRouteDataset(source.datasetPath);
  for (const example of dataset.examples) {
    signal.throwIfAborted();
    await prepareFixedRoute(source.datasetPath, dataset, example, outputTokens);
    increment(routeCounts, example.route);

    supported.push({
      id: example.id,
      expected: null,
      originalPrediction: null,
      fixedRoute: example.route,
      prepare: () => prepareFixedRoute(source.datasetPath, dataset, example, outputTokens),
    });
  }

  return {
    mode: 'fixed-route',
    variant,
    datasetHash: fingerprint(dataset),
    outputTokens,
    recordedOutputTokens: null,
    requestSettings: dataset.requestSettings,
    supported,
    unsupported,
    routeCounts,
  };
}

/** Labels the variant accurately: modified prompt and budget, never exact replay. */
export function describeVariant(plan: ExperimentPlan) {
  let outputTokenDelta: Record<string, number> | null = null;
  if (plan.recordedOutputTokens !== null) {
    outputTokenDelta = Object.create(null) as Record<string, number>;
    for (const recorded of Object.keys(plan.recordedOutputTokens)) {
      outputTokenDelta[recorded] = plan.outputTokens - Number(recorded);
    }
  }

  const percentages = usesPercentages(plan.variant);
  const optionalText = plan.variant === OPTIONAL_TEXT_VARIANT_ID;

  let systemPromptChange =
    'System prompt: two bare-intent-name sentences replaced; response-format and text-cleanup section appended.';
  if (optionalText) {
    systemPromptChange =
      'System prompt: two bare-intent-name sentences replaced; response-format (including self-reported integer percentages for every offered intent, and optional text for text routes whose utterance needs no change) and text-cleanup section appended.';
  } else if (percentages) {
    systemPromptChange =
      'System prompt: two bare-intent-name sentences replaced; response-format (including self-reported integer percentages for every offered intent) and text-cleanup section appended.';
  }

  let modifications: string[];
  if (plan.mode === 'inferred') {
    modifications = [
      systemPromptChange,
      `max_tokens: recorded value replaced by the experimental budget ${plan.outputTokens}.`,
      'model: replaced by the target model.',
      'Unchanged: user message (utterance, application, conversation context), screenshot, offered intent names, temperature, streaming and all other recorded fields.',
    ];
  } else {
    modifications = [
      'New cleanup-only request built from explicit fixed-route fixtures; no recorded request exists for shortcuts.',
      'Screenshot and application metadata are included only for SEND_TEXT_TO_APPLICATION.',
      `max_tokens: ${plan.outputTokens}; other settings from the fixture's requestSettings.`,
    ];
  }

  let contract =
    'One JSON object {"intent", "parameters"}; text routes require parameters {"text": nonempty string}, all other intents require {}; fixed routes must echo the shortcut route.';
  if (percentages) {
    contract =
      'One JSON object {"intent", "parameters", "percentages"}; parameters as in json-cleanup-v1; percentages has exactly the offered intent names as keys, unsigned integer literals 0-100 summing to exactly 100, and the chosen intent has the highest value (ties allowed). SELF-REPORTED estimates, not calibrated probabilities.';
  }
  if (optionalText) {
    contract =
      'One JSON object {"intent", "parameters", "percentages"}; percentages as in json-cleanup-percentages-v1; text routes require parameters {"text": nonempty string without surrounding whitespace} OR exactly {} (text omitted: the recorded transcript is used byte for byte, the only fallback); null, empty or wrong-type text and extra parameter keys stay invalid; all other intents require {}. Omission is the model\'s own judgement and does not prove that cleanup was unnecessary.';
  }

  return {
    id: plan.variant,
    exactReplay: false,
    promptHash: promptFingerprint(plan.variant),
    contract,
    modifications,
    outputTokens: {
      experimental: plan.outputTokens,
      recorded: plan.recordedOutputTokens,
      delta: outputTokenDelta,
    },
    requestSettings: plan.requestSettings,
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function evaluateExample(
  planned: PlannedExample,
  target: EvalTarget,
  check: LiteralCheck | undefined,
  variant: VariantId,
  batchSignal: AbortSignal,
): Promise<{ result: ExperimentResult; privateOutput: PrivateOutput }> {
  const percentages = usesPercentages(variant);
  const optionalText = variant === OPTIONAL_TEXT_VARIANT_ID;

  // Restoring happens before the latency timer starts; it counts only toward wall time.
  const prepared = await planned.prepare();
  const body = { ...prepared.body, model: target.model };

  const result: ExperimentResult = {
    id: planned.id,
    target: target.name,
    expected: planned.expected,
    originalPrediction: planned.originalPrediction,
    fixedRoute: planned.fixedRoute,
    status: 'error',
    prediction: null,
    correct: planned.fixedRoute === null ? false : null,
    selectedIntent: null,
    intentSelectedCorrectly: planned.fixedRoute === null ? false : null,
    hasText: false,
    invalidReason: null,
    literalCheck: 'no-checks',
    error: null,
    latencyMs: 0,
    inputHash: prepared.inputHash,
    variantInputHash: prepared.variantInputHash,
    requestHash: fingerprint(body),
    inputTokens: null,
    outputTokens: null,
    estimatedCost: null,
  };
  const privateOutput: PrivateOutput = {
    id: planned.id,
    target: target.name,
    fixedRoute: planned.fixedRoute,
    expected: planned.expected,
    spokenText: prepared.spokenText,
    intent: null,
    cleanedText: null,
    invalidResponseText: null,
    literalCheck: { status: 'no-checks' },
  };

  // Percentage fields exist only in percentages-variant rows, so json-cleanup-v1
  // rows keep exactly their earlier shape.
  if (percentages) {
    result.chosenPercentage = null;
    result.expectedPercentage = null;
    result.chosenTied = null;
    privateOutput.percentages = null;
  }
  // Likewise, only optional-text rows carry the text source fields.
  if (optionalText) {
    result.textSource = null;
    result.modelTextMatchesTranscript = null;
    privateOutput.textSource = null;
    privateOutput.effectiveText = null;
  }

  // The text literal checks judge: the effective text for the optional-text
  // variant (what an action would use), the cleaned text otherwise.
  let checkedText: string | null = null;

  // Per-request timeout that starts now, not while waiting for a free slot.
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([batchSignal, timeoutSignal]);
  const started = performance.now();

  try {
    const reply = await complete(body, target, requestSignal);

    result.inputTokens = reply.inputTokens;
    result.outputTokens = reply.outputTokens;
    if (target.pricing && reply.inputTokens !== null && reply.outputTokens !== null) {
      const inputCost = reply.inputTokens * target.pricing.inputPerMillion;
      const outputCost = reply.outputTokens * target.pricing.outputPerMillion;
      result.estimatedCost = (inputCost + outputCost) / 1_000_000;
    }

    // Validate the assistant content exactly as received. The trimmed `text`
    // is the exact-replay contract; trimming would also strip non-JSON
    // characters such as U+FEFF and U+00A0 and turn invalid output valid.
    const parsed = parseExperimentResponse(reply.rawText, prepared.expectation);

    result.selectedIntent = diagnosticIntentSelection(reply.rawText, prepared.expectation);
    if (planned.expected !== null) {
      result.intentSelectedCorrectly = result.selectedIntent === planned.expected;
    }

    if (parsed.valid) {
      result.status = 'valid';
      result.prediction = parsed.intent;
      result.hasText = parsed.text !== null;
      if (planned.expected !== null) {
        result.correct = parsed.intent === planned.expected;
      }
      privateOutput.intent = parsed.intent;
      privateOutput.cleanedText = parsed.text;
      checkedText = parsed.text;

      if (optionalText) {
        // The only fallback: an omitted text-route text becomes the verified
        // recorded transcript, byte for byte. Invalid responses never get here.
        const effective = resolveEffectiveText(parsed, prepared.spokenText!);
        result.hasText = effective.text !== null;
        result.textSource = effective.source;
        if (effective.source === 'model') {
          result.modelTextMatchesTranscript = parsed.text === prepared.spokenText;
        }
        privateOutput.textSource = effective.source;
        privateOutput.effectiveText = effective.text;
        checkedText = effective.text;
      }

      if (percentages && parsed.percentages !== undefined) {
        result.chosenPercentage = parsed.percentages[parsed.intent]!;
        // The label is always an offered intent (checked when restoring).
        result.expectedPercentage = parsed.percentages[planned.expected!] ?? null;
        result.chosenTied = parsed.chosenTied === true;
        privateOutput.percentages = parsed.percentages;
      }
    } else {
      result.status = 'invalid';
      result.invalidReason = parsed.reason;
      privateOutput.invalidResponseText = reply.rawText;
    }
  } catch (error) {
    // An interrupted request is never scored as a model error.
    batchSignal.throwIfAborted();

    if (timeoutSignal.aborted) {
      result.error = `Request timed out after ${timeoutMs} ms`;
    } else {
      result.error = describeRequestError(error);
    }
  }

  result.latencyMs = performance.now() - started;

  // Literal checks run on valid (effective) text only; everything else is not evaluated.
  privateOutput.literalCheck = evaluateLiteralCheck(check, checkedText);
  result.literalCheck = privateOutput.literalCheck.status;

  return { result, privateOutput };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Nearest-rank percentile, as in the exact-replay report. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[rank]!;
}

/** Latency summary; also used by the paired comparison. */
export function latencyStatistics(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  let total = 0;
  for (const value of sorted) {
    total += value;
  }

  return {
    count: sorted.length,
    meanMs: sorted.length > 0 ? total / sorted.length : null,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/** Mean of a nonempty list, null for an empty one. */
function meanOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * Percentages variant only: compliance with the percentage rules and simple
 * descriptive statistics of the SELF-REPORTED values. These are the model's
 * own estimates; nothing here calibrates or validates them as probabilities.
 */
function summarizePercentages(rows: ExperimentResult[]) {
  const valid = rows.filter((row) => row.status === 'valid');
  const invalid = rows.filter((row) => row.status === 'invalid');
  const failedOnPercentages = invalid.filter((row) => PERCENTAGE_REASONS.has(row.invalidReason!));

  return {
    definition:
      'SELF-REPORTED integer percentages per offered intent (not calibrated probabilities or log-probabilities). "compliant" responses satisfied the whole contract including the percentage rules; "failedOnPercentageRules" satisfied everything else but broke a percentage rule; "failedEarlier" broke an earlier rule, so their percentages were never judged.',
    compliant: valid.length,
    failedOnPercentageRules: failedOnPercentages.length,
    failedEarlier: invalid.length - failedOnPercentages.length,
    transportErrors: rows.filter((row) => row.status === 'error').length,
    chosenTied: valid.filter((row) => row.chosenTied === true).length,
    meanChosenPercentage: {
      usableCorrect: meanOrNull(
        valid.filter((row) => row.correct === true).map((row) => row.chosenPercentage!),
      ),
      usableWrong: meanOrNull(
        valid.filter((row) => row.correct !== true).map((row) => row.chosenPercentage!),
      ),
    },
    meanExpectedIntentPercentage: meanOrNull(valid.map((row) => row.expectedPercentage!)),
  };
}

/** Mean of the reported output tokens, or null when any row has none. */
function meanOutputTokens(rows: ExperimentResult[]): number | null {
  if (rows.some((row) => row.outputTokens === null)) {
    return null;
  }
  return meanOrNull(rows.map((row) => row.outputTokens!));
}

/**
 * Optional-text variant only: how often valid text-route responses left out
 * the text (the transcript fallback was used), per offered text route, and
 * the latency and output tokens of both groups. Counts and timings only; the
 * texts stay in the private file.
 *
 * Latency groups are descriptive, not a controlled comparison: utterances that
 * need no change tend to be short, and the model chose the group itself.
 */
function summarizeOptionalText(rows: ExperimentResult[]) {
  const textRows = rows.filter(
    (row) => row.status === 'valid' && row.prediction !== null && isTextRoute(row.prediction),
  );
  const omitted = textRows.filter((row) => row.textSource === 'transcript');
  const provided = textRows.filter((row) => row.textSource === 'model');

  const byRoute: Record<string, { omitted: number; provided: number }> = Object.create(null);
  for (const row of textRows) {
    let counts = byRoute[row.prediction!];
    if (counts === undefined) {
      counts = { omitted: 0, provided: 0 };
      byRoute[row.prediction!] = counts;
    }
    if (row.textSource === 'transcript') {
      counts.omitted += 1;
    } else {
      counts.provided += 1;
    }
  }

  return {
    definition:
      'Valid text-route responses that left out parameters.text ("omitted": the recorded transcript is used byte for byte, the only fallback) or returned text ("provided"). Omission is the model\'s own claim that nothing needed cleanup or formatting; it does NOT prove that. Review the private outputs by hand. Latency groups are descriptive, not controlled.',
    validTextRouteResponses: textRows.length,
    omittedUsingTranscript: omitted.length,
    providedText: provided.length,
    providedTextIdenticalToTranscript: provided.filter(
      (row) => row.modelTextMatchesTranscript === true,
    ).length,
    omissionRate: textRows.length > 0 ? omitted.length / textRows.length : null,
    byRoute,
    latencyMs: {
      omitted: latencyStatistics(omitted.map((row) => row.latencyMs)),
      provided: latencyStatistics(provided.map((row) => row.latencyMs)),
    },
    meanOutputTokens: {
      omitted: meanOutputTokens(omitted),
      provided: meanOutputTokens(provided),
    },
  };
}

function summarizeTarget(
  mode: ExperimentMode,
  variant: VariantId,
  target: EvalTarget,
  rows: ExperimentResult[],
  batch: BatchTiming,
) {
  const valid = rows.filter((row) => row.status === 'valid');
  const invalid = rows.filter((row) => row.status === 'invalid');
  const errors = rows.filter((row) => row.status === 'error');

  const invalidReasons: Record<string, number> = Object.create(null);
  for (const row of invalid) {
    increment(invalidReasons, row.invalidReason!);
  }
  const errorMessages: Record<string, number> = Object.create(null);
  for (const row of errors) {
    increment(errorMessages, row.error!);
  }

  // Contract validity is judged only on responses that arrived; transport errors
  // are counted separately rather than hiding inside either rate.
  const answered = valid.length + invalid.length;
  const wallTimeSeconds = batch.wallTimeMs / 1000;

  let classification = null;
  let routeIdentity = null;
  // Classification is scored only against explicit labels of inferred examples.
  // Fixed routes have no classification; their only route question is identity.
  if (mode === 'inferred') {
    const confusion: Record<string, Record<string, number>> = Object.create(null);
    for (const row of rows) {
      let predictions = confusion[row.expected!];
      if (predictions === undefined) {
        predictions = Object.create(null) as Record<string, number>;
        confusion[row.expected!] = predictions;
      }
      let predicted = row.prediction ?? '<ERROR>';
      if (row.status === 'invalid') {
        predicted = '<INVALID>';
      }
      increment(predictions, predicted);
    }

    const usableCorrect = rows.filter((row) => row.correct === true).length;
    const selectedCorrectly = rows.filter((row) => row.intentSelectedCorrectly === true).length;
    classification = {
      definition:
        'PRIMARY usable score: the correct intent inside a fully contract-valid response, over all attempts. Invalid responses and transport errors count as wrong.',
      usableCorrect,
      total: rows.length,
      usableAccuracy: rows.length > 0 ? usableCorrect / rows.length : null,
      // Diagnostic denominator: only contract-valid responses.
      usableAccuracyAmongContractValid: valid.length > 0 ? usableCorrect / valid.length : null,
      intentSelectionDiagnostic: {
        definition:
          'DIAGNOSTIC only: the correct allowed intent in a syntactically valid, duplicate-free JSON object even when other contract rules failed, over all attempts. No response is repaired or promoted; malformed, duplicate-key and unknown-name responses count as wrong.',
        correct: selectedCorrectly,
        total: rows.length,
        accuracy: rows.length > 0 ? selectedCorrectly / rows.length : null,
      },
      confusion,
      regressionsFromRecordedPrediction: rows
        .filter((row) => row.originalPrediction === row.expected && row.correct !== true)
        .map((row) => row.id),
    };
  } else {
    routeIdentity = {
      preserved: valid.length,
      changed: invalid.filter((row) => row.invalidReason === 'route-changed').length,
    };
  }

  // Fixture-specified literal checks: IDs and counts only, never the literals.
  const checked = rows.filter((row) => row.literalCheck !== 'no-checks');
  let literalChecks = null;
  if (checked.length > 0) {
    literalChecks = {
      examplesWithChecks: checked.length,
      passed: checked.filter((row) => row.literalCheck === 'passed').length,
      failed: checked.filter((row) => row.literalCheck === 'failed').length,
      notEvaluated: checked.filter((row) => row.literalCheck === 'not-evaluated').length,
      failedIds: checked.filter((row) => row.literalCheck === 'failed').map((row) => row.id),
      note: 'Fixture-specified literal checks only; not a cleanup quality score.',
    };
  }

  let estimatedCost: number | null = 0;
  for (const row of rows) {
    if (row.estimatedCost === null) {
      estimatedCost = null;
      break;
    }
    estimatedCost += row.estimatedCost;
  }

  return {
    target: target.name,
    model: target.model,
    concurrency: batch.concurrency,
    sent: rows.length,
    responseContract: {
      definition:
        'Full response-contract validity over responses received (strict JSON of the assistant content exactly as received, exact keys, allowed intent, parameter shape), not JSON syntax alone. Transport errors are counted separately.',
      valid: valid.length,
      invalid: invalid.length,
      errors: errors.length,
      validityRate: answered > 0 ? valid.length / answered : null,
      invalidReasons,
      errorMessages,
    },
    classification,
    routeIdentity,
    cleanup: {
      textResponses: valid.filter((row) => row.hasText).length,
      qualityScore: null,
      note: 'No cleanup ground truth exists; review the private outputs file by hand.',
    },
    literalChecks,
    ...(usesPercentages(variant) ? { selfReportedPercentages: summarizePercentages(rows) } : {}),
    ...(variant === OPTIONAL_TEXT_VARIANT_ID ? { optionalText: summarizeOptionalText(rows) } : {}),
    batch: {
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      wallTimeMs: batch.wallTimeMs,
      requestsPerSecond: wallTimeSeconds > 0 ? rows.length / wallTimeSeconds : null,
      validResponsesPerSecond: wallTimeSeconds > 0 ? valid.length / wallTimeSeconds : null,
    },
    latencyMs: {
      allRequests: latencyStatistics(rows.map((row) => row.latencyMs)),
      validResponses: latencyStatistics(valid.map((row) => row.latencyMs)),
    },
    estimatedCost,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runExperiment(
  source: ExperimentSource,
  targets: EvalTarget[],
  outputTokens: number,
  signal: AbortSignal = new AbortController().signal,
  checks: LiteralChecks | null = null,
) {
  validateTargets(targets);
  for (const target of targets) {
    if (target.apiKeyEnv && !process.env[target.apiKeyEnv]) {
      throw Error(`Missing API key environment variable: ${target.apiKeyEnv}`);
    }
  }

  const plan = await planExperiment(source, outputTokens, signal);
  if (plan.supported.length === 0) {
    throw Error(`No example is supported by ${VARIANT_ID}; nothing was sent`);
  }
  if (checks !== null) {
    assertChecksMatchExamples(
      checks,
      plan.supported.map((example) => example.id),
    );
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results: ExperimentResult[] = [];
  const privateOutputs: PrivateOutput[] = [];
  const summary = [];

  // Targets run strictly one after another. See the module comment.
  for (const target of targets) {
    signal.throwIfAborted();

    const concurrency = target.concurrency ?? DEFAULT_CONCURRENCY;
    const batchStartedAt = new Date().toISOString();
    const batchStarted = performance.now();

    const batchResults = await runBounded(
      plan.supported.length,
      concurrency,
      signal,
      (index, batchSignal) => {
        const example = plan.supported[index]!;
        return evaluateExample(
          example,
          target,
          checks?.checks[example.id],
          plan.variant,
          batchSignal,
        );
      },
    );

    const batch: BatchTiming = {
      target: target.name,
      concurrency,
      startedAt: batchStartedAt,
      completedAt: new Date().toISOString(),
      wallTimeMs: performance.now() - batchStarted,
    };

    const rows = batchResults.map((entry) => entry.result);
    results.push(...rows);
    privateOutputs.push(...batchResults.map((entry) => entry.privateOutput));
    summary.push(summarizeTarget(plan.mode, plan.variant, target, rows, batch));
  }

  const report = {
    kind: 'intent-json-cleanup-experiment',
    version: 1,
    mode: plan.mode,
    variant: describeVariant(plan),
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs: performance.now() - started,
    datasetHash: plan.datasetHash,
    policy:
      'Modified prompt and output budget (not exact replay). No retries, no response repair, no LLM judge, no action execution. Text lives only in the private outputs file.',
    schedule:
      'Targets run sequentially in isolated batches; each batch has at most target.concurrency requests in flight.',
    targets: targets.map((target) => ({
      ...target,
      timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      concurrency: target.concurrency ?? DEFAULT_CONCURRENCY,
    })),
    examples: {
      supported: plan.supported.length,
      // Explicit planned support, so offline pairing can verify it exactly.
      supportedIds: plan.supported.map((example) => example.id),
      unsupported: plan.unsupported,
      routeCounts: plan.routeCounts,
    },
    summary,
    results,
  };

  return { report, privateOutputs };
}
