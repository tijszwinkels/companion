import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { exportDataset, inspectDatabase } from './dataset.ts';
import { runEvaluation } from './runner.ts';
import { validateTargets } from './transport.ts';

const help = `Companion intent evals (no listener or UI restart)

npm run eval:intents -- inspect --database /path/utterances.sqlite
npm run eval:intents -- export --database /path/utterances.sqlite --out /new/dataset-directory [--limit 100]
npm run eval:intents -- run --dataset /path/dataset.json --targets targets.json --out /new/report.json --send

inspect: counts only; reads schema 5 without migration or recording access.
export: freezes explicitly labeled recorded requests and checksum-verified PNGs.
        Creates a NEW private directory; skips missing/corrupt/unscorable examples.
run:    sends private recorded text/context/screenshots to explicitly configured
        OpenAI-compatible endpoints. Requires --send. Changes ONLY body.model.
        First target is the comparison baseline. No actions, retries, or fallback.
        Targets run one at a time; each has up to "concurrency" requests in flight.
        JSON report includes errors, accuracy, latency, batch wall time/throughput,
        costs when known, and diffs.

Targets JSON: [{"name":"baseline","model":"model-id","baseUrl":"http://localhost:8000/v1",
  "apiKeyEnv":"OPTIONAL_KEY_ENV","timeoutMs":30000,"concurrency":1,
  "pricing":{"inputPerMillion":0,"outputPerMillion":0}}]
concurrency: integer 1-16, default 1. The same model may appear twice under
different names/concurrency to measure speedup on the same frozen dataset.
Pricing is optional, in your chosen currency. Missing usage/cost is null, not zero.
Existing output files/directories are never overwritten. See docs/intent-evals.md.
`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      database: { type: 'string' },
      dataset: { type: 'string' },
      targets: { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      send: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const command = positionals[0];
  const allowed: Record<string, string[]> = {
    inspect: ['database'],
    export: ['database', 'out', 'limit'],
    run: ['dataset', 'targets', 'out', 'send'],
  };
  if (
    positionals.length !== 1 ||
    !command ||
    !allowed[command] ||
    Object.keys(values).some((key) => !allowed[command]!.includes(key))
  ) {
    throw Error('Unknown command or inappropriate option; use --help');
  }
  if (command === 'inspect' && values.database) {
    console.log(JSON.stringify(inspectDatabase(values.database), null, 2));
    return;
  }
  if (command === 'export' && values.database && values.out) {
    const result = await exportDataset(
      values.database,
      values.out,
      values.limit === undefined ? 100 : Number(values.limit),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.exported === 0) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'run' && values.dataset && values.targets && values.out && values.send) {
    const targets = validateTargets(JSON.parse(await readFile(values.targets, 'utf8')));
    // Reserve a private output before sending anything. Existing reports or a
    // missing parent fail before incurring model calls. A failed run leaves an
    // explicit failure report rather than an apparently successful empty result.
    const output = await open(values.out, 'wx', 0o600);
    const controller = new AbortController();
    const interrupt = () => controller.abort(Error('Evaluation interrupted'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
      const report = await runEvaluation(values.dataset, targets, controller.signal);
      await output.writeFile(JSON.stringify(report, null, 2) + '\n');
      console.log(
        JSON.stringify(
          { summary: report.summary, comparisons: report.comparisons, report: values.out },
          null,
          2,
        ),
      );
      if (report.results.some((result) => result.error !== null)) {
        process.exitCode = 1;
      }
    } catch (error) {
      await output.writeFile(
        JSON.stringify({ version: 2, failed: true, error: (error as Error).message }) + '\n',
      );
      throw error;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      await output.close();
    }
    return;
  }
  throw Error('Missing required arguments (run requires explicit --send); use --help');
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
