/**
 * Strict paired comparison of one exact-replay baseline run/target with one
 * JSON-variant run/target on the same frozen dataset.
 *
 * Input: a complete exact-replay report (`eval:intents run`, version 2) and a
 * complete inferred variant report (`eval:intent-cleanup run --dataset`), plus
 * one explicitly selected target name on each side. Both can come from the
 * same `compare` invocation (in memory) or from report files (offline `pair`).
 *
 * Output: a content-free comparison restricted to exactly the examples the
 * variant planned to send, paired one-to-one by example ID.
 *
 * Why so strict: summary accuracies of two runs are not comparable when their
 * support differs (for example, the variant cannot transform older prompt
 * templates), and a content hash is not a row key (distinct examples can have
 * identical recorded bodies). Both mistakes can turn a real regression into an
 * apparent improvement. This module therefore refuses, rather than guesses:
 *
 * - The same frozen dataset hash on both sides.
 * - Exactly one selected target per side, identified by name, with its model
 *   and endpoint settings recorded in the output.
 * - Unique example IDs per side. The variant rows must equal its planned
 *   supported IDs exactly; the baseline rows must equal supported plus
 *   excluded IDs exactly (the whole frozen dataset).
 * - For every paired ID: the same recorded `inputHash` and the same label.
 *
 * Every attempt of a paired example counts, including invalid responses and
 * transport errors, so neither denominator can shrink silently. Excluded
 * examples are reported with their reasons and coverage; the baseline's full
 * dataset accuracy is kept as a separate, clearly labeled statistic that is
 * never used for the paired delta.
 *
 * Report fields are validated first (report-schema.ts): explicit completion,
 * required metadata and hashes, and per-row type and consistency checks. The
 * output is built only from those validated values.
 *
 * Pure function: no I/O, no model calls.
 */
import { SafeEvalError } from '../../errors.ts';
import {
  validateBaselineReport,
  validateVariantReport,
  type BaselineErrorKind,
  type LiteralCheckStatus,
  type ValidatedPercentages,
  type ValidatedVariantReport,
  type ValidatedVariantRow,
  type VariantStatus,
} from './report-schema.ts';
import { PERCENTAGE_REASONS, type InvalidReason } from './contract.ts';
import { PERCENTAGES_VARIANT_ID } from './prompt.ts';
import { latencyStatistics } from './runner.ts';

export type PairChange = 'both-correct' | 'regression' | 'improvement' | 'both-wrong';

/**
 * One example, both sides side by side. Built only from validated fields; it
 * contains no text and no error strings, only fixed categories.
 */
export interface PairedExample {
  id: string;
  expected: string;
  /** Change of the PRIMARY usable score from baseline to variant. */
  change: PairChange;
  baseline: {
    prediction: string | null;
    correct: boolean;
    errorKind: BaselineErrorKind | null;
    latencyMs: number;
    outputTokens: number | null;
  };
  variant: {
    prediction: string | null;
    correct: boolean;
    selectedIntent: string | null;
    intentSelectedCorrectly: boolean;
    status: VariantStatus;
    invalidReason: InvalidReason | null;
    literalCheck: LiteralCheckStatus;
    latencyMs: number;
    outputTokens: number | null;
    /** Percentages variant only (absent otherwise): self-reported values of a valid response. */
    percentages?: ValidatedPercentages | null;
  };
}

