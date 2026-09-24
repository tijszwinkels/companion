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
import { pairRuns } from './pairing.ts';
import { VARIANT_ID } from './prompt.ts';
import { describeVariant, planExperiment, runExperiment } from './runner.ts';

export { mcnemarExactPValue } from './pairing.ts';

export type ArmOrder = 'baseline-first' | 'variant-first';

export const ARM_ORDERS: readonly ArmOrder[] = ['baseline-first', 'variant-first'];

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

  // One strict comparison per target: the same target name on both sides.
  const paired = [];
  for (const target of targets) {
    const comparison = pairRuns({
      baseline,
      baselineTarget: target.name,
      variant: variant.report,
      variantTarget: target.name,
    });

    const baselineSummary = baseline.summary.find((entry) => entry.target === target.name)!;
    const variantSummary = variant.report.summary.find((entry) => entry.target === target.name)!;
    paired.push({
      target: target.name,
      ...comparison,
      // Batch throughput of each arm. The baseline batch also covers excluded examples.
      requestsPerSecond: {
        baseline: baselineSummary.batch.requestsPerSecond,
        variant: variantSummary.batch.requestsPerSecond,
      },
    });
  }

  const report = {
    kind: 'intent-json-cleanup-paired-comparison',
    version: 2,
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
    caveats: [
      'Paired statistics cover only the variant’s supported examples (see coverage); the baseline full-dataset accuracy is context, not a comparator.',
      'Usable accuracy is the primary, conservative score; intent selection is a diagnostic that never repairs responses.',
      'The arm that runs second may benefit from warmer server caches; compare a run with the opposite --order.',
      'Model outputs can be nondeterministic even at temperature 0; one run is one sample.',
      'A small hand-labeled dataset is a regression suite, not an unbiased population estimate.',
      'The variant changes prompt, output format and output budget together; this measures that combination, not JSON alone.',
      'Cleanup quality is not measured here; review the private outputs by hand.',
    ],
    paired,
    baselineReport: baseline,
    variantReport: variant.report,
  };

  return { report, privateOutputs: variant.privateOutputs };
}
