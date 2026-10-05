/**
 * One guarded HTTP(S) GET for `fetch_content`.
 *
 * Guards, in order:
 * - Only `http:` and `https:` URLs without embedded credentials.
 * - The host name is resolved once, and every resolved address must pass the
 *   address policy (public unicast only by default). The connection then goes
 *   to that vetted address: the host name is kept for the `Host` header and
 *   for TLS (SNI and certificate checks), but it is never resolved again, so
 *   a DNS answer cannot change between the check and the connection.
 * - Redirects are followed manually, at most `maximumRedirects`, and every
 *   hop repeats all of these checks.
 * - The (decompressed) body is limited to `maximumBodyBytes`; a larger body
 *   is an error, never silently cut. The whole fetch, including every DNS
 *   lookup, has a deadline and follows cancellation.
 * - Only textual responses are accepted (HTML, text, JSON, XML).
 *
 * No proxy is used, whatever the environment says, because a proxy would
 * resolve and connect on its own terms.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { publicAddressesOnly, type AddressPolicy } from './address-policy.ts';

export const maximumRedirects = 5;
export const maximumBodyBytes = 5 * 1024 * 1024;
export const fetchTimeoutMilliseconds = 30000;

/** Resolves a host name to its addresses. Tests replace DNS with a table. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export interface SafeFetchOptions {
  resolveHost?: ResolveHost;
  addressPolicy?: AddressPolicy;
  /** Deadline for the whole fetch; `fetchTimeoutMilliseconds` unless a test shortens it. */
  timeoutMilliseconds?: number;
}

/** A successfully fetched textual response. */
export interface FetchedText {
  /** The final URL after redirects. */
  url: string;
  status: number;
  /** The media type without parameters, e.g. `text/html`. */
  mediaType: string;
  /** The body decoded with the response's charset (UTF-8 by default). */
  body: string;
}

const defaultResolveHost: ResolveHost = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/** Textual media types `fetch_content` accepts. */
function isTextual(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/javascript' ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml')
  );
}

/**
 * Resolve `hostname`, but stop waiting as soon as `signal` aborts.
 *
 * `lookup` runs getaddrinfo on libuv's thread pool and cannot be cancelled,
 * so a resolver that never answers would otherwise hold the fetch past its
 * deadline and past cancellation. The abandoned lookup may still finish
 * later; its answer is then ignored and never connected to. `Promise.race`
 * keeps handling that late settlement, so it cannot become unhandled.
 */
async function resolveUntilAborted(
  hostname: string,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();

  let stopWaiting = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stopWaiting = () => reject(signal.reason);
    signal.addEventListener('abort', stopWaiting, { once: true });
  });

  try {
    return await Promise.race([resolveHost(hostname), aborted]);
  } finally {
    signal.removeEventListener('abort', stopWaiting);
  }
}

/**
 * Parse and check one URL, then resolve and vet its host.
 * Returns the address to connect to.
 */
async function vetTarget(
  url: URL,
  resolveHost: ResolveHost,
  addressPolicy: AddressPolicy,
  signal: AbortSignal,
): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw Error('URLs with embedded credentials are not fetched');
  }

  // URL keeps IPv6 literals in brackets.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveUntilAborted(hostname, resolveHost, signal);
  if (addresses.length === 0) {
    throw Error(`${hostname} did not resolve to an address`);
  }

  // Every address must pass, so that no answer points somewhere private.
  for (const address of addresses) {
    if (!addressPolicy(address)) {
      throw Error(`${hostname} resolves to a local or private address, which is not fetched`);
    }
  }

  return addresses[0];
}

/** Send the request to the vetted address and wait for the response head. */
function sendRequest(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = send({
      host: address,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Host: url.host,
        'User-Agent': 'Mozilla/5.0 (compatible; Companion fetch_content)',
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      // TLS verifies the certificate against the host name, not the address.
      servername: secure && !isIP(hostname) ? hostname : undefined,
      agent: false,
      signal,
    });
    request.once('response', resolve);
    request.once('error', reject);
    request.end();
  });
}

/** Read the body, decompressing if needed, up to `maximumBodyBytes`. */
async function readBody(response: IncomingMessage): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();

  // `pipeline` forwards a failure of the response (cancellation, deadline,
  // reset) to the decompressor, so reading below never waits forever.
  let stream: NodeJS.ReadableStream = response;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    stream = pipeline(response, createGunzip(), () => {});
  } else if (encoding === 'deflate') {
    stream = pipeline(response, createInflate(), () => {});
  } else if (encoding === 'br') {
    stream = pipeline(response, createBrotliDecompress(), () => {});
  } else if (encoding !== 'identity') {
    response.destroy();
    throw Error(`Unsupported content encoding ${encoding}`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      if (bytes > maximumBodyBytes) {
        throw Error(`Response exceeds the ${maximumBodyBytes / (1024 * 1024)} MiB limit`);
      }
      chunks.push(chunk as Buffer);
    }
  } finally {
    response.destroy();
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }

  return Buffer.concat(chunks);
}

/** Decode with the declared charset; unknown charsets fall back to UTF-8. */
function decode(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Fetch `address` with every guard above. Throws a readable error on refusal. */
export async function safeFetchText(
  address: string,
  signal: AbortSignal,
  options: SafeFetchOptions = {},
): Promise<FetchedText> {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const addressPolicy = options.addressPolicy ?? publicAddressesOnly;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? fetchTimeoutMilliseconds;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]);

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw Error(`Invalid URL: ${address}`);
  }

  for (let redirects = 0; ; redirects += 1) {
    const connectTo = await vetTarget(url, resolveHost, addressPolicy, deadline);
    deadline.throwIfAborted();
    const response = await sendRequest(url, connectTo, deadline);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      if (redirects >= maximumRedirects) {
        throw Error(`More than ${maximumRedirects} redirects`);
      }
      url = new URL(response.headers.location, url);
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw Error(`HTTP ${status} ${response.statusMessage ?? ''}`.trim());
    }

    const contentType = String(response.headers['content-type'] ?? '');
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    if (mediaType && !isTextual(mediaType)) {
      response.destroy();
      throw Error(
        `Unsupported content type ${mediaType}: this fetch_content retrieves text only (HTML, plain text, JSON, XML)`,
      );
    }

    const body = await readBody(response);

    // Without a declared type, accept only what does not look binary.
    if (!mediaType && body.subarray(0, 1024).includes(0)) {
      throw Error('Unsupported binary response: this fetch_content retrieves text only');
    }

    return {
      url: url.href,
      status,
      mediaType: mediaType || 'text/plain',
      body: decode(body, contentType),
    };
  }
}
