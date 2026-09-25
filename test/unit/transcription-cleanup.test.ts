/**
 * Live automatic transcription cleanup (json-cleanup-v1).
 *
 * Synthetic text, a 1×1 PNG and local HTTP servers only. Model behavior is
 * scripted: these tests show what the app does with each kind of response,
 * never how well any model cleans up text.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { buildPrompt, IntentDetector } from '../../src/core/intent-detector.ts';
import { restoreIntentRequest, snapshotIntentRequest } from '../../src/core/intent-request.ts';
import { IntentDisabledError } from '../../src/core/delivery-error.ts';
import {
  UtteranceSupersededError,
  type DispatchCommitment,
} from '../../src/core/utterance-continuation.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import type { UserSensorFrame, UserSensorProcessor } from '../../src/core/frame.ts';
import {
  UserSensorRouter,
  type CleanupDetection,
  type Detector,
  type FixedRouteCleanup,
  type TextCleaner,
} from '../../src/core/router.ts';
import {
  FixedRouteCleaner,
  SHORTCUT_CLEANUP_TIMEOUT_MS,
} from '../../src/core/transcription-cleanup/fixed-route-cleaner.ts';
import {
  CLEANUP_INSTRUCTION,
  cleanupResponseSection,
  fixedRouteSystemPrompt,
  RECORDED_ANSWER_SENTENCE,
  RECORDED_IGNORE_SENTENCE,
  SEND_FORMATTING_INSTRUCTION,
  VARIANT_ANSWER_SENTENCE,
  VARIANT_IGNORE_SENTENCE,
  withCleanupResponseFormat,
} from '../../src/core/transcription-cleanup/prompt.ts';
import {
  interpretFixedRouteResponse,
  interpretInferredResponse,
} from '../../src/core/transcription-cleanup/response.ts';
import type { TranscriptionCleanupRecord } from '../../src/core/transcription-cleanup/record.ts';
import { TranscriptionCleanupSetting } from '../../src/core/transcription-cleanup/setting.ts';
import { CleanupPreference } from '../../src/desktop/cleanup-preference.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { saveArtifact } from '../../src/desktop/artifacts.ts';
import { exportDataset, inspectDatabase, restoreExample } from '../../src/evals/dataset.ts';
import {
  buildFixedRouteRequest,
  transformRecordedRequest,
} from '../../src/evals/experiments/json-cleanup/prompt.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import type { RunCommand } from '../../src/sensors/screen/capture.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, processor, signal } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'synthetic-private-dictation-7f3a';

const baseFrame: UserSensorFrame = {
  id: 7,
  observedAt: 1000,
  utterance: 'um so send the report uh tomorrow',
  screenshot: frame.screenshot,
  interaction: { agentSessionId: '', agentComposerFocused: false, revision: 3 },
};

const offeredIntents = [
  { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Dictation instruction' },
  { name: 'IGNORE', instruction: 'Background speech' },
  { name: 'START_CODING_AGENT_SESSION', instruction: 'Ask the assistant' },
];

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ModelServer {
  baseUrl: string;
  config: { baseUrl: string; model: string; timeoutMs: number };
  bodies: string[];
  close(): Promise<void>;
}

/**
 * A local OpenAI-compatible SSE endpoint. `reply` returns the assistant text
 * for each request, or null to never answer (for timeouts).
 */
