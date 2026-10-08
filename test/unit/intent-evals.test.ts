import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';

import { snapshotIntentRequest } from '../../src/core/intent-request.ts';
import { saveArtifact } from '../../src/desktop/artifacts.ts';
import {
  exportDataset,
  inspectDatabase,
  loadDataset,
  restoreExample,
} from '../../src/evals/dataset.ts';
import { describeRequestError, SafeEvalError } from '../../src/evals/errors.ts';
import { runBounded } from '../../src/evals/pool.ts';
import { runEvaluation } from '../../src/evals/runner.ts';
import {
  decodeCompletion,
  requestBody,
  validateTargets,
  type EvalTarget,
} from '../../src/evals/transport.ts';

const png = Buffer.from('synthetic image bytes; never a personal recording');
const ids = Array.from(
  { length: 8 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
);
const observedAt = 1_750_000_000_000;
const payload = {
  model: 'original',
  messages: [
    {
      role: 'system',
      content:
        'Classify.\nName: IGNORE\nInstruction: Nothing.\n\nName: DICTATION\nInstruction: Type it.\n',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '{"utterance":"héllo","context":"Name: INJECTED"}' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' },
        },
      ],
    },
  ],
  temperature: 0,
  max_tokens: 32,
  stream: true,
  chat_template_kwargs: { enable_thinking: false },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'companion-evals-'));
  const path = join(root, 'utterances.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA user_version = 5;
    CREATE TABLE utterances (id TEXT PRIMARY KEY, observed_at INTEGER, intent_request TEXT, recognized_intent TEXT);
    CREATE TABLE intent_feedback (id TEXT PRIMARY KEY, correct INTEGER, actual_intent TEXT, recognized_intent TEXT);
  `);
  const record = snapshotIntentRequest(payload, png, 'http://recorded-endpoint.invalid/v1');
  const insert = database.prepare('INSERT INTO utterances VALUES (?, ?, ?, ?)');
  const label = database.prepare('INSERT INTO intent_feedback VALUES (?, ?, ?, ?)');
  for (let index = 0; index < ids.length; index++) {
    insert.run(ids[index]!, observedAt + index, index === 4 ? null : record, 'IGNORE');
  }
  label.run(ids[0]!, 1, null, 'IGNORE');
  label.run(ids[1]!, 0, 'DICTATION', 'IGNORE');
  // Negative-only, unlabeled and legacy examples must not acquire fake labels.
  label.run(ids[2]!, 0, null, 'IGNORE');
  label.run(ids[4]!, 1, 'IGNORE', 'IGNORE');
  // Missing artifact, modified artifact, and label not offered in this prompt.
  label.run(ids[5]!, 1, 'IGNORE', 'IGNORE');
  label.run(ids[6]!, 1, 'IGNORE', 'IGNORE');
  label.run(ids[7]!, 0, 'UNAVAILABLE', 'IGNORE');
  database.close();
  for (const index of [0, 1, 6, 7]) {
    // Different date bucket verifies lookup does not rely on observed_at/timezone.
    await saveArtifact(
      root,
      ids[index]!,
      observedAt - 86_400_000,
      'screenshots',
      index === 6 ? Buffer.from('modified') : png,
      () => true,
    );
  }
  return { root, path, record };
}

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const instance = createServer((request, response) => {
    void handler(request, response);
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function stream(text: string, finish = 'stop', usage = true): string {
  return (
    [
      {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: text.slice(0, 2) },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: { content: text.slice(2) }, finish_reason: finish }] },
      ...(usage ? [{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 2 } }] : []),
    ]
      .map((packet) => `data: ${JSON.stringify(packet)}\r\n\r\n`)
      .join('') + 'data: [DONE]\r\n\r\n'
  );
}

test('read-only inventory and frozen export use explicit labels, reject invalid artifacts', async () => {
  const { root, path } = await fixture();
  const before = await readFile(path);
  assert.deepEqual(inspectDatabase(path), {
    total: 8,
    recorded: 7,
    recordedWithCleanupPrompt: 0,
    labeled: 7,
    usableLabels: 5,
    correctWithRequest: 3,
    correctMissingRequest: 1,
    correctedWithRequest: 2,
    correctedMissingRequest: 0,
    incorrectWithoutClass: 1,
    missingRequest: 1,
    recordedWithoutClass: 2,
  });
  const out = join(root, 'dataset');
  const exported = await exportDataset(path, out);
  assert.equal(exported.exported, 2);
  assert.equal(exported.skipped.length, 3);
  const dataset = await loadDataset(join(out, 'dataset.json'));
  assert.deepEqual(
    dataset.examples.map((example) => example.expected),
    ['IGNORE', 'DICTATION'],
  );
  assert.deepEqual(
    (await restoreExample(join(out, 'dataset.json'), dataset.examples[0]!)).body,
    payload,
  );
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(join(out, 'dataset.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(out, `${ids[0]}.png`))).mode & 0o777, 0o600);
  await assert.rejects(exportDataset(path, out), /EEXIST/);
  await assert.rejects(exportDataset(path, join(root, 'invalid'), 0), /positive/);
});

test('model comparison sends identical bodies except model, reports accuracy, costs and regressions', async () => {
  const { root, path } = await fixture();
  const datasetDirectory = join(root, 'dataset');
  await exportDataset(path, datasetDirectory);
  const bodies: Record<string, unknown>[] = [];
  const endpoint = await server(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    response.setHeader('Content-Type', 'text/event-stream');
    // Targets run in sequential batches in dataset order: the baseline sees
    // examples 1-2 (IGNORE, DICTATION), then the candidate sees the same two.
    const answer = bodies.length === 2 ? 'DICTATION' : 'IGNORE';
    const wire = stream(answer, 'stop', body.model === 'baseline-model');
    // Split in arbitrary byte positions, not SSE/event boundaries.
    response.write(wire.slice(0, 17));
    response.end(wire.slice(17));
  });
  try {
    const targets = ['baseline', 'candidate'].map((name) => ({
      name,
      model: `${name}-model`,
      baseUrl: endpoint.url,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    }));
    const report = await runEvaluation(join(datasetDirectory, 'dataset.json'), targets);
    assert.equal(bodies.length, 4);
    for (const body of bodies) {
      assert.deepEqual({ ...body, model: 'original' }, payload);
    }
    assert.equal(report.summary[0]!.accuracy, 1);
    assert.equal(report.summary[1]!.accuracy, 0.5);
    assert.equal(report.summary[0]!.estimatedCost, 0.000208);
    assert.equal(report.summary[1]!.estimatedCost, null);
    assert.deepEqual(report.comparisons[0]!.regressions, [ids[1]]);
    // Results are target-major: [baseline ex1, baseline ex2, candidate ex1, candidate ex2].
    assert.deepEqual(
      report.results.map((result) => [result.target, result.id]),
      [
        ['baseline', ids[0]],
        ['baseline', ids[1]],
        ['candidate', ids[0]],
        ['candidate', ids[1]],
      ],
    );
    assert.equal(report.results[0]!.inputHash, report.results[2]!.inputHash);
    assert.notEqual(report.results[0]!.requestHash, report.results[2]!.requestHash);
    assert.equal(report.summary[0]!.concurrency, 1);
    assert.equal(report.results[0]!.error, null);
    assert.ok(report.results.every((result) => result.latencyMs >= 0));
    assert.ok(!JSON.stringify(report).includes('héllo'));
    assert.ok(!JSON.stringify(report).includes(png.toString('base64')));
  } finally {
    await endpoint.close();
  }
});

test('HTTP errors are counted, not retried, and private response bodies are not reported', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory, 1);
  let calls = 0;
  const endpoint = await server((_request, response) => {
    calls++;
    response.writeHead(400);
    response.end('secret echoed provider content');
  });
  try {
    const report = await runEvaluation(join(directory, 'dataset.json'), [
      { name: 'bad', model: 'bad', baseUrl: endpoint.url },
    ]);
    assert.equal(calls, 1);
    assert.equal(report.summary[0]!.accuracy, 0);
    assert.equal(report.summary[0]!.errors, 1);
    assert.match(report.results[0]!.error!, /HTTP 400/);
    assert.ok(!JSON.stringify(report).includes('secret echoed'));
  } finally {
    await endpoint.close();
  }
});

test('timeouts abort, corrupt datasets preflight before networking, cancellation stops the run', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory);
  let calls = 0;
  const endpoint = await server(() => {
    calls++;
  });
  const targets = [{ name: 'slow', model: 'slow', baseUrl: endpoint.url, timeoutMs: 30 }];
  try {
    const report = await runEvaluation(join(directory, 'dataset.json'), targets);
    assert.equal(report.summary[0]!.errors, 2);
    assert.equal(calls, 2);
    const controller = new AbortController();
    controller.abort(Error('cancelled'));
    await assert.rejects(
      runEvaluation(join(directory, 'dataset.json'), targets, controller.signal),
      /cancelled/,
    );
    await writeFile(join(directory, `${ids[1]}.png`), 'tampered');
    await assert.rejects(runEvaluation(join(directory, 'dataset.json'), targets), /checksum/);
    assert.equal(calls, 2);
  } finally {
    await endpoint.close();
  }
});

test('decoder rejects truncated, explanatory, tool and reasoning responses', () => {
  assert.equal(decodeCompletion(stream(' IGNORE '), true).text, 'IGNORE');
  assert.throws(() => decodeCompletion(stream('IGNORE', 'length'), true), /normally/);
  assert.throws(
    () => decodeCompletion(stream('IGNORE').replace('data: [DONE]', ''), true),
    /Incomplete/,
  );
  const packet = (message: object) =>
    JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'stop' }] });
  assert.equal(decodeCompletion(packet({ content: 'IGNORE' }), false).text, 'IGNORE');
  assert.throws(
    () => decodeCompletion(packet({ content: 'IGNORE', tool_calls: [{}] }), false),
    /only an intent/,
  );
  assert.throws(
    () => decodeCompletion(packet({ content: 'IGNORE', reasoning_content: 'thinking' }), false),
    /only an intent/,
  );
  assert.throws(
    () => decodeCompletion(packet({ content: [{ text: 'IGNORE' }] }), false),
    /content/,
  );
  assert.throws(() => decodeCompletion('{"error":"bad"}', false), /Invalid/);
});

test('target configuration rejects hidden prompt/settings changes and credential-bearing URLs', () => {
  const target = { name: 'a', model: 'a', baseUrl: 'http://localhost/v1' };
  assert.equal(validateTargets([target])[0]!.model, 'a');
  for (const extra of [
    { messages: [] },
    { temperature: 1 },
    { baseUrl: 'http://user:secret@localhost' },
    { baseUrl: 'http://localhost?key=secret' },
    { timeoutMs: -1 },
    { apiKeyEnv: 'key-value!' },
    { pricing: { inputPerMillion: -1, outputPerMillion: 0 } },
  ]) {
    assert.throws(() => validateTargets([{ ...target, ...extra }]));
  }
  assert.throws(() => validateTargets([target, target]), /duplicate/);
  const record = {
    version: 1 as const,
    api: 'openai-completions' as const,
    preparedAt: 0,
    baseUrl: target.baseUrl,
    body: payload,
  };
  assert.deepEqual(requestBody(record, target), { ...payload, model: 'a' });
  assert.equal(record.body.model, 'original');
});

test('CLI requires explicit send, never migrates old schemas, and rejects irrelevant options', async () => {
  const { path, root } = await fixture();
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/evals/cli.ts', ...args], {
      encoding: 'utf8',
    });
  assert.equal(cli(['--help']).status, 0);
  const absent = cli([
    'run',
    '--dataset',
    'no-file',
    '--targets',
    'no-file',
    '--out',
    join(root, 'report.json'),
  ]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /explicit --send/);
  assert.equal(cli(['inspect', '--database', path, '--send']).status, 1);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 4');
  database.close();
  assert.throws(() => inspectDatabase(path), /never migrates/);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 4);
  check.close();
});

test('CLI completes a synthetic run and refuses an existing report before making calls', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory, 1);
  let calls = 0;
  const endpoint = await server((_request, response) => {
    calls++;
    response.end(stream('IGNORE'));
  });
  try {
    const targets = join(root, 'targets.json');
    const reportPath = join(root, 'report.json');
    await writeFile(
      targets,
      JSON.stringify([{ name: 'fixture', model: 'fixture', baseUrl: endpoint.url }]),
    );
    const args = [
      '--import',
      'tsx',
      'src/evals/cli.ts',
      'run',
      '--dataset',
      join(directory, 'dataset.json'),
      '--targets',
      targets,
      '--out',
      reportPath,
      '--send',
    ];
    await promisify(execFile)(process.execPath, args);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.summary[0].accuracy, 1);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    await assert.rejects(promisify(execFile)(process.execPath, args), /EEXIST/);
    assert.equal(calls, 1);
  } finally {
    await endpoint.close();
  }
});

test('unknown names are errors, redirects are not followed, and missing keys fail before calls', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory, 1);
  let calls = 0;
  const endpoint = await server((_request, response) => {
    calls++;
    if (calls === 1) {
      response.end(stream('IGNORE because I think so'));
    } else {
      response.writeHead(307, { Location: '/redirected' });
      response.end();
    }
  });
  const targets = [{ name: 'fixture', model: 'fixture', baseUrl: endpoint.url }];
  try {
    const unknown = await runEvaluation(join(directory, 'dataset.json'), targets);
    assert.match(unknown.results[0]!.error!, /registered intent/);
    const redirect = await runEvaluation(join(directory, 'dataset.json'), targets);
    assert.equal(redirect.summary[0]!.errors, 1);
    assert.equal(calls, 2);
    delete process.env.COMPANION_EVAL_TEST_MISSING_KEY;
    await assert.rejects(
      runEvaluation(join(directory, 'dataset.json'), [
        { ...targets[0]!, apiKeyEnv: 'COMPANION_EVAL_TEST_MISSING_KEY' },
      ]),
      /Missing API key/,
    );
    assert.equal(calls, 2);
  } finally {
    await endpoint.close();
  }
});

/** Payload for synthetic example `index`, distinguishable by the server. */
function indexedPayload(index: number) {
  const user = payload.messages[1]!.content as object[];
  return {
    ...payload,
    messages: [
      payload.messages[0]!,
      {
        role: 'user',
        content: [{ type: 'text', text: `{"utterance":"example ${index}"}` }, user[1]!],
      },
    ],
  };
}

/** Frozen dataset with `count` labeled, distinguishable examples. */
async function indexedDataset(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'companion-evals-concurrency-'));
  const path = join(root, 'utterances.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA user_version = 5;
    CREATE TABLE utterances (id TEXT PRIMARY KEY, observed_at INTEGER, intent_request TEXT, recognized_intent TEXT);
    CREATE TABLE intent_feedback (id TEXT PRIMARY KEY, correct INTEGER, actual_intent TEXT, recognized_intent TEXT);
  `);
  const exampleIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    exampleIds.push(id);
    const record = snapshotIntentRequest(indexedPayload(index), png, 'http://recorded.invalid/v1');
    database
      .prepare('INSERT INTO utterances VALUES (?, ?, ?, ?)')
      .run(id, observedAt + index, record, 'IGNORE');
    database
      .prepare('INSERT INTO intent_feedback VALUES (?, ?, ?, ?)')
      .run(id, 0, index % 2 === 0 ? 'IGNORE' : 'DICTATION', 'IGNORE');
  }
  database.close();
  for (const id of exampleIds) {
    await saveArtifact(root, id, observedAt, 'screenshots', png, () => true);
  }
  const directory = join(root, 'dataset');
  await exportDataset(path, directory);
  return { root, datasetPath: join(directory, 'dataset.json'), exampleIds };
}

