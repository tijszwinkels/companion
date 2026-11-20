/**
 * What a remote client may know about a session application's chat
 * permissions.
 *
 * Input:  the listener's `application.chatAccess` (a session descriptor in a
 *         snapshot or event) or the result of `set-application-chat-read` /
 *         `set-application-chat-send`, as received: unknown data.
 * Output: a new object with only the fields below, each checked, or
 *         undefined when any of them is missing or malformed.
 *
 * The listener's state (`SessionApplicationChatAccess` in
 * src/session-apps/types.ts) holds:
 * - `requested`: the capability names the application's code asks for,
 *   `chat.read` and/or `chat.send`. Names, not capabilities: they grant
 *   nothing. Passed on.
 * - `read`, `send.allowed`, `send.remaining`, `send.busy`: whether reading and
 *   sending are allowed, how many sends remain and whether one is waiting.
 *   A client shows them. Passed on.
 * - `revision`: a random UUID that changes with every permission change. A
 *   client must name it to change a permission, so a decision made on stale
 *   controls is refused. It grants nothing by itself: the listener still
 *   checks that this connection shows the conversation. Passed on.
 * - `send.grantId`: the identity of the current send grant, which the
 *   application puts into each message it sends (with its view address). A
 *   client drawing the controls never needs it, so it is removed.
 *
 * Nothing in the result is a capability, a path or a view address. Anything
 * the listener adds later is dropped here until it is reviewed, like new
 * events (`remoteEvents` in protocol.ts). Rebuilding, not deleting, is what
 * makes that so.
 */

import type { RemoteApplicationChatAccess } from './protocol.ts';

/** `revision` is `crypto.randomUUID()` in the listener. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The capability names an application can request. */
const requestableCapabilities = new Set(['chat.read', 'chat.send']);

/**
 * Sends one grant allows (`applicationSendLimits.messagesPerGrant`, now 5).
 * A generous bound: the check only refuses nonsense, not a future raise.
 */
const maximumRemainingSends = 1000;

/** The permission state for a remote client, or undefined to send none. */
export function remoteChatAccess(value: unknown): RemoteApplicationChatAccess | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const requested = value.requested;
  if (!Array.isArray(requested) || requested.length > requestableCapabilities.size) {
    return undefined;
  }
  for (const name of requested) {
    if (typeof name !== 'string' || !requestableCapabilities.has(name)) {
      return undefined;
    }
  }
  if (new Set(requested).size !== requested.length) {
    return undefined;
  }

  if (typeof value.read !== 'boolean') {
    return undefined;
  }
  if (typeof value.revision !== 'string' || !uuidPattern.test(value.revision)) {
    return undefined;
  }

  const access: RemoteApplicationChatAccess = {
    requested: [...requested] as RemoteApplicationChatAccess['requested'],
    read: value.read,
    revision: value.revision,
  };

  // Older listeners have no `send`; its absence is passed on as absence.
  if (value.send !== undefined) {
    const send = remoteSendAccess(value.send);
    if (!send) {
      return undefined;
    }
    access.send = send;
  }

  return access;
}

/** `send` without its `grantId`, or undefined when malformed. */
function remoteSendAccess(value: unknown): RemoteApplicationChatAccess['send'] {
  if (!isPlainObject(value)) {
    return undefined;
  }
  if (typeof value.allowed !== 'boolean' || typeof value.busy !== 'boolean') {
    return undefined;
  }

  const remaining = value.remaining;
  if (
    typeof remaining !== 'number' ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    remaining > maximumRemainingSends
  ) {
    return undefined;
  }

  return { allowed: value.allowed, remaining, busy: value.busy };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