async function modelServer(
  reply: (body: Record<string, unknown>) => string | null,
  options: { finish?: string; status?: number } = {},
): Promise<ModelServer> {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
    }
    bodies.push(text);

    const content = reply(JSON.parse(text) as Record<string, unknown>);
    if (content === null) {
      return;
    }

    const status = options.status ?? 200;
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic failure' } }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { role: 'assistant', content };
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: options.finish ?? 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  return {
    baseUrl,
    config: { baseUrl, model: 'test-model', timeoutMs: 2000 },
    bodies,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Recorded intent requests, comparable across runs and endpoints. */
function comparableRecord(serialized: string): string {
  const record = JSON.parse(serialized) as Record<string, unknown>;
  delete record.preparedAt;
  record.baseUrl = 'BASE';
  return JSON.stringify(record);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Switch off: byte-identical to master
// ---------------------------------------------------------------------------

test('switch off: the bare-name wire request and its recording are byte-identical to master', async () => {
  // Pinned by running master c5b01c4's own IntentDetector against this exact
  // frame, intents and endpoint shape (a local fake server; no model).
  const MASTER_WIRE_SHA = 'a78bbb3522e067b3feb184f6406e2e190ef23b0a508e8b214ec578cc6e89692b';
  const MASTER_RECORD_SHA = 'c4ade471a797a9187ec1f532dff44ad3aadfc42b12b3f0701944a50c339c93d8';

  const endpoint = await modelServer(() => 'SEND_TEXT_TO_APPLICATION');
  try {
    const records: string[] = [];
    const detector = new IntentDetector(endpoint.config, undefined, 'detector', {
      intentRequested: (_id, record) => records.push(record),
    });

    const name = await detector.detect(baseFrame, offeredIntents, signal());

    assert.equal(name, 'SEND_TEXT_TO_APPLICATION');
    assert.equal(sha(endpoint.bodies[0]!), MASTER_WIRE_SHA);
    assert.equal(sha(comparableRecord(records[0]!)), MASTER_RECORD_SHA);
    assert.equal(JSON.parse(endpoint.bodies[0]!).max_tokens, 32);
    assert.equal(JSON.parse(records[0]!).version, 1);
    assert.equal('promptVariant' in JSON.parse(records[0]!), false);
  } finally {
    await endpoint.close();
  }
});

test('switch off: the router never uses cleanup and records it as off', async () => {
  const calls: string[] = [];
  const records: TranscriptionCleanupRecord[] = [];
  const delivered: string[] = [];

  const detector: Detector = {
    id: 'detector',
    label: 'Detector',
    dependencies: {},
    async detect() {
      calls.push('detect');
      return 'DICTATE';
    },
    async detectWithCleanup() {
      calls.push('detectWithCleanup');
      throw Error('Cleanup used while off');
    },
  };
  const cleaner = scriptedCleaner(async () => {
    calls.push('clean');
    throw Error('Cleaner used while off');
  });

  const setting = new TranscriptionCleanupSetting();
  const router = new UserSensorRouter(
    { detector, cleaner },
    () => {},
    { transcriptionCleanup: (_id, record) => records.push(record) },
    'router',
    setting,
  );
  processor('IGNORE').subscribe(router);
  textProcessor('SEND_TEXT_TO_APPLICATION', ['insert'], delivered).subscribe(router);
  textProcessor('DICTATE', [], delivered, 'Dictate').subscribe(router);

  await router.route({ ...baseFrame, utterance: 'insert um hello' }, signal());
  await router.route({ ...baseFrame, utterance: 'um hello there' }, signal());

  assert.deepEqual(calls, ['detect']);
  assert.deepEqual(delivered, ['um hello', 'um hello there']);
  assert.deepEqual(records, [{ enabled: false }, { enabled: false }]);
});

// ---------------------------------------------------------------------------
// Switch on: inferred routes
// ---------------------------------------------------------------------------

test('switch on: one request that is exactly the evaluated json-cleanup-v1 transformation', async () => {
  const endpoint = await modelServer((body) =>
    body.max_tokens === 32
      ? 'SEND_TEXT_TO_APPLICATION'
      : json({
          intent: 'SEND_TEXT_TO_APPLICATION',
          parameters: { text: 'Send the report tomorrow.' },
        }),
  );
  try {
    const records: string[] = [];
    const detector = new IntentDetector(endpoint.config, undefined, 'detector', {
      intentRequested: (_id, record) => records.push(record),
    });

    await detector.detect(baseFrame, offeredIntents, signal());
    const detection = await detector.detectWithCleanup(baseFrame, offeredIntents, signal());

    assert.deepEqual(detection, {
      intent: 'SEND_TEXT_TO_APPLICATION',
      text: 'Send the report tomorrow.',
      fallback: null,
    });
    assert.equal(endpoint.bodies.length, 2);

    // The cleanup request equals the offline experiment's transformation of
    // the bare-name recording: same messages, screenshot, flags; the prompt
    // sentences replaced and the section appended; max_tokens 512.
    const bare = restoreIntentRequest(records[0]!, frame.screenshot.png);
    const cleanup = restoreIntentRequest(records[1]!, frame.screenshot.png);
    assert.equal(cleanup.version, 2);
    assert.equal(cleanup.promptVariant, 'json-cleanup-v1');
    assert.deepEqual(cleanup.body, transformRecordedRequest(bare, 512).body);

    const wire = JSON.parse(endpoint.bodies[1]!);
    assert.equal(wire.max_tokens, 512);
    assert.match(wire.messages[0].content, /Response format \(json-cleanup-v1\):/);
    assert.ok(wire.messages[0].content.includes(CLEANUP_INSTRUCTION));
    assert.ok(wire.messages[0].content.includes(SEND_FORMATTING_INSTRUCTION));
  } finally {
    await endpoint.close();
  }
});

test('switch on: inferred responses are used strictly and never repaired', async () => {
  const cases: {
    reply: string;
    finish?: string;
    expected: CleanupDetection | RegExp;
  }[] = [
    {
      reply: json({ intent: 'START_CODING_AGENT_SESSION', parameters: { text: 'What is 2 + 2?' } }),
      expected: { intent: 'START_CODING_AGENT_SESSION', text: 'What is 2 + 2?', fallback: null },
    },
    {
      reply: ` \n${json({ intent: 'IGNORE', parameters: {} })}\n`,
      expected: { intent: 'IGNORE', text: null, fallback: null },
    },
    // A trailing line break could submit a chat message: use the raw text.
    {
      reply: json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: `${SECRET}\n` } }),
      expected: {
        intent: 'SEND_TEXT_TO_APPLICATION',
        text: null,
        fallback: 'text-surrounding-whitespace',
      },
    },
    {
      reply: json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: {} }),
      expected: { intent: 'SEND_TEXT_TO_APPLICATION', text: null, fallback: 'text-missing' },
    },
    {
      reply: json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: '   ' } }),
      expected: { intent: 'SEND_TEXT_TO_APPLICATION', text: null, fallback: 'text-empty' },
    },
    // No usable intent: behaves like today's detection failure.
    { reply: 'SEND_TEXT_TO_APPLICATION', expected: /\(invalid-json\)/ },
    {
      reply: '```json\n{"intent":"IGNORE","parameters":{}}\n```',
      expected: /\(invalid-json\)/,
    },
    { reply: '﻿{"intent":"IGNORE","parameters":{}}', expected: /\(invalid-json\)/ },
    {
      reply: json({ intent: 'ENTER_TEXT_TO_APPLICATION', parameters: { text: SECRET } }),
      expected: /\(unknown-intent\)/,
    },
    {
      reply: `{"intent":"IGNORE","intent":"SEND_TEXT_TO_APPLICATION","parameters":{"text":"${SECRET}"}}`,
      expected: /\(duplicate-key\)/,
    },
    {
      reply: json({ intent: 'IGNORE', parameters: { text: SECRET } }),
      expected: /\(text-on-no-text-intent\)/,
    },
    {
      reply: json({
        intent: 'SEND_TEXT_TO_APPLICATION',
        parameters: { text: SECRET },
        submit: true,
      }),
      expected: /\(unexpected-top-level-key\)/,
    },
    {
      reply: json({
        intent: 'SEND_TEXT_TO_APPLICATION',
        parameters: { text: SECRET, action: 'press-enter' },
      }),
      expected: /\(unexpected-parameter\)/,
    },
    // Truncated output is never used, even when it looks complete.
    {
      reply: json({ intent: 'IGNORE', parameters: {} }),
      finish: 'length',
      expected: /length/,
    },
  ];

  for (const example of cases) {
    const endpoint = await modelServer(() => example.reply, { finish: example.finish });
    try {
      const detector = new IntentDetector(endpoint.config);
      const detection = detector.detectWithCleanup(baseFrame, offeredIntents, signal());

      if (example.expected instanceof RegExp) {
        await assert.rejects(detection, (error: Error) => {
          assert.match(error.message, example.expected as RegExp);
          // Errors carry reason codes, never the (possibly private) response.
          assert.equal(error.message.includes(SECRET), false);
          return true;
        });
      } else {
        assert.deepEqual(await detection, example.expected, example.reply);
      }
    } finally {
      await endpoint.close();
    }
  }
});

