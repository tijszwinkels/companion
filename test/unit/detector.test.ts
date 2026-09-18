import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { IntentDetector } from '../../src/core/intent-detector.ts';
import { frame, signal } from '../helpers.ts';

/** Exercise Pi's actual HTTP adapter against a small, deterministic SSE server. */
async function endpoint(
  body: (
    config: { baseUrl: string; model: string; timeoutMs: number },
    requests: any[],
  ) => Promise<void>,
  reply = 'SEND_TEXT_TO_APPLICATION',
  finish = 'stop',
  status = 200,
) {
  const requests: any[] = [];

  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
    }

    requests.push(JSON.parse(text));
    res.writeHead(status, {
      'content-type': status === 200 ? 'text/event-stream' : 'application/json',
    });

    if (status !== 200) {
      res.end(JSON.stringify({ error: { message: 'Test failure' } }));
      return;
    }

    // A completion arrives as a text delta, a finish reason, then the SSE sentinel.
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await body(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: 'test',
        timeoutMs: 2000,
      },
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const intents = [
  { name: 'SEND_TEXT_TO_APPLICATION', instruction: 'Dictation instruction from processor' },
  { name: 'IGNORE', instruction: 'Background speech' },
];

test('real Pi transport sends one multimodal user message, no history, thinking off, 32-token cap', async () => {
  await endpoint(async (config, requests) => {
    const detector = new IntentDetector(config);

    // A second call must not inherit the first frame's utterance or screenshot.
    assert.equal(await detector.detect(frame, intents, signal()), 'SEND_TEXT_TO_APPLICATION');
    assert.equal(
      await detector.detect({ ...frame, utterance: 'second utterance' }, intents, signal()),
      'SEND_TEXT_TO_APPLICATION',
    );

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.max_tokens, 32);
      assert.equal(request.temperature, 0);
      assert.equal(request.chat_template_kwargs.enable_thinking, false);
      assert.equal(request.tools, undefined);
      assert.deepEqual(
        request.messages.map((message: any) => message.role),
        ['system', 'user'],
      );
      assert.match(request.messages[0].content, /Dictation instruction from processor/);
      assert.deepEqual(
        request.messages[1].content.map((part: any) => part.type),
        ['text', 'image_url'],
      );
      assert.match(request.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    }

    assert.doesNotMatch(requests[1].messages[1].content[0].text, /Hello world/);
  });
});

test('the model sees captured sidebar state without the internal focus generation', async () => {
  await endpoint(async (config, requests) => {
    await new IntentDetector(config).detect(
      {
        ...frame,
        interaction: {
          agentSessionId: 'selected-session',
          agentComposerFocused: true,
          revision: 42,
        },
      },
      intents,
      signal(),
    );
    const input = JSON.parse(requests[0].messages[1].content[0].text);
    assert.deepEqual(input.interaction, {
      agentSessionId: 'selected-session',
      agentComposerFocused: true,
    });
    assert.equal(input.utterance, frame.utterance);
    assert.deepEqual(input.application, frame.screenshot.window);
  });
});

for (const reply of ['IGNORE because this is background speech', '"IGNORE"', 'UNKNOWN', '']) {
  test(`rejects malformed intent ${JSON.stringify(reply)}`, async () => {
    await endpoint(async (config) => {
      await assert.rejects(
        new IntentDetector(config).detect(frame, intents, signal()),
        /Invalid intent/,
      );
    }, reply);
  });
}

test('rejects truncated output even when the visible name is valid', async () => {
  await endpoint(
    async (config) => {
      await assert.rejects(new IntentDetector(config).detect(frame, intents, signal()), /length/);
    },
    'IGNORE',
    'length',
  );
});

test('provider failures are surfaced with no retry', async () => {
  await endpoint(
    async (config, requests) => {
      await assert.rejects(
        new IntentDetector(config).detect(frame, intents, signal()),
        /Test failure/,
      );
      assert.equal(requests.length, 1);
    },
    '',
    'stop',
    503,
  );
});

test('aborted frames do not make a provider request', async () => {
  await endpoint(async (config, requests) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new IntentDetector(config).detect(frame, intents, controller.signal),
      /abort/i,
    );
    assert.equal(requests.length, 0);
  });
});

test('a stalled provider request is cancelled at the detector deadline', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const detector = new IntentDetector({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: 'test',
      timeoutMs: 100,
    });
    await assert.rejects(detector.detect(frame, intents, signal()), /timeout/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
