/**
 * Tests for the json-cleanup-percentages-v1 variant: self-reported integer
 * percentages per offered intent, added to the offline JSON intent experiment.
 *
 * Synthetic recordings, fake PNG bytes and local HTTP servers only. These tests
 * cover the contract, prompt, runner, compare, report validation and v1
 * parity. They say nothing about how well any model estimates percentages.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildPrompt } from '../../src/core/intent-detector.ts';
import { restoreIntentRequest, snapshotIntentRequest } from '../../src/core/intent-request.ts';
import { runEvaluation } from '../../src/evals/runner.ts';
import { requestBody } from '../../src/evals/transport.ts';
import {
  runPairedComparison,
  runVariantComparison,
} from '../../src/evals/experiments/json-cleanup/compare.ts';
import {
  diagnosticIntentSelection,
  numberLiterals,
  parseExperimentResponse,
  TEXT_ROUTES,
  type ResponseExpectation,
} from '../../src/evals/experiments/json-cleanup/contract.ts';
import { pairRuns, pairVariantRuns } from '../../src/evals/experiments/json-cleanup/pairing.ts';
import {
  fixedRouteSystemPrompt,
  PERCENTAGES_INSTRUCTION,
  PERCENTAGES_VARIANT_ID,
  promptFingerprint,
  transformRecordedRequest,
  VARIANT_ID,
} from '../../src/evals/experiments/json-cleanup/prompt.ts';
import { completedRunnerReport } from '../../src/evals/experiments/json-cleanup/report-schema.ts';
import { planExperiment, runExperiment } from '../../src/evals/experiments/json-cleanup/runner.ts';

const png = Buffer.from('synthetic image bytes; never a personal recording');
const CLI = 'src/evals/experiments/json-cleanup/cli.ts';
const SECRET = 'SYNTHETIC-SECRET-9c1e';
const V2_MARKER = `Response format (${PERCENTAGES_VARIANT_ID}):`;
const V1_MARKER = `Response format (${VARIANT_ID}):`;

/** Pinned at ac75f81, before this variant existed: json-cleanup-v1 must not change. */
const V1_PINS = {
  promptHash: '5e14464c61ab8ccff32ea54ba03ab9c0c3e27a44d7657b82ea9d761d81a4d529',
  inferredBodySha: 'a3846f4510cfeb5c9f7fae5d2ad84235df5d5911e5c48498f56c11084d51b5f5',
  fixedPromptsSha: '81101b9fe919d0dd873cfbecb34d8599e37ba017a5bdc12f35a4f790401a27b4',
};

const OFFERED = [
  { name: 'IGNORE', instruction: 'Nothing.' },
  { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Type it.' },
  { name: 'START_CODING_AGENT_SESSION', instruction: 'Ask.' },
  { name: 'CHOOSE_AGENT_OPTION_1', instruction: 'Pick option one.' },
  { name: 'CHOOSE_AGENT_OPTION_2', instruction: 'Pick option two.' },
];
const NAMES = OFFERED.map((intent) => intent.name);

function sha(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function payload(utterance: string, intents = OFFERED, systemPrompt = buildPrompt(intents)) {
  return {
    model: 'recorded-model',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify({ utterance }) },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 32,
    stream: false,
  };
}

function recordFor(value: unknown) {
  const serialized = snapshotIntentRequest(value, png, 'http://recorded.invalid/v1');
  return { serialized, record: restoreIntentRequest(serialized, png) };
}

interface Example {
  utterance: string;
  expected: string;
  systemPrompt?: string;
}

async function writeDataset(root: string, examples: Example[]): Promise<string> {
  const directory = join(root, 'dataset');
  await mkdir(directory, { mode: 0o700 });
  const rows = [];
  for (let index = 0; index < examples.length; index++) {
    const example = examples[index]!;
    await writeFile(join(directory, `${uuid(index)}.png`), png);
    rows.push({
      id: uuid(index),
      observedAt: index,
      expected: example.expected,
      originalPrediction: example.expected,
      request: recordFor(payload(example.utterance, OFFERED, example.systemPrompt)).serialized,
    });
  }
  const path = join(directory, 'dataset.json');
  await writeFile(path, JSON.stringify({ version: 1, exportedAt: 'synthetic', examples: rows }));
  return path;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function utteranceOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: { type: string; text?: string }[] }[];
  const user = messages.find((message) => message.role === 'user')!;
  return JSON.parse(user.content.find((part) => part.type === 'text')!.text!).utterance;
}

function systemPromptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((message) => message.role === 'system')!.content;
}

function completion(content: string): string {
  return JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  });
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

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8' });
}

/** A percentages response over all offered names, with overrides. */
function response(
  intent: string,
  values: Record<string, unknown>,
  parameters: Record<string, unknown> = {},
): string {
  const percentages: Record<string, unknown> = {};
  for (const name of NAMES) {
    percentages[name] = name in values ? values[name] : 0;
  }
  return JSON.stringify({ intent, parameters, percentages });
}

