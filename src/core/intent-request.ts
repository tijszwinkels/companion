import { createHash } from 'node:crypto';

import {
  CLEANUP_PROMPT_VARIANT,
  type CleanupPromptVariant,
} from './transcription-cleanup/prompt.ts';

/**
 * Versioned evaluation evidence at the provider-payload boundary. The body is
 * the actual JSON request, with its one screenshot URL replaced by a structured
 * reference to the PNG belonging to the enclosing utterance row. No paths,
 * authentication headers or duplicated base64 recording are stored here.
 *
 * Two record versions exist:
 *
 * - Version 1: today's bare-name intent prompt. Byte-for-byte the format
 *   recorded before transcription cleanup existed, and still what is recorded
 *   while cleanup is off. It has no `promptVariant`.
 * - Version 2: a request made with transcription cleanup on. `promptVariant`
 *   names the prompt wording (json-cleanup-v1). The version bump is deliberate:
 *   older checkouts refuse version 2 as unsupported instead of silently
 *   treating a cleanup prompt as a bare-name recording, and the exact-replay
 *   export here skips it too (src/evals/dataset.ts).
 */
export type IntentRequestRecord =
  | {
      version: 1;
      promptVariant?: never;
      api: 'openai-completions';
      baseUrl: string;
      preparedAt: number;
      body: Record<string, unknown>;
    }
  | {
      version: 2;
      promptVariant: CleanupPromptVariant;
      api: 'openai-completions';
      baseUrl: string;
      preparedAt: number;
      body: Record<string, unknown>;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Replace only actual image content parts, never matching words in prompt text. */
function mapScreenshot(body: unknown, replace: (url: unknown) => unknown): Record<string, unknown> {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    throw Error('Expected an intent request with messages');
  }
  let images = 0;
  const messages = body.messages.map((message) => {
    if (!isObject(message) || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.map((part: unknown) => {
      if (!isObject(part) || part.type !== 'image_url') {
        return part;
      }
      if (!isObject(part.image_url)) {
        throw Error('Expected an intent screenshot URL');
      }
      images++;
      return { ...part, image_url: { ...part.image_url, url: replace(part.image_url.url) } };
    });
    return { ...message, content };
  });
  if (images !== 1) {
    throw Error('Expected exactly one intent screenshot');
  }
  return { ...body, messages };
}

/**
 * Serialize immediately: later SDK or conversation changes cannot alter evidence.
 * `promptVariant` is null for the bare-name prompt (a version 1 record, exactly
 * as before) and names the cleanup prompt otherwise (a version 2 record).
 */
export function snapshotIntentRequest(
  payload: unknown,
  png: Buffer,
  baseUrl: string,
  promptVariant: CleanupPromptVariant | null = null,
): string {
  const endpoint = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw Error('Intent recording requires an endpoint without credentials or query parameters');
  }
  const imageUrl = 'data:image/png;base64,' + png.toString('base64');
  const sha256 = createHash('sha256').update(png).digest('hex');
  const body = mapScreenshot(payload, (url) => {
    // Do not claim a replayable request if a future adapter changes image bytes.
    if (url !== imageUrl) {
      throw Error('Intent request image differs from the recorded screenshot');
    }
    return { artifact: 'utterance-screenshot', mimeType: 'image/png', sha256 };
  });
  let record: IntentRequestRecord;
  if (promptVariant === null) {
    record = {
      version: 1,
      api: 'openai-completions',
      baseUrl,
      preparedAt: Date.now(),
      body,
    };
  } else {
    record = {
      version: 2,
      promptVariant,
      api: 'openai-completions',
      baseUrl,
      preparedAt: Date.now(),
      body,
    };
  }
  return JSON.stringify(record);
}

/**
 * Rebuild the original provider body from a row's JSON and its saved PNG.
 * This only assembles data; callers choose whether/where to run an evaluation.
 * A missing file is the caller's read error; altered bytes are rejected here.
 */
export function restoreIntentRequest(serialized: string, png: Buffer): IntentRequestRecord {
  const record: unknown = JSON.parse(serialized);
  if (
    !isObject(record) ||
    (record.version !== 1 && record.version !== 2) ||
    record.api !== 'openai-completions' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.preparedAt !== 'number'
  ) {
    throw Error('Unsupported intent request recording');
  }

  // Version 1 never names a variant; version 2 must name a known one.
  if (record.version === 1 && 'promptVariant' in record) {
    throw Error('Unsupported intent request recording');
  }
  if (record.version === 2 && record.promptVariant !== CLEANUP_PROMPT_VARIANT) {
    throw Error('Unsupported intent request recording');
  }

  const sha256 = createHash('sha256').update(png).digest('hex');
  const body = mapScreenshot(record.body, (reference) => {
    if (
      !isObject(reference) ||
      reference.artifact !== 'utterance-screenshot' ||
      reference.mimeType !== 'image/png' ||
      reference.sha256 !== sha256
    ) {
      throw Error('Intent screenshot is missing its reference or does not match its checksum');
    }
    return 'data:image/png;base64,' + png.toString('base64');
  });

  if (record.version === 2) {
    return {
      version: 2,
      promptVariant: CLEANUP_PROMPT_VARIANT,
      api: 'openai-completions',
      baseUrl: record.baseUrl,
      preparedAt: record.preparedAt,
      body,
    };
  }
  return {
    version: 1,
    api: 'openai-completions',
    baseUrl: record.baseUrl,
    preparedAt: record.preparedAt,
    body,
  };
}
