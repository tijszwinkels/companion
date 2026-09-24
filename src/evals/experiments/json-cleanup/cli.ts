/**
 * CLI for the offline JSON intent + spoken-text cleanup experiment.
 *
 * The first question this experiment answers is whether requesting JSON plus
 * cleaned text reduces intent-detection quality compared with exact replay.
 * `compare` answers it on identical frozen examples; cleanup output is
 * secondary evidence for human inspection. Nothing here is wired into the
 * running application, and no response is ever executed.
 *
 * Commands:
 * - prompt:  print the versioned instruction templates. No files, no network.
 * - dry-run: validate a dataset/fixture, targets, output budget and optional
 *            literal checks, and print content-free counts, hashes and the
 *            variant description. Makes zero model calls.
 * - compare: paired run of the unmodified exact-replay baseline and the variant
 *            on the same frozen dataset (requires --send).
 * - run:     variant only, for a frozen dataset or fixed-route fixtures
 *            (requires --send).
 * - pair:    offline, strict pairing of an existing exact-replay report and an
 *            existing inferred variant report (one target each). Zero calls.
 *
 * compare/run write a shareable report plus a separate private outputs file.
 * Output handling mirrors `eval:intents`: both files are reserved (mode 0600,
 * never overwritten) with an "incomplete" marker before any call; the first
 * stop signal aborts and drains gracefully, a second signal exits immediately.
 */
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { parseLocalJson } from '../../errors.ts';
import { parseTargets, type EvalTarget } from '../../transport.ts';
import { assertChecksMatchExamples, loadLiteralChecks, type LiteralChecks } from './checks.ts';
import { ARM_ORDERS, runPairedComparison, type ArmOrder } from './compare.ts';
import { TEXT_ROUTES } from './contract.ts';
import { pairRuns, type BaselineRunReport, type VariantRunReport } from './pairing.ts';
import {
  fixedRouteSystemPrompt,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  promptFingerprint,
  RECORDED_ANSWER_SENTENCE,
  RECORDED_IGNORE_SENTENCE,
  transformRecordedRequest,
  VARIANT_ANSWER_SENTENCE,
  VARIANT_ID,
  VARIANT_IGNORE_SENTENCE,
} from './prompt.ts';
import {
  describeVariant,
  planExperiment,
  runExperiment,
  type ExperimentMode,
  type ExperimentSource,
  type PrivateOutput,
} from './runner.ts';

const help = `Companion intent JSON + spoken-text cleanup EXPERIMENT (${VARIANT_ID})

This is NOT exact replay: the variant changes the recorded prompt and output
budget. It is eval-only: nothing is integrated into the running application.
"npm run eval:intents" (exact replay) is unaffected by this command.

npm run eval:intent-cleanup -- prompt
npm run eval:intent-cleanup -- dry-run (--dataset DATASET.json | --fixed-routes FIXTURE.json) \\
  --targets targets.json --output-tokens N [--checks CHECKS.json]
npm run eval:intent-cleanup -- compare --dataset DATASET.json --targets targets.json \\
  --output-tokens N [--order baseline-first|variant-first] [--checks CHECKS.json] \\
  --out new-report.json --private-out new-private-outputs.json --send
npm run eval:intent-cleanup -- run (--dataset DATASET.json | --fixed-routes FIXTURE.json) \\
  --targets targets.json --output-tokens N [--checks CHECKS.json] \\
  --out new-report.json --private-out new-private-outputs.json --send
npm run eval:intent-cleanup -- pair --baseline-report EXACT.json --baseline-target NAME \\
  --variant-report VARIANT.json --variant-target NAME --out new-pairing.json

prompt:   prints the instruction templates (no private data, no network).
dry-run:  validates everything and prints counts/hashes. Zero model calls.
compare:  PRIMARY QUESTION. Runs the unmodified exact-replay baseline and the
          variant on the same frozen examples and targets, one arm after the
          other, and reports paired accuracy, per-example regressions and
          improvements, malformed-output rates and latency. Default order
          baseline-first; run again with the other order to check cache effects.
run:      variant only (also for fixed-route shortcut fixtures).
pair:     offline strict pairing of an existing "eval:intents run" report and an
          existing inferred "run" report, one selected target each. Requires the
          same frozen dataset; pairs one-to-one by example ID; restricts the
          baseline to the variant's planned support; refuses missing, duplicate
          or mismatched rows. Never joins by content hash. Zero model calls.
compare and run send private text/context/screenshots to every target and
require --send.

--dataset       dataset.json from "eval:intents export" (inferred routes; recorded
                requests only, never reconstructed).
--fixed-routes  explicit, user-supplied fixed-route (shortcut) fixture file.
--output-tokens explicit experimental output budget, ${MIN_OUTPUT_TOKENS}-${MAX_OUTPUT_TOKENS}
                (recorded requests use 32; the report records the delta).
--checks        optional fixture-specified literal checks (must/must-not contain)
                on cleaned text. Reported as IDs and counts; not a quality score.
--out           shareable report: hashes, accuracy, JSON validity, invalid
                reasons, latency. Contains no dictated or cleaned text.
--private-out   PRIVATE file with spoken text, cleaned text and raw invalid
                responses for human review. Keep it out of Git and chats.

Targets use the same JSON format as eval:intents (model, baseUrl, apiKeyEnv,
timeoutMs, concurrency 1-16, pricing). No retries, no response repair, no LLM
judge, no action execution. See docs/intent-json-cleanup-experiment.md.
`;

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const REPORT_KIND: Record<'run' | 'compare', string> = {
  run: 'intent-json-cleanup-experiment',
  compare: 'intent-json-cleanup-paired-comparison',
};
const PRIVATE_KIND = 'intent-json-cleanup-private-outputs';