const V2: ResponseExpectation = { allowedIntents: NAMES, fixedRoute: null, percentages: true };
const V1: ResponseExpectation = { allowedIntents: NAMES, fixedRoute: null };

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('percentages contract: valid shapes, extremes, ties and key order', () => {
  // Chosen IGNORE at 100, everything else 0.
  const extreme = parseExperimentResponse(response('IGNORE', { IGNORE: 100 }), V2);
  assert.ok(extreme.valid);
  // The distribution is a null-prototype object (names are data); compare as plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(extreme)), {
    valid: true,
    intent: 'IGNORE',
    text: null,
    percentages: {
      IGNORE: 100,
      SEND_TEXT_TO_APPLICATION: 0,
      START_CODING_AGENT_SESSION: 0,
      CHOOSE_AGENT_OPTION_1: 0,
      CHOOSE_AGENT_OPTION_2: 0,
    },
    chosenTied: false,
  });

  // A text route with cleaned text, and a scoped choice intent.
  const send = parseExperimentResponse(
    response(
      'SEND_TEXT_TO_APPLICATION',
      { SEND_TEXT_TO_APPLICATION: 55, IGNORE: 45 },
      { text: 'Hi.' },
    ),
    V2,
  );
  assert.equal(send.valid && send.text, 'Hi.');
  const choice = parseExperimentResponse(
    response('CHOOSE_AGENT_OPTION_2', { CHOOSE_AGENT_OPTION_2: 70, CHOOSE_AGENT_OPTION_1: 30 }),
    V2,
  );
  assert.equal(choice.valid && choice.intent, 'CHOOSE_AGENT_OPTION_2');

  // Ties at the top are valid when the chosen intent is one of them, and flagged.
  const tie = parseExperimentResponse(
    response('IGNORE', { IGNORE: 40, SEND_TEXT_TO_APPLICATION: 40, CHOOSE_AGENT_OPTION_1: 20 }),
    V2,
  );
  assert.equal(tie.valid && tie.chosenTied, true);
  // Five-way tie of 20s.
  const allTied = parseExperimentResponse(
    response('CHOOSE_AGENT_OPTION_1', Object.fromEntries(NAMES.map((name) => [name, 20]))),
    V2,
  );
  assert.equal(allTied.valid && allTied.chosenTied, true);

  // Key order is not significant; values are what matter.
  const reversed = `{"intent":"IGNORE","parameters":{},"percentages":{${[...NAMES]
    .reverse()
    .map((name) => `"${name}":${name === 'IGNORE' ? 100 : 0}`)
    .join(',')}}}`;
  assert.equal(parseExperimentResponse(reversed, V2).valid, true);

  // Digits, decimals and exponents inside strings are text, not percentages.
  const digits = parseExperimentResponse(
    response(
      'SEND_TEXT_TO_APPLICATION',
      { SEND_TEXT_TO_APPLICATION: 100 },
      { text: `Room 050 costs 1.5e3 (-7%) ${SECRET}` },
    ),
    V2,
  );
  assert.equal(digits.valid, true);

  // Ordinary JSON whitespace around numbers is fine.
  assert.equal(
    parseExperimentResponse(response('IGNORE', { IGNORE: 100 }).replace(':100', ': 100 '), V2)
      .valid,
    true,
  );
});

