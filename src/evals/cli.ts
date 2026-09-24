import { open, readFile, type FileHandle } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { exportDataset, inspectDatabase } from './dataset.ts';
import { runEvaluation } from './runner.ts';
import { parseTargets } from './transport.ts';

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
apiKeyEnv requires https:// unless the endpoint host is loopback (localhost/127.x/[::1]).
Pricing is optional, in your chosen currency. Missing usage/cost is null, not zero.
Existing output files/directories are never overwritten. See docs/intent-evals.md.
The report file is reserved first with "state": "incomplete"; it becomes "complete"
or "failed". Ctrl+C, SIGTERM or SIGHUP stops gracefully; a second signal exits at
once and leaves the "incomplete" marker.
`;

/** Signals that stop a run gracefully: stop scheduling, abort and drain. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Replace the whole reserved report. Writes at offset 0 after truncating. */
async function replaceReport(output: FileHandle, report: object): Promise<void> {
  await output.truncate(0);
  await output.write(JSON.stringify(report, null, 2) + '\n', 0);
  await output.sync();
}

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
    const targets = parseTargets(await readFile(values.targets, 'utf8'));

    // Reserve a private output before sending anything. Existing reports or a
    // missing parent fail before incurring model calls. The reservation holds an
    // explicit "incomplete" marker at once, so a run killed before it can write
    // its final state (second signal, SIGKILL, crash) never leaves an empty file.
    const output = await open(values.out, 'wx', 0o600);
    await replaceReport(output, {
      version: 2,
      state: 'incomplete',
      note: 'Run started but did not finish writing a result; no score is claimed.',
      startedAt: new Date().toISOString(),
    });

    // The first stop signal aborts the run gracefully: no new requests start,
    // active requests are aborted and drained, then a "failed" report is written.
    // All handlers are removed at that point, so a second signal of any kind
    // takes its default action and ends the process immediately (escape hatch).
    const controller = new AbortController();
    const interrupt = (signal: NodeJS.Signals) => {
      removeStopHandlers();
      controller.abort(Error(`Evaluation interrupted by ${signal}`));
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
      const report = await runEvaluation(values.dataset, targets, controller.signal);
      await replaceReport(output, { state: 'complete', ...report });
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
      // Partial results are not saved; the report states only why it failed.
      await replaceReport(output, {
        version: 2,
        state: 'failed',
        failed: true,
        interrupted: controller.signal.aborted,
        error: (error as Error).message,
      });
      throw error;
    } finally {
      removeStopHandlers();
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
