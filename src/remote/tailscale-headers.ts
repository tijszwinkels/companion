/**
 * Request checks for a gateway that sits behind Tailscale Serve (review M5).
 *
 * Tailscale Serve removes any client-supplied `Tailscale-*` identity headers
 * and then adds its own:
 *
 * - `Tailscale-Funnel-Request: ?1` when the request arrived through Funnel,
 *   i.e. from the public internet. Phone access is tailnet-only, so such a
 *   request is always refused, even if Funnel was turned on by mistake.
 * - `Tailscale-User-Login: <login>` for requests from a tailnet user's device.
 *   It is absent for tagged devices, Funnel and local connections.
 *
 * The login header is trustworthy only when nothing but tailscaled can reach
 * the gateway. With `--listen unix:` in a private directory that holds: other
 * users cannot connect. On a loopback TCP port any local user can connect and
 * send the header, so there it is a second layer only. Pairing tokens remain
 * the primary authorization in every mode.
 *
 * Input: the request headers and the configured required login (if any).
 * Output: undefined when the request may continue, or the refusal reason.
 * Reasons are fixed strings; header values are never echoed or logged.
 */

import type { IncomingHttpHeaders } from 'node:http';

export type TailscaleRefusal = 'funnel' | 'login';

export function tailscaleRefusal(
  headers: IncomingHttpHeaders,
  requiredLogin: string | undefined,
): TailscaleRefusal | undefined {
  // Any value counts: Tailscale sends "?1", and a proxy that sends something
  // else still marks the request as public.
  if (headers['tailscale-funnel-request'] !== undefined) {
    return 'funnel';
  }

  if (requiredLogin !== undefined) {
    // Node joins repeated unknown headers with ", ", so a duplicated header
    // can never equal a single login and is refused.
    const login = headers['tailscale-user-login'];
    if (typeof login !== 'string' || login !== requiredLogin) {
      return 'login';
    }
  }

  return undefined;
}