test('switch on: intent instructions quoting the template sentences stay untouched and routable', async () => {
  // Review M1: agent-authored choice text can quote the bare-name sentences.
  // Only the fixed header is rewritten; the quote survives byte for byte.
  const quoted =
    'Option "You answer with ONLY the intent name." In that case, you return the intent name IGNORE.';
  const intents = [
    ...offeredIntents,
    { name: 'CHOOSE_AGENT_OPTION_1', instruction: `Choose this for the option. ${quoted}` },
  ];

  const endpoint = await modelServer(() =>
    json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: 'Send it.' } }),
  );
  try {
    const detector = new IntentDetector(endpoint.config);
    const detection = await detector.detectWithCleanup(baseFrame, intents, signal());
    assert.equal(detection.text, 'Send it.');

    const system = JSON.parse(endpoint.bodies[0]!).messages[0].content as string;
    const [header, list] = system.split('\nPossible intents:\n');
    assert.ok(header!.includes(VARIANT_ANSWER_SENTENCE));
    assert.ok(header!.includes(VARIANT_IGNORE_SENTENCE));
    assert.equal(header!.includes(RECORDED_ANSWER_SENTENCE), false);
    assert.ok(list!.includes(quoted));
  } finally {
    await endpoint.close();
  }

  // Without a quote the result equals the experiment's whole-prompt replacement.
  const bare = buildPrompt(offeredIntents);
  const experiment =
    bare
      .replace(RECORDED_ANSWER_SENTENCE, VARIANT_ANSWER_SENTENCE)
      .replace(RECORDED_IGNORE_SENTENCE, VARIANT_IGNORE_SENTENCE) +
    '\n' +
    cleanupResponseSection(['SEND_TEXT_TO_APPLICATION', 'START_CODING_AGENT_SESSION']);
  assert.equal(
    withCleanupResponseFormat(
      bare,
      offeredIntents.map((intent) => intent.name),
    ),
    experiment,
  );

  // A prompt that lost its template is refused rather than guessed.
  assert.throws(() => withCleanupResponseFormat('Classify this.', []), /template/);
});

test('switch on: a detector that returns a text route without text or reason is refused', async () => {
  const { router, delivered } = cleanupRouter(
    scriptedDetector(async () => ({
      intent: 'SEND_TEXT_TO_APPLICATION',
      text: null,
      fallback: null,
    })),
    scriptedCleaner(async () => assert.fail('No cleaner call')),
  );

  await assert.rejects(router.route(baseFrame, signal()), /without text or a reason/);
  assert.deepEqual(delivered, []);
});

/** A processor that records the text it received; null instruction = shortcut only. */
function textProcessor(
  name: string,
  prefixes: string[],
  delivered: string[],
  instruction: string | null = `Choose ${name}`,
): UserSensorProcessor {
  return {
    id: name.toLowerCase(),
    label: name,
    dependencies: {},
    name,
    instruction: instruction ?? undefined,
    prefixes,
    async process(received) {
      delivered.push(received.utterance);
    },
    subscribe(router) {
      router.register(this);
    },
  };
}

function scriptedCleaner(
  clean: (
    route: string,
    text: string,
    frame: UserSensorFrame,
    signal: AbortSignal,
  ) => Promise<FixedRouteCleanup>,
): TextCleaner {
  return { id: 'cleaner', label: 'Cleaner', dependencies: {}, clean };
}

function scriptedDetector(detection: () => Promise<CleanupDetection>): Detector {
  return {
    id: 'detector',
    label: 'Detector',
    dependencies: {},
    detect: async () => assert.fail('Bare-name detection used while cleanup is on'),
    detectWithCleanup: detection,
  };
}

function cleanupRouter(detector: Detector, cleaner: TextCleaner, enabled = true) {
  const records: TranscriptionCleanupRecord[] = [];
  const delivered: string[] = [];
  const setting = new TranscriptionCleanupSetting();
  setting.set(enabled);

  const router = new UserSensorRouter(
    { detector, cleaner },
    () => {},
    { transcriptionCleanup: (_id, record) => records.push(record) },
    'router',
    setting,
  );
  processor('IGNORE').subscribe(router);
  textProcessor('SEND_TEXT_TO_APPLICATION', ['insert'], delivered).subscribe(router);
  textProcessor('ENTER_TEXT_TO_APPLICATION', ['enter'], delivered, null).subscribe(router);
  textProcessor('QUICK_QUESTION', ['quick question'], delivered, null).subscribe(router);
  textProcessor('LABEL_PREVIOUS_CORRECT', ['correct'], delivered).subscribe(router);

  return { router, records, delivered, setting };
}