test('percentages contract rejects every rule violation with a fixed reason, never repaired', () => {
  const withRaw = (raw: string) => `{"intent":"IGNORE","parameters":{},"percentages":${raw}}`;
  const keys = (values: string[]) =>
    `{${NAMES.map((name, index) => `"${name}":${values[index]}`).join(',')}}`;

  const cases: [string, string][] = [
    // Structure.
    ['{"intent":"IGNORE","parameters":{}}', 'percentages-missing'],
    [withRaw('null'), 'percentages-not-an-object'],
    [withRaw('[100,0,0,0,0]'), 'percentages-not-an-object'],
    [withRaw('"IGNORE:100"'), 'percentages-not-an-object'],
    // Keys: missing, extra, renamed, case variant, shortcut-only name.
    [withRaw('{"IGNORE":100}'), 'percentages-keys-mismatch'],
    [
      response('IGNORE', { IGNORE: 100 }).replace('}}', ',"EXTRA":0}}'),
      'percentages-keys-mismatch',
    ],
    [
      response('IGNORE', { IGNORE: 100 }).replace('"IGNORE":100', '"ignore":100'),
      'percentages-keys-mismatch',
    ],
    [
      response('IGNORE', { IGNORE: 100 }).replace(
        '"CHOOSE_AGENT_OPTION_2":0',
        '"ENTER_TEXT_TO_APPLICATION":0',
      ),
      'percentages-keys-mismatch',
    ],
    // Types.
    [withRaw(keys(['"100"', '0', '0', '0', '0'])), 'percentage-not-a-number'],
    [withRaw(keys(['null', '100', '0', '0', '0'])), 'percentage-not-a-number'],
    [withRaw(keys(['true', '0', '0', '0', '0'])), 'percentage-not-a-number'],
    [withRaw(keys(['[100]', '0', '0', '0', '0'])), 'percentage-not-a-number'],
    [withRaw(keys(['{"v":100}', '0', '0', '0', '0'])), 'percentage-not-a-number'],
    // Not written as unsigned integer literals (JSON.parse would accept these).
    [withRaw(keys(['100.0', '0', '0', '0', '0'])), 'percentage-not-integer-literal'],
    [withRaw(keys(['50.5', '49.5', '0', '0', '0'])), 'percentage-not-integer-literal'],
    [withRaw(keys(['1e2', '0', '0', '0', '0'])), 'percentage-not-integer-literal'],
    [withRaw(keys(['1E2', '0', '0', '0', '0'])), 'percentage-not-integer-literal'],
    [withRaw(keys(['100', '-0', '0', '0', '0'])), 'percentage-not-integer-literal'],
    // Leading zeros are not even valid JSON.
    [withRaw(keys(['100', '00', '0', '0', '0'])), 'invalid-json'],
    [withRaw(keys(['090', '10', '0', '0', '0'])), 'invalid-json'],
    [withRaw(keys(['110', '-10', '0', '0', '0'])), 'percentage-not-integer-literal'],
    // NaN and Infinity are not JSON at all.
    [withRaw(keys(['NaN', '100', '0', '0', '0'])), 'invalid-json'],
    [withRaw(keys(['Infinity', '0', '0', '0', '0'])), 'invalid-json'],
    // Non-finite after parsing: 1e400 is Infinity.
    [withRaw(keys(['1e400', '0', '0', '0', '0'])), 'percentage-not-integer-literal'],
    // Range and total.
    [withRaw(keys(['150', '0', '0', '0', '0'])), 'percentage-out-of-range'],
    [withRaw(keys(['60', '39', '0', '0', '0'])), 'percentages-sum-not-100'],
    [withRaw(keys(['60', '41', '0', '0', '0'])), 'percentages-sum-not-100'],
    [withRaw(keys(['0', '0', '0', '0', '0'])), 'percentages-sum-not-100'],
    // Semantic consistency: the chosen intent must have the highest value.
    [withRaw(keys(['30', '70', '0', '0', '0'])), 'chosen-intent-not-highest'],
    [withRaw(keys(['30', '35', '35', '0', '0'])), 'chosen-intent-not-highest'],
    // Earlier rules still come first.
    [`${withRaw(keys(['100', '0', '0', '0', '0']))}\n{}`, 'invalid-json'],
    [
      `{"intent":"IGNORE","intent":"IGNORE","parameters":{},"percentages":${keys(['100', '0', '0', '0', '0'])}}`,
      'duplicate-key',
    ],
    [
      withRaw(
        `{"IGNORE":100,"IGNORE":0,${NAMES.slice(1)
          .map((name) => `"${name}":0`)
          .join(',')}}`,
      ),
      'duplicate-key',
    ],
    [
      response('IGNORE', { IGNORE: 100 }).replace('"parameters":{}', '"parameters":{"text":"x"}'),
      'text-on-no-text-intent',
    ],
    [response('UNKNOWN', { IGNORE: 100 }), 'unknown-intent'],
    [
      `${response('IGNORE', { IGNORE: 100 }).slice(0, -1)},"confidence":1}`,
      'unexpected-top-level-key',
    ],
    ['```json\n' + response('IGNORE', { IGNORE: 100 }) + '\n```', 'invalid-json'],
  ];

  for (const [text, reason] of cases) {
    const parsed = parseExperimentResponse(text, V2);
    assert.deepEqual(parsed, { valid: false, reason }, `${reason}: ${text}`);
  }

  // Percentage failures keep the (allowed) diagnostic intent; malformed JSON does not.
  assert.equal(diagnosticIntentSelection(withRaw(keys(['30', '70', '0', '0', '0'])), V2), 'IGNORE');
  assert.equal(diagnosticIntentSelection(`${withRaw('{')}`, V2), null);

  // Under the v1 contract, a percentages key is simply an unexpected key.
  assert.deepEqual(parseExperimentResponse(response('IGNORE', { IGNORE: 100 }), V1), {
    valid: false,
    reason: 'unexpected-top-level-key',
  });
  // And v1 responses are unchanged under v1.
  assert.deepEqual(parseExperimentResponse('{"intent":"IGNORE","parameters":{}}', V1), {
    valid: true,
    intent: 'IGNORE',
    text: null,
  });
});

test('number literal scanner sees only numbers outside strings, exactly as written', () => {
  assert.deepEqual(numberLiterals('{"a":"1.5e3 -7","b":[1,-0,2.50,1E2],"c":{"d":100}}'), [
    '1',
    '-0',
    '2.50',
    '1E2',
    '100',
  ]);
  assert.deepEqual(numberLiterals('{"a":"\\"12\\"","b":0}'), ['0']);
});

// ---------------------------------------------------------------------------
// Prompt and v1 parity
// ---------------------------------------------------------------------------

