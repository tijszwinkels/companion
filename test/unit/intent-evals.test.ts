import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
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
import { runEvaluation } from '../../src/evals/runner.ts';
import { decodeCompletion, requestBody, validateTargets } from '../../src/evals/transport.ts';

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
    const answer =
      bodies.length <= 2 ? 'IGNORE' : body.model === 'baseline-model' ? 'DICTATION' : 'IGNORE';
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
    assert.equal(report.results[0]!.inputHash, report.results[1]!.inputHash);
    assert.notEqual(report.results[0]!.requestHash, report.results[1]!.requestHash);
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
