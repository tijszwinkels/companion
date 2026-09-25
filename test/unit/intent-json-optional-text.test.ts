/**
 * Tests for the json-cleanup-percentages-optional-text-v1 variant: the
 * percentages contract, except that a text route may leave out
 * `parameters.text` when the transcript needs no change. The recorded
 * transcript is then used byte for byte (the only fallback).
 *
 * Synthetic recordings, fake PNG bytes and local HTTP servers only. These tests
 * cover the contract, the fallback, the prompt, planning, the runner, report
 * validation, pairing and the CLI, plus parity pins for json-cleanup-v1 and
 * json-cleanup-percentages-v1. They say nothing about whether any model omits
 * text only when cleanup is really unnecessary: that needs a manual review.
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
import { runVariantComparison } from '../../src/evals/experiments/json-cleanup/compare.ts';
import {
  diagnosticConsistentWithReason,
  diagnosticIntentSelection,
  parseExperimentResponse,
  resolveEffectiveText,
  type ResponseExpectation,
} from '../../src/evals/experiments/json-cleanup/contract.ts';
import { pairRuns, pairVariantRuns } from '../../src/evals/experiments/json-cleanup/pairing.ts';
import {
  CLEANUP_INSTRUCTION,
  OPTIONAL_TEXT_INSTRUCTION,
  OPTIONAL_TEXT_SEND_INSTRUCTION,
  OPTIONAL_TEXT_VARIANT_ID,
  PERCENTAGES_INSTRUCTION,
  PERCENTAGES_VARIANT_ID,
  promptFingerprint,
  SEND_FORMATTING_INSTRUCTION,
  transformRecordedRequest,
  VARIANT_ID,
} from '../../src/evals/experiments/json-cleanup/prompt.ts';
import { completedRunnerReport } from '../../src/evals/experiments/json-cleanup/report-schema.ts';
import { planExperiment, runExperiment } from '../../src/evals/experiments/json-cleanup/runner.ts';

const png = Buffer.from('synthetic image bytes; never a personal recording');
const CLI = 'src/evals/experiments/json-cleanup/cli.ts';
const SECRET = 'SYNTHETIC-SECRET-5d2a';
const OPTIONAL_MARKER = `Response format (${OPTIONAL_TEXT_VARIANT_ID}):`;
const V2_MARKER = `Response format (${PERCENTAGES_VARIANT_ID}):`;

/**
 * Pins for the variants this one must not change. v1 is pinned at ac75f81
 * (as in intent-json-percentages.test.ts); json-cleanup-percentages-v1 at
 * 56ed553, the reviewed commit this variant was built on.
 */
const V1_PROMPT_HASH = '5e14464c61ab8ccff32ea54ba03ab9c0c3e27a44d7657b82ea9d761d81a4d529';
const V2_PINS = {
  promptHash: '4dedf41a4efaa75c4f5e6f5d3305cdf9760a6dcbc02754d1c7dfbcfe8dc617ff',
  inferredBodySha: '2a302dabd6af25196c41f580ed285f5a6a4da1b182ea81b54ee502325503c96b',
};

