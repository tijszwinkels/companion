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
import { describeRequestError } from '../../errors.ts';
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
  parseExperimentResponse,
  type InvalidReason,
  type ResponseExpectation,
  type TextRoute,
} from './contract.ts';
import {
  loadFixedRouteDataset,
  restoreFixedRouteExample,
  type FixedRouteDataset,
  type FixedRouteExample,
} from './fixed-routes.ts';
import {
  buildFixedRouteRequest,
  promptFingerprint,
  transformRecordedRequest,
  UnsupportedExampleError,
  validateOutputTokens,
  VARIANT_ID,
  type UnsupportedReason,
} from './prompt.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 1;

export type ExperimentMode = 'inferred' | 'fixed-route';

export interface ExperimentSource {
  mode: ExperimentMode;
  /** `dataset.json` from an exact-replay export, or a fixed-route fixture file. */
  datasetPath: string;
}

/** One example's request, prepared just before sending; the model is set per target. */
interface PreparedRequest {
  body: Record<string, unknown>;
  /** Same hash as the exact-replay report's inputHash (recorded body without model). */
  inputHash: string | null;
  /** Variant body without model: identical across targets, differs from inputHash. */
  variantInputHash: string;
  expectation: ResponseExpectation;
  /** For the private review file only. */
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
  prediction: string | null;
  /** Inferred only: valid and equal to the explicit label. Null for fixed routes. */
  correct: boolean | null;
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

/** The recorded utterance, for the private review file. Null if not recognizable. */
function recordedUtterance(record: IntentRequestRecord): string | null {
  const messages = record.body.messages;
  if (!Array.isArray(messages)) {
    return null;
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
        const data = JSON.parse(part.text) as { utterance?: unknown };
        if (typeof data.utterance === 'string') {
          return data.utterance;
        }
      } catch {
        // Not the frame JSON; keep looking without reporting its contents.
      }
    }
  }
  return null;
}

async function prepareInferred(
  datasetPath: string,
  example: EvalExample,
  outputTokens: number,
): Promise<PreparedRequest & { recordedOutputTokens: number; textIntents: string[] }> {
  const record = await restoreExample(datasetPath, example);
  const transformed = transformRecordedRequest(record, outputTokens);

  const { model: _recordedModel, ...recordedInputs } = record.body;
  const { model: _variantModel, ...variantInputs } = transformed.body;

  return {
    body: transformed.body,
    inputHash: fingerprint(recordedInputs),
    variantInputHash: fingerprint(variantInputs),
    expectation: { allowedIntents: transformed.allowedIntents, fixedRoute: null },
    spokenText: recordedUtterance(record),
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

  const supported: PlannedExample[] = [];
  const unsupported: { id: string; reason: UnsupportedReason }[] = [];
  const routeCounts: Record<string, number> = Object.create(null);

  if (source.mode === 'inferred') {
    const dataset = await loadDataset(source.datasetPath);
    const recordedOutputTokens: Record<string, number> = Object.create(null);

    for (const example of dataset.examples) {
      signal.throwIfAborted();
      try {
        const prepared = await prepareInferred(source.datasetPath, example, outputTokens);
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
        prepare: () => prepareInferred(source.datasetPath, example, outputTokens),
      });
    }

    return {
      mode: 'inferred',
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

  let modifications: string[];
  if (plan.mode === 'inferred') {
    modifications = [
      'System prompt: two bare-intent-name sentences replaced; response-format and text-cleanup section appended.',
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

  return {
    id: VARIANT_ID,
    exactReplay: false,
    promptHash: promptFingerprint(),
    contract:
      'One JSON object {"intent", "parameters"}; text routes require parameters {"text": nonempty string}, all other intents require {}; fixed routes must echo the shortcut route.',
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
  batchSignal: AbortSignal,
): Promise<{ result: ExperimentResult; privateOutput: PrivateOutput }> {
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

    const parsed = parseExperimentResponse(reply.text, prepared.expectation);
    if (parsed.valid) {
      result.status = 'valid';
      result.prediction = parsed.intent;
      result.hasText = parsed.text !== null;
      if (planned.expected !== null) {
        result.correct = parsed.intent === planned.expected;
      }
      privateOutput.intent = parsed.intent;
      privateOutput.cleanedText = parsed.text;
    } else {
      result.status = 'invalid';
      result.invalidReason = parsed.reason;
      privateOutput.invalidResponseText = reply.text;
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

  // Literal checks run on valid cleaned text only; everything else is not evaluated.
  privateOutput.literalCheck = evaluateLiteralCheck(check, privateOutput.cleanedText);
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

function summarizeTarget(
  mode: ExperimentMode,
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

  // JSON validity is judged only on responses that arrived; transport errors
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

    const correct = rows.filter((row) => row.correct === true).length;
    classification = {
      correct,
      total: rows.length,
      // Invalid responses and errors count as wrong, as in the exact-replay report.
      accuracy: rows.length > 0 ? correct / rows.length : null,
      accuracyAmongValid: valid.length > 0 ? correct / valid.length : null,
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
    json: {
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
        return evaluateExample(example, target, checks?.checks[example.id], batchSignal);
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
    summary.push(summarizeTarget(plan.mode, target, rows, batch));
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
      unsupported: plan.unsupported,
      routeCounts: plan.routeCounts,
    },
    summary,
    results,
  };

  return { report, privateOutputs };
}
