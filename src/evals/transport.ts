import type { IntentRequestRecord } from '../core/intent-request.ts';
import { parseLocalJson, SafeEvalError } from './errors.ts';

export interface EvalTarget {
  name: string;
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  /**
   * Maximum requests this target has in flight at once (default 1). Targets run
   * one at a time in isolated batches, so this never adds to another target's load.
   */
  concurrency?: number;
  /** Optional user-supplied pricing, per million tokens, not a provider quote. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}

export interface Completion {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Upper bound for per-target concurrency; a sanity limit, not a recommendation. */
export const MAX_CONCURRENCY = 16;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Loopback hosts where a plain-HTTP bearer key never leaves this machine. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Parse a targets file without echoing its contents on malformed JSON. */
export function parseTargets(text: string): EvalTarget[] {
  return validateTargets(parseLocalJson(text, 'Targets file'));
}

/** Explicit endpoints only; never dispatch to an endpoint found in a dataset. */
export function validateTargets(value: unknown): EvalTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw Error('Targets must be a nonempty JSON array');
  }
  const names = new Set<string>();
  for (const target of value) {
    if (
      !object(target) ||
      Object.keys(target).some(
        (key) =>
          ![
            'name',
            'model',
            'baseUrl',
            'apiKeyEnv',
            'timeoutMs',
            'concurrency',
            'pricing',
          ].includes(key),
      ) ||
      typeof target.name !== 'string' ||
      !target.name.trim() ||
      names.has(target.name) ||
      typeof target.model !== 'string' ||
      !target.model.trim() ||
      typeof target.baseUrl !== 'string'
    ) {
      throw Error(
        'Invalid target or duplicate name; only model/endpoint/transport/pricing settings are allowed',
      );
    }
    let url: URL;
    try {
      url = new URL(target.baseUrl);
    } catch {
      throw Error(`Target ${target.name}: baseUrl is not a valid URL`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw Error('Target endpoint must be HTTP(S), without credentials, query, or fragment');
    }
    if (
      target.apiKeyEnv !== undefined &&
      (typeof target.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.apiKeyEnv))
    ) {
      throw Error('apiKeyEnv must name an environment variable, not contain a key');
    }

    // A bearer key over plain HTTP is readable by anything on the network path.
    // Loopback stays on this machine, so unauthenticated or keyed local servers
    // keep working; remote keyed endpoints must use HTTPS.
    if (
      target.apiKeyEnv !== undefined &&
      url.protocol === 'http:' &&
      !isLoopbackHost(url.hostname)
    ) {
      throw Error(
        `Target ${target.name}: apiKeyEnv requires an https:// endpoint unless the host is loopback`,
      );
    }
    if (
      target.timeoutMs !== undefined &&
      (typeof target.timeoutMs !== 'number' ||
        !Number.isSafeInteger(target.timeoutMs) ||
        target.timeoutMs < 1 ||
        target.timeoutMs > 600_000)
    ) {
      throw Error('timeoutMs must be an integer from 1 to 600000');
    }

    // Concurrency bounds client-side in-flight work. A server may still queue
    // admitted requests internally; that shows up as higher per-request latency.
    if (
      target.concurrency !== undefined &&
      (typeof target.concurrency !== 'number' ||
        !Number.isSafeInteger(target.concurrency) ||
        target.concurrency < 1 ||
        target.concurrency > MAX_CONCURRENCY)
    ) {
      throw Error(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
    }

    if (target.pricing !== undefined) {
      const pricing = target.pricing;
      if (
        !object(pricing) ||
        Object.keys(pricing).some(
          (key) => !['inputPerMillion', 'outputPerMillion'].includes(key),
        ) ||
        !['inputPerMillion', 'outputPerMillion'].every(
          (key) =>
            typeof pricing[key] === 'number' && Number.isFinite(pricing[key]) && pricing[key] >= 0,
        )
      ) {
        throw Error('Pricing requires nonnegative inputPerMillion and outputPerMillion');
      }
    }
    names.add(target.name);
  }
  return value as EvalTarget[];
}

/** The model is the only changed field. No SDK prompt conversion or retries. */
export function requestBody(
  record: IntentRequestRecord,
  target: EvalTarget,
): Record<string, unknown> {
  return { ...record.body, model: target.model };
}