/** Correct answer for synthetic example `index`. */
function indexedAnswer(index: number): string {
  return index % 2 === 0 ? 'IGNORE' : 'DICTATION';
}

interface ObservedRequest {
  index: number;
  body: Record<string, unknown>;
  response: ServerResponse;
}

/**
 * Local HTTP server that counts overlapping requests per model. `respond`
 * decides when and how each request is answered; it may never answer.
 */
async function overlapServer(respond: (request: ObservedRequest) => void | Promise<void>) {
  const state = {
    calls: 0,
    active: 0,
    activeByModel: new Map<string, number>(),
    maxActive: new Map<string, number>(),
    activeModels: new Set<string>(),
    mixedModels: false,
    arrivals: [] as number[],
    completions: [] as number[],
    bodies: [] as Record<string, unknown>[],
  };
  const endpoint = await server(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    const model = String(body.model);
    const text = ((body.messages as { content: { text?: string }[] }[])[1]!.content[0]!.text ??
      '') as string;
    const index = Number(/example (\d+)/.exec(text)![1]);

    state.calls++;
    state.active++;
    state.bodies.push(body);
    state.arrivals.push(index);
    state.activeModels.add(model);
    if (state.activeModels.size > 1) {
      state.mixedModels = true;
    }
    const perModel = (state.activeByModel.get(model) ?? 0) + 1;
    state.activeByModel.set(model, perModel);
    state.maxActive.set(model, Math.max(state.maxActive.get(model) ?? 0, perModel));

    // 'close' fires both after a normal response and when the client aborts.
    response.once('close', () => {
      state.active--;
      const remaining = state.activeByModel.get(model)! - 1;
      state.activeByModel.set(model, remaining);
      if (remaining === 0) {
        state.activeModels.delete(model);
      }
      if (response.writableFinished) {
        state.completions.push(index);
      }
    });
    await respond({ index, body, response });
  });
  return { endpoint, state };
}

