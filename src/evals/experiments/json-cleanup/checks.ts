/**
 * Optional, fixture-specified literal checks on cleaned-up text.
 *
 * Cleanup has no ground truth, and this experiment has no LLM judge. For
 * adversarial and regression fixtures, the fixture author can still state
 * narrow, objective expectations per example: literals that must survive
 * cleanup (a negation, a number, a name, a code fragment) and literals that
 * must not appear (an injected word, Markdown in a plain-text field, a line
 * break in a single-line search box, an answer to a dictated question).
 *
 *   {
 *     "version": 1,
 *     "kind": "companion-cleanup-literal-checks",
 *     "checks": {
 *       "<example id>": {
 *         "mustContain": ["4.2", ["don't merge", "do not merge"]],
 *         "mustNotContain": ["**", "\n"]
 *       }
 *     }
 *   }
 *
 * A `mustContain` entry is a literal or a list of accepted alternatives. All
 * matching is exact, case-sensitive substring matching; list alternatives for
 * capitalization or wording variants that are equally acceptable.
 *
 * These checks are evidence about specific literals only. They are NOT a
 * cleanup quality score, and passing them does not mean the text is good.
 * Checks can contain private text, so reports receive only IDs and counts;
 * the literals themselves appear only in the private outputs.
 */
import { readFile } from 'node:fs/promises';

import { parseLocalJson, SafeEvalError } from '../../errors.ts';

export const LITERAL_CHECKS_KIND = 'companion-cleanup-literal-checks';

/** One required literal: any one of the alternatives must be present. */
export type RequiredLiteral = string | string[];

export interface LiteralCheck {
  mustContain: RequiredLiteral[];
  mustNotContain: string[];
}

export interface LiteralChecks {
  version: 1;
  kind: typeof LITERAL_CHECKS_KIND;
  checks: Record<string, LiteralCheck>;
}

/** Outcome of the literal checks for one response. */
export type LiteralCheckOutcome =
  | { status: 'no-checks' }
  /** The response had no valid cleaned text (invalid, error or no-text intent). */
  | { status: 'not-evaluated' }
  | { status: 'passed' }
  | {
      status: 'failed';
      /** Required literals (with their alternatives) that were missing. */
      missing: RequiredLiteral[];
      /** Forbidden literals that were present. */
      forbiddenPresent: string[];
    };

const MAX_LITERAL_CHARACTERS = 1_000;
const MAX_LITERALS_PER_EXAMPLE = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLiteral(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LITERAL_CHARACTERS;
}

function isRequiredLiteral(value: unknown): value is RequiredLiteral {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((alternative) => isLiteral(alternative));
  }
  return isLiteral(value);
}

/** Error messages name the example ID, never a literal (which may be private). */
function validateCheck(id: string, value: unknown): LiteralCheck {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== 'mustContain' && key !== 'mustNotContain')
  ) {
    throw new SafeEvalError(`Literal checks for ${id}: only mustContain/mustNotContain allowed`);
  }

  const mustContain = value.mustContain ?? [];
  const mustNotContain = value.mustNotContain ?? [];
  if (
    !Array.isArray(mustContain) ||
    !Array.isArray(mustNotContain) ||
    !mustContain.every((entry) => isRequiredLiteral(entry)) ||
    !mustNotContain.every((entry) => isLiteral(entry)) ||
    mustContain.length + mustNotContain.length === 0 ||
    mustContain.length + mustNotContain.length > MAX_LITERALS_PER_EXAMPLE
  ) {
    throw new SafeEvalError(
      `Literal checks for ${id}: need 1-${MAX_LITERALS_PER_EXAMPLE} nonempty literals of at most ${MAX_LITERAL_CHARACTERS} characters`,
    );
  }

  return { mustContain, mustNotContain };
}

export async function loadLiteralChecks(path: string): Promise<LiteralChecks> {
  const value = parseLocalJson(await readFile(path, 'utf8'), 'Literal checks file');

  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !['version', 'kind', 'checks'].includes(key)) ||
    value.version !== 1 ||
    value.kind !== LITERAL_CHECKS_KIND ||
    !isPlainObject(value.checks)
  ) {
    throw new SafeEvalError(`Expected a version 1 "${LITERAL_CHECKS_KIND}" file`);
  }

  // Null prototype: example IDs are data and must not collide with Object keys.
  const checks: Record<string, LiteralCheck> = Object.create(null);
  for (const [id, check] of Object.entries(value.checks)) {
    checks[id] = validateCheck(id, check);
  }
  return { version: 1, kind: LITERAL_CHECKS_KIND, checks };
}

/** Every checked ID must name an example that will actually be sent. */
export function assertChecksMatchExamples(
  checks: LiteralChecks,
  exampleIds: readonly string[],
): void {
  const known = new Set(exampleIds);
  for (const id of Object.keys(checks.checks)) {
    if (!known.has(id)) {
      throw new SafeEvalError(`Literal checks name ${id}, which is not a supported example`);
    }
  }
}

/** Apply one example's checks to its cleaned text (null when there is none). */
export function evaluateLiteralCheck(
  check: LiteralCheck | undefined,
  cleanedText: string | null,
): LiteralCheckOutcome {
  if (check === undefined) {
    return { status: 'no-checks' };
  }
  if (cleanedText === null) {
    return { status: 'not-evaluated' };
  }

  const missing: RequiredLiteral[] = [];
  for (const required of check.mustContain) {
    const alternatives = Array.isArray(required) ? required : [required];
    if (!alternatives.some((alternative) => cleanedText.includes(alternative))) {
      missing.push(required);
    }
  }

  const forbiddenPresent: string[] = [];
  for (const forbidden of check.mustNotContain) {
    if (cleanedText.includes(forbidden)) {
      forbiddenPresent.push(forbidden);
    }
  }

  if (missing.length === 0 && forbiddenPresent.length === 0) {
    return { status: 'passed' };
  }
  return { status: 'failed', missing, forbiddenPresent };
}
