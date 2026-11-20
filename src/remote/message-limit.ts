/**
 * Raise the largest message one accepted WebSocket takes from its client.
 *
 * Inputs:  an open `ws` WebSocket and the new bound in bytes.
 * Outputs: true when the bound was raised; false when the installed `ws`
 *          does not expose it, and the socket keeps the server's bound.
 *
 * The gateway's WebSocketServer accepts at most 32 KiB per message, the bound
 * every socket had before drafts, so a socket that has not authenticated, or
 * that is still closing after a refusal, is held to exactly what it was held
 * to before: the parser refuses a larger message from its frame header,
 * before buffering its payload. Only once a connection is authenticated and
 * admitted does the gateway raise its own bound to 128 KiB, for drafts.
 *
 * `ws` (8.x) sets `maxPayload` per server only. Its receiver keeps the bound
 * in `_maxPayload` and reads it for every frame, so changing it affects the
 * following frames of that one connection. This touches a private field: if
 * a future `ws` drops it, nothing is raised (fail closed) and the gateway
 * logs it; the tests in remote-draft-limits.test.ts then fail on the 128 KiB
 * message.
 */

import type { WebSocket } from 'ws';

interface ReceiverWithLimit {
  _maxPayload?: unknown;
}

export function raiseMessageLimit(socket: WebSocket, bytes: number): boolean {
  const receiver = (socket as unknown as { _receiver?: ReceiverWithLimit })._receiver;
  if (!receiver || typeof receiver._maxPayload !== 'number') {
    return false;
  }

  receiver._maxPayload = bytes;
  return true;
}