function answer(response: ServerResponse, text: string): void {
  response.setHeader('Content-Type', 'text/event-stream');
  response.end(stream(text));
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Poll `condition` until true or the timeout passes; returns the final value. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      return false;
    }
    await delay(5);
  }
  return true;
}

test('concurrency 1 and 4 run in isolated batches with real, bounded overlap and exact bodies', async () => {
  const { datasetPath, exampleIds } = await indexedDataset(10);
  let parallelArrivals = 0;
  const { endpoint, state } = await overlapServer(async ({ index, body, response }) => {
    if (body.model === 'parallel-model') {
      parallelArrivals++;
      // Hold the first wave until four requests overlap. If the runner were
      // secretly sequential this would time out and maxActive would stay 1.
      if (parallelArrivals <= 4) {
        await waitUntil(() => state.activeByModel.get('parallel-model') === 4);
      }
    }
    await delay(10);
    answer(response, indexedAnswer(index));
  });
  try {
    const targets: EvalTarget[] = [
      { name: 'serial', model: 'serial-model', baseUrl: endpoint.url, concurrency: 1 },
      { name: 'parallel', model: 'parallel-model', baseUrl: endpoint.url, concurrency: 4 },
    ];
    const report = await runEvaluation(datasetPath, targets);

    assert.equal(state.calls, 20);
    assert.equal(state.maxActive.get('serial-model'), 1);
    assert.equal(state.maxActive.get('parallel-model'), 4);
    // Batches are isolated: two targets never had requests in flight together.
    assert.equal(state.mixedModels, false);

    // Exact restored body per example; only the model differs.
    for (const body of state.bodies) {
      const text = JSON.stringify(body);
      const index = Number(/example (\d+)/.exec(text)![1]);
      assert.deepEqual({ ...body, model: 'original' }, indexedPayload(index));
      assert.equal(JSON.stringify({ ...indexedPayload(index), model: body.model }), text);
    }

    assert.equal(report.version, 2);
    assert.deepEqual(
      report.targets.map((target) => target.concurrency),
      [1, 4],
    );
    assert.deepEqual(
      report.summary.map((summary) => [summary.target, summary.concurrency, summary.accuracy]),
      [
        ['serial', 1, 1],
        ['parallel', 4, 1],
      ],
    );
    for (const summary of report.summary) {
      assert.ok(summary.batch.wallTimeMs > 0);
      assert.ok(summary.batch.requestsPerSecond! > 0);
      assert.equal(summary.latencyMs.allRequests.count, 10);
      assert.equal(summary.latencyMs.successfulRequests.count, 10);
    }
    assert.ok(report.wallTimeMs >= report.summary[0]!.batch.wallTimeMs);
    assert.deepEqual(
      report.results.map((result) => [result.target, result.id]),
      [...exampleIds.map((id) => ['serial', id]), ...exampleIds.map((id) => ['parallel', id])],
    );
  } finally {
    await endpoint.close();
  }
});

