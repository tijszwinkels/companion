/**
 * Paired comparison: does requesting JSON plus cleaned text reduce intent
 * detection quality compared with exact replay, on identical frozen examples?
 *
 * Input: a frozen exact-replay dataset, validated targets, the explicit
 * experimental output budget, the arm order, optional literal checks and a
 * cancellation signal.
 *
 * Two arms per target, on the same frozen examples and the same endpoints:
 * - Baseline: the unmodified exact-replay runner (`src/evals/runner.ts`,
 *   `runEvaluation`). Only `model` changes; this module does not reimplement or
 *   adjust it, so the baseline arm is exactly what `eval:intents run` measures.
 * - Variant: `json-cleanup-v1` (modified prompt and output budget) through the
 *   experiment runner.
 *
 * The arms run one after the other (never overlapping), in the explicit order
 * given. Within each arm, targets run sequentially with their own concurrency.
 * Examples the variant cannot transform exactly are still in the baseline
 * report, but are excluded from pairing and listed with their reason.
 *
 * Pairing is checked, not assumed: for every paired example both arms must
 * report the same `inputHash` (the recorded body without model), or the run
 * fails instead of comparing different inputs.
 *
 * Output: a content-free report with, per target, paired accuracy, the
 * accuracy delta, per-example regressions and improvements (with an exact
 * McNemar p-value over the discordant pairs), malformed-output rates and
 * latency; plus the variant's private outputs for human review. Nothing is
 * executed and no text reaches the report.
 */
import { SafeEvalError } from '../../errors.ts';
import { runEvaluation, type EvalResult } from '../../runner.ts';
import { validateTargets, type EvalTarget } from '../../transport.ts';
import { assertChecksMatchExamples, type LiteralChecks } from './checks.ts';
import { VARIANT_ID } from './prompt.ts';
import {
  describeVariant,
  latencyStatistics,
  planExperiment,
  runExperiment,
  type ExperimentResult,
} from './runner.ts';

export type ArmOrder = 'baseline-first' | 'variant-first';

export const ARM_ORDERS: readonly ArmOrder[] = ['baseline-first', 'variant-first'];

/** The exact-replay runner's fixed message for a response that is not a registered name. */
const BASELINE_UNREGISTERED_NAME = 'Response is not a registered intent name';

export type PairChange = 'both-correct' | 'regression' | 'improvement' | 'both-wrong';

/** One example on one target, both arms side by side. Contains no text. */
export interface PairedExample {
  id: string;
  target: string;
  expected: string;
  change: PairChange;
  baseline: {
    prediction: string | null;
    correct: boolean;
    error: string | null;
    latencyMs: number;
    outputTokens: number | null;
  };
  variant: {
    prediction: string | null;
    correct: boolean;
    status: ExperimentResult['status'];
    invalidReason: ExperimentResult['invalidReason'];
    error: string | null;
    literalCheck: ExperimentResult['literalCheck'];
    latencyMs: number;
    outputTokens: number | null;
  };
}

/**
 * Exact two-sided McNemar test (binomial test on the discordant pairs).
 * Returns 1 when there are no discordant pairs. Computed in log space so large
 * counts do not underflow.
 */
export function mcnemarExactPValue(regressions: number, improvements: number): number {
  const discordant = regressions + improvements;
  if (discordant === 0) {
    return 1;
  }

  // log(k!) for k = 0..discordant.
  const logFactorial: number[] = [0];
  for (let k = 1; k <= discordant; k++) {
    logFactorial.push(logFactorial[k - 1]! + Math.log(k));
  }

  const smaller = Math.min(regressions, improvements);
  let tail = 0;
  for (let k = 0; k <= smaller; k++) {
    const logChoose = logFactorial[discordant]! - logFactorial[k]! - logFactorial[discordant - k]!;
    tail += Math.exp(logChoose - discordant * Math.LN2);
  }

  return Math.min(1, 2 * tail);
}

function mean(values: (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value!;
  }
  return total / values.length;
}

function pairChange(baselineCorrect: boolean, variantCorrect: boolean): PairChange {
  if (baselineCorrect && variantCorrect) {
    return 'both-correct';
  }
  if (baselineCorrect) {
    return 'regression';
  }
  if (variantCorrect) {
    return 'improvement';
  }
  return 'both-wrong';
}