async function replaceFile(output: FileHandle, value: object): Promise<void> {
  await output.truncate(0);
  await output.write(JSON.stringify(value, null, 2) + '\n', 0);
  await output.sync();
}

function parseOutputTokens(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw Error(
      `--output-tokens is required: an integer from ${MIN_OUTPUT_TOKENS} to ${MAX_OUTPUT_TOKENS}`,
    );
  }
  return Number(value);
}

function parseOrder(value: string | undefined): ArmOrder {
  if (value === undefined) {
    return 'baseline-first';
  }
  if (!(ARM_ORDERS as readonly string[]).includes(value)) {
    throw Error('--order must be baseline-first or variant-first');
  }
  return value as ArmOrder;
}

function sourceFrom(values: { dataset?: string; 'fixed-routes'?: string }): ExperimentSource {
  const hasDataset = values.dataset !== undefined;
  const hasFixedRoutes = values['fixed-routes'] !== undefined;
  if (hasDataset === hasFixedRoutes) {
    throw Error('Specify exactly one of --dataset or --fixed-routes');
  }

  const mode: ExperimentMode = hasDataset ? 'inferred' : 'fixed-route';
  return { mode, datasetPath: (values.dataset ?? values['fixed-routes'])! };
}

/** Print the templates for review. Uses a synthetic prompt, never a recording. */
function printPrompt(): void {
  const syntheticRecordedPrompt = `…recorded preamble… ${RECORDED_ANSWER_SENTENCE}\n…the user didn't intent to use any of the available systems. ${RECORDED_IGNORE_SENTENCE}\n…\n\nPossible intents:\n\nName: IGNORE\nInstruction: …\n\nName: SEND_TEXT_TO_APPLICATION\nInstruction: …\n\nName: START_CODING_AGENT_SESSION\nInstruction: …\n\nName: CONTINUE_OPEN_AGENT_CONVERSATION\nInstruction: …\n`;
  const transformed = transformRecordedRequest(
    {
      version: 1,
      api: 'openai-completions',
      baseUrl: 'http://synthetic.invalid/v1',
      preparedAt: 0,
      body: { messages: [{ role: 'system', content: syntheticRecordedPrompt }], max_tokens: 32 },
    },
    MIN_OUTPUT_TOKENS,
  );
  const systemMessage = (transformed.body.messages as { content: string }[])[0]!;

  console.log(`Variant ${VARIANT_ID}; prompt hash ${promptFingerprint()}\n`);
  console.log('=== Inferred routes: sentence replacements in the recorded system prompt ===');
  console.log(`- ${RECORDED_ANSWER_SENTENCE}\n+ ${VARIANT_ANSWER_SENTENCE}`);
  console.log(`- ${RECORDED_IGNORE_SENTENCE}\n+ ${VARIANT_IGNORE_SENTENCE}\n`);
  console.log(
    '=== Inferred routes: resulting system prompt for a synthetic recording offering all three inferred text routes ===',
  );
  console.log(systemMessage.content);

  for (const route of TEXT_ROUTES) {
    console.log(`=== Fixed route ${route}: complete system prompt ===`);
    console.log(fixedRouteSystemPrompt(route));
  }
}

/** Summary written to stdout after a successful compare/run. Content-free. */
interface Completed {
  report: object & { datasetHash: string };
  privateOutputs: PrivateOutput[];
  console: object;
  hasErrors: boolean;
}

/**
 * Reserve both output files, run `work` with a stop-signal controller, and
 * replace both files with the result or an explicit failure. Existing files or
 * a missing parent fail before any model call.
 */