test('out-of-order completion yields canonical result order and stable hashes', async () => {
  const { datasetPath, exampleIds } = await indexedDataset(8);
  const { endpoint, state } = await overlapServer(async ({ index, response }) => {
    // Later examples answer first, so completion order reverses within a wave.
    await delay((8 - index) * 6);
    answer(response, indexedAnswer(index));
  });
  const serial = { name: 'qwen-c1', model: 'same-model', baseUrl: endpoint.url, concurrency: 1 };
  const parallel = { name: 'qwen-c4', model: 'same-model', baseUrl: endpoint.url, concurrency: 4 };
  try {
    const forward = await runEvaluation(datasetPath, [serial, parallel]);
    const parallelCompletions = state.completions.slice(8);
    assert.deepEqual(state.completions.slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.notDeepEqual(parallelCompletions, [0, 1, 2, 3, 4, 5, 6, 7]);

    const reversed = await runEvaluation(datasetPath, [parallel, serial]);
    assert.equal(forward.datasetHash, reversed.datasetHash);

    const canonical = (report: typeof forward) =>
      report.results
        .map((result) => ({
          target: result.target,
          id: result.id,
          prediction: result.prediction,
          correct: result.correct,
          inputHash: result.inputHash,
          requestHash: result.requestHash,
        }))
        .sort((left, right) =>
          `${left.target}/${left.id}`.localeCompare(`${right.target}/${right.id}`),
        );
    assert.deepEqual(canonical(forward), canonical(reversed));

    // One record per example and target, in dataset order within each batch.
    assert.deepEqual(
      forward.results.filter((result) => result.target === 'qwen-c4').map((result) => result.id),
      exampleIds,
    );
    assert.equal(new Set(forward.results.map((row) => `${row.target}/${row.id}`)).size, 16);
    for (let index = 0; index < 8; index++) {
      // Same model and dataset: identical wire body whatever the concurrency.
      assert.equal(forward.results[index]!.requestHash, forward.results[index + 8]!.requestHash);
      assert.equal(forward.results[index]!.inputHash, forward.results[index + 8]!.inputHash);
    }
    assert.equal(forward.comparisons[0]!.regressions.length, 0);
  } finally {
    await endpoint.close();
  }
});

test('concurrent errors and timeouts are recorded per example, not retried, and cleaned up', async () => {
  const { datasetPath, exampleIds } = await indexedDataset(8);
  const { endpoint, state } = await overlapServer(async ({ index, response }) => {
    if (index % 4 === 0) {
      response.writeHead(500);
      response.end('private echoed prompt');
      return;
    }
    if (index % 4 === 1) {
      // Never answer: the client's per-request timeout must abort it.
      return;
    }
    await delay(5);
    answer(response, indexedAnswer(index));
  });
  try {
    const report = await runEvaluation(datasetPath, [
      { name: 'mixed', model: 'mixed', baseUrl: endpoint.url, concurrency: 4, timeoutMs: 150 },
    ]);
    assert.equal(state.calls, 8);
    assert.ok(state.maxActive.get('mixed')! <= 4);
    assert.ok(await waitUntil(() => state.active === 0));

    assert.deepEqual(
      report.results.map((result) => result.id),
      exampleIds,
    );
    for (const [index, result] of report.results.entries()) {
      if (index % 4 === 0) {
        assert.match(result.error!, /HTTP 500/);
      } else if (index % 4 === 1) {
        assert.equal(result.error, 'Request timed out after 150 ms');
        assert.ok(result.latencyMs >= 140);
      } else {
        assert.equal(result.error, null);
        assert.equal(result.correct, true);
      }
    }
    assert.ok(!JSON.stringify(report).includes('private echoed'));

    const summary = report.summary[0]!;
    assert.equal(summary.errors, 4);
    assert.equal(summary.accuracy, 0.5);
    assert.equal(summary.latencyMs.allRequests.count, 8);
    assert.equal(summary.latencyMs.successfulRequests.count, 4);
    // Timeouts dominate the all-request tail; success-only latency excludes them.
    assert.ok(summary.latencyMs.allRequests.p95Ms! >= 140);
    assert.ok(summary.latencyMs.successfulRequests.p95Ms! < 140);
  } finally {
    await endpoint.close();
  }
});

test('cancellation stops scheduling, aborts active requests and drains before rejecting', async () => {
  const { datasetPath } = await indexedDataset(10);
  const { endpoint, state } = await overlapServer(() => {
    // Never answer; only cancellation can end these requests.
  });
  const controller = new AbortController();
  try {
    const run = runEvaluation(
      datasetPath,
      [{ name: 'hung', model: 'hung', baseUrl: endpoint.url, concurrency: 4 }],
      controller.signal,
    );
    assert.ok(await waitUntil(() => state.calls === 4));
    controller.abort(Error('cancelled by test'));
    await assert.rejects(run, /cancelled by test/);

    assert.equal(state.calls, 4);
    assert.ok(await waitUntil(() => state.active === 0));
    await delay(50);
    assert.equal(state.calls, 4);
  } finally {
    await endpoint.close();
  }
});

test('bounded pool keeps order, respects its limit, and drains on fatal errors', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await runBounded(10, 3, new AbortController().signal, async (index) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay((10 - index) * 2);
    active--;
    return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(maxActive, 3);

  assert.deepEqual(
    await runBounded(2, 16, new AbortController().signal, async (index) => index),
    [0, 1],
  );
  assert.deepEqual(await runBounded(0, 4, new AbortController().signal, async () => 1), []);

  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      runBounded(1, invalid, new AbortController().signal, async () => 1),
      /positive integer/,
    );
  }

  let started = 0;
  const aborted = new AbortController();
  aborted.abort(Error('already cancelled'));
  await assert.rejects(
    runBounded(3, 2, aborted.signal, async () => {
      started++;
    }),
    /already cancelled/,
  );
  assert.equal(started, 0);

  const startedIndexes: number[] = [];
  let settled = 0;
  const fatal = runBounded(10, 3, new AbortController().signal, async (index, signal) => {
    startedIndexes.push(index);
    try {
      if (index === 1) {
        await delay(5);
        throw Error('fatal task');
      }
      // Siblings wait until the pool aborts them, then settle a little later.
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      await delay(10);
      signal.throwIfAborted();
    } finally {
      settled++;
    }
  });
  await assert.rejects(fatal, /fatal task/);
  assert.deepEqual(startedIndexes, [0, 1, 2]);
  assert.equal(settled, 3);
});