test('json-cleanup-v1 prompt, transform and fixed prompts are byte-identical to ac75f81', () => {
  const record = {
    version: 1 as const,
    api: 'openai-completions' as const,
    baseUrl: 'http://x.invalid/v1',
    preparedAt: 0,
    body: {
      model: 'm',
      messages: [
        {
          role: 'system',
          content: buildPrompt([
            { name: 'IGNORE', instruction: 'Nothing.' },
            { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Type it.' },
            { name: 'START_CODING_AGENT_SESSION', instruction: 'Ask.' },
            { name: 'CONTINUE_OPEN_AGENT_CONVERSATION', instruction: 'Follow up.' },
            { name: 'CHOOSE_AGENT_OPTION_1', instruction: 'Pick one.' },
          ]),
        },
        { role: 'user', content: [{ type: 'text', text: '{"utterance":"u"}' }] },
      ],
      max_tokens: 32,
      temperature: 0,
      stream: true,
    },
  };

  assert.equal(promptFingerprint(), V1_PINS.promptHash);
  assert.equal(promptFingerprint(VARIANT_ID), V1_PINS.promptHash);
  assert.equal(sha(transformRecordedRequest(record, 512).body), V1_PINS.inferredBodySha);
  assert.equal(
    sha(transformRecordedRequest(record, 512, VARIANT_ID).body),
    V1_PINS.inferredBodySha,
  );
  assert.equal(
    sha(TEXT_ROUTES.map((route) => fixedRouteSystemPrompt(route))),
    V1_PINS.fixedPromptsSha,
  );

  // The new variant has its own, different prompt hash.
  assert.notEqual(promptFingerprint(PERCENTAGES_VARIANT_ID), V1_PINS.promptHash);
});

test('percentages prompt lists exactly the offered intents and changes only the system prompt', () => {
  const { record } = recordFor(payload(`dictation ${SECRET}`));
  const before = structuredClone(record);
  const v1 = transformRecordedRequest(record, 256, VARIANT_ID);
  const v2 = transformRecordedRequest(record, 256, PERCENTAGES_VARIANT_ID);

  // The recording is untouched and exact replay still changes only the model.
  assert.deepEqual(record, before);
  assert.deepEqual(requestBody(record, { name: 't', model: 'x', baseUrl: 'http://x/v1' }), {
    ...before.body,
    model: 'x',
  });

  // Everything except the system prompt matches v1 (and so the recording).
  const { messages: v1Messages, ...v1Rest } = v1.body;
  const { messages: v2Messages, ...v2Rest } = v2.body;
  assert.deepEqual(v2Rest, v1Rest);
  assert.deepEqual((v2Messages as unknown[])[1], (v1Messages as unknown[])[1]);
  assert.deepEqual(v2.allowedIntents, NAMES);

  const prompt = (v2Messages as { content: string }[])[0]!.content;
  assert.ok(prompt.includes(V2_MARKER));
  assert.ok(!prompt.includes(V1_MARKER));
  assert.ok(prompt.includes(PERCENTAGES_INSTRUCTION));
  assert.ok(
    prompt.includes(
      `exactly one key for each of the 5 intent names listed above (${NAMES.join(', ')})`,
    ),
  );
  for (const name of NAMES) {
    assert.ok(prompt.includes(`"${name}":<whole number>`), name);
  }
  // Placeholders only: the prompt suggests no particular numbers.
  assert.ok(!/"[A-Z_0-9]+":\d/.test(prompt));
  assert.ok(prompt.includes('not exact probabilities'));
  assert.ok(!prompt.includes('ENTER_TEXT_TO_APPLICATION'));
  assert.ok(!prompt.includes('QUICK_QUESTION'));
});

test('percentages variant is inferred-only: fixed shortcut routes are refused before any call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-fixed-'));
  const fixture = join(root, 'fixed.json');
  await writeFile(
    fixture,
    JSON.stringify({
      version: 1,
      kind: 'companion-fixed-route-cleanup',
      requestSettings: { stream: false, temperature: 0, disableThinking: false },
      examples: [{ id: 'q', route: 'QUICK_QUESTION', text: 'why' }],
    }),
  );

  await assert.rejects(
    planExperiment(
      { mode: 'fixed-route', datasetPath: fixture, variant: PERCENTAGES_VARIANT_ID },
      64,
    ),
    /applies only to inferred --dataset runs/,
  );
  // v1 fixed routes are unchanged.
  assert.equal(
    (await planExperiment({ mode: 'fixed-route', datasetPath: fixture }, 64)).variant,
    VARIANT_ID,
  );

  const targets = join(root, 'targets.json');
  await writeFile(
    targets,
    JSON.stringify([{ name: 't', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }]),
  );
  const dry = cli([
    'dry-run',
    '--fixed-routes',
    fixture,
    '--targets',
    targets,
    '--output-tokens',
    '64',
    '--variant',
    PERCENTAGES_VARIANT_ID,
  ]);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /fixed-route shortcuts stay on json-cleanup-v1/);
  assert.match(cli(['prompt', '--variant', 'json-cleanup-v9']).stderr, /--variant must be one of/);
});

// ---------------------------------------------------------------------------
// Runner, private separation, cancellation
// ---------------------------------------------------------------------------

/** Scenario: one answer per utterance key for the percentages variant. */
const V2_ANSWERS: Record<string, string> = {
  ignore: response('IGNORE', { IGNORE: 90, SEND_TEXT_TO_APPLICATION: 10 }),
  send: response(
    'SEND_TEXT_TO_APPLICATION',
    { SEND_TEXT_TO_APPLICATION: 100 },
    { text: `Hi ${SECRET}.` },
  ),
  choice: response('CHOOSE_AGENT_OPTION_1', {
    CHOOSE_AGENT_OPTION_1: 45,
    CHOOSE_AGENT_OPTION_2: 45,
    IGNORE: 10,
  }),
  // START_CODING_AGENT_SESSION is a text route, so it carries cleaned text.
  wrong: response(
    'START_CODING_AGENT_SESSION',
    { START_CODING_AGENT_SESSION: 60, IGNORE: 40 },
    { text: 'What is this?' },
  ),
  sum: response('IGNORE', { IGNORE: 60, SEND_TEXT_TO_APPLICATION: 39 }),
  decimal:
    '{"intent":"IGNORE","parameters":{},"percentages":{"IGNORE":99.5,"SEND_TEXT_TO_APPLICATION":0.5,"START_CODING_AGENT_SESSION":0,"CHOOSE_AGENT_OPTION_1":0,"CHOOSE_AGENT_OPTION_2":0}}',
  highest: response('IGNORE', { IGNORE: 20, SEND_TEXT_TO_APPLICATION: 80 }),
};
const SCENARIO: Example[] = [
  { utterance: 'ignore', expected: 'IGNORE' },
  { utterance: 'send', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'choice', expected: 'CHOOSE_AGENT_OPTION_1' },
  { utterance: 'wrong', expected: 'IGNORE' },
  { utterance: 'sum', expected: 'IGNORE' },
  { utterance: 'decimal', expected: 'IGNORE' },
  { utterance: 'highest', expected: 'IGNORE' },
];
/** v1 answers: the same intents, without percentages. */
const V1_ANSWERS: Record<string, string> = {
  ignore: '{"intent":"IGNORE","parameters":{}}',
  send: `{"intent":"SEND_TEXT_TO_APPLICATION","parameters":{"text":"Hi ${SECRET}."}}`,
  choice: '{"intent":"CHOOSE_AGENT_OPTION_1","parameters":{}}',
  wrong: '{"intent":"IGNORE","parameters":{}}',
  sum: '{"intent":"IGNORE","parameters":{}}',
  decimal: '{"intent":"IGNORE","parameters":{}}',
  highest: '{"intent":"IGNORE","parameters":{}}',
};