test('switch on: inferred text routes deliver cleaned text, or the raw text on fallback', async () => {
  const neverClean = scriptedCleaner(async () =>
    assert.fail('Inference must not call the cleaner'),
  );

  const cleaned = cleanupRouter(
    scriptedDetector(async () => ({
      intent: 'SEND_TEXT_TO_APPLICATION',
      text: 'Hello there.',
      fallback: null,
    })),
    neverClean,
  );
  await cleaned.router.route({ ...baseFrame, utterance: 'um hello there' }, signal());
  assert.deepEqual(cleaned.delivered, ['Hello there.']);
  assert.deepEqual(cleaned.records, [{ enabled: true, status: 'cleaned', text: 'Hello there.' }]);

  const fallback = cleanupRouter(
    scriptedDetector(async () => ({
      intent: 'SEND_TEXT_TO_APPLICATION',
      text: null,
      fallback: 'text-surrounding-whitespace',
    })),
    neverClean,
  );
  await fallback.router.route({ ...baseFrame, utterance: 'um hello there' }, signal());
  assert.deepEqual(fallback.delivered, ['um hello there']);
  assert.deepEqual(fallback.records, [
    { enabled: true, status: 'fallback', reason: 'text-surrounding-whitespace' },
  ]);

  const ignored = cleanupRouter(
    scriptedDetector(async () => ({ intent: 'IGNORE', text: null, fallback: null })),
    neverClean,
  );
  await ignored.router.route(baseFrame, signal());
  assert.deepEqual(ignored.delivered, []);
  assert.deepEqual(ignored.records, [{ enabled: true, status: 'no-text' }]);

  const failed = cleanupRouter(
    scriptedDetector(async () => {
      throw Error('Invalid cleanup intent response (invalid-json)');
    }),
    neverClean,
  );
  await assert.rejects(failed.router.route(baseFrame, signal()), /invalid-json/);
  assert.deepEqual(failed.delivered, []);
  assert.deepEqual(failed.records, [{ enabled: true, status: 'no-text' }]);
});

test('switch on: a detector cannot pick a shortcut-only route, even with valid cleaned text', async () => {
  const { router, delivered } = cleanupRouter(
    scriptedDetector(async () => ({
      intent: 'ENTER_TEXT_TO_APPLICATION',
      text: 'rm -rf ~',
      fallback: null,
    })),
    scriptedCleaner(async () => assert.fail('No cleaner call')),
  );

  await assert.rejects(router.route(baseFrame, signal()), /Unregistered intent/);
  assert.deepEqual(delivered, []);
});

test('switch on: a superseded provisional attempt gets no cleanup record and no delivery', async () => {
  // Speech timing: a commitment that rejects because resumed speech replaced
  // the attempt. The merged attempt is a new history row, so this one must
  // keep NULL cleanup columns instead of claiming "no-text".
  const supersededCommitment: DispatchCommitment = {
    async commit() {
      throw new UtteranceSupersededError();
    },
  };

  const inferred = cleanupRouter(
    scriptedDetector(async () => ({
      intent: 'SEND_TEXT_TO_APPLICATION',
      text: 'Hello there.',
      fallback: null,
    })),
    scriptedCleaner(async () => assert.fail('Inference must not call the cleaner')),
  );
  await assert.rejects(
    inferred.router.route(baseFrame, signal(), supersededCommitment),
    UtteranceSupersededError,
  );
  assert.deepEqual(inferred.delivered, []);
  assert.deepEqual(inferred.records, []);

  const shortcut = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async () => assert.fail('A superseded shortcut must not be cleaned')),
  );
  await assert.rejects(
    shortcut.router.route(
      { ...baseFrame, utterance: 'insert um hello' },
      signal(),
      supersededCommitment,
    ),
    UtteranceSupersededError,
  );
  assert.deepEqual(shortcut.delivered, []);
  assert.deepEqual(shortcut.records, []);

  // An ordinary failure while cleanup is on still records "no-text".
  const failed = cleanupRouter(
    scriptedDetector(async () => {
      throw Error('Invalid cleanup intent response (invalid-json)');
    }),
    scriptedCleaner(async () => assert.fail('No cleaner call')),
  );
  await assert.rejects(failed.router.route(baseFrame, signal()), /invalid-json/);
  assert.deepEqual(failed.records, [{ enabled: true, status: 'no-text' }]);
});

// ---------------------------------------------------------------------------
// Switch on: explicit shortcuts
// ---------------------------------------------------------------------------

test('switch on: shortcut text routes get a separate cleanup call; the route never changes', async () => {
  const calls: { route: string; text: string }[] = [];
  const { router, delivered, records } = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async (route, text) => {
      calls.push({ route, text });
      return { kind: 'cleaned', text: `Cleaned ${route}` };
    }),
  );

  await router.route({ ...baseFrame, utterance: 'insert um hello' }, signal());
  await router.route({ ...baseFrame, utterance: 'enter git status' }, signal());
  await router.route({ ...baseFrame, utterance: 'quick question what is uh DNS' }, signal());

  assert.deepEqual(calls, [
    { route: 'SEND_TEXT_TO_APPLICATION', text: 'um hello' },
    { route: 'ENTER_TEXT_TO_APPLICATION', text: 'git status' },
    { route: 'QUICK_QUESTION', text: 'what is uh DNS' },
  ]);
  assert.deepEqual(delivered, [
    'Cleaned SEND_TEXT_TO_APPLICATION',
    'Cleaned ENTER_TEXT_TO_APPLICATION',
    'Cleaned QUICK_QUESTION',
  ]);
  assert.equal(records.length, 3);
});

test('switch on: failed shortcut cleanup delivers the raw text after the prefix', async () => {
  const { router, delivered, records } = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async () => ({ kind: 'raw-text', reason: 'timeout' })),
  );

  await router.route({ ...baseFrame, utterance: 'insert um hello' }, signal());

  assert.deepEqual(delivered, ['um hello']);
  assert.deepEqual(records, [{ enabled: true, status: 'fallback', reason: 'timeout' }]);
});

