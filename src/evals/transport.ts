import type { IntentRequestRecord } from '../core/intent-request.ts';

export interface EvalTarget {
  name: string;
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  /** Optional user-supplied pricing, per million tokens, not a provider quote. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}

export interface Completion {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
        (key) => !['name', 'model', 'baseUrl', 'apiKeyEnv', 'timeoutMs', 'pricing'].includes(key),
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
    const url = new URL(target.baseUrl);
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
    if (
      target.timeoutMs !== undefined &&
      (typeof target.timeoutMs !== 'number' ||
        !Number.isSafeInteger(target.timeoutMs) ||
        target.timeoutMs < 1 ||
        target.timeoutMs > 600_000)
    ) {
      throw Error('timeoutMs must be an integer from 1 to 600000');
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
    throw Error(`Missing API key environment variable: ${target.apiKeyEnv}`);
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
    throw Error(`HTTP ${response.status}; request rejected without retry or adaptation`);
  }
  if (!response.body) {
    throw Error('Empty response body');
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
        throw Error('Intent response exceeded 1 MiB');
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
        throw Error('Data after stream completion');
      }
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      packets.push(JSON.parse(data));
    }
    if (!done) {
      throw Error('Incomplete response stream');
    }
  } else {
    packets.push(JSON.parse(wire));
  }

  let text = '';
  let finish: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const packet of packets) {
    if (!object(packet) || packet.error || !Array.isArray(packet.choices)) {
      throw Error('Invalid completion response');
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
        throw Error('Expected one completion choice at index zero');
      }
      const message = streaming ? choice.delta : choice.message;
      if (
        !object(message) ||
        message.tool_calls ||
        message.function_call ||
        message.refusal ||
        message.reasoning_content ||
        message.reasoning ||
        message.reasoning_text
      ) {
        throw Error('Expected only an intent name, not tool calls, refusals or reasoning');
      }
      if (message.content !== null && message.content !== undefined) {
        if (typeof message.content !== 'string' || finish !== null) {
          throw Error('Invalid completion content');
        }
        text += message.content;
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (finish !== null || typeof choice.finish_reason !== 'string') {
          throw Error('Duplicate or invalid finish reason');
        }
        finish = choice.finish_reason;
      }
    }
  }
  if (finish !== 'stop') {
    throw Error(`Intent response did not finish normally (${finish ?? 'missing finish reason'})`);
  }
  return { text: text.trim(), inputTokens, outputTokens };
}
