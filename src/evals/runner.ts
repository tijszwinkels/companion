/**
 * Evaluation runner: replays frozen recorded intent requests against explicit
 * targets and builds the JSON report.
 *
 * Input: a frozen dataset path, validated targets and a cancellation signal.
 * Output: a version 2 report with canonical per-request results and summaries.
 *
 * Scheduling: targets run one after another in isolated batches, in target
 * order. Within a batch, up to `target.concurrency` requests (default 1) are in
 * flight. Two targets never share the wire at the same time, so one target's
 * load cannot slow another target's measured latency or throughput.
 *
 * Determinism: results are stored by (target, example) position, not by
 * completion time. The report lists them target by target in dataset order,
 * with exactly one result per example and target.
 *
 * This module imports no sensor, router, processor, history-writer or UI code,
 * and never executes a detected action.
 */
import { performance } from 'node:perf_hooks';

import {
  fingerprint,
  loadDataset,
  recordedIntents,
  restoreExample,
  type EvalDataset,
  type EvalExample,
} from './dataset.ts';
import { describeRequestError, SafeEvalError } from './errors.ts';
import { runBounded } from './pool.ts';
import { compareWithBaseline, summarize, type BatchTiming, type EvalResult } from './summary.ts';
import { complete, requestBody, validateTargets, type EvalTarget } from './transport.ts';

export type { EvalResult } from './summary.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 1;

/**
 * Send one example to one target and score it.
 *
 * Ordinary request failures (HTTP errors, timeouts, invalid responses) become
 * an error in the returned result. Cancellation of the batch signal is rethrown
 * instead, so an interrupted request is never scored as a model error.
 */
async function evaluateExample(
  datasetPath: string,
  example: EvalExample,
  target: EvalTarget,
  batchSignal: AbortSignal,
): Promise<EvalResult> {
  // Restore per request instead of holding every screenshot in memory. Restoring
  // happens before the latency timer starts; it counts only toward wall time.
  const record = await restoreExample(datasetPath, example);
  const { model: _originalModel, ...fixedInputs } = record.body;
  const allowedIntents = recordedIntents(record);
  const body = requestBody(record, target);

  const result: EvalResult = {
    id: example.id,
    target: target.name,
    expected: example.expected,
    originalPrediction: example.originalPrediction,
    prediction: null,
    correct: false,
    error: null,
    latencyMs: 0,
    inputHash: fingerprint(fixedInputs),
    requestHash: fingerprint(body),
    inputTokens: null,
    outputTokens: null,
    estimatedCost: null,
  };

  // The timeout is per request and starts now, so time spent waiting for a
  // free concurrency slot never counts against it. Server-side queueing does.
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

    if (!allowedIntents.includes(reply.text)) {
      throw new SafeEvalError('Response is not a registered intent name');
    }
    result.prediction = reply.text;
    result.correct = reply.text === example.expected;
  } catch (error) {
    batchSignal.throwIfAborted();

    // Only eval-written messages and allowlisted causes reach the report;
    // library messages could echo keys or private request data.
    if (timeoutSignal.aborted) {
      result.error = `Request timed out after ${timeoutMs} ms`;
    } else {
      result.error = describeRequestError(error);
    }
  }

  result.latencyMs = performance.now() - started;
  return result;
}

/** Run all examples for one target with bounded concurrency. */
async function runTargetBatch(
  datasetPath: string,
  dataset: EvalDataset,
  target: EvalTarget,
  signal: AbortSignal,
): Promise<{ results: EvalResult[]; timing: BatchTiming }> {
  const concurrency = target.concurrency ?? DEFAULT_CONCURRENCY;
  const startedAt = new Date().toISOString();
  const started = performance.now();

  // runBounded returns results in example order and, on cancellation or a fatal
  // error, rejects only after every active request has settled.
  const results = await runBounded(
    dataset.examples.length,
    concurrency,
    signal,
    (index, batchSignal) =>
      evaluateExample(datasetPath, dataset.examples[index]!, target, batchSignal),
  );

  const wallTimeMs = performance.now() - started;
  const timing: BatchTiming = {
    target: target.name,
    concurrency,
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs,
  };
  return { results, timing };
}

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
  // create a partially comparable run. Restore again per request to bound memory.
  for (const example of dataset.examples) {
    signal.throwIfAborted();
    await restoreExample(datasetPath, example);
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results: EvalResult[] = [];
  const batches: BatchTiming[] = [];

  // Targets run strictly one after another. See the module comment.
  for (const target of targets) {
    signal.throwIfAborted();
    const batch = await runTargetBatch(datasetPath, dataset, target, signal);
    results.push(...batch.results);
    batches.push(batch.timing);
  }

  const wallTimeMs = performance.now() - started;

  return {
    version: 2,
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs,
    datasetHash: fingerprint(dataset),
    policy: 'Only body.model changes; no prompt conversion, retries, or action execution.',
    schedule:
      'Targets run sequentially in isolated batches; each batch has at most target.concurrency requests in flight.',
    // Resolved values, so every report states the concurrency actually used.
    targets: targets.map((target) => ({
      ...target,
      timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      concurrency: target.concurrency ?? DEFAULT_CONCURRENCY,
    })),
    baseline: targets[0]!.name,
    summary: summarize(targets, results, batches),
    comparisons: compareWithBaseline(targets, results),
    results,
  };
}