const OFFERED = [
  { name: 'IGNORE', instruction: 'Nothing.' },
  { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Type it.' },
  { name: 'START_CODING_AGENT_SESSION', instruction: 'Ask.' },
  { name: 'CONTINUE_OPEN_AGENT_CONVERSATION', instruction: 'Follow up.' },
  { name: 'CHOOSE_AGENT_OPTION_1', instruction: 'Pick option one.' },
];
const NAMES = OFFERED.map((intent) => intent.name);

const OPTIONAL: ResponseExpectation = {
  allowedIntents: NAMES,
  fixedRoute: null,
  percentages: true,
  optionalText: true,
};
const V2: ResponseExpectation = { allowedIntents: NAMES, fixedRoute: null, percentages: true };
const V1: ResponseExpectation = { allowedIntents: NAMES, fixedRoute: null };

function sha(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * A recorded request. `userTexts` replaces the frame part(s) of the user
 * message, to build recordings without a usable utterance.
 */
function payload(utterance: string, userTexts?: string[], intents = OFFERED) {
  const texts = userTexts ?? [JSON.stringify({ utterance })];
  return {
    model: 'recorded-model',
    messages: [
      { role: 'system', content: buildPrompt(intents) },
      {
        role: 'user',
        content: [
          ...texts.map((text) => ({ type: 'text', text })),
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
  /** Also the scenario key the fake server answers by. */
  utterance: string;
  expected: string;
  userTexts?: string[];
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
      request: recordFor(payload(example.utterance, example.userTexts)).serialized,
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

function completion(content: string, completionTokens = 30): string {
  return JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: completionTokens },
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

/** A percentages response over all offered names (unlisted names get 0). */
function response(intent: string, values: Record<string, unknown>, parameters: unknown = {}) {
  const percentages: Record<string, unknown> = {};
  for (const name of NAMES) {
    percentages[name] = name in values ? values[name] : 0;
  }
  return JSON.stringify({ intent, parameters, percentages });
}

/** A valid-percentages response whose raw `parameters` JSON is given verbatim. */
function withRawParameters(intent: string, rawParameters: string): string {
  const percentages = NAMES.map((name) => `"${name}":${name === intent ? 100 : 0}`).join(',');
  return `{"intent":"${intent}","parameters":${rawParameters},"percentages":{${percentages}}}`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('optional-text contract: a text route may omit text only as exactly {}', () => {
  // Omitted text on a text route: valid, flagged, no text.
  const omitted = parseExperimentResponse(
    response('SEND_TEXT_TO_APPLICATION', { SEND_TEXT_TO_APPLICATION: 90, IGNORE: 10 }),
    OPTIONAL,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(omitted)), {
    valid: true,
    intent: 'SEND_TEXT_TO_APPLICATION',
    text: null,
    textOmitted: true,
    percentages: {
      IGNORE: 10,
      SEND_TEXT_TO_APPLICATION: 90,
      START_CODING_AGENT_SESSION: 0,
      CONTINUE_OPEN_AGENT_CONVERSATION: 0,
      CHOOSE_AGENT_OPTION_1: 0,
    },
    chosenTied: false,
  });

  // Every text route can omit; each can also return text.
  for (const route of [
    'SEND_TEXT_TO_APPLICATION',
    'START_CODING_AGENT_SESSION',
    'CONTINUE_OPEN_AGENT_CONVERSATION',
  ]) {
    const without = parseExperimentResponse(withRawParameters(route, '{}'), OPTIONAL);
    assert.equal(without.valid && without.textOmitted, true, route);
    const withText = parseExperimentResponse(
      withRawParameters(route, `{"text":"Cleaned ${SECRET}."}`),
      OPTIONAL,
    );
    assert.ok(withText.valid, route);
    assert.equal(withText.textOmitted, false, route);
    assert.equal(withText.text, `Cleaned ${SECRET}.`, route);
  }

  // Intents without text are unchanged: {} is valid and never "omitted".
  for (const intent of ['IGNORE', 'CHOOSE_AGENT_OPTION_1']) {
    const parsed = parseExperimentResponse(withRawParameters(intent, '{}'), OPTIONAL);
    assert.ok(parsed.valid, intent);
    assert.equal(parsed.text, null, intent);
    assert.equal(parsed.textOmitted, false, intent);
  }

  // Ordinary JSON whitespace inside the empty object is still exactly {}.
  assert.equal(
    parseExperimentResponse(withRawParameters('SEND_TEXT_TO_APPLICATION', '{ \n }'), OPTIONAL)
      .valid,
    true,
  );
});

test('optional-text contract rejects null, empty, wrong-type, whitespace, extra keys and wrong routes', () => {
  const send = 'SEND_TEXT_TO_APPLICATION';
  const cases: [string, string][] = [
    // Missing is the only omission: null and other types are not.
    [withRawParameters(send, '{"text":null}'), 'text-not-a-string'],
    [withRawParameters(send, '{"text":5}'), 'text-not-a-string'],
    [withRawParameters(send, '{"text":true}'), 'text-not-a-string'],
    [withRawParameters(send, '{"text":["Hi"]}'), 'text-not-a-string'],
    [withRawParameters(send, '{"text":{}}'), 'text-not-a-string'],
    // Empty and whitespace-only text never means "use the transcript".
    [withRawParameters(send, '{"text":""}'), 'text-empty'],
    [withRawParameters(send, '{"text":"   "}'), 'text-empty'],
    [withRawParameters(send, '{"text":"\\n"}'), 'text-empty'],
    [withRawParameters(send, '{"text":" Hi"}'), 'text-surrounding-whitespace'],
    [withRawParameters(send, '{"text":"Hi\\n"}'), 'text-surrounding-whitespace'],
    [withRawParameters(send, '{"text":"Hi\\r\\n"}'), 'text-surrounding-whitespace'],
    // Unexpected keys, with or without text, are never an omission.
    [withRawParameters(send, '{"submit":true}'), 'unexpected-parameter'],
    [withRawParameters(send, '{"text":"Hi","submit":true}'), 'unexpected-parameter'],
    [withRawParameters(send, '{"Text":"Hi"}'), 'unexpected-parameter'],
    [withRawParameters(send, '{"useTranscript":true}'), 'unexpected-parameter'],
    [withRawParameters(send, '{"__proto__":{"text":"Hi"}}'), 'unexpected-parameter'],
    [withRawParameters(send, '{"text":"a","text":"b"}'), 'duplicate-key'],
    // Parameters themselves are still required and must be an object.
    [
      `{"intent":"${send}","percentages":{${NAMES.map((name) => `"${name}":${name === send ? 100 : 0}`).join(',')}}}`,
      'parameters-missing',
    ],
    [withRawParameters(send, 'null'), 'parameters-not-an-object'],
    [withRawParameters(send, '""'), 'parameters-not-an-object'],
    [withRawParameters(send, '[]'), 'parameters-not-an-object'],
    // Intents without text still refuse any text key, even null.
    [withRawParameters('IGNORE', '{"text":null}'), 'text-on-no-text-intent'],
    [withRawParameters('IGNORE', `{"text":"${SECRET}"}`), 'text-on-no-text-intent'],
    [withRawParameters('CHOOSE_AGENT_OPTION_1', '{"other":1}'), 'unexpected-parameter'],
    // Wrong routes: shortcut-only, case variants and unknown names.
    [withRawParameters('ENTER_TEXT_TO_APPLICATION', '{}'), 'unknown-intent'],
    [withRawParameters('QUICK_QUESTION', '{}'), 'unknown-intent'],
    [withRawParameters('send_text_to_application', '{}'), 'unknown-intent'],
    // A top-level text key is not a parameter.
    [`${withRawParameters(send, '{}').slice(0, -1)},"text":"Hi"}`, 'unexpected-top-level-key'],
    // The percentage rules still apply to omitted responses.
    [`{"intent":"${send}","parameters":{}}`, 'percentages-missing'],
    [response(send, { SEND_TEXT_TO_APPLICATION: 60, IGNORE: 39 }), 'percentages-sum-not-100'],
    [response(send, { SEND_TEXT_TO_APPLICATION: 30, IGNORE: 70 }), 'chosen-intent-not-highest'],
    [
      withRawParameters(send, '{}').replace(`"${send}":100`, `"${send}":100.0`),
      'percentage-not-integer-literal',
    ],
    // Malformed wrappers are never unwrapped.
    ['```json\n' + withRawParameters(send, '{}') + '\n```', 'invalid-json'],
    [`﻿${withRawParameters(send, '{}')}`, 'invalid-json'],
  ];

  for (const [text, reason] of cases) {
    assert.deepEqual(parseExperimentResponse(text, OPTIONAL), { valid: false, reason }, text);
  }
});

test('old variants still reject {} on a text route and keep their result shapes', () => {
  const send = 'SEND_TEXT_TO_APPLICATION';

  // json-cleanup-percentages-v1: omission is text-missing, as before.
  assert.deepEqual(parseExperimentResponse(withRawParameters(send, '{}'), V2), {
    valid: false,
    reason: 'text-missing',
  });
  // json-cleanup-v1 likewise.
  assert.deepEqual(parseExperimentResponse(`{"intent":"${send}","parameters":{}}`, V1), {
    valid: false,
    reason: 'text-missing',
  });

  // Their valid results carry no textOmitted field.
  const v2 = parseExperimentResponse(withRawParameters(send, '{"text":"Hi."}'), V2);
  assert.ok(v2.valid);
  assert.ok(!('textOmitted' in v2));
  assert.deepEqual(
    parseExperimentResponse(`{"intent":"${send}","parameters":{"text":"Hi."}}`, V1),
    { valid: true, intent: send, text: 'Hi.' },
  );
  assert.deepEqual(parseExperimentResponse('{"intent":"IGNORE","parameters":{}}', V1), {
    valid: true,
    intent: 'IGNORE',
    text: null,
  });
});

test('optional-text diagnostics stay consistent with every reason; text-missing never occurs', () => {
  const intents: unknown[] = [
    'IGNORE',
    'SEND_TEXT_TO_APPLICATION',
    'START_CODING_AGENT_SESSION',
    'ENTER_TEXT_TO_APPLICATION',
    'UNKNOWN',
    7,
  ];
  const parameters: unknown[] = [
    undefined,
    {},
    { text: 'x' },
    { text: null },
    { text: '' },
    { text: ' x' },
    { text: 3 },
    { other: 1 },
    { text: 'x', other: 1 },
    null,
    [],
  ];
  const corpus: string[] = [];
  for (const intent of intents) {
    for (const parameter of parameters) {
      for (const percentages of [undefined, { IGNORE: 100 }, 'full']) {
        const value: Record<string, unknown> = { intent };
        if (parameter !== undefined) {
          value.parameters = parameter;
        }
        if (percentages === 'full') {
          value.percentages = Object.fromEntries(
            NAMES.map((name) => [name, name === intent ? 100 : 0]),
          );
        } else if (percentages !== undefined) {
          value.percentages = percentages;
        }
        corpus.push(JSON.stringify(value));
      }
    }
  }

  const reasons = new Set<string>();
  for (const text of corpus) {
    const parsed = parseExperimentResponse(text, OPTIONAL);
    const selected = diagnosticIntentSelection(text, OPTIONAL);
    if (parsed.valid) {
      assert.equal(selected, parsed.intent, text);
      continue;
    }
    reasons.add(parsed.reason);
    assert.ok(diagnosticConsistentWithReason(parsed.reason, selected), `${parsed.reason}: ${text}`);
  }
  assert.ok(!reasons.has('text-missing'));
  // The corpus reaches the parameter and text reasons it is meant to cover.
  for (const reason of [
    'parameters-missing',
    'parameters-not-an-object',
    'unexpected-parameter',
    'text-not-a-string',
    'text-empty',
    'text-surrounding-whitespace',
    'text-on-no-text-intent',
    'unknown-intent',
    'percentages-missing',
  ]) {
    assert.ok(reasons.has(reason), reason);
  }
});

test('the only fallback: an omitted text becomes the transcript byte for byte', () => {
  // Filler, non-breaking and zero-width spaces, CRLF and surrounding spaces:
  // nothing is trimmed, normalized or cleaned.
  const transcript = `  um, héllo wörld\r\nsecond line ​ ${SECRET} `;

  const omitted = parseExperimentResponse(
    withRawParameters('START_CODING_AGENT_SESSION', '{}'),
    OPTIONAL,
  );
  assert.ok(omitted.valid);
  const fallback = resolveEffectiveText(omitted, transcript);
  assert.equal(fallback.source, 'transcript');
  assert.equal(fallback.text, transcript);
  assert.ok(Buffer.from(fallback.text!, 'utf8').equals(Buffer.from(transcript, 'utf8')));

  // Model text is used exactly as returned.
  const provided = parseExperimentResponse(
    withRawParameters('SEND_TEXT_TO_APPLICATION', '{"text":"Hello, world."}'),
    OPTIONAL,
  );
  assert.ok(provided.valid);
  assert.deepEqual(resolveEffectiveText(provided, transcript), {
    text: 'Hello, world.',
    source: 'model',
  });

  // Intents without text never get the transcript.
  const ignore = parseExperimentResponse(withRawParameters('IGNORE', '{}'), OPTIONAL);
  assert.ok(ignore.valid);
  assert.deepEqual(resolveEffectiveText(ignore, transcript), { text: null, source: null });
});

// ---------------------------------------------------------------------------
// Prompt, pins and planning
// ---------------------------------------------------------------------------

test('prompt: only the system prompt changes; v1 and percentages-v1 pins are unchanged', () => {
  const pinRecord = {
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
  assert.equal(promptFingerprint(VARIANT_ID), V1_PROMPT_HASH);
  assert.equal(promptFingerprint(PERCENTAGES_VARIANT_ID), V2_PINS.promptHash);
  assert.equal(
    sha(transformRecordedRequest(pinRecord, 512, PERCENTAGES_VARIANT_ID).body),
    V2_PINS.inferredBodySha,
  );
  const optionalHash = promptFingerprint(OPTIONAL_TEXT_VARIANT_ID);
  assert.notEqual(optionalHash, V1_PROMPT_HASH);
  assert.notEqual(optionalHash, V2_PINS.promptHash);

  // Everything except the system prompt matches percentages-v1 (and so the recording).
  const { record } = recordFor(payload(`dictation ${SECRET}`));
  const before = structuredClone(record);
  const v2 = transformRecordedRequest(record, 256, PERCENTAGES_VARIANT_ID);
  const optional = transformRecordedRequest(record, 256, OPTIONAL_TEXT_VARIANT_ID);
  assert.deepEqual(record, before);
  const { messages: v2Messages, ...v2Rest } = v2.body;
  const { messages: optionalMessages, ...optionalRest } = optional.body;
  assert.deepEqual(optionalRest, v2Rest);
  assert.deepEqual((optionalMessages as unknown[])[1], (v2Messages as unknown[])[1]);
  assert.deepEqual(optional.allowedIntents, NAMES);

  const prompt = (optionalMessages as { content: string }[])[0]!.content;
  const v2Prompt = (v2Messages as { content: string }[])[0]!.content;
  assert.ok(prompt.includes(OPTIONAL_MARKER));
  assert.ok(!prompt.includes(V2_MARKER));
  // The percentages rules, cleanup (with its injection rules) and SEND formatting are kept.
  for (const instruction of [
    PERCENTAGES_INSTRUCTION,
    CLEANUP_INSTRUCTION,
    SEND_FORMATTING_INSTRUCTION,
    OPTIONAL_TEXT_SEND_INSTRUCTION,
    OPTIONAL_TEXT_INSTRUCTION,
  ]) {
    assert.ok(prompt.includes(instruction), instruction.slice(0, 40));
  }
  // The percentages-v1 prompt has none of the optional-text wording.
  assert.ok(!v2Prompt.includes(OPTIONAL_TEXT_INSTRUCTION));
  assert.ok(!v2Prompt.includes(OPTIONAL_TEXT_SEND_INSTRUCTION));
  // The SEND omission rule is attached to the SEND formatting section.
  assert.ok(prompt.includes(`${SEND_FORMATTING_INSTRUCTION}\n${OPTIONAL_TEXT_SEND_INSTRUCTION}\n`));
  assert.ok(prompt.includes('"text", containing the cleaned-up text of the current utterance, or'));
  assert.ok(prompt.includes('If you are unsure, include "text".'));
  assert.ok(!prompt.includes('ENTER_TEXT_TO_APPLICATION'));
  assert.ok(!prompt.includes('QUICK_QUESTION'));

  // Without SEND: no SEND formatting or SEND omission rule, still optional text.
  const noSend = transformRecordedRequest(
    recordFor(
      payload('u', undefined, [
        { name: 'IGNORE', instruction: 'Nothing.' },
        { name: 'CONTINUE_OPEN_AGENT_CONVERSATION', instruction: 'Follow up.' },
      ]),
    ).record,
    256,
    OPTIONAL_TEXT_VARIANT_ID,
  );
  const noSendPrompt = (noSend.body.messages as { content: string }[])[0]!.content;
  assert.ok(!noSendPrompt.includes(SEND_FORMATTING_INSTRUCTION));
  assert.ok(!noSendPrompt.includes(OPTIONAL_TEXT_SEND_INSTRUCTION));
  assert.ok(noSendPrompt.includes(OPTIONAL_TEXT_INSTRUCTION));

  // No text route offered: no optional-text section at all.
  const noText = transformRecordedRequest(
    recordFor(
      payload('u', undefined, [
        { name: 'IGNORE', instruction: 'Nothing.' },
        { name: 'CHOOSE_AGENT_OPTION_1', instruction: 'Pick.' },
      ]),
    ).record,
    256,
    OPTIONAL_TEXT_VARIANT_ID,
  );
  const noTextPrompt = (noText.body.messages as { content: string }[])[0]!.content;
  assert.ok(noTextPrompt.includes('For every intent, "parameters" is an empty object.'));
  assert.ok(!noTextPrompt.includes('Optional text:'));
});

test('optional-text is inferred-only and needs exactly one nonempty recorded utterance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-plan-'));

  // Fixed shortcut routes are refused before any call.
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
      { mode: 'fixed-route', datasetPath: fixture, variant: OPTIONAL_TEXT_VARIANT_ID },
      64,
    ),
    /applies only to inferred --dataset runs; fixed-route shortcuts stay on json-cleanup-v1/,
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
    OPTIONAL_TEXT_VARIANT_ID,
  ]);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /fixed-route shortcuts stay on json-cleanup-v1/);

  // Recordings without an unambiguous utterance: the fallback is never guessed.
  const unusable: [string, string[]][] = [
    ['no frame JSON', [`not json ${SECRET}`]],
    ['no utterance field', [JSON.stringify({ application: { title: SECRET } })]],
    ['utterance not a string', [JSON.stringify({ utterance: 5 })]],
    ['empty utterance', [JSON.stringify({ utterance: '' })]],
    [
      'two utterances',
      [JSON.stringify({ utterance: `a ${SECRET}` }), JSON.stringify({ utterance: 'b' })],
    ],
  ];
  let calls = 0;
  const endpoint = await server((_request, response) => {
    calls++;
    response.end(completion('IGNORE'));
  });
  try {
    for (const [name, userTexts] of unusable) {
      const datasetPath = await writeDataset(await mkdtemp(join(root, 'case-')), [
        { utterance: 'fine', expected: 'IGNORE' },
        { utterance: 'x', expected: 'IGNORE', userTexts },
      ]);
      const refusal = new RegExp(
        `Example ${uuid(1)}: ${OPTIONAL_TEXT_VARIANT_ID} needs exactly one nonempty recorded utterance`,
      );
      await assert.rejects(
        planExperiment({ mode: 'inferred', datasetPath, variant: OPTIONAL_TEXT_VARIANT_ID }, 64),
        refusal,
        name,
      );
      await assert.rejects(
        runExperiment(
          { mode: 'inferred', datasetPath, variant: OPTIONAL_TEXT_VARIANT_ID },
          [{ name: 't', model: 'm', baseUrl: endpoint.url }],
          64,
        ),
        (error: Error) => refusal.test(error.message) && !error.message.includes(SECRET),
        name,
      );
      // The percentages variant does not need the fallback and still plans.
      const v2Plan = await planExperiment(
        { mode: 'inferred', datasetPath, variant: PERCENTAGES_VARIANT_ID },
        64,
      );
      assert.equal(v2Plan.supported.length, 2, name);
    }
    assert.equal(calls, 0);
  } finally {
    await endpoint.close();
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Transcript with bytes that trimming or normalization would change. */
const RAW_TRANSCRIPT = ` send héllo ${SECRET}\r\n `;

/** Scenario: the fake server answers by utterance; keys are the utterances. */
const OPTIONAL_ANSWERS: Record<string, string> = {
  [RAW_TRANSCRIPT]: response('SEND_TEXT_TO_APPLICATION', { SEND_TEXT_TO_APPLICATION: 100 }),
  'clean send': response(
    'SEND_TEXT_TO_APPLICATION',
    { SEND_TEXT_TO_APPLICATION: 80, IGNORE: 20 },
    { text: 'Clean send.' },
  ),
  'Already clean.': response(
    'SEND_TEXT_TO_APPLICATION',
    { SEND_TEXT_TO_APPLICATION: 100 },
    { text: 'Already clean.' },
  ),
  'start coding': response('START_CODING_AGENT_SESSION', { START_CODING_AGENT_SESSION: 100 }),
  ignore: response('IGNORE', { IGNORE: 100 }),
  'null text': response(
    'SEND_TEXT_TO_APPLICATION',
    { SEND_TEXT_TO_APPLICATION: 100 },
    {
      text: null,
    },
  ),
  'empty text': response(
    'SEND_TEXT_TO_APPLICATION',
    { SEND_TEXT_TO_APPLICATION: 100 },
    {
      text: '',
    },
  ),
  'enter route': withRawParameters('ENTER_TEXT_TO_APPLICATION', '{}'),
  'wrong omitted': response('START_CODING_AGENT_SESSION', {
    START_CODING_AGENT_SESSION: 70,
    SEND_TEXT_TO_APPLICATION: 30,
  }),
};
const SCENARIO: Example[] = [
  { utterance: RAW_TRANSCRIPT, expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'clean send', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'Already clean.', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'start coding', expected: 'START_CODING_AGENT_SESSION' },
  { utterance: 'ignore', expected: 'IGNORE' },
  { utterance: 'null text', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'empty text', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'enter route', expected: 'SEND_TEXT_TO_APPLICATION' },
  { utterance: 'wrong omitted', expected: 'SEND_TEXT_TO_APPLICATION' },
];

/** Percentages-v1 answers: the same intents, always with text on text routes. */
function v2Answer(key: string): string {
  const parsed = JSON.parse(OPTIONAL_ANSWERS[key]!);
  if (
    parsed.intent === 'SEND_TEXT_TO_APPLICATION' ||
    parsed.intent === 'START_CODING_AGENT_SESSION'
  ) {
    if (parsed.parameters && Object.keys(parsed.parameters).length === 0) {
      parsed.parameters = { text: 'Cleaned.' };
    }
  }
  return JSON.stringify(parsed);
}

async function scenarioServer() {
  const arms: string[] = [];
  const endpoint = await server(async (request, response) => {
    const body = await readBody(request);
    const key = utteranceOf(body);
    const system = systemPromptOf(body);
    if (system.includes(OPTIONAL_MARKER)) {
      arms.push('optional');
      // Omitted answers are shorter, so report fewer output tokens.
      const answer = OPTIONAL_ANSWERS[key]!;
      response.end(completion(answer, answer.includes('"parameters":{}') ? 20 : 40));
    } else if (system.includes(V2_MARKER)) {
      arms.push('percentages');
      response.end(completion(v2Answer(key), 40));
    } else {
      arms.push('baseline');
      const example = SCENARIO.find((entry) => entry.utterance === key)!;
      response.end(completion(example.expected));
    }
  });
  return { endpoint, arms };
}

test('runs use the transcript byte for byte for omitted text and report counts and timing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-run-'));
  const datasetPath = await writeDataset(root, SCENARIO);
  const { endpoint } = await scenarioServer();

  try {
    const target = { name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 3 };
    const checks = {
      version: 1 as const,
      kind: 'companion-cleanup-literal-checks' as const,
      checks: {
        // The omitted text is checked as the transcript it would deliver.
        [uuid(0)]: { mustContain: ['héllo '], mustNotContain: ['APPROVED'] },
        [uuid(5)]: { mustContain: ['x'], mustNotContain: [] },
      },
    };
    const run = await runExperiment(
      { mode: 'inferred', datasetPath, variant: OPTIONAL_TEXT_VARIANT_ID },
      [target],
      512,
      undefined,
      checks,
    );
    const rows = new Map(run.report.results.map((row) => [row.id, row]));
    const row = (index: number) => rows.get(uuid(index))!;
    const fields = (index: number) => [
      row(index).status,
      row(index).correct,
      row(index).hasText,
      row(index).textSource,
      row(index).modelTextMatchesTranscript,
      row(index).invalidReason,
    ];

    assert.equal(run.report.variant.id, OPTIONAL_TEXT_VARIANT_ID);
    assert.equal(run.report.variant.promptHash, promptFingerprint(OPTIONAL_TEXT_VARIANT_ID));
    assert.match(run.report.variant.contract, /does not prove that cleanup was unnecessary/);

    assert.deepEqual(fields(0), ['valid', true, true, 'transcript', null, null]);
    assert.deepEqual(fields(1), ['valid', true, true, 'model', false, null]);
    // Text returned although it equals the transcript: valid, flagged.
    assert.deepEqual(fields(2), ['valid', true, true, 'model', true, null]);
    assert.deepEqual(fields(3), ['valid', true, true, 'transcript', null, null]);
    assert.deepEqual(fields(4), ['valid', true, false, null, null, null]);
    // Invalid responses never get the fallback.
    assert.deepEqual(fields(5), ['invalid', false, false, null, null, 'text-not-a-string']);
    assert.deepEqual(fields(6), ['invalid', false, false, null, null, 'text-empty']);
    assert.deepEqual(fields(7), ['invalid', false, false, null, null, 'unknown-intent']);
    // A wrong intent with omitted text is still valid, and still wrong.
    assert.deepEqual(fields(8), ['valid', false, true, 'transcript', null, null]);
    assert.equal(row(5).selectedIntent, 'SEND_TEXT_TO_APPLICATION');
    assert.equal(row(0).chosenPercentage, 100);

    // Literal checks judge the effective text; invalid rows are not evaluated.
    assert.equal(row(0).literalCheck, 'passed');
    assert.equal(row(5).literalCheck, 'not-evaluated');

    const summary = run.report.summary[0]!;
    assert.equal(summary.classification!.usableCorrect, 5);
    assert.equal(summary.cleanup.textResponses, 5);
    const optional = summary.optionalText!;
    assert.match(optional.definition, /does NOT prove that/);
    assert.deepEqual(
      {
        ...optional,
        definition: undefined,
        latencyMs: undefined,
        byRoute: { ...optional.byRoute },
      },
      {
        definition: undefined,
        validTextRouteResponses: 5,
        omittedUsingTranscript: 3,
        providedText: 2,
        providedTextIdenticalToTranscript: 1,
        omissionRate: 3 / 5,
        byRoute: {
          SEND_TEXT_TO_APPLICATION: { omitted: 1, provided: 2 },
          START_CODING_AGENT_SESSION: { omitted: 2, provided: 0 },
        },
        latencyMs: undefined,
        meanOutputTokens: { omitted: 20, provided: 40 },
      },
    );
    assert.equal(optional.latencyMs.omitted.count, 3);
    assert.equal(optional.latencyMs.provided.count, 2);
    assert.ok(summary.selfReportedPercentages);

    // Shareable report: no dictation, transcript or model text.
    const shareable = JSON.stringify(run.report);
    assert.ok(!shareable.includes(SECRET));
    assert.ok(!shareable.includes('Clean send.'));
    assert.ok(!shareable.includes('héllo'));

    // Private outputs: byte-exact effective text and the text source.
    const privateById = new Map(run.privateOutputs.map((entry) => [entry.id, entry]));
    const omitted = privateById.get(uuid(0))!;
    assert.equal(omitted.cleanedText, null);
    assert.equal(omitted.textSource, 'transcript');
    assert.equal(omitted.effectiveText, RAW_TRANSCRIPT);
    assert.equal(omitted.spokenText, RAW_TRANSCRIPT);
    assert.deepEqual(omitted.literalCheck, { status: 'passed' });
    const provided = privateById.get(uuid(1))!;
    assert.deepEqual(
      [provided.cleanedText, provided.effectiveText, provided.textSource],
      ['Clean send.', 'Clean send.', 'model'],
    );
    const invalid = privateById.get(uuid(5))!;
    assert.deepEqual(
      [invalid.cleanedText, invalid.effectiveText, invalid.textSource],
      [null, null, null],
    );
    assert.ok(invalid.invalidResponseText!.includes('"text":null'));
    assert.equal(privateById.get(uuid(4))!.effectiveText, null);

    // Percentages-v1 rows keep exactly their earlier shape.
    const v2 = await runExperiment(
      { mode: 'inferred', datasetPath, variant: PERCENTAGES_VARIANT_ID },
      [target],
      512,
    );
    for (const result of v2.report.results) {
      assert.ok(!('textSource' in result));
      assert.ok(!('modelTextMatchesTranscript' in result));
      assert.ok('chosenPercentage' in result);
    }
    assert.ok(!('optionalText' in v2.report.summary[0]!));
    assert.ok(!('effectiveText' in v2.privateOutputs[0]!));
  } finally {
    await endpoint.close();
  }
});

test('optional-text runs cancel cleanly: no scheduling after abort, drained before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-cancel-'));
  const datasetPath = await writeDataset(root, SCENARIO.slice(0, 3));
  let calls = 0;
  const endpoint = await server(() => {
    // Never answer.
    calls++;
  });
  try {
    const controller = new AbortController();
    const run = runExperiment(
      { mode: 'inferred', datasetPath, variant: OPTIONAL_TEXT_VARIANT_ID },
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
// Pairing and report validation
// ---------------------------------------------------------------------------

type ReportJson = Record<string, any>;

test('pair and pair-variants accept optional-text reports and refuse corruption before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-pair-'));
  const datasetPath = await writeDataset(root, SCENARIO);
  const { endpoint } = await scenarioServer();

  let baseline: ReportJson;
  let v2: ReportJson;
  let optional: ReportJson;
  try {
    const target = { name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 2 };
    baseline = { state: 'complete', ...(await runEvaluation(datasetPath, [target])) };
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
    optional = {
      state: 'complete',
      ...(
        await runExperiment(
          { mode: 'inferred', datasetPath, variant: OPTIONAL_TEXT_VARIANT_ID },
          [target],
          512,
        )
      ).report,
    };
  } finally {
    await endpoint.close();
  }
  [baseline, v2, optional] = [baseline, v2, optional].map((report) =>
    JSON.parse(JSON.stringify(report)),
  );

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
      await write(`variant-${counter}.json`, variant),
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

  // Baseline versus optional-text.
  const valid = await pair(optional);
  assert.equal(valid.result.status, 0, valid.result.stderr);
  const pairing = JSON.parse(await readFile(valid.out, 'utf8'));
  assert.equal((await stat(valid.out)).mode & 0o777, 0o600);
  assert.equal(pairing.selection.variant.variantId, OPTIONAL_TEXT_VARIANT_ID);
  assert.deepEqual(
    pairing.pairs.map((entry: ReportJson) => entry.variant.textSource),
    ['transcript', 'model', 'model', 'transcript', null, null, null, null, 'transcript'],
  );
  assert.deepEqual(pairing.summary.variant.optionalText, {
    validTextRouteResponses: 5,
    omittedUsingTranscript: 3,
    providedText: 2,
    omissionRate: 3 / 5,
  });
  assert.match(pairing.summary.definitions.optionalText, /does NOT prove that/);
  assert.ok(!JSON.stringify(pairing).includes(SECRET));

  // Percentages-v1 (left) versus optional-text (right), and reversed.
  const versus = await pairVariants(v2, optional);
  assert.equal(versus.result.status, 0, versus.result.stderr);
  const versusReport = JSON.parse(await readFile(versus.out, 'utf8'));
  assert.equal(versusReport.selection.left.variantId, PERCENTAGES_VARIANT_ID);
  assert.equal(versusReport.selection.right.variantId, OPTIONAL_TEXT_VARIANT_ID);
  assert.equal(versusReport.summary.pairedExamples, 9);
  assert.ok(!('optionalText' in versusReport.summary.left));
  assert.equal(versusReport.summary.right.optionalText.omittedUsingTranscript, 3);
  assert.equal(versusReport.pairs[0].left.textSource, undefined);
  assert.equal(versusReport.pairs[0].right.textSource, 'transcript');
  const [byRight] = versusReport.summary.latencyMs.byOptionalTextSource;
  assert.equal(byRight.groupedBy, 'right');
  assert.equal(byRight.omittedPairedDifference.count, 3);
  assert.equal(byRight.providedPairedDifference.count, 2);

  const reversed = pairVariantRuns({
    left: optional,
    leftTarget: 'local',
    right: v2,
    rightTarget: 'local',
  });
  assert.equal(reversed.summary.latencyMs.byOptionalTextSource![0]!.groupedBy, 'left');
  // v1-style pairings are unchanged: no optional-text fields.
  const v2Pairing = pairRuns({
    baseline: completedRunnerReport(baseline),
    baselineTarget: 'local',
    variant: v2,
    variantTarget: 'local',
  });
  assert.ok(!('optionalText' in v2Pairing.summary.variant));
  assert.ok(!('optionalText' in v2Pairing.summary.definitions));
  assert.ok(!('textSource' in v2Pairing.pairs[0]!.variant));

  const row = (report: ReportJson, index: number) =>
    report.results.find((entry: ReportJson) => entry.id === uuid(index));
  const invalidTextMissing = (r: ReportJson) =>
    Object.assign(row(r, 5), { invalidReason: 'text-missing' });

  const corruptions: [string, (report: ReportJson) => void, RegExp][] = [
    [
      'text source on an intent without text',
      (r) => void (row(r, 4).textSource = 'transcript'),
      /textSource must be set exactly for a valid text-route response/,
    ],
    [
      'no text source on a valid text route',
      (r) => void (row(r, 0).textSource = null),
      /textSource must be set exactly for a valid text-route response/,
    ],
    [
      'fallback on an invalid row',
      (r) => void (row(r, 5).textSource = 'transcript'),
      /textSource must be set exactly for a valid text-route response/,
    ],
    [
      'unknown text source',
      (r) => void (row(r, 0).textSource = 'cleaned'),
      /textSource is not an allowed value/,
    ],
    [
      'match flag on a transcript row',
      (r) => void (row(r, 0).modelTextMatchesTranscript = true),
      /must be null unless the model returned text/,
    ],
    [
      'match flag missing on a model row',
      (r) => void (row(r, 1).modelTextMatchesTranscript = null),
      /modelTextMatchesTranscript must be true or false/,
    ],
    [
      'missing text source field',
      (r) => void delete row(r, 0).textSource,
      /missing or unexpected fields/,
    ],
    [
      'fallback row without text',
      (r) => void (row(r, 0).hasText = false),
      /hasText does not match whether its intent takes text/,
    ],
    ['text-missing reason', invalidTextMissing, /invalidReason is not possible for this variant/],
    [
      'prompt hash of percentages-v1',
      (r) => void (r.variant.promptHash = V2_PINS.promptHash),
      /promptHash does not match/,
    ],
  ];
  for (const [name, corrupt, reason] of corruptions) {
    const copy = structuredClone(optional);
    corrupt(copy);
    const { result, out } = await pair(copy);
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, reason, name);
    await assert.rejects(stat(out), /ENOENT/, name);
    assert.ok(!result.stderr.includes(SECRET), name);
  }

  // Old-variant rejection: percentages-v1 rows cannot carry the new fields,
  // and a percentages-v1 report cannot be relabeled as the new variant.
  const v2WithFields = structuredClone(v2);
  Object.assign(row(v2WithFields, 0), { textSource: 'model', modelTextMatchesTranscript: false });
  const extra = await pairVariants(v2WithFields, optional);
  assert.equal(extra.result.status, 1);
  assert.match(extra.result.stderr, /missing or unexpected fields/);
  await assert.rejects(stat(extra.out), /ENOENT/);

  const relabeled = structuredClone(v2);
  relabeled.variant.id = OPTIONAL_TEXT_VARIANT_ID;
  assert.match((await pair(relabeled)).result.stderr, /promptHash does not match/);
  relabeled.variant.promptHash = promptFingerprint(OPTIONAL_TEXT_VARIANT_ID);
  assert.match((await pair(relabeled)).result.stderr, /missing or unexpected fields/);

  // And the new report cannot pose as percentages-v1.
  const posing = structuredClone(optional);
  posing.variant.id = PERCENTAGES_VARIANT_ID;
  posing.variant.promptHash = V2_PINS.promptHash;
  assert.match((await pair(posing)).result.stderr, /missing or unexpected fields/);

  // Variant-vs-variant pairing still refuses different datasets.
  const otherDataset = structuredClone(optional);
  otherDataset.datasetHash = '0'.repeat(64);
  assert.match((await pairVariants(v2, otherDataset)).result.stderr, /different frozen datasets/);
});