/** The variant side of a pair, built only from a validated row. */
function variantSide(row: ValidatedVariantRow, withPercentages: boolean): PairedExample['variant'] {
  return {
    prediction: row.prediction,
    correct: row.correct,
    selectedIntent: row.selectedIntent,
    intentSelectedCorrectly: row.intentSelectedCorrectly,
    status: row.status,
    invalidReason: row.invalidReason,
    literalCheck: row.literalCheck,
    latencyMs: row.latencyMs,
    outputTokens: row.outputTokens,
    // json-cleanup-v1 pairs keep exactly their earlier shape.
    ...(withPercentages ? { percentages: row.percentages } : {}),
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

/** Index rows by example ID, refusing duplicates instead of keeping one. */
function uniqueById<Row extends { id: string }>(rows: Row[], side: string): Map<string, Row> {
  const byId = new Map<string, Row>();
  for (const row of rows) {
    if (byId.has(row.id)) {
      throw new SafeEvalError(`${side} has more than one row for example ${row.id}`);
    }
    byId.set(row.id, row);
  }
  return byId;
}

/**
 * One variant report's planned partition of the frozen dataset: unique
 * supported IDs, unique excluded IDs, and no ID in both. Every pairing of a
 * variant report (with the baseline or with another variant) checks this
 * first, so coverage counts can never describe an impossible dataset.
 */
function supportPartition(report: ValidatedVariantReport, side: string) {
  const supported = new Set(report.supportedIds);
  if (supported.size !== report.supportedIds.length) {
    throw new SafeEvalError(`${side} report has missing or duplicate planned supported IDs`);
  }
  const excludedIds = new Set(report.exclusions.map((entry) => entry.id));
  if (
    excludedIds.size !== report.exclusions.length ||
    report.exclusions.some((entry) => supported.has(entry.id))
  ) {
    throw new SafeEvalError(`${side} report lists an example as both supported and excluded`);
  }
  return { supported, excludedIds };
}

function sameIdSet(left: Iterable<string>, right: Set<string>): boolean {
  const leftSet = new Set(left);
  if (leftSet.size !== right.size) {
    return false;
  }
  for (const id of leftSet) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * Two reports and one target name per side. The reports are `unknown` on
 * purpose: they are validated here, whether they came from files or from the
 * runners (through `completedRunnerReport`).
 */
export interface PairSelection {
  baseline: unknown;
  baselineTarget: string;
  variant: unknown;
  variantTarget: string;
}

/**
 * Validate both reports, then build the paired comparison. Throws a bounded,
 * content-free SafeEvalError on any schema, consistency, identity or
 * cardinality problem, before any output exists.
 */
export function pairRuns(selection: PairSelection) {
  // Schema, completeness and per-row consistency (report-schema.ts). From here
  // on only validated, newly constructed values are used.
  const baseline = validateBaselineReport(selection.baseline, selection.baselineTarget);
  const variant = validateVariantReport(selection.variant, selection.variantTarget);

  if (baseline.datasetHash !== variant.datasetHash) {
    throw new SafeEvalError('Baseline and variant used different frozen datasets');
  }

  // Rows of exactly the selected targets, keyed by unique example ID.
  const baselineById = uniqueById(baseline.rows, 'Baseline');
  const variantById = uniqueById(variant.rows, 'Variant');

  // Planned support: the variant must have attempted exactly its supported IDs,
  // and those must be disjoint from its listed exclusions.
  const { supported, excludedIds } = supportPartition(variant, 'Variant');
  const supportedIds = variant.supportedIds;
  const excluded = variant.exclusions;
  if (!sameIdSet(variantById.keys(), supported)) {
    throw new SafeEvalError('Variant rows do not match its planned supported examples exactly');
  }

  // The baseline must cover the whole frozen dataset: supported plus excluded.
  const datasetIds = new Set([...supported, ...excludedIds]);
  if (!sameIdSet(baselineById.keys(), datasetIds)) {
    throw new SafeEvalError(
      'Baseline rows do not match the frozen dataset (supported plus excluded) exactly',
    );
  }

  // One-to-one pairs in the variant's planned order. Hashes and labels are
  // already known to be present and well formed, so equality is real evidence.
  const pairs: PairedExample[] = [];
  for (const id of supportedIds) {
    const baselineRow = baselineById.get(id)!;
    const variantRow = variantById.get(id)!;

    if (baselineRow.inputHash !== variantRow.inputHash) {
      throw new SafeEvalError(`Example ${id}: the two runs used different recorded inputs`);
    }
    if (baselineRow.expected !== variantRow.expected) {
      throw new SafeEvalError(`Example ${id}: the two runs have different labels`);
    }

    pairs.push({
      id,
      expected: baselineRow.expected,
      change: pairChange(baselineRow.correct, variantRow.correct),
      baseline: {
        prediction: baselineRow.prediction,
        correct: baselineRow.correct,
        errorKind: baselineRow.errorKind,
        latencyMs: baselineRow.latencyMs,
        outputTokens: baselineRow.outputTokens,
      },
      variant: variantSide(variantRow, variant.variantId === PERCENTAGES_VARIANT_ID),
    });
  }

  // Full-dataset baseline: context only, never the paired comparator.
  const allBaseline = [...baselineById.values()];
  const allBaselineCorrect = allBaseline.filter((row) => row.correct).length;

  return {
    selection: {
      baseline: { startedAt: baseline.startedAt, target: baseline.target },
      variant: {
        startedAt: variant.startedAt,
        target: variant.target,
        variantId: variant.variantId,
        promptHash: variant.promptHash,
        outputTokens: variant.outputTokens,
      },
    },
    datasetHash: baseline.datasetHash,
    coverage: {
      datasetExamples: datasetIds.size,
      paired: pairs.length,
      excluded: excluded.length,
      pairedFraction: datasetIds.size > 0 ? pairs.length / datasetIds.size : null,
      exclusions: excluded,
    },
    summary: summarizePairs(pairs, variant.variantId === PERCENTAGES_VARIANT_ID),
    baselineFullDataset: {
      note: 'Context only, NOT a paired statistic: includes examples the variant never attempted.',
      correct: allBaselineCorrect,
      total: allBaseline.length,
      accuracy: allBaseline.length > 0 ? allBaselineCorrect / allBaseline.length : null,
    },
    pairs,
  };
}

function summarizePairs(pairs: PairedExample[], withPercentages: boolean) {
  const count = pairs.length;
  const rate = (value: number) => (count > 0 ? value / count : null);

  const baselineCorrect = pairs.filter((pair) => pair.baseline.correct).length;
  const variantCorrect = pairs.filter((pair) => pair.variant.correct).length;
  const variantSelected = pairs.filter((pair) => pair.variant.intentSelectedCorrectly).length;
  const regressions = pairs.filter((pair) => pair.change === 'regression');
  const improvements = pairs.filter((pair) => pair.change === 'improvement');

  // Diagnostic: regressions of intent selection alone (ignoring the rest of the contract).
  const selectionRegressions = pairs.filter(
    (pair) => pair.baseline.correct && !pair.variant.intentSelectedCorrectly,
  );
  const selectionImprovements = pairs.filter(
    (pair) => !pair.baseline.correct && pair.variant.intentSelectedCorrectly,
  );

  const baselineUnregistered = pairs.filter(
    (pair) => pair.baseline.errorKind === 'unregistered-name',
  ).length;
  const baselineOtherErrors = pairs.filter(
    (pair) => pair.baseline.errorKind === 'request-error',
  ).length;
  const variantInvalid = pairs.filter((pair) => pair.variant.status === 'invalid').length;
  const variantErrors = pairs.filter((pair) => pair.variant.status === 'error').length;

  const baselineAccuracy = rate(baselineCorrect);
  const variantAccuracy = rate(variantCorrect);
  const selectionAccuracy = rate(variantSelected);

  return {
    definitions: {
      usable:
        'PRIMARY: correct intent in a response that satisfies that side’s full contract (a registered bare name for the baseline; the strict JSON contract for the variant), over every paired attempt including invalid responses and errors.',
      intentSelection:
        'DIAGNOSTIC: the variant’s intent from a syntactically valid, duplicate-free JSON object even if other contract rules failed. Never repaired or promoted; malformed output counts as wrong.',
    },
    pairedExamples: count,
    baseline: {
      usableCorrect: baselineCorrect,
      usableAccuracy: baselineAccuracy,
      unregisteredNameResponses: baselineUnregistered,
      otherErrors: baselineOtherErrors,
      malformedRate: rate(baselineUnregistered),
    },
    variant: {
      usableCorrect: variantCorrect,
      usableAccuracy: variantAccuracy,
      intentSelectionCorrect: variantSelected,
      intentSelectionAccuracy: selectionAccuracy,
      invalidContractResponses: variantInvalid,
      otherErrors: variantErrors,
      malformedRate: rate(variantInvalid),
      // Percentages variant only: responses that failed only a percentage rule.
      ...(withPercentages ? { percentageRuleFailures: countPercentageFailures(pairs) } : {}),
    },
    usableAccuracyDelta:
      baselineAccuracy !== null && variantAccuracy !== null
        ? variantAccuracy - baselineAccuracy
        : null,
    intentSelectionDelta:
      baselineAccuracy !== null && selectionAccuracy !== null
        ? selectionAccuracy - baselineAccuracy
        : null,
    changes: {
      bothCorrect: pairs.filter((pair) => pair.change === 'both-correct').length,
      regressions: regressions.length,
      improvements: improvements.length,
      bothWrong: pairs.filter((pair) => pair.change === 'both-wrong').length,
      mcnemarExactPValue: mcnemarExactPValue(regressions.length, improvements.length),
    },
    // Why each usable-score regression happened on the variant side.
    regressionCauses: {
      wrongIntent: regressions.filter((pair) => pair.variant.status === 'valid').length,
      invalidContract: regressions.filter((pair) => pair.variant.status === 'invalid').length,
      transportError: regressions.filter((pair) => pair.variant.status === 'error').length,
    },
    regressionIds: regressions.map((pair) => pair.id),
    improvementIds: improvements.map((pair) => pair.id),
    intentSelectionDiagnostic: {
      regressionIds: selectionRegressions.map((pair) => pair.id),
      improvementIds: selectionImprovements.map((pair) => pair.id),
    },
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
  };
}

function countPercentageFailures(pairs: PairedExample[]): number {
  return pairs.filter(
    (pair) =>
      pair.variant.invalidReason !== null && PERCENTAGE_REASONS.has(pair.variant.invalidReason),
  ).length;
}

// ---------------------------------------------------------------------------
// Variant versus variant (for example json-cleanup-percentages-v1 vs json-cleanup-v1)
// ---------------------------------------------------------------------------

/** Two variant reports and one target name per side, validated like `pairRuns`. */
export interface VariantPairSelection {
  left: unknown;
  leftTarget: string;
  right: unknown;
  rightTarget: string;
}

/** Pair one variant side with the other; `change` goes from left to right. */
interface VariantVersusVariantPair {
  id: string;
  expected: string;
  change: PairChange;
  left: PairedExample['variant'];
  right: PairedExample['variant'];
}

function variantRowsById(report: ValidatedVariantReport, side: string) {
  const { supported } = supportPartition(report, side);
  const byId = uniqueById(report.rows, side);
  if (!sameIdSet(byId.keys(), supported)) {
    throw new SafeEvalError(`${side} rows do not match its planned supported examples exactly`);
  }
  return { byId, supported };
}

function sideStatistics(sides: PairedExample['variant'][], withPercentages: boolean) {
  const count = sides.length;
  const rate = (value: number) => (count > 0 ? value / count : null);
  const usableCorrect = sides.filter((side) => side.correct).length;
  const selected = sides.filter((side) => side.intentSelectedCorrectly).length;
  const invalid = sides.filter((side) => side.status === 'invalid').length;

  return {
    usableCorrect,
    usableAccuracy: rate(usableCorrect),
    intentSelectionCorrect: selected,
    intentSelectionAccuracy: rate(selected),
    invalidContractResponses: invalid,
    otherErrors: sides.filter((side) => side.status === 'error').length,
    malformedRate: rate(invalid),
    ...(withPercentages
      ? {
          percentageRuleFailures: sides.filter(
            (side) => side.invalidReason !== null && PERCENTAGE_REASONS.has(side.invalidReason),
          ).length,
        }
      : {}),
  };
}

/**
 * Strict pairing of two JSON variant runs on the same frozen dataset, for
 * example whether adding self-reported percentages (right) changes intent
 * recognition compared with json-cleanup-v1 (left). Same rules as `pairRuns`:
 * validated reports, same dataset hash, identical planned support and
 * exclusions (both variants use the same transformation support), one-to-one
 * by unique example ID, matching `inputHash` and labels, every attempt counted.
 */
export function pairVariantRuns(selection: VariantPairSelection) {
  const left = validateVariantReport(selection.left, selection.leftTarget);
  const right = validateVariantReport(selection.right, selection.rightTarget);

  if (left.datasetHash !== right.datasetHash) {
    throw new SafeEvalError('The two variant runs used different frozen datasets');
  }

  const leftRows = variantRowsById(left, 'Left');
  const rightRows = variantRowsById(right, 'Right');
  if (!sameIdSet(leftRows.supported, rightRows.supported)) {
    throw new SafeEvalError('The two variant runs planned different supported examples');
  }
  const leftExcluded = new Set(left.exclusions.map((entry) => entry.id));
  if (
    leftExcluded.size !== left.exclusions.length ||
    !sameIdSet(
      right.exclusions.map((entry) => entry.id),
      leftExcluded,
    ) ||
    right.exclusions.length !== left.exclusions.length
  ) {
    throw new SafeEvalError('The two variant runs excluded different examples');
  }

  const leftPercentages = left.variantId === PERCENTAGES_VARIANT_ID;
  const rightPercentages = right.variantId === PERCENTAGES_VARIANT_ID;

  const pairs: VariantVersusVariantPair[] = [];
  for (const id of left.supportedIds) {
    const leftRow = leftRows.byId.get(id)!;
    const rightRow = rightRows.byId.get(id)!;
    if (leftRow.inputHash !== rightRow.inputHash) {
      throw new SafeEvalError(`Example ${id}: the two runs used different recorded inputs`);
    }
    if (leftRow.expected !== rightRow.expected) {
      throw new SafeEvalError(`Example ${id}: the two runs have different labels`);
    }
    pairs.push({
      id,
      expected: leftRow.expected,
      change: pairChange(leftRow.correct, rightRow.correct),
      left: variantSide(leftRow, leftPercentages),
      right: variantSide(rightRow, rightPercentages),
    });
  }

  const regressions = pairs.filter((pair) => pair.change === 'regression');
  const improvements = pairs.filter((pair) => pair.change === 'improvement');
  const leftStatistics = sideStatistics(
    pairs.map((pair) => pair.left),
    leftPercentages,
  );
  const rightStatistics = sideStatistics(
    pairs.map((pair) => pair.right),
    rightPercentages,
  );
  const delta = (leftValue: number | null, rightValue: number | null) =>
    leftValue !== null && rightValue !== null ? rightValue - leftValue : null;

  const describe = (report: ValidatedVariantReport) => ({
    startedAt: report.startedAt,
    target: report.target,
    variantId: report.variantId,
    promptHash: report.promptHash,
    outputTokens: report.outputTokens,
  });

  return {
    selection: { left: describe(left), right: describe(right) },
    datasetHash: left.datasetHash,
    coverage: {
      paired: pairs.length,
      excluded: left.exclusions.length,
      exclusions: left.exclusions,
    },
    summary: {
      definitions: {
        usable:
          'PRIMARY: correct intent in a fully contract-valid response of that variant, over every paired attempt including invalid responses and errors.',
        intentSelection:
          'DIAGNOSTIC: intent from a syntactically valid, duplicate-free JSON object even if other contract rules failed; never repaired or promoted.',
        change: 'From left to right: a regression is left usable-correct and right not.',
      },
      pairedExamples: pairs.length,
      left: leftStatistics,
      right: rightStatistics,
      usableAccuracyDelta: delta(leftStatistics.usableAccuracy, rightStatistics.usableAccuracy),
      intentSelectionDelta: delta(
        leftStatistics.intentSelectionAccuracy,
        rightStatistics.intentSelectionAccuracy,
      ),
      changes: {
        bothCorrect: pairs.filter((pair) => pair.change === 'both-correct').length,
        regressions: regressions.length,
        improvements: improvements.length,
        bothWrong: pairs.filter((pair) => pair.change === 'both-wrong').length,
        mcnemarExactPValue: mcnemarExactPValue(regressions.length, improvements.length),
      },
      regressionCauses: {
        wrongIntent: regressions.filter((pair) => pair.right.status === 'valid').length,
        invalidContract: regressions.filter((pair) => pair.right.status === 'invalid').length,
        transportError: regressions.filter((pair) => pair.right.status === 'error').length,
      },
      regressionIds: regressions.map((pair) => pair.id),
      improvementIds: improvements.map((pair) => pair.id),
      intentSelectionDiagnostic: {
        regressionIds: pairs
          .filter(
            (pair) => pair.left.intentSelectedCorrectly && !pair.right.intentSelectedCorrectly,
          )
          .map((pair) => pair.id),
        improvementIds: pairs
          .filter(
            (pair) => !pair.left.intentSelectedCorrectly && pair.right.intentSelectedCorrectly,
          )
          .map((pair) => pair.id),
      },
      latencyMs: {
        left: latencyStatistics(pairs.map((pair) => pair.left.latencyMs)),
        right: latencyStatistics(pairs.map((pair) => pair.right.latencyMs)),
        // Per-example right minus left; negative means the right variant was faster.
        pairedDifference: latencyStatistics(
          pairs.map((pair) => pair.right.latencyMs - pair.left.latencyMs),
        ),
      },
      meanOutputTokens: {
        left: mean(pairs.map((pair) => pair.left.outputTokens)),
        right: mean(pairs.map((pair) => pair.right.outputTokens)),
      },
    },
    pairs,
  };
}
