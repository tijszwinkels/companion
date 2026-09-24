/**
 * Explicit fixed-route fixtures for the JSON cleanup experiment.
 *
 * Explicit shortcuts ("insert", "enter", "quick question", "new session",
 * "continue session") bypass the classifier, so history holds no recorded LLM
 * request for them. This experiment never reconstructs such requests from
 * history. Fixed-route inputs are instead supplied by the user in this separate,
 * documented format (see docs/intent-json-cleanup-experiment.md):
 *
 *   {
 *     "version": 1,
 *     "kind": "companion-fixed-route-cleanup",
 *     "requestSettings": { "stream": false, "temperature": 0, "disableThinking": false },
 *     "examples": [
 *       { "id": "email-1", "route": "SEND_TEXT_TO_APPLICATION", "text": "…",
 *         "application": { … }, "screenshotSha256": "<sha256 of email-1.png>" },
 *       { "id": "enter-1", "route": "ENTER_TEXT_TO_APPLICATION", "text": "…" }
 *     ]
 *   }
 *
 * `text` is the spoken text after the shortcut prefix. SEND_TEXT_TO_APPLICATION
 * examples require a checksum-verified `<id>.png` next to the fixture file and
 * may carry application metadata; other routes must not carry either, because
 * the user approved application-aware formatting only for that route.
 *
 * Fixture files contain private text. Keep them outside Git, like exports.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseLocalJson, SafeEvalError } from '../../errors.ts';
import { isTextRoute, type TextRoute } from './contract.ts';
import type { FixedRouteInput, FixedRouteRequestSettings } from './prompt.ts';

export const FIXED_ROUTE_KIND = 'companion-fixed-route-cleanup';

export interface FixedRouteExample {
  id: string;
  route: TextRoute;
  text: string;
  application?: Record<string, unknown>;
  screenshotSha256?: string;
}

export interface FixedRouteDataset {
  version: 1;
  kind: typeof FIXED_ROUTE_KIND;
  requestSettings: FixedRouteRequestSettings;
  examples: FixedRouteExample[];
}

/** Safe as a file name and in reports; it is not derived from private text. */
const EXAMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Generous bounds that still keep a malformed fixture from bloating requests. */
const MAX_TEXT_CHARACTERS = 20_000;
const MAX_APPLICATION_JSON_CHARACTERS = 65_536;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateSettings(value: unknown): FixedRouteRequestSettings {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ['stream', 'temperature', 'disableThinking']) ||
    typeof value.stream !== 'boolean' ||
    typeof value.disableThinking !== 'boolean' ||
    typeof value.temperature !== 'number' ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2
  ) {
    throw new SafeEvalError(
      'requestSettings must be exactly {stream: boolean, temperature: 0-2, disableThinking: boolean}',
    );
  }
  return {
    stream: value.stream,
    temperature: value.temperature,
    disableThinking: value.disableThinking,
  };
}

/** Error messages name the example ID and the field, never its private value. */
function validateExample(value: unknown, seen: Set<string>): FixedRouteExample {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !EXAMPLE_ID.test(value.id)) {
    throw new SafeEvalError(
      'Every fixed-route example needs an id of 1-64 letters, digits, - or _',
    );
  }
  const id = value.id;
  if (seen.has(id)) {
    throw new SafeEvalError(`Duplicate fixed-route example id ${id}`);
  }

  if (!hasOnlyKeys(value, ['id', 'route', 'text', 'application', 'screenshotSha256'])) {
    throw new SafeEvalError(`Example ${id}: unknown field`);
  }
  if (typeof value.route !== 'string' || !isTextRoute(value.route)) {
    throw new SafeEvalError(`Example ${id}: route must be one of the five text routes`);
  }
  if (
    typeof value.text !== 'string' ||
    value.text.trim() === '' ||
    value.text.length > MAX_TEXT_CHARACTERS
  ) {
    throw new SafeEvalError(
      `Example ${id}: text must be nonempty and at most ${MAX_TEXT_CHARACTERS} characters`,
    );
  }

  const example: FixedRouteExample = { id, route: value.route, text: value.text };

  if (value.route === 'SEND_TEXT_TO_APPLICATION') {
    if (typeof value.screenshotSha256 !== 'string' || !SHA256.test(value.screenshotSha256)) {
      throw new SafeEvalError(`Example ${id}: SEND_TEXT_TO_APPLICATION requires screenshotSha256`);
    }
    example.screenshotSha256 = value.screenshotSha256;

    if (value.application !== undefined) {
      if (
        !isPlainObject(value.application) ||
        JSON.stringify(value.application).length > MAX_APPLICATION_JSON_CHARACTERS
      ) {
        throw new SafeEvalError(`Example ${id}: application must be a bounded JSON object`);
      }
      example.application = value.application;
    }
  } else if (value.application !== undefined || value.screenshotSha256 !== undefined) {
    throw new SafeEvalError(
      `Example ${id}: only SEND_TEXT_TO_APPLICATION examples use application context`,
    );
  }

  seen.add(id);
  return example;
}

export async function loadFixedRouteDataset(path: string): Promise<FixedRouteDataset> {
  const value = parseLocalJson(await readFile(path, 'utf8'), 'Fixed-route fixture file');

  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ['version', 'kind', 'requestSettings', 'examples']) ||
    value.version !== 1 ||
    value.kind !== FIXED_ROUTE_KIND ||
    !Array.isArray(value.examples) ||
    value.examples.length === 0
  ) {
    throw new SafeEvalError(
      `Expected a nonempty version 1 "${FIXED_ROUTE_KIND}" fixture with only known fields`,
    );
  }

  const requestSettings = validateSettings(value.requestSettings);
  const seen = new Set<string>();
  const examples: FixedRouteExample[] = [];
  for (const example of value.examples) {
    examples.push(validateExample(example, seen));
  }

  return { version: 1, kind: FIXED_ROUTE_KIND, requestSettings, examples };
}

/**
 * Load one example's inputs just before use, verifying its screenshot checksum
 * so an edited image cannot silently change a supposedly fixed input.
 */
export async function restoreFixedRouteExample(
  datasetPath: string,
  example: FixedRouteExample,
): Promise<FixedRouteInput> {
  let screenshot: Buffer | null = null;

  if (example.screenshotSha256 !== undefined) {
    screenshot = await readFile(join(dirname(datasetPath), `${example.id}.png`));
    const sha256 = createHash('sha256').update(screenshot).digest('hex');
    if (sha256 !== example.screenshotSha256) {
      throw new SafeEvalError(`Example ${example.id}: screenshot does not match its checksum`);
    }
  }

  return {
    route: example.route,
    text: example.text,
    application: example.application ?? null,
    screenshot,
  };
}