test('concurrency configuration is a bounded positive integer and fails before any call', async () => {
  const target = { name: 'a', model: 'a', baseUrl: 'http://localhost/v1' };
  for (const concurrency of [1, 4, 16]) {
    assert.equal(validateTargets([{ ...target, concurrency }])[0]!.concurrency, concurrency);
  }
  for (const concurrency of [0, -1, 17, 1.5, '4', null, Number.NaN]) {
    assert.throws(() => validateTargets([{ ...target, concurrency }]), /concurrency/);
  }

  const root = await mkdtemp(join(tmpdir(), 'companion-evals-cli-'));
  const targets = join(root, 'targets.json');
  const reportPath = join(root, 'report.json');
  await writeFile(targets, JSON.stringify([{ ...target, concurrency: 0 }]));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/evals/cli.ts',
      'run',
      '--dataset',
      join(root, 'absent.json'),
      '--targets',
      targets,
      '--out',
      reportPath,
      '--send',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /concurrency/);
  // Validation happens before the report file is reserved or anything is sent.
  await assert.rejects(stat(reportPath), /ENOENT/);
});

test('decoder hides invalid JSON snippets and rejects reasoning_details', () => {
  for (const [wire, streaming] of [
    ['SECRET-PRIVATE prompt echo', false],
    ['data: SECRET-PRIVATE prompt echo\n\ndata: [DONE]\n\n', true],
  ] as const) {
    assert.throws(
      () => decodeCompletion(wire, streaming),
      (error: Error) => error.message === 'Response contained invalid JSON',
    );
  }
  const packet = JSON.stringify({
    choices: [
      {
        index: 0,
        message: { content: 'IGNORE', reasoning_details: [{ text: 'x' }] },
        finish_reason: 'stop',
      },
    ],
  });
  assert.throws(() => decodeCompletion(packet, false), /only an intent/);
});