async function scenarioServer() {
  const arms: string[] = [];
  const baselineBodies: Record<string, unknown>[] = [];
  const endpoint = await server(async (request, response) => {
    const body = await readBody(request);
    const key = utteranceOf(body);
    const system = systemPromptOf(body);
    if (system.includes(V2_MARKER)) {
      arms.push('percentages');
      assert.equal(body.max_tokens, 512);
      response.end(completion(V2_ANSWERS[key]!));
    } else if (system.includes(V1_MARKER)) {
      arms.push('v1');
      response.end(completion(V1_ANSWERS[key]!));
    } else {
      arms.push('baseline');
      baselineBodies.push(body);
      // Every example's label (the legacy one is IGNORE) as a bare name.
      const example = SCENARIO.find((entry) => entry.utterance === key);
      response.end(completion(example?.expected ?? 'IGNORE'));
    }
  });
  return { endpoint, arms, baselineBodies };
}

test('percentages runs record self-reported values, keep invalid details private and v1 rows unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-run-'));
  const datasetPath = await writeDataset(root, SCENARIO);
  const { endpoint } = await scenarioServer();

  try {
    const target = { name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 3 };
    const v2 = await runExperiment(
      { mode: 'inferred', datasetPath, variant: PERCENTAGES_VARIANT_ID },
      [target],
      512,
    );
    const rows = new Map(v2.report.results.map((row) => [row.id, row]));
    const row = (index: number) => rows.get(uuid(index))!;

    assert.equal(v2.report.variant.id, PERCENTAGES_VARIANT_ID);
    assert.equal(v2.report.variant.promptHash, promptFingerprint(PERCENTAGES_VARIANT_ID));

    assert.deepEqual(
      [row(0).chosenPercentage, row(0).expectedPercentage, row(0).chosenTied],
      [90, 90, false],
    );
    assert.deepEqual(
      [row(1).chosenPercentage, row(1).expectedPercentage, row(1).hasText],
      [100, 100, true],
    );
    // Tie at the top including the chosen (correct) choice intent.
    assert.deepEqual([row(2).status, row(2).chosenTied, row(2).correct], ['valid', true, true]);
    // Valid but wrong intent: the label's own percentage is recorded.
    assert.deepEqual(
      [row(3).correct, row(3).chosenPercentage, row(3).expectedPercentage],
      [false, 60, 40],
    );
    // Percentage-rule failures: invalid, never repaired, reason only.
    assert.deepEqual(
      [4, 5, 6].map((index) => [
        row(index).status,
        row(index).invalidReason,
        row(index).chosenPercentage,
      ]),
      [
        ['invalid', 'percentages-sum-not-100', null],
        ['invalid', 'percentage-not-integer-literal', null],
        ['invalid', 'chosen-intent-not-highest', null],
      ],
    );
    // The diagnostic still sees the chosen intent for percentage failures.
    assert.equal(row(4).selectedIntent, 'IGNORE');
    assert.equal(row(4).intentSelectedCorrectly, true);

    const summary = v2.report.summary[0]!;
    assert.equal(summary.classification!.usableCorrect, 3);
    assert.equal(summary.classification!.intentSelectionDiagnostic.correct, 6);
    assert.deepEqual(
      {
        ...summary.selfReportedPercentages!,
        definition: undefined,
        meanChosenPercentage: undefined,
      },
      {
        definition: undefined,
        compliant: 4,
        failedOnPercentageRules: 3,
        failedEarlier: 0,
        transportErrors: 0,
        chosenTied: 1,
        meanChosenPercentage: undefined,
        meanExpectedIntentPercentage: (90 + 100 + 45 + 40) / 4,
      },
    );
    assert.deepEqual(summary.selfReportedPercentages!.meanChosenPercentage, {
      usableCorrect: (90 + 100 + 45) / 3,
      usableWrong: 60,
    });
    assert.match(summary.selfReportedPercentages!.definition, /not calibrated probabilities/);

    // Shareable report: no dictation, no raw invalid distributions.
    const shareable = JSON.stringify(v2.report);
    assert.ok(!shareable.includes(SECRET));
    assert.ok(!shareable.includes('99.5'));
    assert.ok(!shareable.includes('"percentages"'));

    // Private outputs: full valid distributions and raw invalid text.
    const privateById = new Map(v2.privateOutputs.map((entry) => [entry.id, entry]));
    assert.equal(privateById.get(uuid(0))!.percentages!.IGNORE, 90);
    assert.equal(privateById.get(uuid(5))!.percentages, null);
    assert.ok(privateById.get(uuid(5))!.invalidResponseText!.includes('99.5'));

    // json-cleanup-v1 rows keep exactly their earlier shape.
    const v1 = await runExperiment({ mode: 'inferred', datasetPath }, [target], 512);
    for (const result of v1.report.results) {
      assert.ok(!('chosenPercentage' in result));
      assert.ok(!('chosenTied' in result));
    }
    assert.ok(!('selfReportedPercentages' in v1.report.summary[0]!));
    assert.ok(!('percentages' in v1.privateOutputs[0]!));
    assert.equal(v1.report.variant.id, VARIANT_ID);
    assert.equal(v1.report.variant.promptHash, V1_PINS.promptHash);
  } finally {
    await endpoint.close();
  }
});