async function withReservedOutputs(
  command: 'run' | 'compare',
  reportPath: string,
  privatePath: string,
  work: (signal: AbortSignal) => Promise<Completed>,
): Promise<void> {
  if (reportPath === privatePath) {
    throw Error('--out and --private-out must be different files');
  }

  const reportKind = REPORT_KIND[command];
  const reportFile = await open(reportPath, 'wx', 0o600);
  let privateFile: FileHandle;
  try {
    privateFile = await open(privatePath, 'wx', 0o600);
  } catch (error) {
    await replaceFile(reportFile, {
      kind: reportKind,
      state: 'failed',
      failed: true,
      error: 'Private outputs file could not be reserved; nothing was sent',
    });
    await reportFile.close();
    throw error;
  }

  const incomplete = {
    state: 'incomplete',
    note: 'Run started but did not finish writing a result; no score is claimed.',
    startedAt: new Date().toISOString(),
  };
  await replaceFile(reportFile, { kind: reportKind, ...incomplete });
  await replaceFile(privateFile, { kind: PRIVATE_KIND, ...incomplete });

  // The first stop signal aborts gracefully: no new requests, active requests
  // aborted and drained, then "failed" files. Handlers are removed at once, so
  // a second signal takes its default action and ends the process immediately.
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    removeStopHandlers();
    controller.abort(Error(`Experiment interrupted by ${signal}`));
  };
  const removeStopHandlers = () => {
    for (const signal of STOP_SIGNALS) {
      process.removeListener(signal, interrupt);
    }
  };
  for (const signal of STOP_SIGNALS) {
    process.on(signal, interrupt);
  }

  try {
    const completed = await work(controller.signal);

    await replaceFile(privateFile, {
      kind: PRIVATE_KIND,
      state: 'complete',
      sensitive:
        'Contains dictated text and model outputs. Keep out of Git, chats and coding-model prompts; delete when reviewed.',
      variant: VARIANT_ID,
      datasetHash: completed.report.datasetHash,
      outputs: completed.privateOutputs,
    });
    await replaceFile(reportFile, { state: 'complete', ...completed.report });

    console.log(
      JSON.stringify(
        { ...completed.console, report: reportPath, privateOutputs: privatePath },
        null,
        2,
      ),
    );
    if (completed.hasErrors) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Partial results are not saved; both files state only why the run failed.
    const failed = {
      state: 'failed',
      failed: true,
      interrupted: controller.signal.aborted,
      error: (error as Error).message,
    };
    await replaceFile(privateFile, { kind: PRIVATE_KIND, ...failed });
    await replaceFile(reportFile, { kind: reportKind, ...failed });
    throw error;
  } finally {
    removeStopHandlers();
    await privateFile.close();
    await reportFile.close();
  }
}

/**
 * Offline strict pairing of two existing report files. Reads only reports
 * (which contain no dictated text) and writes one new 0600 file.
 */
