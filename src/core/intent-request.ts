import { createHash } from 'node:crypto';

/**
 * Versioned evaluation evidence at the provider-payload boundary. The body is
 * the actual JSON request, with its one screenshot URL replaced by a structured
 * reference to the PNG belonging to the enclosing utterance row. No paths,
 * authentication headers or duplicated base64 recording are stored here.
 */
export interface IntentRequestRecord {
  version: 1;
  api: 'openai-completions';
  baseUrl: string;
  preparedAt: number;
  body: Record<string, unknown>;
}

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

/** Serialize immediately: later SDK or conversation changes cannot alter evidence. */
export function snapshotIntentRequest(payload: unknown, png: Buffer, baseUrl: string): string {
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
  const record: IntentRequestRecord = {
    version: 1,
    api: 'openai-completions',
    baseUrl,
    preparedAt: Date.now(),
    body,
  };
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
    record.version !== 1 ||
    record.api !== 'openai-completions' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.preparedAt !== 'number'
  ) {
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
  return {
    version: 1,
    api: 'openai-completions',
    baseUrl: record.baseUrl,
    preparedAt: record.preparedAt,
    body,
  };
}
