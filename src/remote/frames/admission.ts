/**
 * Request admission for the frame origin: which requests may become a
 * request to the widget service, decided from the request line and headers
 * alone, before any handle is looked up.
 *
 * Input:  method, raw request target and headers of one HTTP request that
 *         already passed the Tailscale and Host checks (./server.ts).
 * Output: the handle and operation to forward, with the body limit, or a
 *         refusal (status and fixed message).
 *
 * Rules (src/remote/README.md, "Widget and application frames"):
 * - The target must be exactly `/f/<43 base64url characters>/<operation>`
 *   with an operation from src/widgets/frame-operations.ts (empty for the
 *   document). No query string at all (a query could carry a token or a
 *   viewport the desktop-only operations read), no percent-encoding, no
 *   dot segments, no second slash, no absolute-form target. Anything else is
 *   the same 404 as an unknown handle.
 * - The method must be the operation's method; HEAD and OPTIONS are refused.
 * - `Authorization` is refused: no credential is ever accepted, or needed,
 *   on this origin. An `Upgrade` header is refused (no WebSockets).
 * - `Origin`, when sent, must be exactly the frame origin. A POST must send
 *   it: the frame page sends it with every fetch, and a page on any other
 *   origin cannot make the browser send ours.
 * - POST bodies: `Content-Type: application/json`, a `Content-Length` no
 *   larger than the widget service's own limit for that operation, and no
 *   `Transfer-Encoding`. GET requests carry no body.
 *
 * Because none of these steps looks at the handle, a refused request reveals
 * nothing about whether a handle exists.
 */

import type { IncomingHttpHeaders } from 'node:http';

import { frameOperation, type FrameOperation } from '../../widgets/frame-operations.ts';

export type Admission =
  | {
      ok: true;
      handle: string;
      /** Path segment after the handle; empty for the view document. */
      operation: string;
      definition: FrameOperation;
      /** Declared body length in bytes; 0 for GET. */
      bodyBytes: number;
    }
  | { ok: false; status: number; error: string };

/** `/f/<handle>/` or `/f/<handle>/<operation>`, with a 256-bit base64url handle. */
const frameTarget = /^\/f\/([A-Za-z0-9_-]{43})\/([a-z-]*)$/;

/** The answer for every path that is not a frame, and for unknown handles. */
export const notFound = { status: 404, error: 'Not found' } as const;

export function admitFrameRequest(
  method: string | undefined,
  target: string | undefined,
  headers: IncomingHttpHeaders,
  frameOrigin: string,
): Admission {
  if (headers.authorization !== undefined) {
    return refuse(400, 'Credentials are not accepted here');
  }
  if (headers.upgrade !== undefined) {
    return refuse(400, 'Upgrades are not accepted here');
  }
  if (typeof target !== 'string' || target.includes('?')) {
    return refuse(400, 'Query strings are not accepted here');
  }

  const match = frameTarget.exec(target);
  const definition = match ? frameOperation(match[2]) : undefined;
  if (!match || !definition) {
    return { ok: false, ...notFound };
  }

  if (method !== definition.method) {
    return refuse(405, 'Method not allowed');
  }

  const origin = headers.origin;
  if (origin !== undefined && origin !== frameOrigin) {
    return refuse(403, 'Origin not allowed');
  }

  if (definition.method === 'GET') {
    if (headers['transfer-encoding'] !== undefined || !emptyLength(headers['content-length'])) {
      return refuse(400, 'Unexpected request body');
    }
    return { ok: true, handle: match[1], operation: match[2], definition, bodyBytes: 0 };
  }

  if (origin === undefined) {
    return refuse(403, 'Origin required');
  }
  const contentType = headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return refuse(415, 'Expected JSON');
  }
  if (headers['transfer-encoding'] !== undefined) {
    return refuse(411, 'A Content-Length is required');
  }
  const length = declaredLength(headers['content-length']);
  if (length === undefined) {
    return refuse(411, 'A Content-Length is required');
  }
  if (length > definition.requestBytes) {
    return refuse(413, 'Request body too large');
  }
  return { ok: true, handle: match[1], operation: match[2], definition, bodyBytes: length };
}

function refuse(status: number, error: string): Admission {
  return { ok: false, status, error };
}

/** Absent or exactly zero. */
function emptyLength(value: string | undefined): boolean {
  return value === undefined || value === '0';
}

/** A plain decimal byte count, or undefined (absent, repeated or malformed). */
function declaredLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,9}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
