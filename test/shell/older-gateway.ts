import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { freePort } from '../remote-fixture.ts';

/**
 * A gateway without draft support, for the browser suites: a loopback proxy
 * in front of the real gateway that forwards every HTTP request and the
 * WebSocket unchanged, except that it removes `drafts` from the page's
 * `auth` message. That is exactly what a gateway from before remote drafts
 * did with the field (it read only `token` and `incrementalSessions`), so
 * the connection is not a draft host: no draft events reach it, and
 * `draft-set` and `pendingSend` would be refused. Everything else (pairing,
 * the page's files and their Content-Security-Policy, every request and
 * event) is the real gateway's.
 *
 * The page talks to the proxy's own origin; the proxy presents the
 * gateway's origin upstream, so the gateway's origin check is unchanged.
 */
export async function olderGateway(gatewayOrigin: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const upstream = new URL(gatewayOrigin);
  const sockets = new Set<WebSocket>();

  /** The request's headers as the gateway expects them from its own origin. */
  function upstreamHeaders(incoming: IncomingMessage): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    headers.host = upstream.host;
    if (headers.origin) {
      headers.origin = gatewayOrigin;
    }
    if (typeof headers.referer === 'string') {
      headers.referer = headers.referer.replace(origin, gatewayOrigin);
    }
    return headers;
  }

  const server = createServer((incoming, outgoing) => {
    const forwarded = httpRequest(
      {
        host: upstream.hostname,
        port: Number(upstream.port),
        method: incoming.method,
        path: incoming.url,
        headers: upstreamHeaders(incoming),
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on('error', () => {
      outgoing.destroy();
    });
    incoming.pipe(forwarded);
  });

  const pages = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = `ws://${upstream.host}${incoming.url ?? '/'}`;
    const gateway = new WebSocket(target, { headers: { Origin: gatewayOrigin } });
    sockets.add(gateway);
    gateway.once('error', () => socket.destroy());
    gateway.once('open', () => {
      pages.handleUpgrade(incoming, socket, head, (page) => {
        sockets.add(page);
        let first = true;
        page.on('message', (data, isBinary) => {
          let forwarded: WebSocket.RawData | string = data;
          if (first && !isBinary) {
            first = false;
            // The older gateway never saw `drafts`.
            try {
              const message = JSON.parse(String(data));
              if (message && message.type === 'auth') {
                delete message.drafts;
                forwarded = JSON.stringify(message);
              }
            } catch {
              // Forwarded as it is; the gateway refuses it.
            }
          }
          gateway.send(forwarded, { binary: isBinary });
        });
        gateway.on('message', (data, isBinary) => page.send(data, { binary: isBinary }));
        page.on('close', (code, reason) => gateway.close(validCode(code), reason));
        gateway.on('close', (code, reason) => page.close(validCode(code), reason));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    origin,
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}

/** Close codes a WebSocket may send on (1005 and 1006 are only reported). */
function validCode(code: number): number {
  if (code === 1005 || code === 1006) {
    return 1000;
  }
  return code;
}
