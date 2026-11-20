/**
 * The widget service's private Unix socket.
 *
 * The phone gateway runs as a hardened user service that may only open Unix
 * sockets (src/remote/service/transient-unit.ts, `RestrictAddressFamilies=
 * AF_UNIX`), so it cannot reach the widget service's loopback port. The
 * listener therefore also serves views on `widgets.sock` next to its control
 * socket (`$XDG_RUNTIME_DIR/companion/widgets.sock`). The loopback port keeps
 * working unchanged for the desktop.
 *
 * What differs from the loopback route (enforced in WidgetService.receive):
 * - `Host` must be exactly `privateSocketHost`, and an `Origin` header is
 *   refused. Browsers cannot open Unix sockets; the gateway is the expected
 *   client and sends neither a browser host nor an origin.
 * - Only the operations in ./frame-operations.ts are served: no `/agent`, no
 *   `frame`, `layout`, `input` or `popout`.
 * - View documents name no address: `bootstrap.api` is a fixed marker, and
 *   the page derives its address from its own location (host.js), so the
 *   listener's capability never appears in a document served here.
 *
 * Every other check is the same code as on loopback: an unknown capability
 * is 404, a closed conversation is refused, methods, content type, body
 * limits, viewport bounds, application code versions and chat grants are
 * checked as before.
 *
 * Reach: the socket is 0600 in a directory only this user can enter
 * (claimUnixSocket checks it), so only this user's processes and root can
 * connect. Any local process can already connect to the loopback port, and
 * both routes need the same 256-bit view capability, so the socket gives no
 * process more reach than the loopback port does, and offers fewer operations.
 *
 * Lifetime: started by the listener after its control socket is bound (it
 * holds the control socket's lock, and claimUnixSocket takes
 * `widgets.sock.lock` as well). Closing the server unlinks the socket; the
 * lock is released afterwards.
 */

import { chmod } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { claimUnixSocket, type UnixSocketClaim } from '../remote/unix-socket-claim.ts';

/** The fixed Host the socket route accepts; `.invalid` can never resolve. */
export const privateSocketHost = 'companion-widgets.invalid';

/**
 * Stand-in for the view address in documents served on the socket route.
 * host.js only checks that `bootstrap.api` is present and then uses its own
 * `location`, which is the frame address the browser loaded.
 */
export const privateSocketDocumentApi = 'location';

/** The gateway keeps few connections; refuse a flood instead of queueing it. */
const maximumConnections = 64;
const headersTimeoutMilliseconds = 10_000;
const requestTimeoutMilliseconds = 30_000;

export interface PrivateSocket {
  readonly path: string;
  close(): Promise<void>;
}

/**
 * Bind `socketPath` (0600, private directory) and answer every request with
 * `handle`. Rejects when the directory is not private or a live process
 * already serves the path; nothing is left bound or locked then.
 */
export async function listenOnPrivateSocket(
  socketPath: string,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<PrivateSocket> {
  const claim: UnixSocketClaim = await claimUnixSocket(socketPath);
  const server: Server = createServer(handle);
  server.maxConnections = maximumConnections;
  server.headersTimeout = headersTimeoutMilliseconds;
  server.requestTimeout = requestTimeoutMilliseconds;
  // The listener's lifetime is decided by its own sockets, not this one.
  server.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // process.umask() is process-wide; the bind happens synchronously in
      // listen(), so the restrictive mask applies only to this socket.
      const previousUmask = process.umask(0o177);
      try {
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      } finally {
        process.umask(previousUmask);
      }
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await claim.release();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    path: socketPath,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        // Closing a Unix socket server also unlinks the socket file.
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await claim.release();
      })();
      return closing;
    },
  };
}