const secret = 'SECRET-PRIVATE-UTTERANCE-sk-live-0123456789';

test('decoder accepts empty tool/reasoning arrays and empty post-finish content like pi-ai', () => {
  const nonStreaming = (message: object) =>
    JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'stop' }] });

  // vLLM's non-streaming form always serializes an empty tool_calls array.
  assert.equal(
    decodeCompletion(nonStreaming({ content: 'IGNORE', tool_calls: [] }), false).text,
    'IGNORE',
  );
  assert.equal(
    decodeCompletion(
      nonStreaming({ content: 'IGNORE', function_call: null, reasoning_details: [] }),
      false,
    ).text,
    'IGNORE',
  );
  // Real tool calls, function calls and reasoning are still rejected.
  for (const extra of [
    { tool_calls: [{ id: 'call', type: 'function' }] },
    { function_call: { name: 'x', arguments: '{}' } },
    { reasoning_details: [{ type: 'reasoning.text', text: 'x' }] },
    { reasoning_content: 'thinking' },
  ]) {
    assert.throws(
      () => decodeCompletion(nonStreaming({ content: 'IGNORE', ...extra }), false),
      /only an intent/,
    );
  }

  const events = (...packets: object[]) =>
    packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n';
  const delta = (value: object, finish: string | null = null) => ({
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  });

  assert.equal(
    decodeCompletion(
      events(delta({ content: 'IGN', tool_calls: [] }), delta({ content: 'ORE' }, 'stop')),
      true,
    ).text,
    'IGNORE',
  );
  // Empty content after the finish chunk is ignored; real text there is not.
  assert.equal(
    decodeCompletion(events(delta({ content: 'IGNORE' }, 'stop'), delta({ content: '' })), true)
      .text,
    'IGNORE',
  );
  assert.throws(
    () =>
      decodeCompletion(
        events(delta({ content: 'IGNORE' }, 'stop'), delta({ content: 'more' })),
        true,
      ),
    /Invalid completion content/,
  );
});

