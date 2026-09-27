/**
 * Privacy-safe error reporting for intent evals.
 *
 * Eval errors end up in reports, stdout/stderr and agent transcripts. Error
 * messages from libraries can quote private inputs: V8's JSON SyntaxError
 * includes a snippet of the parsed text, and network errors can carry arbitrary
 * strings. This module therefore reports only:
 * - messages the eval code wrote itself (`SafeEvalError`), and
 * - fixed descriptions of recognised library failures, with a cause code only
 *   when it is on an explicit allowlist.
 * Anything else becomes a fixed "unclassified" message.
 */

/** An error whose message was written by eval code and contains no private input. */
export class SafeEvalError extends Error {
  override name = 'SafeEvalError';
}

/**
 * Parse local JSON (dataset, recorded request, targets) without leaking V8's
 * input snippet. `description` names the file or field, never its contents.
 */
export function parseLocalJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeEvalError(`${description} is not valid JSON`);
  }
}

/**
 * System and undici error codes that identify a transport failure without
 * containing request data. Unlisted codes are reported as unclassified.
 */
const SAFE_CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_CLOSED',
]);

/** Exact undici cause messages that are fixed library strings, not data. */
const SAFE_CAUSE_MESSAGES = new Map([
  ['unexpected redirect', 'redirect refused'],
  ['bad port', 'blocked port'],
]);

function causeDescription(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') {
    return null;
  }

  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string' && SAFE_CAUSE_CODES.has(code)) {
    return code;
  }

  const message = (cause as { message?: unknown }).message;
  if (typeof message === 'string') {
    const known = SAFE_CAUSE_MESSAGES.get(message);
    if (known !== undefined) {
      return known;
    }
  }
  return null;
}

/**
 * Describe a failed request for the report. Never returns an arbitrary library
 * message. Timeouts and cancellation are classified by the caller, which knows
 * which signal fired.
 */
export function describeRequestError(error: unknown): string {
  if (error instanceof SafeEvalError) {
    return error.message;
  }

  // undici wraps connection failures as TypeError('fetch failed') and failures
  // while reading the body as TypeError('terminated'), with details in `cause`.
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = causeDescription(error.cause);
    return cause ? `Request failed (${cause})` : 'Request failed (unclassified network error)';
  }
  if (error instanceof TypeError && error.message === 'terminated') {
    const cause = causeDescription(error.cause);
    return cause
      ? `Response stream terminated (${cause})`
      : 'Response stream terminated (unclassified)';
  }

  return 'Request failed (unclassified error)';
}