test('percentages runs cancel cleanly: no scheduling after abort, drained before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-cancel-'));
  const datasetPath = await writeDataset(root, SCENARIO.slice(0, 3));
  let calls = 0;
  const endpoint = await server(() => {
    // Never answer.
    calls++;
  });
  try {
    const controller = new AbortController();
    const run = runExperiment(
      { mode: 'inferred', datasetPath, variant: PERCENTAGES_VARIANT_ID },
      [{ name: 'hung', model: 'm', baseUrl: endpoint.url, concurrency: 1 }],
      128,
      controller.signal,
    );
    while (calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort(Error('stop'));
    await assert.rejects(run, /stop/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 1);
  } finally {
    await endpoint.close();
  }
});

// ---------------------------------------------------------------------------
// Compare: baseline + v1 + percentages, strict pairing
// ---------------------------------------------------------------------------

test('compare runs baseline, v1 and percentages arms and pairs them strictly by ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-compare-'));
  const datasetPath = await writeDataset(root, [
    ...SCENARIO,
    { utterance: 'legacy', expected: 'IGNORE', systemPrompt: 'Legacy\nName: IGNORE\n' },
  ]);
  const { endpoint, arms, baselineBodies } = await scenarioServer();

  try {
    const target = { name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 2 };
    const { report, privateOutputs } = await runVariantComparison({
      datasetPath,
      targets: [target],
      outputTokens: 512,
      order: 'variant-first',
      checks: null,
      variants: [VARIANT_ID, PERCENTAGES_VARIANT_ID],
    });

    // Whole arms in order, never interleaved: v1, percentages, then baseline.
    assert.deepEqual(arms, [
      ...Array(7).fill('v1'),
      ...Array(7).fill('percentages'),
      ...Array(8).fill('baseline'),
    ]);
    assert.deepEqual(report.armSequence, [VARIANT_ID, PERCENTAGES_VARIANT_ID, 'baseline']);
    // Replay parity: the baseline arm sent exact recorded bodies (model only).
    for (const body of baselineBodies) {
      const key = utteranceOf(body);
      const example = [
        ...SCENARIO,
        { utterance: 'legacy', expected: 'IGNORE', systemPrompt: 'Legacy\nName: IGNORE\n' },
      ].find((entry) => entry.utterance === key)!;
      const { record } = recordFor(payload(key, OFFERED, example.systemPrompt));
      assert.deepEqual(body, requestBody(record, target));
    }

    // Each variant is paired with the baseline on the same 7 supported examples.
    assert.equal(report.paired.length, 2);
    const [v1Pairing, v2Pairing] = report.paired;
    assert.equal(v1Pairing!.variant, VARIANT_ID);
    assert.equal(v2Pairing!.variant, PERCENTAGES_VARIANT_ID);
    assert.equal(v1Pairing!.coverage.paired, 7);
    assert.equal(v2Pairing!.coverage.excluded, 1);
    assert.equal(v1Pairing!.summary.variant.usableAccuracy, 1);
    assert.equal(v2Pairing!.summary.variant.usableAccuracy, 3 / 7);
    assert.equal(
      (v2Pairing!.summary.variant as { percentageRuleFailures?: number }).percentageRuleFailures,
      3,
    );
    assert.ok(!('percentageRuleFailures' in v1Pairing!.summary.variant));

    // Percentages vs v1: the added requirement's effect, one-to-one by ID.
    const versus = report.variantComparisons[0]!;
    assert.equal(versus.selection.left.variantId, VARIANT_ID);
    assert.equal(versus.selection.right.variantId, PERCENTAGES_VARIANT_ID);
    assert.equal(versus.summary.pairedExamples, 7);
    assert.equal(versus.summary.usableAccuracyDelta, 3 / 7 - 1);
    // Regressions: 'sum', 'decimal', 'highest' broke percentage rules; 'wrong' changed intent.
    assert.deepEqual(versus.summary.regressionIds, [uuid(3), uuid(4), uuid(5), uuid(6)]);
    assert.deepEqual(versus.summary.regressionCauses, {
      wrongIntent: 1,
      invalidContract: 3,
      transportError: 0,
    });
    // Pure intent selection: only 'wrong' actually changed the chosen intent.
    assert.deepEqual(versus.summary.intentSelectionDiagnostic.regressionIds, [uuid(3)]);
    assert.equal(
      (versus.summary.right as { percentageRuleFailures?: number }).percentageRuleFailures,
      3,
    );
    assert.equal(versus.summary.latencyMs.pairedDifference.count, 7);

    // Private outputs are grouped per variant; shareable report has no text.
    assert.deepEqual(
      privateOutputs.map((group) => group.variant),
      [VARIANT_ID, PERCENTAGES_VARIANT_ID],
    );
    assert.ok(!JSON.stringify(report).includes(SECRET));

    // Single-variant compare with the percentages variant keeps the version 2 shape.
    const single = await runPairedComparison({
      datasetPath,
      targets: [target],
      outputTokens: 512,
      order: 'baseline-first',
      checks: null,
      variant: PERCENTAGES_VARIANT_ID,
    });
    assert.equal(single.report.version, 2);
    assert.equal(single.report.arms.variant.id, PERCENTAGES_VARIANT_ID);
    assert.equal(single.report.paired[0]!.summary.variant.usableAccuracy, 3 / 7);
  } finally {
    await endpoint.close();
  }
});