/** Preserve streaming and all other recorded flags, decoding either wire form. */
export async function complete(
  body: Record<string, unknown>,
  target: EvalTarget,
  signal: AbortSignal,
): Promise<Completion> {
  const key = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  if (target.apiKeyEnv && !key) {
    throw new SafeEvalError(`Missing API key environment variable: ${target.apiKeyEnv}`);
  }
  const response = await fetch(`${target.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Provider error bodies may echo private prompts or credentials. Do not log.
    throw new SafeEvalError(
      `HTTP ${response.status}; request rejected without retry or adaptation`,
    );
  }
  if (!response.body) {
    throw new SafeEvalError('Empty response body');
  }

  let wire = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        throw new SafeEvalError('Intent response exceeded 1 MiB');
      }
      wire += decoder.decode(chunk.value, { stream: true });
    }
    wire += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  return decodeCompletion(wire, body.stream === true);
}

/**
 * V8's SyntaxError message quotes part of the input. Response text can echo
 * private prompts, so reports receive only this fixed message.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeEvalError('Response contained invalid JSON');
  }
}

/**
 * Finish reasons reported by name. The value is server-controlled, so any
 * other string is reported as unrecognised instead of copied into the report.
 */
const KNOWN_FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'function_call',
  'content_filter',
  'end',
  'abort',
  'error',
  'repetition',
]);

/**
 * A field counts as present when it carries content. Some servers (for example
 * vLLM's non-streaming responses) always send `tool_calls: []`; pi-ai, used by
 * the live detector, treats an empty array as no tool calls, so the eval does too.
 */
function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

export function decodeCompletion(wire: string, streaming: boolean): Completion {
  const packets: unknown[] = [];
  if (streaming) {
    let done = false;
    for (const event of wire.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) {
        continue;
      }
      if (done) {
        throw new SafeEvalError('Data after stream completion');
      }
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      packets.push(parseJson(data));
    }
    if (!done) {
      throw new SafeEvalError('Incomplete response stream');
    }
  } else {
    packets.push(parseJson(wire));
  }

  let text = '';
  let finish: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const packet of packets) {
    if (!object(packet) || packet.error || !Array.isArray(packet.choices)) {
      throw new SafeEvalError('Invalid completion response');
    }
    if (object(packet.usage)) {
      const input = packet.usage.prompt_tokens;
      const output = packet.usage.completion_tokens;
      if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) {
        inputTokens = input;
      }
      if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
        outputTokens = output;
      }
    }
    for (const choice of packet.choices) {
      if (!object(choice) || choice.index !== 0) {
        throw new SafeEvalError('Expected one completion choice at index zero');
      }
      const message = streaming ? choice.delta : choice.message;
      if (
        !object(message) ||
        hasContent(message.tool_calls) ||
        hasContent(message.function_call) ||
        hasContent(message.refusal) ||
        hasContent(message.reasoning_content) ||
        hasContent(message.reasoning) ||
        hasContent(message.reasoning_text) ||
        hasContent(message.reasoning_details)
      ) {
        throw new SafeEvalError(
          'Expected only an intent name, not tool calls, refusals or reasoning',
        );
      }

      // Empty content carries no text; pi-ai ignores it, even after the finish
      // chunk. Nonempty content after the finish reason is still rejected.
      const content = message.content;
      if (content !== null && content !== undefined && content !== '') {
        if (typeof content !== 'string' || finish !== null) {
          throw new SafeEvalError('Invalid completion content');
        }
        text += content;
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (finish !== null || typeof choice.finish_reason !== 'string') {
          throw new SafeEvalError('Duplicate or invalid finish reason');
        }
        finish = choice.finish_reason;
      }
    }
  }
  if (finish !== 'stop') {
    let reason = 'missing finish reason';
    if (finish !== null) {
      reason = KNOWN_FINISH_REASONS.has(finish) ? finish : 'unrecognized finish reason';
    }
    throw new SafeEvalError(`Intent response did not finish normally (${reason})`);
  }
  return { text: text.trim(), inputTokens, outputTokens };
}