// ---------------------------------------------------------------------------
// Compare and CLI
// ---------------------------------------------------------------------------

test('compare pairs percentages-v1 with optional-text and labels the omission caveat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-compare-'));
  const datasetPath = await writeDataset(root, SCENARIO);
  const { endpoint, arms } = await scenarioServer();

  try {
    const { report, privateOutputs } = await runVariantComparison({
      datasetPath,
      targets: [{ name: 'local', model: 'm', baseUrl: endpoint.url, concurrency: 2 }],
      outputTokens: 512,
      order: 'baseline-first',
      checks: null,
      variants: [PERCENTAGES_VARIANT_ID, OPTIONAL_TEXT_VARIANT_ID],
    });

    assert.deepEqual(arms, [
      ...Array(9).fill('baseline'),
      ...Array(9).fill('percentages'),
      ...Array(9).fill('optional'),
    ]);
    assert.ok(report.caveats.some((caveat) => /does NOT prove it/.test(caveat)));
    assert.ok(report.caveats.some((caveat) => /SELF-REPORTED/.test(caveat)));
    const versus = report.variantComparisons[0]!;
    assert.equal(
      (versus.summary.right as { optionalText?: { omittedUsingTranscript: number } }).optionalText!
        .omittedUsingTranscript,
      3,
    );
    assert.equal(report.paired[1]!.variant, OPTIONAL_TEXT_VARIANT_ID);
    assert.deepEqual(
      privateOutputs.map((group) => group.variant),
      [PERCENTAGES_VARIANT_ID, OPTIONAL_TEXT_VARIANT_ID],
    );
    assert.ok(!JSON.stringify(report).includes(SECRET));
  } finally {
    await endpoint.close();
  }
});

