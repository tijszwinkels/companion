import { performance } from 'node:perf_hooks';

import { fingerprint, loadDataset, recordedIntents, restoreExample } from './dataset.ts';
import { complete, requestBody, validateTargets, type EvalTarget } from './transport.ts';

export interface EvalResult {
  id: string;
  target: string;
  expected: string;
  originalPrediction: string | null;
  prediction: string | null;
  correct: boolean;
  error: string | null;
  latencyMs: number;
  inputHash: string;
  requestHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

function percentile(values: number[], fraction: number): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
}

export function summarize(results: EvalResult[]) {
  const summaries = [];
  for (const target of new Set(results.map((result) => result.target))) {
    const rows = results.filter((result) => result.target === target);
    const confusion: Record<string, Record<string, number>> = Object.create(null);
    for (const row of rows) {
      const predictions = (confusion[row.expected] ??= Object.create(null) as Record<
        string,
        number
      >);
      const predicted = row.prediction ?? '<ERROR>';
      predictions[predicted] = (predictions[predicted] ?? 0) + 1;
    }
    const correct = rows.filter((row) => row.correct).length;
    summaries.push({
      target,
      total: rows.length,
      correct,
      errors: rows.filter((row) => row.error !== null).length,
      // Errors count against accuracy rather than disappearing from its denominator.
      accuracy: correct / rows.length,
      latencyMs: {
        mean: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
        p50: percentile(
          rows.map((row) => row.latencyMs),
          0.5,
        ),
        p95: percentile(
          rows.map((row) => row.latencyMs),
          0.95,
        ),
      },
      estimatedCost: rows.every((row) => row.estimatedCost !== null)
        ? rows.reduce((sum, row) => sum + row.estimatedCost!, 0)
        : null,
      pricedResults: rows.filter((row) => row.estimatedCost !== null).length,
      confusion,
      regressionsFromRecordedPrediction: rows
        .filter((row) => row.originalPrediction === row.expected && !row.correct)
        .map((row) => row.id),
    });
  }
  return summaries;
}

/** Sequential, bounded inference only. No sensor, router, processor, or UI imports. */
export async function runEvaluation(
  datasetPath: string,
  targets: EvalTarget[],
  signal: AbortSignal = new AbortController().signal,
) {
  validateTargets(targets);
  for (const target of targets) {
    if (target.apiKeyEnv && !process.env[target.apiKeyEnv]) {
      throw Error(`Missing API key environment variable: ${target.apiKeyEnv}`);
    }
  }
  const dataset = await loadDataset(datasetPath);

  // Validate every artifact before any network call, so broken fixtures cannot
  // create a partially comparable run. Restore again per example to bound memory.
  for (const example of dataset.examples) {
    signal.throwIfAborted();
    await restoreExample(datasetPath, example);
  }
  const results: EvalResult[] = [];
  const startedAt = new Date().toISOString();

  for (const example of dataset.examples) {
    const record = await restoreExample(datasetPath, example);
    const { model: _originalModel, ...fixedInputs } = record.body;
    const inputHash = fingerprint(fixedInputs);
    const allowed = recordedIntents(record);

    for (const target of targets) {
      signal.throwIfAborted();
      const body = requestBody(record, target);
      const started = performance.now();
      const result: EvalResult = {
        id: example.id,
        target: target.name,
        expected: example.expected,
        originalPrediction: example.originalPrediction,
        prediction: null,
        correct: false,
        error: null,
        latencyMs: 0,
        inputHash,
        requestHash: fingerprint(body),
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
      };
      try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(target.timeoutMs ?? 30_000)]);
        const reply = await complete(body, target, deadline);
        result.inputTokens = reply.inputTokens;
        result.outputTokens = reply.outputTokens;
        if (target.pricing && reply.inputTokens !== null && reply.outputTokens !== null) {
          result.estimatedCost =
            (reply.inputTokens * target.pricing.inputPerMillion +
              reply.outputTokens * target.pricing.outputPerMillion) /
            1_000_000;
        }
        if (!allowed.includes(reply.text)) {
          throw Error('Response is not a registered intent name');
        }
        result.prediction = reply.text;
        result.correct = reply.text === example.expected;
      } catch (error) {
        signal.throwIfAborted();
        result.error = (error as Error).message;
      }
      result.latencyMs = performance.now() - started;
      results.push(result);
    }
  }

  const baseline = targets[0]!.name;
  return {
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    datasetHash: fingerprint(dataset),
    policy: 'Only body.model changes; no prompt conversion, retries, or action execution.',
    targets,
    baseline,
    summary: summarize(results),
    comparisons: targets.slice(1).map((target) => {
      const baselineRows = new Map(
        results.filter((row) => row.target === baseline).map((row) => [row.id, row]),
      );
      const rows = results.filter((row) => row.target === target.name);
      return {
        target: target.name,
        regressions: rows
          .filter((row) => baselineRows.get(row.id)!.correct && !row.correct)
          .map((row) => row.id),
        improvements: rows
          .filter((row) => !baselineRows.get(row.id)!.correct && row.correct)
          .map((row) => row.id),
      };
    }),
    results,
  };
}