function pairTarget(
  target: EvalTarget,
  baselineRows: EvalResult[],
  variantRows: ExperimentResult[],
): PairedExample[] {
  const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
  const pairs: PairedExample[] = [];

  for (const variantRow of variantRows) {
    const baselineRow = baselineById.get(variantRow.id);
    if (baselineRow === undefined) {
      throw new SafeEvalError(`Example ${variantRow.id} is missing from the baseline arm`);
    }

    // Both arms must have started from the identical recorded input.
    if (baselineRow.inputHash !== variantRow.inputHash) {
      throw new SafeEvalError(`Example ${variantRow.id}: arms used different recorded inputs`);
    }

    const variantCorrect = variantRow.correct === true;
    pairs.push({
      id: variantRow.id,
      target: target.name,
      expected: baselineRow.expected,
      change: pairChange(baselineRow.correct, variantCorrect),
      baseline: {
        prediction: baselineRow.prediction,
        correct: baselineRow.correct,
        error: baselineRow.error,
        latencyMs: baselineRow.latencyMs,
        outputTokens: baselineRow.outputTokens,
      },
      variant: {
        prediction: variantRow.prediction,
        correct: variantCorrect,
        status: variantRow.status,
        invalidReason: variantRow.invalidReason,
        error: variantRow.error,
        literalCheck: variantRow.literalCheck,
        latencyMs: variantRow.latencyMs,
        outputTokens: variantRow.outputTokens,
      },
    });
  }

  return pairs;
}

function summarizePairs(
  target: EvalTarget,
  pairs: PairedExample[],
  baselineRequestsPerSecond: number | null,
  variantRequestsPerSecond: number | null,
) {
  const count = pairs.length;
  const rate = (value: number) => (count > 0 ? value / count : null);

  const baselineCorrect = pairs.filter((pair) => pair.baseline.correct).length;
  const variantCorrect = pairs.filter((pair) => pair.variant.correct).length;
  const regressions = pairs.filter((pair) => pair.change === 'regression');
  const improvements = pairs.filter((pair) => pair.change === 'improvement');

  const baselineUnregistered = pairs.filter(
    (pair) => pair.baseline.error === BASELINE_UNREGISTERED_NAME,
  ).length;
  const baselineOtherErrors = pairs.filter(
    (pair) => pair.baseline.error !== null && pair.baseline.error !== BASELINE_UNREGISTERED_NAME,
  ).length;
  const variantInvalid = pairs.filter((pair) => pair.variant.status === 'invalid').length;
  const variantErrors = pairs.filter((pair) => pair.variant.status === 'error').length;

  const baselineAccuracy = rate(baselineCorrect);
  const variantAccuracy = rate(variantCorrect);

  return {
    target: target.name,
    model: target.model,
    pairedExamples: count,
    baseline: {
      correct: baselineCorrect,
      accuracy: baselineAccuracy,
      // The exact-replay contract's malformed output: not a registered bare name.
      unregisteredNameResponses: baselineUnregistered,
      otherErrors: baselineOtherErrors,
      malformedRate: rate(baselineUnregistered),
    },
    variant: {
      correct: variantCorrect,
      accuracy: variantAccuracy,
      // The JSON contract's malformed output: any invalid-reason code.
      invalidJsonResponses: variantInvalid,
      otherErrors: variantErrors,
      malformedRate: rate(variantInvalid),
    },
    accuracyDelta:
      baselineAccuracy !== null && variantAccuracy !== null
        ? variantAccuracy - baselineAccuracy
        : null,
    changes: {
      bothCorrect: pairs.filter((pair) => pair.change === 'both-correct').length,
      regressions: regressions.length,
      improvements: improvements.length,
      bothWrong: pairs.filter((pair) => pair.change === 'both-wrong').length,
      mcnemarExactPValue: mcnemarExactPValue(regressions.length, improvements.length),
    },
    // Why each regression happened on the variant side.
    regressionCauses: {
      wrongIntent: regressions.filter((pair) => pair.variant.status === 'valid').length,
      invalidJson: regressions.filter((pair) => pair.variant.status === 'invalid').length,
      transportError: regressions.filter((pair) => pair.variant.status === 'error').length,
    },
    regressionIds: regressions.map((pair) => pair.id),
    improvementIds: improvements.map((pair) => pair.id),
    latencyMs: {
      baseline: latencyStatistics(pairs.map((pair) => pair.baseline.latencyMs)),
      variant: latencyStatistics(pairs.map((pair) => pair.variant.latencyMs)),
      // Per-example variant minus baseline; negative means the variant was faster.
      pairedDifference: latencyStatistics(
        pairs.map((pair) => pair.variant.latencyMs - pair.baseline.latencyMs),
      ),
    },
    meanOutputTokens: {
      baseline: mean(pairs.map((pair) => pair.baseline.outputTokens)),
      variant: mean(pairs.map((pair) => pair.variant.outputTokens)),
    },
    // Batch throughput from each arm's own report. The baseline batch also
    // includes examples excluded from pairing.
    requestsPerSecond: {
      baseline: baselineRequestsPerSecond,
      variant: variantRequestsPerSecond,
    },
  };
}

