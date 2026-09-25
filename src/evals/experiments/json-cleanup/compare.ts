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
 * Pairing is delegated to `pairing.ts` (`pairRuns`), the same strict function
 * the offline `pair` command uses: one target per side, the same dataset hash,
 * one-to-one pairing by unique example ID, matching `inputHash` and labels,
 * and the baseline restricted to exactly the variant's planned support. A
 * content hash is never used as a row key.
 *
 * Variants: one variant (default json-cleanup-v1) gives the version 2 report
 * shape, unchanged. Two distinct variants (for example json-cleanup-v1 and
 * json-cleanup-percentages-v1) run as separate whole arms on the same examples;
 * each is paired with the baseline, and the second is also paired with the
 * first (`pairVariantRuns`), in a version 3 report.
 *
 * Output: a content-free report with, per target, paired accuracy, the
 * accuracy delta, per-example regressions and improvements (with an exact
 * McNemar p-value over the discordant pairs), malformed-output rates and
 * latency; plus the variant's private outputs for human review. Nothing is
 * executed and no text reaches the report.
 */
import { SafeEvalError } from '../../errors.ts';
import { runEvaluation } from '../../runner.ts';
import { validateTargets, type EvalTarget } from '../../transport.ts';
import { assertChecksMatchExamples, type LiteralChecks } from './checks.ts';
import { pairRuns, pairVariantRuns } from './pairing.ts';
import { completedRunnerReport } from './report-schema.ts';
import { OPTIONAL_TEXT_VARIANT_ID, usesPercentages, VARIANT_ID, type VariantId } from './prompt.ts';
import {
  describeVariant,
  planExperiment,
  runExperiment,
  type ExperimentPlan,
  type PrivateOutput,
} from './runner.ts';

export { mcnemarExactPValue } from './pairing.ts';

export type ArmOrder = 'baseline-first' | 'variant-first';

export const ARM_ORDERS: readonly ArmOrder[] = ['baseline-first', 'variant-first'];

export interface PairedComparisonOptions {
  datasetPath: string;
  targets: EvalTarget[];
  outputTokens: number;
  order: ArmOrder;
  checks: LiteralChecks | null;
  /** Variant to compare with the baseline; default json-cleanup-v1. */
  variant?: VariantId;
  signal?: AbortSignal;
}

export interface VariantComparisonOptions extends Omit<PairedComparisonOptions, 'variant'> {
  /** Two distinct variants, run and reported in this order (left, right). */
  variants: [VariantId, VariantId];
}

const CAVEATS = [
  'Paired statistics cover only the variant’s supported examples (see coverage); the baseline full-dataset accuracy is context, not a comparator.',
  'Usable accuracy is the primary, conservative score; intent selection is a diagnostic that never repairs responses.',
  'The arm that runs second may benefit from warmer server caches; compare a run with the opposite --order.',
  'Model outputs can be nondeterministic even at temperature 0; one run is one sample.',
  'A small hand-labeled dataset is a regression suite, not an unbiased population estimate.',
  'The variant changes prompt, output format and output budget together; this measures that combination, not JSON alone.',
  'Cleanup quality is not measured here; review the private outputs by hand.',
];

const PERCENTAGES_CAVEAT =
  'Percentages are SELF-REPORTED integer estimates from the model, not calibrated probabilities or log-probabilities; the percentages variant also asks for more output, so its comparison with json-cleanup-v1 measures that added requirement together.';

const OPTIONAL_TEXT_CAVEAT =
  'The optional-text variant lets text routes leave out parameters.text; the recorded transcript is then used byte for byte. Omission is the model’s own claim that nothing needed cleanup or formatting and does NOT prove it: review the private outputs by hand. Latency split by omission is descriptive, not controlled, because the model chose the group.';

/** The caveats that apply to a set of compared variants. */
function caveatsFor(variants: readonly VariantId[]): string[] {
  const caveats = [...CAVEATS];
  if (variants.some((variant) => usesPercentages(variant))) {
    caveats.push(PERCENTAGES_CAVEAT);
  }
  if (variants.includes(OPTIONAL_TEXT_VARIANT_ID)) {
    caveats.push(OPTIONAL_TEXT_CAVEAT);
  }
  return caveats;
}

type BaselineRun = Awaited<ReturnType<typeof runEvaluation>>;
type VariantRun = Awaited<ReturnType<typeof runExperiment>>;

function armThroughput(baseline: BaselineRun, variant: VariantRun, targetName: string) {
  const baselineSummary = baseline.summary.find((entry) => entry.target === targetName)!;
  const variantSummary = variant.report.summary.find((entry) => entry.target === targetName)!;

  // Whole-arm throughput, reported with each arm's own request count. The
  // workloads differ when examples are excluded, so this is not a matched
  // speedup statistic; paired latency is the matched comparison.
  return {
    note: 'Per whole arm, not matched workload: the baseline arm also sends examples excluded from pairing. Do not read the ratio as a speedup; use paired latency instead.',
    baseline: {
      requests: baselineSummary.total,
      wallTimeMs: baselineSummary.batch.wallTimeMs,
      requestsPerSecond: baselineSummary.batch.requestsPerSecond,
    },
    variant: {
      requests: variantSummary.sent,
      wallTimeMs: variantSummary.batch.wallTimeMs,
      requestsPerSecond: variantSummary.batch.requestsPerSecond,
    },
  };
}

/**
 * Validate, preflight and run the baseline arm and one arm per variant, in
 * the explicit order. Arms never overlap; nothing is sent before every
 * variant's plan (and the checks file) validated.
 */
