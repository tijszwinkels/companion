/**
 * Public origins under which paired phones reach registered apps.
 *
 * Every phone-reachable app needs its own explicitly configured origin; nothing
 * is allocated automatically and no DNS name or TLS certificate is created.
 * Arbitrary app JavaScript therefore never runs on the Companion gateway's
 * origin, where the phone keeps its device token.
 *
 * Browsers scope cookies by host name, not by port: `https://desk:8444` and
 * `https://desk:8445` share cookies and `document.cookie`. Two apps on one host
 * name could read and overwrite each other's cookies and forward them to each
 * other's backends, so this configuration refuses it. The same applies to the
 * gateway: even though it authenticates with bearer tokens rather than cookies
 * today, arbitrary app cookies must not be coupled to the privileged origin's
 * host name, so an app may not use the gateway's host name on any port.
 */

import { checkAppId } from './registry.ts';

/** Host names that browsers resolve to this computer without DNS. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/** Validate one origin: exactly scheme://host[:port], HTTPS or loopback HTTP. */
export function checkPublicOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw Error(`Not a URL: ${origin}`);
  }

  if (parsed.origin !== origin) {
    throw Error(`App origin must be exactly scheme://host[:port]: ${origin}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw Error(`App origins must use https or loopback http: ${origin}`);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw Error(`Non-loopback app origins must use https: ${origin}`);
  }

  return parsed;
}

/**
 * Parse `--app-origin id=origin` values and check the whole set against itself
 * and the gateway's origins. Returns a map from app ID to origin.
 */
export function checkAppOrigins(
  entries: Iterable<[string, string]>,
  gatewayOrigins: string[] = [],
): Map<string, string> {
  const result = new Map<string, string>();
  const hostnameOwners = new Map<string, string>();
  const gatewayHostnames = new Set(gatewayOrigins.map((origin) => new URL(origin).hostname));

  for (const [id, origin] of entries) {
    checkAppId(id);
    const parsed = checkPublicOrigin(origin);

    if (result.has(id)) {
      throw Error(`App ${id} has more than one origin`);
    }
    if (gatewayHostnames.has(parsed.hostname)) {
      throw Error(
        `App ${id} cannot use the Companion gateway's host name ${parsed.hostname}, on any port. ` +
          'Give each phone app its own host name.',
      );
    }

    const owner = hostnameOwners.get(parsed.hostname);
    if (owner !== undefined) {
      throw Error(
        `Apps ${owner} and ${id} share the host name ${parsed.hostname}. Browsers share ` +
          'cookies across ports, so each phone app needs its own host name.',
      );
    }

    hostnameOwners.set(parsed.hostname, id);
    result.set(id, origin);
  }

  return result;
}

/** Parse one `id=origin` command-line value. */
export function parseAppOriginOption(value: string): [string, string] {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw Error(`Expected --app-origin ID=ORIGIN, got ${value}`);
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}
