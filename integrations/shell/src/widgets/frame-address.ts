/**
 * A widget page's address on the gateway's frame origin, as the gateway
 * sends it to a paired browser (`widget.frameUrl`, src/remote/README.md,
 * "Widget and application frames"): `<frame origin>/f/<handle>/`, where the
 * handle is 43 base64url characters.
 *
 * The shell embeds the address exactly as given and adds nothing to it (no
 * query, no fragment, no device token, no conversation ID). Anything that is
 * not exactly that shape is treated as absent, so the message shows the
 * "not set up" card instead of a frame.
 *
 * Input: the `frameUrl` field of a widget attachment (any JSON value).
 * Output: the same string when it is a valid address, otherwise ''.
 */

const handlePath = /^\/f\/[A-Za-z0-9_-]{43}\/$/;

export function frameAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) {
    return '';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return '';
  }
  if (url.username !== '' || url.password !== '') {
    return '';
  }
  if (url.search !== '' || url.hash !== '') {
    return '';
  }
  if (!handlePath.test(url.pathname)) {
    return '';
  }

  // Only the canonical spelling: the string the browser loads is exactly the
  // one checked here (no case or encoding the URL parser would change, and
  // no empty `?` or `#`, which the parser reports as no query or fragment).
  if (value !== url.origin + url.pathname) {
    return '';
  }
  return value;
}

/**
 * The origin of a valid frame address: the only origin whose messages this
 * frame's panel accepts, and the target origin of what it posts.
 */
export function frameOriginOf(address: string): string {
  return new URL(address).origin;
}