test('switch on: non-text shortcuts and empty payloads make no cleanup call', async () => {
  const { router, delivered, records } = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async () => assert.fail('No cleanup for this shortcut')),
  );

  await router.route({ ...baseFrame, utterance: 'correct that one' }, signal());
  await router.route({ ...baseFrame, utterance: 'insert' }, signal());

  assert.deepEqual(delivered, ['that one']);
  assert.deepEqual(records, [
    { enabled: true, status: 'no-text' },
    { enabled: true, status: 'no-text' },
  ]);
});

test('switch on: disabling the route or stopping during cleanup delivers nothing', async () => {
  // Disabling the shortcut while its cleanup call runs.
  const disabled = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async (_route, _text, _frame, cleanupSignal) => {
      disabled.router.setEnabled('SEND_TEXT_TO_APPLICATION', false, 'shortcut');
      cleanupSignal.throwIfAborted();
      return { kind: 'cleaned', text: 'Too late' };
    }),
  );
  await assert.rejects(
    disabled.router.route({ ...baseFrame, utterance: 'insert hello' }, signal()),
    IntentDisabledError,
  );
  assert.deepEqual(disabled.delivered, []);

  // Shutdown or pause while the cleanup call runs.
  const controller = new AbortController();
  const stopped = cleanupRouter(
    scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
    scriptedCleaner(async (_route, _text, _frame, cleanupSignal) => {
      controller.abort(Error('Listener stopped'));
      cleanupSignal.throwIfAborted();
      return { kind: 'cleaned', text: 'Too late' };
    }),
  );
  await assert.rejects(
    stopped.router.route({ ...baseFrame, utterance: 'insert hello' }, controller.signal),
    /Listener stopped/,
  );
  assert.deepEqual(stopped.delivered, []);
});

test('the switch is read once per utterance; a click mid-utterance applies to the next one', async () => {
  let setting!: TranscriptionCleanupSetting;
  const {
    router,
    delivered,
    records,
    setting: live,
  } = cleanupRouter(
    scriptedDetector(async () => {
      setting.set(false);
      return { intent: 'SEND_TEXT_TO_APPLICATION', text: 'Cleaned.', fallback: null };
    }),
    scriptedCleaner(async () => assert.fail('No shortcut')),
  );
  setting = live;

  await router.route(baseFrame, signal());

  assert.deepEqual(delivered, ['Cleaned.']);
  assert.deepEqual(records, [{ enabled: true, status: 'cleaned', text: 'Cleaned.' }]);
  assert.equal(setting.enabled, false);
});

test('a router with a cleanup switch refuses to start without a cleaner', () => {
  assert.throws(
    () =>
      new UserSensorRouter(
        { detector: scriptedDetector(async () => assert.fail()) },
        () => {},
        {},
        'router',
        new TranscriptionCleanupSetting(),
      ),
    /requires a text cleaner/,
  );
});

// ---------------------------------------------------------------------------
// The cleanup-only call (real HTTP adapter)
// ---------------------------------------------------------------------------

test('SEND shortcut cleanup sends the screenshot and application; other routes send text only', async () => {
  const endpoint = await modelServer((body) => {
    const system = (body.messages as { content: string }[])[0]!.content;
    const route = system.includes('SEND_TEXT_TO_APPLICATION')
      ? 'SEND_TEXT_TO_APPLICATION'
      : 'QUICK_QUESTION';
    return json({ intent: route, parameters: { text: 'Clean text.' } });
  });
  try {
    const cleaner = new FixedRouteCleaner(endpoint.config);

    const send = await cleaner.clean(
      'SEND_TEXT_TO_APPLICATION',
      'um clean text',
      baseFrame,
      signal(),
    );
    const quick = await cleaner.clean('QUICK_QUESTION', 'um clean text', baseFrame, signal());

    assert.deepEqual(send, { kind: 'cleaned', text: 'Clean text.' });
    assert.deepEqual(quick, { kind: 'cleaned', text: 'Clean text.' });

    // The request has the experiment's fixed-route shape.
    const sendBody = JSON.parse(endpoint.bodies[0]!);
    const expected = buildFixedRouteRequest(
      {
        route: 'SEND_TEXT_TO_APPLICATION',
        text: 'um clean text',
        application: baseFrame.screenshot.window,
        screenshot: baseFrame.screenshot.png,
      },
      { stream: true, temperature: 0, disableThinking: true },
      512,
    );
    const expectedMessages = expected.messages as {
      content: string | { type: string; text?: string; image_url?: { url: string } }[];
    }[];
    assert.equal(sendBody.messages[0].content, fixedRouteSystemPrompt('SEND_TEXT_TO_APPLICATION'));
    assert.equal(sendBody.messages[0].content, expectedMessages[0]!.content);
    const expectedUser = expectedMessages[1]!.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    assert.equal(sendBody.messages[1].content[0].text, expectedUser[0]!.text);
    assert.equal(sendBody.messages[1].content[1].image_url.url, expectedUser[1]!.image_url!.url);
    assert.equal(sendBody.max_tokens, 512);
    assert.equal(sendBody.temperature, 0);
    // The same adapter flags as the live intent detector (thinking off).
    assert.equal(sendBody.chat_template_kwargs.enable_thinking, false);

    const quickBody = JSON.parse(endpoint.bodies[1]!);
    assert.equal(quickBody.messages[0].content, fixedRouteSystemPrompt('QUICK_QUESTION'));
    assert.equal(quickBody.messages[1].content.length, 1);
    assert.deepEqual(JSON.parse(quickBody.messages[1].content[0].text), {
      utterance: 'um clean text',
    });
    assert.equal(endpoint.bodies[1]!.includes('image_url'), false);
    assert.equal(endpoint.bodies[1]!.includes('editor'), false);
  } finally {
    await endpoint.close();
  }
});

