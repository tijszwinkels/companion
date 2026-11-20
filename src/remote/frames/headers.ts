/**
 * Response headers of the frame origin, and the frame-src addition to the
 * gateway's own Content-Security-Policy.
 *
 * Every frame-origin response, proxied or refused, carries the same fixed set
 * below. From a proxied widget service response only `Content-Type` (checked
 * by the caller) and `Content-Security-Policy` (each value unchanged) are
 * kept; everything else upstream sends is dropped, including
 * `X-Frame-Options: DENY` (replaced by `frame-ancestors`), `Set-Cookie`,
 * `Location`, `Cache-Control` and `Referrer-Policy` (replaced by ours).
 * No cookie is ever set, and none is forwarded upstream (./server.ts).
 */

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

/** Browser features a widget page never needs. */
const deniedFeatures = [
  'camera',
  'microphone',
  'geolocation',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
];

/**
 * Fixed headers for a frame-origin response. `gatewayOrigins` are the only
 * pages allowed to embed a frame; `upstreamPolicies` are the widget service's
 * own Content-Security-Policy values, kept as separate headers so the browser
 * enforces each of them as well.
 */
export function frameResponseHeaders(
  gatewayOrigins: readonly string[],
  upstreamPolicies: readonly string[] = [],
): OutgoingHttpHeaders {
  return {
    // `webrtc 'block'` stops WebRTC where browsers implement it. Chromium
    // (tested) does not yet, so it is a hardening, not a guarantee; see
    // README "What a widget page can and cannot reach".
    'Content-Security-Policy': [
      `frame-ancestors ${gatewayOrigins.join(' ')}; webrtc 'block'`,
      ...upstreamPolicies,
    ],
    'Origin-Agent-Cluster': '?1',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': deniedFeatures.map((feature) => `${feature}=()`).join(', '),
  };
}

/** The upstream Content-Security-Policy values, unchanged, in order. */
export function upstreamPolicies(headers: IncomingHttpHeaders): string[] {
  const value = headers['content-security-policy'];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  // Node joins repeated Content-Security-Policy headers with ", ", which is
  // also how a browser combines them: each comma-separated policy applies.
  return [value];
}

/**
 * The directive the gateway's page policy gains when a frame origin is
 * configured. Without one the policy stays byte-identical to before.
 */
export function frameSourceDirective(frameOrigin: string): string {
  return `frame-src ${frameOrigin}`;
}