// ---------------------------------------------------------------------------
// Offline report validation for the percentages variant
// ---------------------------------------------------------------------------

type ReportJson = Record<string, any>;

test('offline pair and pair-variants validate percentages reports and refuse corruption before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-pair-'));
  const datasetPath = await writeDataset(root, SCENARIO);
  const { endpoint } = await scenarioServer();

  let baseline: ReportJson;
  let v1: ReportJson;
  let v2: ReportJson;
  try {
    const target = { name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 1 };
    baseline = { state: 'complete', ...(await runEvaluation(datasetPath, [target])) };
    v1 = {
      state: 'complete',
      ...(await runExperiment({ mode: 'inferred', datasetPath }, [target], 512)).report,
    };
    v2 = {
      state: 'complete',
      ...(
        await runExperiment(
          { mode: 'inferred', datasetPath, variant: PERCENTAGES_VARIANT_ID },
          [target],
          512,
        )
      ).report,
    };
  } finally {
    await endpoint.close();
  }
  [baseline, v1, v2] = [baseline, v1, v2].map((report) => JSON.parse(JSON.stringify(report)));

  const write = async (name: string, value: unknown) => {
    const path = join(root, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const baselinePath = await write('baseline.json', baseline);

  let counter = 0;
  const pair = async (variant: ReportJson) => {
    counter++;
    const out = join(root, `paired-${counter}.json`);
    const result = cli([
      'pair',
      '--baseline-report',
      baselinePath,
      '--baseline-target',
      'local',
      '--variant-report',
      await write(`v2-${counter}.json`, variant),
      '--variant-target',
      'local',
      '--out',
      out,
    ]);
    return { result, out };
  };
  const pairVariants = async (left: ReportJson, right: ReportJson) => {
    counter++;
    const out = join(root, `versus-${counter}.json`);
    const result = cli([
      'pair-variants',
      '--left-report',
      await write(`left-${counter}.json`, left),
      '--left-target',
      'local',
      '--right-report',
      await write(`right-${counter}.json`, right),
      '--right-target',
      'local',
      '--out',
      out,
    ]);
    return { result, out };
  };

  // Valid files pair (baseline vs percentages, and v1 vs percentages).
  const valid = await pair(v2);
  assert.equal(valid.result.status, 0, valid.result.stderr);
  const pairing = JSON.parse(await readFile(valid.out, 'utf8'));
  assert.equal(pairing.selection.variant.variantId, PERCENTAGES_VARIANT_ID);
  assert.deepEqual(pairing.pairs[0].variant.percentages, {
    chosen: 90,
    expected: 90,
    chosenTied: false,
  });
  const versus = await pairVariants(v1, v2);
  assert.equal(versus.result.status, 0, versus.result.stderr);
  assert.equal(JSON.parse(await readFile(versus.out, 'utf8')).summary.changes.regressions, 4);
  // In-memory helpers agree with the files.
  assert.equal(
    pairVariantRuns({ left: v1, leftTarget: 'local', right: v2, rightTarget: 'local' }).summary
      .regressionIds.length,
    4,
  );
  assert.equal(
    pairRuns({
      baseline: completedRunnerReport(baseline),
      baselineTarget: 'local',
      variant: v2,
      variantTarget: 'local',
    }).summary.variant.usableCorrect,
    3,
  );

  const row = (report: ReportJson, index: number) =>
    report.results.find((entry: ReportJson) => entry.id === uuid(index));

  const corruptions: [string, (report: ReportJson) => void, RegExp][] = [
    [
      'fractional chosen percentage',
      (r) => void (row(r, 0).chosenPercentage = 90.5),
      /chosenPercentage must be an integer/,
    ],
    [
      'string percentage',
      (r) => void (row(r, 0).expectedPercentage = '90'),
      /expectedPercentage must be an integer/,
    ],
    [
      'percentage above 100',
      (r) => void (row(r, 0).chosenPercentage = 101),
      /chosenPercentage must be an integer/,
    ],
    [
      'correct but different expected value',
      (r) => void (row(r, 0).expectedPercentage = 80),
      /must equal chosenPercentage when correct/,
    ],
    [
      'wrong intent with a larger labeled value',
      (r) => void (row(r, 3).expectedPercentage = 70),
      /cannot exceed the chosen/,
    ],
    [
      'wrong intent with an equal labeled value but no tie',
      (r) => void (row(r, 3).expectedPercentage = 60),
      /chosenTied must be true/,
    ],
    [
      'tie above 50',
      (r) => Object.assign(row(r, 2), { chosenPercentage: 60, expectedPercentage: 60 }),
      /tied highest percentage cannot exceed 50/,
    ],
    [
      '100 with a nonzero labeled value',
      (r) => Object.assign(row(r, 3), { chosenPercentage: 100, expectedPercentage: 10 }),
      /must be 0 when another intent has 100/,
    ],
    [
      'values on an invalid row',
      (r) => void (row(r, 4).chosenPercentage = 60),
      /must be null unless the response was valid/,
    ],
    [
      'tie flag on an invalid row',
      (r) => void (row(r, 4).chosenTied = false),
      /must be null unless the response was valid/,
    ],
    [
      'missing percentage fields',
      (r) => void delete row(r, 0).chosenTied,
      /missing or unexpected fields/,
    ],
    [
      'unknown variant id',
      (r) => void (r.variant.id = 'json-cleanup-v9'),
      /not a known experiment variant/,
    ],
    [
      'prompt hash of another variant',
      (r) => void (r.variant.promptHash = V1_PINS.promptHash),
      /promptHash does not match/,
    ],
  ];
  for (const [name, corrupt, reason] of corruptions) {
    const copy = structuredClone(v2);
    corrupt(copy);
    const { result, out } = await pair(copy);
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, reason, name);
    await assert.rejects(stat(out), /ENOENT/, name);
    assert.ok(!result.stderr.includes(SECRET), name);
  }

  // v1 reports cannot carry percentage fields or percentage reasons.
  const v1WithFields = structuredClone(v1);
  Object.assign(row(v1WithFields, 0), {
    chosenPercentage: 90,
    expectedPercentage: 90,
    chosenTied: false,
  });
  const extra = await pairVariants(v1WithFields, v2);
  assert.equal(extra.result.status, 1);
  assert.match(extra.result.stderr, /missing or unexpected fields/);

  const v1WithReason = structuredClone(v1);
  Object.assign(row(v1WithReason, 4), {
    status: 'invalid',
    prediction: null,
    correct: false,
    hasText: false,
    invalidReason: 'percentages-sum-not-100',
    literalCheck: 'no-checks',
  });
  const reason = await pairVariants(v1WithReason, v2);
  assert.equal(reason.result.status, 1);
  assert.match(reason.result.stderr, /not possible for this variant/);

  // Variant-vs-variant pairing refuses different support or datasets.
  const fewer = structuredClone(v2);
  fewer.examples.supportedIds.pop();
  fewer.results.pop();
  const unequal = await pairVariants(v1, fewer);
  assert.equal(unequal.result.status, 1);
  assert.match(unequal.result.stderr, /planned different supported examples/);
  const otherDataset = structuredClone(v2);
  otherDataset.datasetHash = '0'.repeat(64);
  assert.match((await pairVariants(v1, otherDataset)).result.stderr, /different frozen datasets/);
});