test('shortcut cleanup keeps the raw text for route changes, invalid text and failures', async () => {
  const cases: {
    route: 'ENTER_TEXT_TO_APPLICATION' | 'SEND_TEXT_TO_APPLICATION';
    reply: string;
    finish?: string;
    status?: number;
    reason: string;
  }[] = [
    {
      route: 'ENTER_TEXT_TO_APPLICATION',
      reply: json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: 'git status' } }),
      reason: 'route-changed',
    },
    {
      route: 'ENTER_TEXT_TO_APPLICATION',
      reply: json({ intent: 'IGNORE', parameters: {} }),
      reason: 'route-changed',
    },
    {
      route: 'ENTER_TEXT_TO_APPLICATION',
      reply: json({ intent: 'ENTER_TEXT_TO_APPLICATION', parameters: { text: 'git status\n' } }),
      reason: 'text-surrounding-whitespace',
    },
    {
      route: 'SEND_TEXT_TO_APPLICATION',
      reply: 'Here is the cleaned text: hello',
      reason: 'invalid-json',
    },
    {
      route: 'SEND_TEXT_TO_APPLICATION',
      reply: json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: 'hel' } }),
      finish: 'length',
      reason: 'request-failed',
    },
    {
      route: 'SEND_TEXT_TO_APPLICATION',
      reply: '',
      status: 500,
      reason: 'request-failed',
    },
  ];

  for (const example of cases) {
    const endpoint = await modelServer(() => example.reply, {
      finish: example.finish,
      status: example.status,
    });
    try {
      const result = await new FixedRouteCleaner(endpoint.config).clean(
        example.route,
        'git status',
        baseFrame,
        signal(),
      );
      assert.deepEqual(result, { kind: 'raw-text', reason: example.reason }, example.reply);
    } finally {
      await endpoint.close();
    }
  }
});

test('shortcut cleanup is bounded by its own timeout, and the caller can still cancel it', async () => {
  assert.equal(SHORTCUT_CLEANUP_TIMEOUT_MS, 8000);

  const endpoint = await modelServer(() => null);
  try {
    const started = performance.now();
    const result = await new FixedRouteCleaner(endpoint.config, undefined, 'cleaner', 150).clean(
      'SEND_TEXT_TO_APPLICATION',
      'hello',
      baseFrame,
      signal(),
    );
    assert.deepEqual(result, { kind: 'raw-text', reason: 'timeout' });
    assert.ok(performance.now() - started < 2000);

    // The caller's cancellation is not a fallback: nothing may be delivered.
    const controller = new AbortController();
    const cancelled = new FixedRouteCleaner(endpoint.config, undefined, 'cleaner', 5000).clean(
      'SEND_TEXT_TO_APPLICATION',
      'hello',
      baseFrame,
      controller.signal,
    );
    setTimeout(() => controller.abort(Error('Stopped by user')), 50);
    await assert.rejects(cancelled, /Stopped by user/);
  } finally {
    await endpoint.close();
  }
});

// ---------------------------------------------------------------------------
// ENTER safety, end to end through the real processor and keyboard command
// ---------------------------------------------------------------------------

function keyboard() {
  const calls: { file: string; args: string[] }[] = [];
  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    if (file === 'hyprctl') {
      return Buffer.from(
        JSON.stringify({
          address: frame.screenshot.window.address,
          class: 'terminal',
          title: 'Shell',
          at: [0, 0],
          size: [900, 600],
          mapped: true,
          hidden: false,
        }),
      );
    }
    return Buffer.alloc(0);
  };
  return { calls, run };
}