export interface PairedComparisonOptions {
  datasetPath: string;
  targets: EvalTarget[];
  outputTokens: number;
  order: ArmOrder;
  checks: LiteralChecks | null;
  signal?: AbortSignal;
}

export async function runPairedComparison(options: PairedComparisonOptions) {
  const signal = options.signal ?? new AbortController().signal;
  const targets = options.targets;

  if (!ARM_ORDERS.includes(options.order)) {
    throw new SafeEvalError('Arm order must be baseline-first or variant-first');
  }
  validateTargets(targets);
  for (const target of targets) {
    if (target.apiKeyEnv && !process.env[target.apiKeyEnv]) {
      throw Error(`Missing API key environment variable: ${target.apiKeyEnv}`);
    }
  }

  // Preflight the variant before either arm sends anything, so an unusable
  // budget, dataset or checks file cannot leave a half-run comparison.
  const source = { mode: 'inferred' as const, datasetPath: options.datasetPath };
  const plan = await planExperiment(source, options.outputTokens, signal);
  if (plan.supported.length === 0) {
    throw Error(`No example is supported by ${VARIANT_ID}; nothing was sent`);
  }
  if (options.checks !== null) {
    assertChecksMatchExamples(
      options.checks,
      plan.supported.map((example) => example.id),
    );
  }

  const startedAt = new Date().toISOString();
  let baseline: Awaited<ReturnType<typeof runEvaluation>>;
  let variant: Awaited<ReturnType<typeof runExperiment>>;

  // The arms never overlap. Whichever runs second may benefit from a warmer
  // server (prefix and image caches); run both orders to check for that.
  if (options.order === 'baseline-first') {
    baseline = await runEvaluation(options.datasetPath, targets, signal);
    variant = await runExperiment(source, targets, options.outputTokens, signal, options.checks);
  } else {
    variant = await runExperiment(source, targets, options.outputTokens, signal, options.checks);
    baseline = await runEvaluation(options.datasetPath, targets, signal);
  }

  if (baseline.datasetHash !== variant.report.datasetHash) {
    throw new SafeEvalError('The dataset changed between the two arms');
  }

  const pairs: PairedExample[] = [];
  const paired = [];
  for (const target of targets) {
    const targetPairs = pairTarget(
      target,
      baseline.results.filter((row) => row.target === target.name),
      variant.report.results.filter((row) => row.target === target.name),
    );
    pairs.push(...targetPairs);

    const baselineSummary = baseline.summary.find((entry) => entry.target === target.name)!;
    const variantSummary = variant.report.summary.find((entry) => entry.target === target.name)!;
    paired.push(
      summarizePairs(
        target,
        targetPairs,
        baselineSummary.batch.requestsPerSecond,
        variantSummary.batch.requestsPerSecond,
      ),
    );
  }

  const report = {
    kind: 'intent-json-cleanup-paired-comparison',
    version: 1,
    question:
      'Does requesting JSON plus cleaned text reduce intent-detection quality compared with exact replay on identical frozen examples?',
    startedAt,
    completedAt: new Date().toISOString(),
    order: options.order,
    datasetHash: baseline.datasetHash,
    arms: {
      baseline:
        'Exact replay via the unmodified eval:intents runner: recorded body with only model changed.',
      variant: describeVariant(plan),
    },
    excludedFromPairing: plan.unsupported,
    caveats: [
      'The arm that runs second may benefit from warmer server caches; compare a run with the opposite --order.',
      'Model outputs can be nondeterministic even at temperature 0; one run is one sample.',
      'A small hand-labeled dataset is a regression suite, not an unbiased population estimate.',
      'Cleanup quality is not measured here; review the private outputs by hand.',
    ],
    paired,
    pairs,
    baselineReport: baseline,
    variantReport: variant.report,
  };

  return { report, privateOutputs: variant.privateOutputs };
}
