/**
 * Header and browser-request policy for the phone app proxy.
 *
 * Pure functions, so each rule can be tested on its own:
 *
 * - which cookies belong to Companion (the app-session cookie) and must never
 *   reach the app backend, and which `Set-Cookie` lines an app may not send;
 * - which request headers are forwarded upstream (hop-by-hop and forwarding
 *   headers are dropped; the app's own cookies and Authorization pass through);
 * - which browser requests may use an app session at all (Fetch Metadata and
 *   exact Origin checks against cross-site and sibling-app request forgery);
 * - how an upstream `Location` naming the loopback origin is shown to the phone.
 */

import type { IncomingHttpHeaders } from 'node:http';

/**
 * Companion's app-session cookie. The `__Host-` prefix makes browsers refuse
 * it unless it is Secure, host-only (no Domain) and Path=/, so a sibling host
 * cannot plant one for this app's host.
 */
export const sessionCookieName = '__Host-companion-app';

/** The one path on each app origin that Companion reserves: grant redemption. */
export const grantPath = '/__companion_app_grant';

/** Headers that describe one hop, never forwarded (RFC 9110 §7.6.1 plus legacy). */
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // The proxy already answered `100 Continue` itself.
  'expect',
]);

/**
 * Headers a client could use to claim a different address, scheme or host.
 * The backend must not mistake them for the proxy's own statement.
 */
function isForwardingHeader(name: string): boolean {
  return name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-');
}

/** True for Companion's cookie name, including look-alike suffixes. */
export function isCompanionCookie(name: string): boolean {
  return name.toLowerCase().startsWith(sessionCookieName.toLowerCase());
}

interface CookiePair {
  name: string;
  value: string;
  /** The piece exactly as sent, so forwarded cookies stay byte-for-byte intact. */
  raw: string;
}

/** Split a Cookie header into pairs; malformed pieces are kept verbatim as names. */
export function parseCookieHeader(header: string | undefined): CookiePair[] {
  if (!header) {
    return [];
  }

  const pairs: CookiePair[] = [];
  for (const piece of header.split(';')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator < 0) {
      pairs.push({ name: trimmed, value: '', raw: trimmed });
    } else {
      pairs.push({
        name: trimmed.slice(0, separator).trim(),
        value: trimmed.slice(separator + 1).trim(),
        raw: trimmed,
      });
    }
  }

  return pairs;
}

/**
 * Every value offered for Companion's session cookie. A browser can send more
 * than one (for example a shadowing cookie on a longer path); each is checked.
 */
export function sessionCookieValues(header: string | undefined): string[] {
  return parseCookieHeader(header)
    .filter((pair) => pair.name === sessionCookieName)
    .map((pair) => pair.value);
}

/** The Cookie header without Companion's cookies, or undefined if nothing remains. */
export function withoutCompanionCookies(header: string | undefined): string | undefined {
  const remaining = parseCookieHeader(header).filter((pair) => !isCompanionCookie(pair.name));
  if (remaining.length === 0) {
    return undefined;
  }

  return remaining.map((pair) => pair.raw).join('; ');
}

/**
 * Request headers for the upstream backend.
 *
 * Kept: everything the browser sent for the app, including Host and Origin as
 * the browser sent them (so the backend's own origin/CSRF checks see the real
 * public origin), the app's own cookies and Authorization.
 * Removed: hop-by-hop headers and any header named in `Connection`, forwarding
 * claims, and Companion's session cookie.
 *
 * `keepUpgrade` keeps `Connection: Upgrade` and `Upgrade` for a WebSocket
 * handshake, which is itself hop-by-hop but must reach the backend.
 */
export function upstreamRequestHeaders(
  headers: IncomingHttpHeaders,
  keepUpgrade = false,
): Record<string, string | string[]> {
  const namedInConnection = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );

  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (hopByHopHeaders.has(name) || isForwardingHeader(name)) {
      continue;
    }
    if (namedInConnection.has(name) && !(keepUpgrade && name === 'upgrade')) {
      continue;
    }
    if (name === 'cookie') {
      const cookies = withoutCompanionCookies(Array.isArray(value) ? value.join('; ') : value);
      if (cookies !== undefined) {
        result.cookie = cookies;
      }
      continue;
    }

    result[name] = value;
  }

  if (keepUpgrade) {
    result.connection = 'Upgrade';
    result.upgrade = String(headers.upgrade ?? '');
  }

  return result;
}

/** The name of the cookie a `Set-Cookie` line sets. */
function setCookieName(line: string): string {
  const pair = line.split(';', 1)[0];
  const separator = pair.indexOf('=');
  return (separator < 0 ? pair : pair.slice(0, separator)).trim();
}

/**
 * An app's `Set-Cookie` without any `Domain` attribute, which makes the
 * cookie host-only on the app's own host name. A backend therefore cannot
 * widen a cookie to a parent domain shared with sibling apps or the gateway.
 * (Page JavaScript can still set such cookies through `document.cookie`; see
 * docs/local-apps.md.) Other attributes are kept as sent.
 */
export function withoutDomainAttribute(line: string): string {
  const [pair, ...attributes] = line.split(';');
  const kept = attributes.filter((attribute) => {
    const name = attribute.split('=', 1)[0].trim().toLowerCase();
    return name !== 'domain';
  });

  return [pair, ...kept].join(';');
}

