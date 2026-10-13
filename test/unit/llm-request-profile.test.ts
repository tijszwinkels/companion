/**
 * Classifier request profiles end to end: config validation, and the actual
 * serialized requests of all three classifier paths (bare intent, inferred
 * json-cleanup-v1 and explicit-shortcut cleanup) through Pi's real HTTP
 * adapter against a loopback SSE server. No hosted provider is contacted and
 * only a dummy credential is used.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config.ts';
import type { StreamFn } from '@earendil-works/pi-agent-core';

import { IntentDetector, localStream, type LlmConfig } from '../../src/core/intent-detector.ts';
import { restoreIntentRequest } from '../../src/core/intent-request.ts';
import {
  LLM_REQUEST_PROFILES,
  type LlmRequestProfile,
} from '../../src/core/llm-request-profile.ts';
import { FixedRouteCleaner } from '../../src/core/transcription-cleanup/fixed-route-cleaner.ts';
import { fixedRouteSystemPrompt } from '../../src/core/transcription-cleanup/prompt.ts';
import { frame, signal } from '../helpers.ts';

// Never let a real classifier credential reach even the loopback server.
const DUMMY_KEY = 'synthetic-test-key';
process.env.COMPANION_LLM_API_KEY = DUMMY_KEY;

/** The only reasoning-off field each profile may send, and its exact value. */
const EXPECTED_REASONING_OFF: Record<LlmRequestProfile, Record<string, unknown>> = {
  'local-qwen': { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
  groq: { reasoning_effort: 'none' },
  openrouter: { reasoning: { enabled: false } },
};

/** Every reasoning-related field any profile or adapter dialect could add. */
const REASONING_FIELDS = [
  'chat_template_kwargs',
  'chat_template_args',
  'reasoning_effort',
  'reasoning',
  'enable_thinking',
  'thinking',
  'thinking_token_budget',
];

const intents = [
  { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Dictation instruction from processor' },
  { name: 'IGNORE', instruction: 'Background speech' },
];

interface Captured {
  body: Record<string, any>;
  headers: IncomingHttpHeaders;
}

interface Endpoint {
  config: LlmConfig;
  requests: Captured[];
  close(): Promise<void>;
}

interface ServerReply {
  content: string;
  finish?: string;
  /** Reasoning text streamed before the answer, as a hosted model may do. */
  reasoning?: string;
}

/**
 * A loopback OpenAI-compatible SSE endpoint that records each request's body
 * and headers, and streams the reply in two content deltas and a finish chunk.
 */
async function endpoint(
  requestProfile: LlmRequestProfile | undefined,
  reply: (body: Record<string, any>) => ServerReply,
): Promise<Endpoint> {
  const requests: Captured[] = [];

  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
    }

    const body = JSON.parse(text) as Record<string, any>;
    requests.push({ body, headers: request.headers });

    const answer = reply(body);
    const chunks: unknown[] = [];

    if (answer.reasoning !== undefined) {
      chunks.push({
        choices: [{ index: 0, delta: { role: 'assistant', reasoning: answer.reasoning } }],
      });
    }

    // Split the answer to exercise streamed accumulation.
    const middle = Math.ceil(answer.content.length / 2);
    chunks.push({
      choices: [
        { index: 0, delta: { role: 'assistant', content: answer.content.slice(0, middle) } },
      ],
    });
    chunks.push({
      choices: [{ index: 0, delta: { content: answer.content.slice(middle) } }],
    });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: answer.finish ?? 'stop' }] });

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const config: LlmConfig = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: 'synthetic-vision-model',
    timeoutMs: 2000,
  };
  if (requestProfile !== undefined) {
    config.requestProfile = requestProfile;
  }

  return {
    config,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The reasoning-related fields actually present in one serialized request. */
function reasoningFields(body: Record<string, any>): Record<string, unknown> {
  const present: Record<string, unknown> = {};
  for (const field of REASONING_FIELDS) {
    if (field in body) {
      present[field] = body[field];
    }
  }
  return present;
}

/** Shared assertions for every classifier request, whatever the path. */
function assertCommonRequest(
  captured: Captured,
  profile: LlmRequestProfile,
  maxTokens: number,
  parts: string[],
) {
  const body = captured.body;

  assert.equal(body.model, 'synthetic-vision-model');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, maxTokens);
  assert.equal('max_completion_tokens' in body, false);
  assert.equal('tools' in body, false);
  assert.equal('store' in body, false);
  assert.equal('stream_options' in body, false);
  assert.deepEqual(
    body.messages.map((message: any) => message.role),
    ['system', 'user'],
  );
  assert.deepEqual(
    body.messages[1].content.map((part: any) => part.type),
    parts,
  );
  assert.deepEqual(reasoningFields(body), EXPECTED_REASONING_OFF[profile]);

  // Authentication uses the environment credential, here the dummy key.
  assert.equal(captured.headers.authorization, `Bearer ${DUMMY_KEY}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function withConfigFile<T>(content: unknown, body: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-request-profile-'));
  const path = join(directory, 'companion.config.json');

  try {
    await writeFile(path, JSON.stringify(content));
    return await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an absent requestProfile keeps the local Qwen default and the other llm defaults', async () => {
  await withConfigFile({ llm: { baseUrl: 'http://127.0.0.1:1/v1' } }, async (path) => {
    const config = await loadConfig(path);

    assert.deepEqual(config.llm, {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'qwen3.8-128k',
      timeoutMs: 15000,
      requestProfile: 'local-qwen',
    });
  });
});

test('every documented requestProfile is accepted with an https endpoint', async () => {
  assert.deepEqual([...LLM_REQUEST_PROFILES], ['local-qwen', 'groq', 'openrouter']);

  for (const requestProfile of LLM_REQUEST_PROFILES) {
    const llm = {
      baseUrl: 'https://provider.invalid/v1',
      model: 'provider/model',
      timeoutMs: 5000,
      requestProfile,
    };

    await withConfigFile({ llm }, async (path) => {
      assert.deepEqual((await loadConfig(path)).llm, llm);
    });
  }
});

test('invalid requestProfile values fail clearly instead of falling back', async () => {
  const invalid: unknown[] = [
    '',
    ' groq',
    'Groq',
    'OPENROUTER',
    'vllm',
    'openai',
    0,
    null,
    true,
    [],
    {},
  ];

  for (const requestProfile of invalid) {
    await withConfigFile(
      { llm: { baseUrl: 'http://127.0.0.1:1/v1', requestProfile } },
      async (path) => {
        await assert.rejects(loadConfig(path), {
          message: 'Invalid llm.requestProfile: expected one of local-qwen, groq, openrouter',
        });
      },
    );
  }
});

test('a request profile does not relax endpoint, timeout or unknown-key validation', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ baseUrl: 'https://user:secret@provider.invalid/v1' }, 'Invalid llm.baseUrl'],
    [{ baseUrl: 'https://provider.invalid/v1?key=secret' }, 'Invalid llm.baseUrl'],
    [{ baseUrl: 'ftp://provider.invalid/v1' }, 'Invalid llm.baseUrl'],
    [{ timeoutMs: 99 }, 'Invalid llm.timeoutMs'],
    [{ apiKey: 'secret' }, 'Unknown llm key: apiKey'],
    [{ extraBody: { reasoning: { enabled: false } } }, 'Unknown llm key: extraBody'],
  ];

  for (const [override, message] of cases) {
    for (const requestProfile of LLM_REQUEST_PROFILES) {
      await withConfigFile(
        { llm: { baseUrl: 'https://provider.invalid/v1', requestProfile, ...override } },
        async (path) => {
          await assert.rejects(loadConfig(path), { message });
        },
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Bare intent classification
// ---------------------------------------------------------------------------

test('no profile and an explicit local-qwen profile send byte-identical requests', async () => {
  const absent = await endpoint(undefined, () => ({ content: 'IGNORE' }));
  const explicit = await endpoint('local-qwen', () => ({ content: 'IGNORE' }));

  try {
    await new IntentDetector(absent.config).detect(frame, intents, signal());
    await new IntentDetector(explicit.config).detect(frame, intents, signal());

    assert.deepEqual(absent.requests[0]!.body, explicit.requests[0]!.body);
    assertCommonRequest(absent.requests[0]!, 'local-qwen', 32, ['text', 'image_url']);
  } finally {
    await absent.close();
    await explicit.close();
  }
});

for (const profile of LLM_REQUEST_PROFILES) {
  test(`${profile}: the bare intent request is multimodal, deterministic, 32 tokens, reasoning off, and recorded exactly`, async () => {
    const server = await endpoint(profile, () => ({ content: 'SEND_TEXT_TO_APPLICATION' }));
    const records: string[] = [];

    try {
      const detector = new IntentDetector(server.config, undefined, 'detector', {
        intentRequested: (_id, record) => records.push(record),
      });

      assert.equal(await detector.detect(frame, intents, signal()), 'SEND_TEXT_TO_APPLICATION');

      assert.equal(server.requests.length, 1);
      const captured = server.requests[0]!;
      assertCommonRequest(captured, profile, 32, ['text', 'image_url']);
      assert.match(captured.body.messages[0].content, /Dictation instruction from processor/);
      assert.equal(
        captured.body.messages[1].content[1].image_url.url,
        'data:image/png;base64,' + frame.screenshot.png.toString('base64'),
      );

      // The recording hook stores exactly the body that went over the wire.
      assert.equal(records.length, 1);
      const restored = restoreIntentRequest(records[0]!, frame.screenshot.png);
      assert.equal(restored.version, 1);
      assert.deepEqual(restored.body, captured.body);
    } finally {
      await server.close();
    }
  });
}

test('hosted profiles still reject truncated, reasoning-only and unknown replies', async () => {
  for (const profile of ['groq', 'openrouter'] as const) {
    // OpenRouter's observed failure: reasoning consumes the budget, no answer.
    const truncated = await endpoint(profile, () => ({
      content: '',
      reasoning: 'The user said hello, so',
      finish: 'length',
    }));
    const unknown = await endpoint(profile, () => ({ content: 'NOT_AN_INTENT' }));

    try {
      await assert.rejects(new IntentDetector(truncated.config).detect(frame, intents, signal()), {
        message: /length|Expected only an intent name/,
      });
      await assert.rejects(new IntentDetector(unknown.config).detect(frame, intents, signal()), {
        message: 'Invalid intent response: "NOT_AN_INTENT"',
      });
    } finally {
      await truncated.close();
      await unknown.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Inferred cleanup (json-cleanup-v1) and explicit-shortcut cleanup
// ---------------------------------------------------------------------------

for (const profile of LLM_REQUEST_PROFILES) {
  test(`${profile}: inferred json-cleanup-v1 keeps its response format, 512 tokens and exact recording`, async () => {
    const server = await endpoint(profile, () => ({
      content: JSON.stringify({
        intent: 'SEND_TEXT_TO_APPLICATION',
        parameters: { text: 'Send the report tomorrow.' },
      }),
    }));
    const records: string[] = [];

    try {
      const detector = new IntentDetector(server.config, undefined, 'detector', {
        intentRequested: (_id, record) => records.push(record),
      });

      const detection = await detector.detectWithCleanup(frame, intents, signal());

      assert.deepEqual(detection, {
        intent: 'SEND_TEXT_TO_APPLICATION',
        text: 'Send the report tomorrow.',
        fallback: null,
      });

      const captured = server.requests[0]!;
      assertCommonRequest(captured, profile, 512, ['text', 'image_url']);
      assert.match(captured.body.messages[0].content, /Response format \(json-cleanup-v1\):/);

      const restored = restoreIntentRequest(records[0]!, frame.screenshot.png);
      assert.equal(restored.version, 2);
      assert.equal(restored.promptVariant, 'json-cleanup-v1');
      assert.deepEqual(restored.body, captured.body);
    } finally {
      await server.close();
    }
  });

  test(`${profile}: explicit-shortcut cleanup sends the profile field with and without a screenshot`, async () => {
    const server = await endpoint(profile, (body) => {
      const system = body.messages[0].content as string;
      const route = system.includes('SEND_TEXT_TO_APPLICATION')
        ? 'SEND_TEXT_TO_APPLICATION'
        : 'QUICK_QUESTION';
      return { content: JSON.stringify({ intent: route, parameters: { text: 'Clean text.' } }) };
    });

    try {
      const cleaner = new FixedRouteCleaner(server.config);

      const send = await cleaner.clean(
        'SEND_TEXT_TO_APPLICATION',
        'um clean text',
        frame,
        signal(),
      );
      const quick = await cleaner.clean('QUICK_QUESTION', 'um clean text', frame, signal());

      assert.deepEqual(send, { kind: 'cleaned', text: 'Clean text.' });
      assert.deepEqual(quick, { kind: 'cleaned', text: 'Clean text.' });

      const [sendRequest, quickRequest] = server.requests;
      assertCommonRequest(sendRequest!, profile, 512, ['text', 'image_url']);
      assertCommonRequest(quickRequest!, profile, 512, ['text']);
      assert.equal(
        sendRequest!.body.messages[0].content,
        fixedRouteSystemPrompt('SEND_TEXT_TO_APPLICATION'),
      );
      assert.equal(
        quickRequest!.body.messages[0].content,
        fixedRouteSystemPrompt('QUICK_QUESTION'),
      );
    } finally {
      await server.close();
    }
  });
}

test('hosted shortcut cleanup falls back to the raw text when reasoning truncates the reply', async () => {
  for (const profile of ['groq', 'openrouter'] as const) {
    const server = await endpoint(profile, () => ({
      content: '',
      reasoning: 'Thinking about formatting',
      finish: 'length',
    }));

    try {
      const result = await new FixedRouteCleaner(server.config).clean(
        'QUICK_QUESTION',
        'um clean text',
        frame,
        signal(),
      );

      assert.deepEqual(result, { kind: 'raw-text', reason: 'request-failed' });
    } finally {
      await server.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Provider host names
// ---------------------------------------------------------------------------

test('provider-like host names do not change the profile request', async () => {
  // The adapter guesses some settings from the base URL ("openrouter.ai").
  // These hosts contain the provider names but use the reserved .invalid
  // domain, and the production transport gets an in-process fetch, so nothing
  // can reach a provider even if the injection stopped working.
  const hosts: [LlmRequestProfile, string][] = [
    ['groq', 'https://api.groq.com.invalid/openai/v1'],
    ['openrouter', 'https://openrouter.ai.invalid/api/v1'],
  ];

  for (const [profile, baseUrl] of hosts) {
    const loopback = await endpoint(profile, () => ({ content: 'IGNORE' }));
    const sent: { url: string; body: Record<string, any>; headers: Headers }[] = [];

    const offlineFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      sent.push({ url: request.url, body: await request.json(), headers: request.headers });

      const chunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'IGNORE' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      const sse =
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    };
    const offlineStream: StreamFn = (model, context, options) =>
      localStream(model, context, { ...options, fetch: offlineFetch });

    try {
      const hosted = new IntentDetector({ ...loopback.config, baseUrl }, offlineStream);
      const local = new IntentDetector(loopback.config);

      assert.equal(await hosted.detect(frame, intents, signal()), 'IGNORE');
      assert.equal(await local.detect(frame, intents, signal()), 'IGNORE');

      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.url, `${baseUrl}/chat/completions`);
      assert.equal(sent[0]!.headers.get('authorization'), `Bearer ${DUMMY_KEY}`);
      assert.deepEqual(sent[0]!.body, loopback.requests[0]!.body);
      assertCommonRequest(
        { body: sent[0]!.body, headers: { authorization: `Bearer ${DUMMY_KEY}` } },
        profile,
        32,
        ['text', 'image_url'],
      );
    } finally {
      await loopback.close();
    }
  }
});