test('CLI prompt and run with the optional-text variant write labeled 0600 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-optional-text-cli-'));
  const datasetPath = await writeDataset(root, SCENARIO.slice(0, 4));
  const { endpoint } = await scenarioServer();

  try {
    const printed = cli(['prompt', '--variant', OPTIONAL_TEXT_VARIANT_ID]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.ok(printed.stdout.includes(OPTIONAL_TEXT_INSTRUCTION));
    assert.ok(printed.stdout.includes(promptFingerprint(OPTIONAL_TEXT_VARIANT_ID)));
    assert.match(cli(['--help']).stdout, /json-cleanup-percentages-optional-text-v1/);

    const targets = join(root, 'targets.json');
    await writeFile(targets, JSON.stringify([{ name: 't', model: 'm', baseUrl: endpoint.url }]));
    // spawnSync would block the fake server in this process; run asynchronously.
    const exec = promisify(execFile);
    const out = join(root, 'run.json');
    const privateOut = join(root, 'run-private.json');
    const ran = await exec(process.execPath, [
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
      OPTIONAL_TEXT_VARIANT_ID,
      '--out',
      out,
      '--private-out',
      privateOut,
      '--send',
    ]);
    assert.ok(!ran.stdout.includes(SECRET));
    assert.match(ran.stdout, /"omittedUsingTranscript": 2/);

    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.state, 'complete');
    assert.equal(report.variant.id, OPTIONAL_TEXT_VARIANT_ID);
    assert.ok(!JSON.stringify(report).includes(SECRET));
    const privateFile = JSON.parse(await readFile(privateOut, 'utf8'));
    assert.equal(privateFile.variant, OPTIONAL_TEXT_VARIANT_ID);
    assert.equal(privateFile.outputs[0].effectiveText, RAW_TRANSCRIPT);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.equal((await stat(privateOut)).mode & 0o777, 0o600);
  } finally {
    await endpoint.close();
  }
});