test('CLI compare with two variants and run with the percentages variant write labeled 0600 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-percentages-cli-'));
  const datasetPath = await writeDataset(root, SCENARIO.slice(0, 3));
  const { endpoint, arms } = await scenarioServer();

  try {
    const targets = join(root, 'targets.json');
    await writeFile(targets, JSON.stringify([{ name: 't', model: 'm', baseUrl: endpoint.url }]));
    // spawnSync would block this process's event loop, so the fake server
    // could not answer; calls that reach the server run asynchronously.
    const exec = promisify(execFile);

    const compareOut = join(root, 'compare.json');
    const comparePrivate = join(root, 'compare-private.json');
    const compared = await exec(process.execPath, [
      '--import',
      'tsx',
      CLI,
      'compare',
      '--dataset',
      datasetPath,
      '--targets',
      targets,
      '--output-tokens',
      '512',
      '--variant',
      VARIANT_ID,
      '--variant',
      PERCENTAGES_VARIANT_ID,
      '--out',
      compareOut,
      '--private-out',
      comparePrivate,
      '--send',
    ]);
    assert.ok(!compared.stdout.includes(SECRET));
    assert.deepEqual(arms, [
      ...Array(3).fill('baseline'),
      ...Array(3).fill('v1'),
      ...Array(3).fill('percentages'),
    ]);
    const report = JSON.parse(await readFile(compareOut, 'utf8'));
    assert.equal(report.version, 3);
    assert.equal(report.variantComparisons[0].summary.pairedExamples, 3);
    assert.ok(!JSON.stringify(report).includes(SECRET));
    const privateFile = JSON.parse(await readFile(comparePrivate, 'utf8'));
    assert.deepEqual(
      privateFile.variants.map((group: { variant: string }) => group.variant),
      [VARIANT_ID, PERCENTAGES_VARIANT_ID],
    );
    assert.equal((await stat(compareOut)).mode & 0o777, 0o600);
    assert.equal((await stat(comparePrivate)).mode & 0o777, 0o600);

    // Three variants, or a repeated variant, are refused before any call.
    arms.length = 0;
    const tooMany = cli([
      'compare',
      '--dataset',
      datasetPath,
      '--targets',
      targets,
      '--output-tokens',
      '512',
      '--variant',
      VARIANT_ID,
      '--variant',
      PERCENTAGES_VARIANT_ID,
      '--variant',
      VARIANT_ID,
      '--out',
      join(root, 'x.json'),
      '--private-out',
      join(root, 'y.json'),
      '--send',
    ]);
    assert.match(tooMany.stderr, /at most two --variant/);
    assert.equal(arms.length, 0);

    // run --variant: the private file names the variant actually used.
    const runOut = join(root, 'run.json');
    const runPrivate = join(root, 'run-private.json');
    await exec(process.execPath, [
      '--import',
      'tsx',
      CLI,
      'run',
      '--dataset',
      datasetPath,
      '--targets',
      targets,
      '--output-tokens',
      '512',
      '--variant',
      PERCENTAGES_VARIANT_ID,
      '--out',
      runOut,
      '--private-out',
      runPrivate,
      '--send',
    ]);
    assert.equal(JSON.parse(await readFile(runPrivate, 'utf8')).variant, PERCENTAGES_VARIANT_ID);
    assert.equal(JSON.parse(await readFile(runOut, 'utf8')).variant.id, PERCENTAGES_VARIANT_ID);
  } finally {
    await endpoint.close();
  }
});