async function pairReports(values: {
  'baseline-report'?: string;
  'baseline-target'?: string;
  'variant-report'?: string;
  'variant-target'?: string;
  out?: string;
}): Promise<void> {
  const baselinePath = values['baseline-report'];
  const variantPath = values['variant-report'];
  const baselineTarget = values['baseline-target'];
  const variantTarget = values['variant-target'];
  if (!baselinePath || !variantPath || !baselineTarget || !variantTarget || !values.out) {
    throw Error(
      'pair requires --baseline-report, --baseline-target, --variant-report, --variant-target and --out',
    );
  }

  const baseline = parseLocalJson(await readFile(baselinePath, 'utf8'), 'Baseline report');
  const variant = parseLocalJson(await readFile(variantPath, 'utf8'), 'Variant report');
  const comparison = pairRuns({
    baseline: baseline as BaselineRunReport,
    baselineTarget,
    variant: variant as VariantRunReport,
    variantTarget,
  });

  // Never overwrite an earlier result; fail before writing anything partial.
  const output = await open(values.out, 'wx', 0o600);
  try {
    await replaceFile(output, {
      kind: 'intent-json-cleanup-offline-pairing',
      version: 1,
      state: 'complete',
      createdAt: new Date().toISOString(),
      sources: { baselineReport: baselinePath, variantReport: variantPath },
      ...comparison,
    });
  } finally {
    await output.close();
  }

  console.log(
    JSON.stringify(
      {
        modelCalls: 0,
        selection: comparison.selection,
        coverage: {
          datasetExamples: comparison.coverage.datasetExamples,
          paired: comparison.coverage.paired,
          excluded: comparison.coverage.excluded,
        },
        summary: comparison.summary,
        baselineFullDataset: comparison.baselineFullDataset,
        report: values.out,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      dataset: { type: 'string' },
      'fixed-routes': { type: 'string' },
      targets: { type: 'string' },
      'output-tokens': { type: 'string' },
      checks: { type: 'string' },
      order: { type: 'string' },
      'baseline-report': { type: 'string' },
      'baseline-target': { type: 'string' },
      'variant-report': { type: 'string' },
      'variant-target': { type: 'string' },
      out: { type: 'string' },
      'private-out': { type: 'string' },
      send: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }

  const command = positionals[0];
  const allowed: Record<string, string[]> = {
    prompt: [],
    pair: ['baseline-report', 'baseline-target', 'variant-report', 'variant-target', 'out'],
    'dry-run': ['dataset', 'fixed-routes', 'targets', 'output-tokens', 'checks'],
    // fixed-routes is accepted only to refuse it with an explanation below.
    compare: [
      'dataset',
      'fixed-routes',
      'targets',
      'output-tokens',
      'checks',
      'order',
      'out',
      'private-out',
      'send',
    ],
    run: [
      'dataset',
      'fixed-routes',
      'targets',
      'output-tokens',
      'checks',
      'out',
      'private-out',
      'send',
    ],
  };
  if (
    positionals.length !== 1 ||
    !command ||
    !allowed[command] ||
    Object.keys(values).some((key) => !allowed[command]!.includes(key))
  ) {
    throw Error('Unknown command or inappropriate option; use --help');
  }

  if (command === 'prompt') {
    printPrompt();
    return;
  }

  if (command === 'pair') {
    await pairReports(values);
    return;
  }

  const source = sourceFrom(values);
  const outputTokens = parseOutputTokens(values['output-tokens']);
  if (!values.targets) {
    throw Error('--targets is required; use --help');
  }
  const targets: EvalTarget[] = parseTargets(await readFile(values.targets, 'utf8'));
  let checks: LiteralChecks | null = null;
  if (values.checks !== undefined) {
    checks = await loadLiteralChecks(values.checks);
  }

  if (command === 'dry-run') {
    const plan = await planExperiment(source, outputTokens);
    if (checks !== null) {
      assertChecksMatchExamples(
        checks,
        plan.supported.map((example) => example.id),
      );
    }

    console.log(
      JSON.stringify(
        {
          dryRun: true,
          modelCalls: 0,
          mode: plan.mode,
          variant: describeVariant(plan),
          datasetHash: plan.datasetHash,
          examples: {
            supported: plan.supported.length,
            unsupported: plan.unsupported,
            routeCounts: plan.routeCounts,
            withLiteralChecks: checks === null ? 0 : Object.keys(checks.checks).length,
          },
          targets: targets.map((target) => ({
            name: target.name,
            model: target.model,
            baseUrl: target.baseUrl,
            concurrency: target.concurrency ?? 1,
            timeoutMs: target.timeoutMs ?? 30_000,
            apiKeyEnv: target.apiKeyEnv ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!values.out || !values['private-out'] || !values.send) {
    throw Error(`${command} requires --out, --private-out and explicit --send; use --help`);
  }

  if (command === 'compare') {
    if (source.mode !== 'inferred') {
      throw Error(
        'compare requires --dataset: fixed-route shortcuts have no exact-replay baseline',
      );
    }
    const order = parseOrder(values.order);

    await withReservedOutputs('compare', values.out, values['private-out'], async (signal) => {
      const { report, privateOutputs } = await runPairedComparison({
        datasetPath: source.datasetPath,
        targets,
        outputTokens,
        order,
        checks,
        signal,
      });
      const hasErrors =
        report.baselineReport.results.some((result) => result.error !== null) ||
        report.variantReport.results.some((result) => result.status === 'error');
      return {
        report,
        privateOutputs,
        console: {
          variant: VARIANT_ID,
          order: report.order,
          paired: report.paired.map((entry) => ({
            target: entry.target,
            coverage: {
              datasetExamples: entry.coverage.datasetExamples,
              paired: entry.coverage.paired,
              excluded: entry.coverage.excluded,
            },
            summary: entry.summary,
            baselineFullDataset: entry.baselineFullDataset,
          })),
        },
        hasErrors,
      };
    });
    return;
  }

  await withReservedOutputs('run', values.out, values['private-out'], async (signal) => {
    const { report, privateOutputs } = await runExperiment(
      source,
      targets,
      outputTokens,
      signal,
      checks,
    );
    return {
      report,
      privateOutputs,
      console: {
        variant: report.variant.id,
        exactReplay: false,
        summary: report.summary,
        unsupported: report.examples.unsupported.length,
      },
      hasErrors: report.results.some((result) => result.status === 'error'),
    };
  });
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