test('server-controlled finish reasons and invalid JSON never reach error text verbatim', () => {
  const finished = (reason: string) =>
    JSON.stringify({
      choices: [{ index: 0, message: { content: 'IGNORE' }, finish_reason: reason }],
    });

  assert.throws(
    () => decodeCompletion(finished('length'), false),
    (error: Error) => error.message === 'Intent response did not finish normally (length)',
  );
  assert.throws(
    () => decodeCompletion(finished(secret), false),
    (error: Error) =>
      error.message === 'Intent response did not finish normally (unrecognized finish reason)',
  );
  assert.throws(
    () => decodeCompletion(`data: ${secret}\n\ndata: [DONE]\n\n`, true),
    (error: Error) => error instanceof SafeEvalError && !error.message.includes('SECRET'),
  );
});

test('transport errors report allowlisted causes only', async () => {
  const withCause = (message: string, cause: object) => new TypeError(message, { cause });

  assert.equal(
    describeRequestError(
      withCause('fetch failed', Object.assign(Error(secret), { code: 'ECONNREFUSED' })),
    ),
    'Request failed (ECONNREFUSED)',
  );
  assert.equal(
    describeRequestError(withCause('fetch failed', Error('unexpected redirect'))),
    'Request failed (redirect refused)',
  );
  assert.equal(
    describeRequestError(withCause('fetch failed', Object.assign(Error(secret), { code: secret }))),
    'Request failed (unclassified network error)',
  );
  assert.equal(
    describeRequestError(
      withCause('terminated', Object.assign(Error(secret), { code: 'UND_ERR_SOCKET' })),
    ),
    'Response stream terminated (UND_ERR_SOCKET)',
  );
  assert.equal(describeRequestError(Error(secret)), 'Request failed (unclassified error)');
  assert.equal(describeRequestError(new TypeError(secret)), 'Request failed (unclassified error)');

  // Real local sockets: a refused port and a refused redirect.
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory, 1);
  const closed = await server(() => {});
  const closedUrl = closed.url;
  await closed.close();
  const redirecting = await server((_request, response) => {
    response.writeHead(307, { Location: '/elsewhere' });
    response.end();
  });
  try {
    const report = await runEvaluation(join(directory, 'dataset.json'), [
      { name: 'refused', model: 'refused', baseUrl: closedUrl },
      { name: 'redirect', model: 'redirect', baseUrl: redirecting.url },
    ]);
    assert.deepEqual(
      report.results.map((result) => result.error),
      ['Request failed (ECONNREFUSED)', 'Request failed (redirect refused)'],
    );
  } finally {
    await redirecting.close();
  }
});

test('malformed local dataset, recorded request and targets JSON do not leak snippets', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory, 1);
  const datasetPath = join(directory, 'dataset.json');
  const target = [{ name: 'unused', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' }];

  // Corrupted recorded request inside an otherwise valid dataset.
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
  const example = dataset.examples[0];
  const corrupted = { ...dataset, examples: [{ ...example, request: `${secret} {` }] };
  const corruptedPath = join(directory, 'corrupted.json');
  await writeFile(corruptedPath, JSON.stringify(corrupted));
  await assert.rejects(runEvaluation(corruptedPath, target), (error: Error) => {
    assert.equal(error.message, `Example ${example.id}: Recorded intent request is not valid JSON`);
    return true;
  });

  // Whole dataset file is not JSON.
  const brokenPath = join(directory, 'broken.json');
  await writeFile(brokenPath, `${secret} not json`);
  await assert.rejects(
    runEvaluation(brokenPath, target),
    /^SafeEvalError: Dataset file is not valid JSON$/,
  );

  // Export skip reasons for a corrupted database recording.
  const database = new DatabaseSync(path);
  database
    .prepare('UPDATE utterances SET intent_request = ? WHERE id = ?')
    .run(`${secret} {`, ids[0]!);
  database.close();
  const exported = await exportDataset(path, join(root, 'second-export'));
  assert.ok(!JSON.stringify(exported).includes('SECRET'));
  assert.ok(
    exported.skipped.some((skip) => skip.reason === 'Recorded intent request is not valid JSON'),
  );
  assert.ok(
    !(await readFile(join(root, 'second-export', 'export-report.json'), 'utf8')).includes('SECRET'),
  );

  // CLI: malformed targets and dataset. Neither stderr nor the report may quote them.
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/evals/cli.ts', ...args], {
      encoding: 'utf8',
    });
  const targetsPath = join(root, 'targets.json');
  await writeFile(targetsPath, `${secret} [`);
  const badTargets = cli([
    'run',
    '--dataset',
    datasetPath,
    '--targets',
    targetsPath,
    '--out',
    join(root, 'r1.json'),
    '--send',
  ]);
  assert.equal(badTargets.status, 1);
  assert.match(badTargets.stderr, /Targets file is not valid JSON/);
  assert.ok(!badTargets.stderr.includes('SECRET'));

  await writeFile(targetsPath, JSON.stringify(target));
  const reportPath = join(root, 'r2.json');
  const badDataset = cli([
    'run',
    '--dataset',
    brokenPath,
    '--targets',
    targetsPath,
    '--out',
    reportPath,
    '--send',
  ]);
  assert.equal(badDataset.status, 1);
  assert.ok(!badDataset.stderr.includes('SECRET'));
  assert.ok(!badDataset.stdout.includes('SECRET'));
  const failure = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(failure.state, 'failed');
  assert.equal(failure.error, 'Dataset file is not valid JSON');
});

