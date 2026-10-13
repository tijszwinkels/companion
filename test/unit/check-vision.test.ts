/**
 * docs/examples/check-vision.py against loopback servers only: the request
 * profile's reasoning-off field, its explicit User-Agent, and the credential
 * protections (no redirects, no environment proxies, no secret in output).
 * The script runs as a subprocess with a minimal environment and a dummy key.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../docs/examples/check-vision.py', import.meta.url));
const DUMMY_KEY = 'synthetic-test-key';
const PYTHON = 'python3';

const pythonAvailable = spawnSync(PYTHON, ['--version']).status === 0;
const skip = pythonAvailable ? false : 'python3 is not available';

interface Captured {
  body: Record<string, any>;
  headers: IncomingHttpHeaders;
}

interface LoopbackServer {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

/** A loopback HTTP server that records requests and answers with `respond`. */
async function loopback(respond: (response: ServerResponse) => void): Promise<LoopbackServer> {
  const requests: Captured[] = [];

  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
    }

    requests.push({ body: text ? JSON.parse(text) : {}, headers: request.headers });
    respond(response);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A non-streaming chat completion, as the script requests. */
function completion(content: string, finishReason = 'stop') {
  return (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: finishReason },
        ],
      }),
    );
  };
}

interface RunResult {
  code: number | null;
  output: string;
}

/**
 * Run the script with a config file holding `llm`, a minimal environment
 * (PATH plus the dummy key) and any extra variables, and collect its output.
 */
async function runCheck(
  llm: Record<string, unknown>,
  extraEnvironment: Record<string, string> = {},
): Promise<RunResult> {
  const directory = await mkdtemp(join(tmpdir(), 'companion-check-vision-'));
  const configPath = join(directory, 'companion.config.json');

  try {
    await writeFile(configPath, JSON.stringify({ llm }));

    const child = spawn(PYTHON, [SCRIPT, '--config', configPath], {
      env: { PATH: process.env.PATH ?? '', COMPANION_LLM_API_KEY: DUMMY_KEY, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));

    const [code] = (await once(child, 'close')) as [number | null];
    return { code, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const EXPECTED_REASONING_OFF: Record<string, Record<string, unknown>> = {
  'local-qwen': { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
  groq: { reasoning_effort: 'none' },
  openrouter: { reasoning: { enabled: false } },
};

for (const profile of [undefined, 'local-qwen', 'groq', 'openrouter']) {
  test(
    `check-vision sends the ${profile ?? 'default'} profile request with an explicit User-Agent`,
    { skip },
    async () => {
      const server = await loopback(completion('Red.'));

      try {
        const llm: Record<string, unknown> = {
          baseUrl: server.url,
          model: 'synthetic-vision-model',
          timeoutMs: 2000,
        };
        if (profile !== undefined) {
          llm.requestProfile = profile;
        }

        const result = await runCheck(llm);

        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /PASS: endpoint accepted the inline image/);
        assert.equal(result.output.includes(DUMMY_KEY), false);

        assert.equal(server.requests.length, 1);
        const { body, headers } = server.requests[0]!;
        const { messages, ...fields } = body;

        assert.deepEqual(fields, {
          model: 'synthetic-vision-model',
          stream: false,
          temperature: 0,
          max_tokens: 32,
          ...EXPECTED_REASONING_OFF[profile ?? 'local-qwen'],
        });
        assert.equal(messages.length, 1);
        assert.deepEqual(
          messages[0].content.map((part: any) => part.type),
          ['text', 'image_url'],
        );

        // The generated image is a PNG, not a desktop capture.
        const url = messages[0].content[1].image_url.url as string;
        assert.match(url, /^data:image\/png;base64,/);
        const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
        assert.deepEqual(png.subarray(0, 8), Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));

        assert.equal(headers['user-agent'], 'companion-check-vision/1');
        assert.equal(headers.authorization, `Bearer ${DUMMY_KEY}`);
      } finally {
        await server.close();
      }
    },
  );
}

test('check-vision refuses an unknown profile before sending anything', { skip }, async () => {
  const server = await loopback(completion('Red'));

  try {
    for (const requestProfile of ['Groq', 'openai', '', 7, ['groq']]) {
      const result = await runCheck({ baseUrl: server.url, model: 'm', requestProfile });

      assert.equal(result.code, 2, result.output);
      assert.match(
        result.output,
        /llm\.requestProfile must be one of: local-qwen, groq, openrouter/,
      );
    }

    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test(
  'check-vision does not follow redirects, so the credential stays with the configured host',
  { skip },
  async () => {
    // Python follows 302 for a POST by default (as a GET that keeps the
    // Authorization header); 307 is refused by Python itself for a POST.
    for (const status of [302, 307]) {
      const target = await loopback(completion('Red'));
      const redirecting = await loopback((response) => {
        response.writeHead(status, { location: `${target.url}/chat/completions` });
        response.end();
      });

      try {
        const result = await runCheck({
          baseUrl: redirecting.url,
          model: 'm',
          timeoutMs: 2000,
          requestProfile: 'groq',
        });

        assert.notEqual(result.code, 0);
        assert.match(result.output, new RegExp(`Endpoint returned HTTP ${status}`));
        assert.equal(result.output.includes(DUMMY_KEY), false);
        assert.equal(redirecting.requests.length, 1);
        assert.equal(target.requests.length, 0);
      } finally {
        await redirecting.close();
        await target.close();
      }
    }
  },
);

test('check-vision ignores environment proxies', { skip }, async () => {
  const target = await loopback(completion('red'));
  const proxy = await loopback(completion('red'));
  const proxyUrl = proxy.url.replace(/\/v1$/, '');

  try {
    const result = await runCheck(
      { baseUrl: target.url, model: 'm', timeoutMs: 2000, requestProfile: 'openrouter' },
      { http_proxy: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl },
    );

    assert.equal(result.code, 0, result.output);
    assert.equal(target.requests.length, 1);
    assert.equal(proxy.requests.length, 0);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test(
  'check-vision reports HTTP errors and unfinished replies without printing the key',
  { skip },
  async () => {
    const forbidden = await loopback((response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `echo ${DUMMY_KEY}` } }));
    });
    const truncated = await loopback(completion('', 'length'));

    try {
      const refused = await runCheck({
        baseUrl: forbidden.url,
        model: 'm',
        requestProfile: 'groq',
      });
      assert.notEqual(refused.code, 0);
      assert.match(refused.output, /Endpoint returned HTTP 403/);
      assert.equal(refused.output.includes(DUMMY_KEY), false);

      const unfinished = await runCheck({
        baseUrl: truncated.url,
        model: 'm',
        requestProfile: 'openrouter',
      });
      assert.notEqual(unfinished.code, 0);
      assert.match(unfinished.output, /Reply did not finish normally/);
      assert.equal(unfinished.output.includes(DUMMY_KEY), false);
    } finally {
      await forbidden.close();
      await truncated.close();
    }
  },
);
