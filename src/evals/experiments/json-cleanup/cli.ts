/**
 * CLI for the offline JSON intent + spoken-text cleanup experiment.
 *
 * Commands:
 * - prompt:  print the versioned instruction templates. No files, no network.
 * - dry-run: validate a dataset/fixture, targets and output budget and print
 *            content-free counts, hashes and the variant description. Makes
 *            zero model calls.
 * - run:     send the variant requests (requires --send) and write a shareable
 *            report plus a separate private outputs file for human review.
 *
 * This is deliberately a separate CLI from `npm run eval:intents`, whose exact-
 * replay behavior stays unchanged. Output handling mirrors that CLI: both output
 * files are reserved (mode 0600, never overwritten) with an "incomplete" marker
 * before any call; the first stop signal aborts and drains gracefully, and a
 * second signal exits immediately.
 */
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { parseTargets, type EvalTarget } from '../../transport.ts';
import { TEXT_ROUTES } from './contract.ts';
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
} from './runner.ts';

const help = `Companion intent JSON + spoken-text cleanup EXPERIMENT (${VARIANT_ID})

This is NOT exact replay: it changes the recorded prompt and output budget.
Use "npm run eval:intents" for exact replay; it is unaffected by this command.

npm run eval:intent-cleanup -- prompt
npm run eval:intent-cleanup -- dry-run (--dataset DATASET.json | --fixed-routes FIXTURE.json) \\
  --targets targets.json --output-tokens N
npm run eval:intent-cleanup -- run (--dataset DATASET.json | --fixed-routes FIXTURE.json) \\
  --targets targets.json --output-tokens N --out new-report.json \\
  --private-out new-private-outputs.json --send

prompt:   prints the instruction templates (no private data, no network).
dry-run:  validates everything and prints counts/hashes. Zero model calls.
run:      sends private text/context/screenshots to every target. Requires --send.

--dataset       dataset.json from "eval:intents export" (inferred routes; recorded
                requests only, never reconstructed).
--fixed-routes  explicit, user-supplied fixed-route (shortcut) fixture file.
--output-tokens explicit experimental output budget, ${MIN_OUTPUT_TOKENS}-${MAX_OUTPUT_TOKENS}
                (recorded requests use 32; the report records the delta).
--out           shareable report: hashes, accuracy, JSON validity, invalid
                reasons, latency. Contains no dictated or cleaned text.
--private-out   PRIVATE file with spoken text, cleaned text and raw invalid
                responses for human review. Keep it out of Git and chats.

Targets use the same JSON format as eval:intents (model, baseUrl, apiKeyEnv,
timeoutMs, concurrency 1-16, pricing). No retries, no response repair, no LLM
judge, no action execution. See docs/intent-json-cleanup-experiment.md.
`;

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

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

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      dataset: { type: 'string' },
      'fixed-routes': { type: 'string' },
      targets: { type: 'string' },
      'output-tokens': { type: 'string' },
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
    'dry-run': ['dataset', 'fixed-routes', 'targets', 'output-tokens'],
    run: ['dataset', 'fixed-routes', 'targets', 'output-tokens', 'out', 'private-out', 'send'],
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

  const source = sourceFrom(values);
  const outputTokens = parseOutputTokens(values['output-tokens']);
  if (!values.targets) {
    throw Error('--targets is required; use --help');
  }
  const targets: EvalTarget[] = parseTargets(await readFile(values.targets, 'utf8'));

  if (command === 'dry-run') {
    const plan = await planExperiment(source, outputTokens);
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
    throw Error('run requires --out, --private-out and explicit --send; use --help');
  }
  if (values.out === values['private-out']) {
    throw Error('--out and --private-out must be different files');
  }

  // Reserve both private files before sending anything. Existing files or a
  // missing parent fail before any model call.
  const reportFile = await open(values.out, 'wx', 0o600);
  let privateFile: FileHandle;
  try {
    privateFile = await open(values['private-out'], 'wx', 0o600);
  } catch (error) {
    await replaceFile(reportFile, {
      kind: 'intent-json-cleanup-experiment',
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
  await replaceFile(reportFile, { kind: 'intent-json-cleanup-experiment', ...incomplete });
  await replaceFile(privateFile, { kind: 'intent-json-cleanup-private-outputs', ...incomplete });

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
    const { report, privateOutputs } = await runExperiment(
      source,
      targets,
      outputTokens,
      controller.signal,
    );

    await replaceFile(privateFile, {
      kind: 'intent-json-cleanup-private-outputs',
      state: 'complete',
      sensitive:
        'Contains dictated text and model outputs. Keep out of Git, chats and coding-model prompts; delete when reviewed.',
      variant: VARIANT_ID,
      datasetHash: report.datasetHash,
      outputs: privateOutputs,
    });
    await replaceFile(reportFile, { state: 'complete', ...report });

    // Console output is content-free: summary counts and file locations only.
    console.log(
      JSON.stringify(
        {
          variant: report.variant.id,
          exactReplay: false,
          summary: report.summary,
          unsupported: report.examples.unsupported.length,
          report: values.out,
          privateOutputs: values['private-out'],
        },
        null,
        2,
      ),
    );
    if (report.results.some((result) => result.status === 'error')) {
      process.exitCode = 1;
    }
  } catch (error) {
    const failed = {
      state: 'failed',
      failed: true,
      interrupted: controller.signal.aborted,
      error: (error as Error).message,
    };
    await replaceFile(privateFile, { kind: 'intent-json-cleanup-private-outputs', ...failed });
    await replaceFile(reportFile, { kind: 'intent-json-cleanup-experiment', ...failed });
    throw error;
  } finally {
    removeStopHandlers();
    await privateFile.close();
    await reportFile.close();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