async function runArms(options: PairedComparisonOptions, variants: VariantId[]) {
  const signal = options.signal ?? new AbortController().signal;
  const targets = options.targets;

  if (!ARM_ORDERS.includes(options.order)) {
    throw new SafeEvalError('Arm order must be baseline-first or variant-first');
  }
  if (new Set(variants).size !== variants.length) {
    throw new SafeEvalError('Compared variants must be distinct');
  }
  validateTargets(targets);
  for (const target of targets) {
    if (target.apiKeyEnv && !process.env[target.apiKeyEnv]) {
      throw Error(`Missing API key environment variable: ${target.apiKeyEnv}`);
    }
  }

  const sources = variants.map((variant) => ({
    mode: 'inferred' as const,
    datasetPath: options.datasetPath,
    variant,
  }));
  const plans: ExperimentPlan[] = [];
  for (const source of sources) {
    const plan = await planExperiment(source, options.outputTokens, signal);
    if (plan.supported.length === 0) {
      throw Error(`No example is supported by ${plan.variant}; nothing was sent`);
    }
    if (options.checks !== null) {
      assertChecksMatchExamples(
        options.checks,
        plan.supported.map((example) => example.id),
      );
    }
    plans.push(plan);
  }

  const startedAt = new Date().toISOString();
  let baseline: BaselineRun | undefined;
  const variantRuns: VariantRun[] = [];

  // Whichever arm runs later may benefit from a warmer server (prefix and
  // image caches); run both orders to check for that.
  if (options.order === 'baseline-first') {
    baseline = await runEvaluation(options.datasetPath, targets, signal);
  }
  for (const source of sources) {
    variantRuns.push(
      await runExperiment(source, targets, options.outputTokens, signal, options.checks),
    );
  }
  if (options.order === 'variant-first') {
    baseline = await runEvaluation(options.datasetPath, targets, signal);
  }

  return { plans, startedAt, baseline: baseline!, variantRuns };
}

/**
 * One strict comparison per target: the same target on both sides. Every
 * runner promise resolved, so every run completed; the explicit adapter marks
 * that, and the reports still go through full validation.
 */
function pairWithBaseline(
  baseline: BaselineRun,
  variantRun: VariantRun,
  targets: EvalTarget[],
  labelVariant: boolean,
) {
  return targets.map((target) => ({
    target: target.name,
    ...(labelVariant ? { variant: variantRun.report.variant.id } : {}),
    ...pairRuns({
      baseline: completedRunnerReport(baseline),
      baselineTarget: target.name,
      variant: completedRunnerReport(variantRun.report),
      variantTarget: target.name,
    }),
    armThroughput: armThroughput(baseline, variantRun, target.name),
  }));
}

const QUESTION =
  'Does requesting JSON plus cleaned text reduce intent-detection quality compared with exact replay on identical frozen examples?';

const BASELINE_ARM =
  'Exact replay via the unmodified eval:intents runner: recorded body with only model changed.';

/** Baseline versus one variant (version 2 report, unchanged shape). */
export async function runPairedComparison(options: PairedComparisonOptions) {
  const variant = options.variant ?? VARIANT_ID;
  const { plans, startedAt, baseline, variantRuns } = await runArms(options, [variant]);
  const variantRun = variantRuns[0]!;

  const report = {
    kind: 'intent-json-cleanup-paired-comparison',
    version: 2,
    question: QUESTION,
    startedAt,
    completedAt: new Date().toISOString(),
    order: options.order,
    datasetHash: baseline.datasetHash,
    arms: { baseline: BASELINE_ARM, variant: describeVariant(plans[0]!) },
    caveats: caveatsFor([variant]),
    paired: pairWithBaseline(baseline, variantRun, options.targets, false),
    baselineReport: baseline,
    variantReport: variantRun.report,
  };

  return { report, privateOutputs: variantRun.privateOutputs };
}

/**
 * Baseline versus two variants (version 3 report), for example
 * json-cleanup-v1 (left) and json-cleanup-percentages-v1 (right). Each variant
 * is paired with the baseline, and right is paired with left.
 */
export async function runVariantComparison(options: VariantComparisonOptions) {
  const { plans, startedAt, baseline, variantRuns } = await runArms(options, options.variants);
  const [left, right] = variantRuns as [VariantRun, VariantRun];

  const variantComparisons = options.targets.map((target) => ({
    target: target.name,
    ...pairVariantRuns({
      left: completedRunnerReport(left.report),
      leftTarget: target.name,
      right: completedRunnerReport(right.report),
      rightTarget: target.name,
    }),
  }));

  const report = {
    kind: 'intent-json-cleanup-paired-comparison',
    version: 3,
    question: `${QUESTION} And does the right variant change intent recognition compared with the left one?`,
    startedAt,
    completedAt: new Date().toISOString(),
    order: options.order,
    armSequence:
      options.order === 'baseline-first'
        ? ['baseline', ...options.variants]
        : [...options.variants, 'baseline'],
    datasetHash: baseline.datasetHash,
    arms: {
      baseline: BASELINE_ARM,
      variants: plans.map((plan) => describeVariant(plan)),
    },
    caveats: caveatsFor(options.variants),
    paired: [
      ...pairWithBaseline(baseline, left, options.targets, true),
      ...pairWithBaseline(baseline, right, options.targets, true),
    ],
    variantComparisons,
    baselineReport: baseline,
    variantReports: [left.report, right.report],
  };

  const privateOutputs: { variant: VariantId; outputs: PrivateOutput[] }[] = [
    { variant: options.variants[0], outputs: left.privateOutputs },
    { variant: options.variants[1], outputs: right.privateOutputs },
  ];
  return { report, privateOutputs };
}