test('bearer keys are refused over plain HTTP to non-loopback hosts before any call', async () => {
  const keyed = { name: 'k', model: 'k', apiKeyEnv: 'EVAL_KEY' };
  for (const baseUrl of [
    'http://127.0.0.1:18081/v1',
    'http://127.1.2.3/v1',
    'http://localhost:8000/v1',
    'http://[::1]:8000/v1',
    'https://provider.example/v1',
  ]) {
    assert.equal(validateTargets([{ ...keyed, baseUrl }]).length, 1);
  }
  for (const baseUrl of [
    'http://provider.example/v1',
    'http://192.168.1.20:8000/v1',
    'http://127.0.0.1.example/v1',
  ]) {
    assert.throws(() => validateTargets([{ ...keyed, baseUrl }]), /requires an https/);
  }
  // Unauthenticated plain HTTP stays allowed, including the local Qwen endpoint.
  assert.equal(
    validateTargets([{ name: 'q', model: 'q', baseUrl: 'http://192.168.1.20:8000/v1' }]).length,
    1,
  );
  assert.throws(
    () => validateTargets([{ ...keyed, name: 'x', baseUrl: 'not a url' }]),
    /valid URL/,
  );
});

test('pool never starts a task after cancellation, even when active tasks resolve normally', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const run = runBounded(6, 2, controller.signal, async (index, signal) => {
    started.push(index);
    // Resolve (not reject) on abort, so only the pool's claim check can stop
    // the worker from taking the next item.
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    }
    return index;
  });
  assert.ok(await waitUntil(() => started.length === 2));
  controller.abort(Error('stop now'));
  await assert.rejects(run, /stop now/);
  await delay(20);
  assert.deepEqual(started, [0, 1]);
});

test('CLI reserves an explicit incomplete report and handles SIGHUP gracefully', async () => {
  const { root, path } = await fixture();
  const directory = join(root, 'dataset');
  await exportDataset(path, directory);
  let calls = 0;
  const endpoint = await server(() => {
    // Never answer; the run can only end by signal.
    calls++;
  });
  const targets = join(root, 'targets.json');
  await writeFile(
    targets,
    JSON.stringify([{ name: 'hung', model: 'hung', baseUrl: endpoint.url, concurrency: 1 }]),
  );
  const start = (reportPath: string) =>
    spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/evals/cli.ts',
        'run',
        '--dataset',
        join(directory, 'dataset.json'),
        '--targets',
        targets,
        '--out',
        reportPath,
        '--send',
      ],
      { stdio: 'ignore' },
    );
  try {
    // Hard kill: the reserved marker survives instead of an empty file.
    const killedPath = join(root, 'killed.json');
    const killed = start(killedPath);
    assert.ok(await waitUntil(() => calls === 1, 10_000));
    killed.kill('SIGKILL');
    await once(killed, 'exit');
    const marker = JSON.parse(await readFile(killedPath, 'utf8'));
    assert.equal(marker.state, 'incomplete');
    assert.equal(marker.version, 2);
    assert.equal((await stat(killedPath)).mode & 0o777, 0o600);

    // SIGHUP: graceful stop, drain, explicit failed/interrupted report.
    const hupPath = join(root, 'hup.json');
    const hup = start(hupPath);
    assert.ok(await waitUntil(() => calls === 2, 10_000));
    hup.kill('SIGHUP');
    const [code, signal] = await once(hup, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 1);
    const failure = JSON.parse(await readFile(hupPath, 'utf8'));
    assert.deepEqual(failure, {
      version: 2,
      state: 'failed',
      failed: true,
      interrupted: true,
      error: 'Evaluation interrupted by SIGHUP',
    });
    // The second example was never scheduled after the signal.
    assert.equal(calls, 2);
  } finally {
    await endpoint.close();
  }
});
