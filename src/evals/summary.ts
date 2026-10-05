/**
 * Scoring and timing statistics for an evaluation report.
 *
 * Input: per-request results in canonical order plus the measured wall time of
 * each target's batch. Output: one summary per target, in target order.
 *
 * Two different timing views are reported and must not be confused:
 * - Per-request latency: client-observed time for one request, including any
 *   queueing inside the inference server. Higher concurrency can increase it.
 * - Batch wall time and throughput: elapsed time for a target's whole batch and
 *   completed requests per second. This is where concurrency can help.
 */
import type { EvalTarget } from './transport.ts';

export interface EvalResult {
  id: string;
  target: string;
  expected: string;
  originalPrediction: string | null;
  prediction: string | null;
  correct: boolean;
  error: string | null;
  /** Request start to full response read or failure, in milliseconds. */
  latencyMs: number;
  inputHash: string;
  requestHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

/** Measured timing of one target's isolated batch. */
export interface BatchTiming {
  target: string;
  concurrency: number;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
}

export interface LatencyStatistics {
  count: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Nearest-rank percentile. Returns null for an empty sample. */
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[rank]!;
}

function latencyStatistics(values: number[]): LatencyStatistics {
  if (values.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, p95Ms: null };
  }

  let total = 0;
  for (const value of values) {
    total += value;
  }

  return {
    count: values.length,
    meanMs: total / values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function confusionCounts(rows: EvalResult[]): Record<string, Record<string, number>> {
  const confusion: Record<string, Record<string, number>> = Object.create(null);

  for (const row of rows) {
    let predictions = confusion[row.expected];
    if (predictions === undefined) {
      predictions = Object.create(null) as Record<string, number>;
      confusion[row.expected] = predictions;
    }

    const predicted = row.prediction ?? '<ERROR>';
    predictions[predicted] = (predictions[predicted] ?? 0) + 1;
  }

  return confusion;
}

function totalCost(rows: EvalResult[]): number | null {
  let total = 0;

  for (const row of rows) {
    // One unknown cost makes the total unknown rather than silently low.
    if (row.estimatedCost === null) {
      return null;
    }
    total += row.estimatedCost;
  }

  return total;
}

export function summarize(targets: EvalTarget[], results: EvalResult[], batches: BatchTiming[]) {
  const summaries = [];

  for (const target of targets) {
    const rows = results.filter((result) => result.target === target.name);
    const successful = rows.filter((row) => row.error === null);
    const correct = rows.filter((row) => row.correct).length;

    const batch = batches.find((timing) => timing.target === target.name);
    if (!batch) {
      throw Error(`Missing batch timing for target ${target.name}`);
    }
    const wallTimeSeconds = batch.wallTimeMs / 1000;

    summaries.push({
      target: target.name,
      model: target.model,
      concurrency: batch.concurrency,
      total: rows.length,
      correct,
      errors: rows.length - successful.length,
      // Errors count against accuracy rather than disappearing from its denominator.
      accuracy: correct / rows.length,
      batch: {
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
        wallTimeMs: batch.wallTimeMs,
        // Throughput counts every completed request, including errors.
        requestsPerSecond: wallTimeSeconds > 0 ? rows.length / wallTimeSeconds : null,
        successfulRequestsPerSecond:
          wallTimeSeconds > 0 ? successful.length / wallTimeSeconds : null,
      },
      latencyMs: {
        // Includes failed requests: fast refusals and slow timeouts both count.
        allRequests: latencyStatistics(rows.map((row) => row.latencyMs)),
        // Only requests that produced a valid intent-name response.
        successfulRequests: latencyStatistics(successful.map((row) => row.latencyMs)),
      },
      estimatedCost: totalCost(rows),
      pricedResults: rows.filter((row) => row.estimatedCost !== null).length,
      confusion: confusionCounts(rows),
      regressionsFromRecordedPrediction: rows
        .filter((row) => row.originalPrediction === row.expected && !row.correct)
        .map((row) => row.id),
    });
  }

  return summaries;
}

/** Per-example differences from the first (baseline) target. */
export function compareWithBaseline(targets: EvalTarget[], results: EvalResult[]) {
  const baseline = targets[0]!.name;
  const baselineRows = new Map<string, EvalResult>();
  for (const row of results) {
    if (row.target === baseline) {
      baselineRows.set(row.id, row);
    }
  }

  const comparisons = [];
  for (const target of targets.slice(1)) {
    const regressions: string[] = [];
    const improvements: string[] = [];

    for (const row of results) {
      if (row.target !== target.name) {
        continue;
      }

      const baselineRow = baselineRows.get(row.id)!;
      if (baselineRow.correct && !row.correct) {
        regressions.push(row.id);
      }
      if (!baselineRow.correct && row.correct) {
        improvements.push(row.id);
      }
    }

    comparisons.push({ target: target.name, regressions, improvements });
  }

  return comparisons;
}
