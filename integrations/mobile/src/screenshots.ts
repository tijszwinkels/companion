/**
 * Fetching a conversation's screenshot from the gateway's authenticated
 * route (`api/screenshots/<conversation>`), shared by the phone panel and
 * the browser shell.
 *
 * Images cannot send headers by themselves, so the image is fetched with the
 * device token in the Authorization header and shown from a `blob:` URL made
 * from the answer. The token never appears in a URL: the request's address
 * is the bare route, and the `blob:` URL holds only the image and lives only
 * in this document until it is revoked. No cookies are sent
 * (`credentials: 'omit'`); the gateway answers `Cache-Control: private,
 * no-store` and `Referrer-Policy: no-referrer`, and the request asks for no
 * caching and sends no referrer as well.
 */

import { gatewayUrl, type Connection } from './connection.ts';

/** The gateway refused or did not have the screenshot (its HTTP status). */
export class ScreenshotRefused extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

/**
 * The screenshot at the gateway route `path`, as a Blob. Rejects with
 * ScreenshotRefused for an answer other than 200, or with the fetch's own
 * error when the gateway could not be reached or `signal` aborted it.
 */
export async function fetchScreenshot(
  path: string,
  connection: Pick<Connection, 'server' | 'token'>,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(gatewayUrl(path, connection.server), {
    headers: { Authorization: `Bearer ${connection.token}` },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: signal,
  });
  if (!response.ok) {
    throw new ScreenshotRefused(response.status);
  }
  return response.blob();
}