/**
 * One response header as the phone may see it, or undefined to drop it.
 * Shared by ordinary responses and WebSocket handshake responses:
 *
 * - an app can neither set nor clear Companion's session cookie;
 * - app cookies lose any `Domain` attribute (host-only);
 * - `Location` and `Refresh` URLs naming the loopback upstream are shown with
 *   the app's public origin. Redirects are never followed by the proxy.
 */
export function phoneResponseHeader(
  name: string,
  value: string,
  upstreamOrigin: string,
  publicOrigin: string,
): string | undefined {
  const lower = name.toLowerCase();

  if (lower === 'set-cookie') {
    if (isCompanionCookie(setCookieName(value))) {
      return undefined;
    }
    return withoutDomainAttribute(value);
  }
  if (lower === 'location') {
    return rewriteLocation(value, upstreamOrigin, publicOrigin);
  }
  if (lower === 'refresh') {
    return rewriteRefresh(value, upstreamOrigin, publicOrigin);
  }

  return value;
}

/**
 * Response headers for the phone, from Node's flat `rawHeaders` list:
 * hop-by-hop headers are dropped and every other header passes through
 * `phoneResponseHeader`.
 */
export function phoneResponseHeaders(
  rawHeaders: string[],
  upstreamOrigin: string,
  publicOrigin: string,
): string[] {
  const namedInConnection = new Set<string>();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === 'connection') {
      for (const token of rawHeaders[index + 1].split(',')) {
        namedInConnection.add(token.trim().toLowerCase());
      }
    }
  }

  const result: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();

    if (hopByHopHeaders.has(lower) || namedInConnection.has(lower)) {
      continue;
    }

    const value = phoneResponseHeader(name, rawHeaders[index + 1], upstreamOrigin, publicOrigin);
    if (value !== undefined) {
      result.push(name, value);
    }
  }

  return result;
}

/**
 * A backend's WebSocket handshake response head (status line and headers,
 * without the final blank line), rewritten with `phoneResponseHeader`. Upgrade
 * headers such as `Connection`, `Upgrade` and `Sec-WebSocket-Accept` are kept
 * because they belong to this handshake. Returns undefined for a malformed
 * head (including obsolete line folding), which closes the connection.
 */
export function filterHandshakeResponse(
  head: string,
  upstreamOrigin: string,
  publicOrigin: string,
): string | undefined {
  const [statusLine, ...lines] = head.split('\r\n');
  if (!/^HTTP\/1\.[01] \d{3}(?: [^\r\n]*)?$/.test(statusLine)) {
    return undefined;
  }

  const output = [statusLine];
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0 || /^[ \t]/.test(line) || line.includes('\n') || line.includes('\r')) {
      return undefined;
    }

    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      return undefined;
    }

    const filtered = phoneResponseHeader(name, value, upstreamOrigin, publicOrigin);
    if (filtered !== undefined) {
      output.push(`${name}: ${filtered}`);
    }
  }

  return output.join('\r\n') + '\r\n\r\n';
}

/** `Refresh: 5; url=http://127.0.0.1:8123/x` gets the same treatment as `Location`. */
export function rewriteRefresh(
  value: string,
  upstreamOrigin: string,
  publicOrigin: string,
): string {
  const match = /^(.*?url\s*=\s*)(['"]?)(.*?)\2\s*$/i.exec(value);
  if (!match) {
    return value;
  }

  const [, prefix, quote, target] = match;
  return prefix + quote + rewriteLocation(target, upstreamOrigin, publicOrigin) + quote;
}

/**
 * An absolute redirect to the backend's own loopback origin would send the
 * phone to its own loopback; show it the app's public origin instead. Relative
 * and other-origin locations are left for the browser to follow normally.
 */
export function rewriteLocation(
  location: string,
  upstreamOrigin: string,
  publicOrigin: string,
): string {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return location;
  }

  if (target.origin !== upstreamOrigin) {
    return location;
  }

  return publicOrigin + target.pathname + target.search + target.hash;
}

/** Methods that browsers may send cross-origin without CORS preflight side effects being blocked. */
export function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export type BrowserRequestVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this browser request act with the phone's app session?
 *
 * - `Sec-Fetch-Site`, when the browser sends it (current Safari and Chromium
 *   do), must be `same-origin` or `none` (typed/bookmarked/reloaded). This
 *   refuses cross-site and same-site requests, such as a sibling app on another
 *   subdomain of the same tailnet or `*.localhost`, even for GET.
 * - State-changing methods and WebSocket handshakes additionally need an exact
 *   `Origin` match, which older browsers without Fetch Metadata still send.
 *
 * The SameSite=Strict cookie is a further, independent layer.
 */
export function checkBrowserRequest(
  headers: IncomingHttpHeaders,
  method: string | undefined,
  publicOrigin: string,
  webSocket: boolean,
): BrowserRequestVerdict {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { allowed: false, reason: `cross-origin request (${String(site)})` };
  }

  if (webSocket || !isSafeMethod(method)) {
    if (headers.origin !== publicOrigin) {
      return { allowed: false, reason: 'missing or foreign Origin' };
    }
  }

  return { allowed: true };
}