test('ENTER never gains a trailing newline and presses Return exactly once', async () => {
  const replies = [
    // Valid cleaned text.
    json({ intent: 'ENTER_TEXT_TO_APPLICATION', parameters: { text: 'git status' } }),
    // A trailing newline is refused: the raw payload is typed instead.
    json({ intent: 'ENTER_TEXT_TO_APPLICATION', parameters: { text: 'git status\n' } }),
    // An internal line break is valid JSON text, but never typed as a key.
    json({ intent: 'ENTER_TEXT_TO_APPLICATION', parameters: { text: 'git status\necho done' } }),
  ];
  const typed = ['git status', 'um git status', 'git status echo done'];

  for (let index = 0; index < replies.length; index++) {
    const endpoint = await modelServer(() => replies[index]!);
    try {
      const screen = keyboard();
      const setting = new TranscriptionCleanupSetting();
      setting.set(true);
      const router = new UserSensorRouter(
        {
          detector: scriptedDetector(async () => assert.fail('Shortcuts bypass inference')),
          cleaner: new FixedRouteCleaner(endpoint.config),
        },
        () => {},
        {},
        'router',
        setting,
      );
      new EnterTextToApplication(() => {}, false, screen.run).subscribe(router);
      new SendTextToApplication(() => {}, false, screen.run).subscribe(router);

      await router.route({ ...baseFrame, utterance: 'enter um git status' }, signal());

      assert.deepEqual(screen.calls, [
        { file: 'hyprctl', args: ['-j', 'activewindow'] },
        { file: 'wtype', args: ['-d', '1', '--', typed[index]!] },
        { file: 'hyprctl', args: ['-j', 'activewindow'] },
        { file: 'wtype', args: ['-k', 'Return'] },
      ]);
    } finally {
      await endpoint.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Response interpretation (pure)
// ---------------------------------------------------------------------------

test('response interpretation maps each contract reason to a routing decision', () => {
  const offered = ['SEND_TEXT_TO_APPLICATION', 'IGNORE'];

  assert.deepEqual(
    interpretInferredResponse(
      json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: { text: 42 } }),
      offered,
    ),
    { kind: 'raw-text', intent: 'SEND_TEXT_TO_APPLICATION', reason: 'text-not-a-string' },
  );
  assert.deepEqual(
    interpretInferredResponse(json({ intent: 'SEND_TEXT_TO_APPLICATION' }), offered),
    { kind: 'no-intent', reason: 'parameters-missing' },
  );
  assert.deepEqual(
    interpretInferredResponse(
      json({ intent: 'SEND_TEXT_TO_APPLICATION', parameters: [] }),
      offered,
    ),
    { kind: 'no-intent', reason: 'parameters-not-an-object' },
  );
  assert.deepEqual(
    interpretInferredResponse(
      `{"intent":"SEND_TEXT_TO_APPLICATION","parameters":{"text":"a","text":"b"}}`,
      offered,
    ),
    { kind: 'no-intent', reason: 'duplicate-key' },
  );
  assert.deepEqual(interpretInferredResponse('[]', offered), {
    kind: 'no-intent',
    reason: 'not-an-object',
  });
  assert.deepEqual(interpretInferredResponse(json({ intent: 7, parameters: {} }), offered), {
    kind: 'no-intent',
    reason: 'intent-not-a-string',
  });

  assert.deepEqual(
    interpretFixedRouteResponse(
      json({ intent: 'QUICK_QUESTION', parameters: { text: 'Why?' } }),
      'QUICK_QUESTION',
    ),
    { kind: 'cleaned', text: 'Why?' },
  );
  assert.deepEqual(
    interpretFixedRouteResponse(
      json({ intent: 'START_CODING_AGENT_SESSION', parameters: { text: 'Why?' } }),
      'QUICK_QUESTION',
    ),
    { kind: 'raw-text', reason: 'route-changed' },
  );
});

// ---------------------------------------------------------------------------
// Recordings and exact-replay evals
// ---------------------------------------------------------------------------

test('cleanup recordings are version 2, never exported for exact replay, and refused by datasets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-cleanup-evals-'));
  try {
    const png = Buffer.from('synthetic image bytes');
    const payload = {
      model: 'original',
      messages: [
        { role: 'system', content: 'Classify.\nName: IGNORE\nInstruction: Nothing.\n' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '{"utterance":"synthetic"}' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
            },
          ],
        },
      ],
      max_tokens: 32,
    };
    const bare = snapshotIntentRequest(payload, png, 'http://recorded.invalid/v1');
    const cleanup = snapshotIntentRequest(
      payload,
      png,
      'http://recorded.invalid/v1',
      'json-cleanup-v1',
    );
    assert.equal(JSON.parse(bare).version, 1);
    assert.equal(JSON.parse(cleanup).version, 2);
    assert.equal(JSON.parse(cleanup).promptVariant, 'json-cleanup-v1');

    // Unknown variants and mismatched version markers are refused.
    const forged = JSON.parse(cleanup);
    forged.promptVariant = 'json-cleanup-v9';
    assert.throws(() => restoreIntentRequest(JSON.stringify(forged), png), /Unsupported/);
    const mislabeled = JSON.parse(bare);
    mislabeled.promptVariant = 'json-cleanup-v1';
    assert.throws(() => restoreIntentRequest(JSON.stringify(mislabeled), png), /Unsupported/);

    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const path = join(root, 'utterances.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA user_version = 5;
      CREATE TABLE utterances (id TEXT PRIMARY KEY, observed_at INTEGER, intent_request TEXT, recognized_intent TEXT);
      CREATE TABLE intent_feedback (id TEXT PRIMARY KEY, correct INTEGER, actual_intent TEXT, recognized_intent TEXT);
    `);
    database.prepare('INSERT INTO utterances VALUES (?, ?, ?, ?)').run(ids[0]!, 1, bare, 'IGNORE');
    database
      .prepare('INSERT INTO utterances VALUES (?, ?, ?, ?)')
      .run(ids[1]!, 2, cleanup, 'IGNORE');
    for (const id of ids) {
      database.prepare('INSERT INTO intent_feedback VALUES (?, 1, NULL, ?)').run(id, 'IGNORE');
      await saveArtifact(root, id, 1, 'screenshots', png);
    }
    database.close();

    assert.equal(inspectDatabase(path).recordedWithCleanupPrompt, 1);

    const exported = await exportDataset(path, join(root, 'dataset'));
    assert.equal(exported.exported, 1);
    assert.equal(exported.skipped.length, 1);
    assert.equal(exported.skipped[0]!.id, ids[1]);
    assert.match(exported.skipped[0]!.reason, /json-cleanup-v1 cleanup prompt/);

    // A hand-made dataset that includes one anyway fails before any call.
    await writeFile(join(root, 'dataset', `${ids[1]}.png`), png);
    await assert.rejects(
      restoreExample(join(root, 'dataset', 'dataset.json'), {
        id: ids[1]!,
        observedAt: 2,
        expected: 'IGNORE',
        originalPrediction: 'IGNORE',
        request: cleanup,
      }),
      /exact replay uses only bare-name recordings/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history keeps the raw transcript beside cleanup results without changing the schema version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-cleanup-history-'));
  try {
    const path = join(root, 'utterances.sqlite');
    const history = new UtteranceHistory(path);
    await history.open();

    const records: TranscriptionCleanupRecord[] = [
      { enabled: true, status: 'cleaned', text: 'Hello there.' },
      { enabled: true, status: 'fallback', reason: 'timeout' },
      { enabled: true, status: 'no-text' },
      { enabled: false },
    ];
    for (let index = 0; index < records.length; index++) {
      history.add({ id: index + 1, observedAt: 1000 + index, utterance: `um hello ${index}` });
      history.saveCleanup(index + 1, records[index]!);
      // The first record is kept.
      history.saveCleanup(index + 1, { enabled: false });
    }
    // An utterance that never reached routing (or an older checkout's row).
    history.add({ id: 9, observedAt: 2000, utterance: 'um unknown' });

    const entries = history.snapshot().reverse();
    assert.deepEqual(
      entries.map((entry) => [
        entry.utterance,
        entry.cleanupEnabled,
        entry.cleanupStatus,
        entry.cleanedText,
        entry.cleanupFallback,
      ]),
      [
        ['um hello 0', true, 'cleaned', 'Hello there.', null],
        ['um hello 1', true, 'fallback', null, 'timeout'],
        ['um hello 2', true, 'no-text', null, null],
        ['um hello 3', false, null, null, null],
        ['um unknown', null, null, null, null],
      ],
    );

    for (let frameId = 1; frameId <= 9; frameId++) {
      history.finish(frameId);
    }
    history.close();

    // Older checkouts must still open this database: the version is unchanged.
    const reader = new DatabaseSync(path, { readOnly: true });
    assert.equal(reader.prepare('PRAGMA user_version').get()!.user_version, 5);
    reader.close();

    // Reopening is idempotent, and deletion removes the cleaned text with the row.
    const reopened = new UtteranceHistory(path);
    await reopened.open();
    const cleanedId = reopened.snapshot().find((entry) => entry.cleanedText !== null)!.id;
    await reopened.delete(cleanedId);
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      check
        .prepare("SELECT COUNT(*) AS n FROM utterances WHERE cleaned_text = 'Hello there.'")
        .get()!.n,
      0,
    );
    check.close();
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Desktop switch
// ---------------------------------------------------------------------------

test('the cleanup preference file: missing is off, malformed is refused, writes are private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-cleanup-preference-'));
  try {
    const path = join(root, 'transcription-cleanup.json');
    const preference = new CleanupPreference(path);
    assert.equal(await preference.load(), false);

    for (const content of [
      '{"version":1,"enabled":"true"}',
      '{"version":2,"enabled":true}',
      '{"version":1,"enabled":true,"extra":1}',
      '[true]',
      'not json',
    ]) {
      await writeFile(path, content);
      await assert.rejects(preference.load());
    }

    let applied = 0;
    await preference.set(true, () => applied++);
    assert.equal(applied, 1);
    assert.equal(await preference.load(), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, enabled: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the desktop switch persists, applies and publishes; history entries carry cleanup fields', async () => {
  const cleanup = new TranscriptionCleanupSetting();
  const desktop = await desktopFixture(async () => assert.fail('No desktop command'), undefined, {
    cleanup,
  });
  try {
    await waitFor(() =>
      desktop.messages.some(
        (message) =>
          (message as { transcriptionCleanup?: unknown }).transcriptionCleanup !== undefined,
      ),
    );
    const latest = () =>
      [...desktop.messages].reverse().find((message) => message.type === 'state') as {
        transcriptionCleanup?: unknown;
      };
    assert.deepEqual(latest().transcriptionCleanup, { enabled: false });

    desktop.send({ action: 'set-transcription-cleanup', enabled: true });
    assert.equal((await desktop.reply('set-transcription-cleanup')).result, 'cleanup-enabled');
    assert.equal(cleanup.enabled, true);
    await waitFor(() => json(latest().transcriptionCleanup) === json({ enabled: true }));

    const path = join(dirname(desktop.socketPath), 'transcription-cleanup.json');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, enabled: true });

    for (const enabled of ['true', 1, null]) {
      desktop.send({ action: 'set-transcription-cleanup', enabled });
      assert.equal((await desktop.reply('set-transcription-cleanup')).type, 'error');
    }
    assert.equal(cleanup.enabled, true);

    desktop.send({ action: 'set-transcription-cleanup', enabled: false });
    assert.equal((await desktop.reply('set-transcription-cleanup')).result, 'cleanup-disabled');
    assert.equal(cleanup.enabled, false);

    // A routed utterance stores and publishes both texts.
    const activity = desktop.runtime.activity;
    activity.transcribed?.({ id: 5, observedAt: 1000, utterance: 'um hello there' });
    activity.intentRecognized?.(5, 'SEND_TEXT_TO_APPLICATION');
    activity.transcriptionCleanup?.(5, { enabled: true, status: 'cleaned', text: 'Hello there.' });
    activity.outcome?.(5, 'sent');
    activity.finished?.(5);
    await waitFor(() => desktop.messages.some((message) => message.type === 'activity-entry'));
    const entry = desktop.messages.find((message) => message.type === 'activity-entry')!.entry!;
    assert.equal(entry.utterance, 'um hello there');
    assert.equal(entry.cleanupEnabled, true);
    assert.equal(entry.cleanupStatus, 'cleaned');
    assert.equal(entry.cleanedText, 'Hello there.');
    assert.equal(entry.cleanupFallback, null);
  } finally {
    await desktop.close();
  }
});

test('a saved "on" choice is applied at startup; without the setting the switch is hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-cleanup-startup-'));
  const controller = new AbortController();
  const cleanup = new TranscriptionCleanupSetting();
  const runtime = new DesktopRuntime(
    new PauseControl(),
    () => {},
    controller.signal,
    {
      database: join(root, 'utterances.sqlite'),
      socket: join(root, 'control.sock'),
      preview: true,
      sounds: false,
      cleanup,
    },
    async () => assert.fail('No desktop command'),
  );
  try {
    await writeFile(join(root, 'transcription-cleanup.json'), '{"version":1,"enabled":true}\n');
    await runtime.start();
    assert.equal(cleanup.enabled, true);
  } finally {
    controller.abort();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }

  const hidden = await desktopFixture(async () => assert.fail('No desktop command'));
  try {
    await waitFor(() => hidden.messages.some((message) => message.type === 'state'));
    const state = hidden.messages.find((message) => message.type === 'state') as {
      transcriptionCleanup?: unknown;
    };
    assert.equal(state.transcriptionCleanup, null);
    hidden.send({ action: 'set-transcription-cleanup', enabled: true });
    assert.equal((await hidden.reply('set-transcription-cleanup')).type, 'error');
  } finally {
    await hidden.close();
  }
});
