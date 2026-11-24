/**
 * What the browser shell shows for a conversation's session application
 * (integrations/shell/README.md, "Session applications"), from the
 * conversation as the gateway relays it. Pure, without DOM access.
 *
 * Input: the conversation (`AgentSession`, as a remote client receives it:
 * `application` without the listener's `viewUrl`, with `frameUrl` when the
 * gateway has a frame origin and `chatAccess` without the send grant's ID;
 * src/remote/protocol.ts `RemoteSessionApplication`).
 *
 * Output, one of:
 * - `null`: the conversation has no application; the shell shows its chat;
 * - `frame`: the application can be shown, in a frame on the gateway's
 *   frame origin (`address`, exactly as the gateway sent it);
 * - `unavailable`: the listener could not restore the saved application
 *   (`error`); its description is shown with the error, and the chat;
 * - `not-set-up`: the gateway gives no frame address (an older gateway, or
 *   one without a frame origin): the application is named above the chat,
 *   which is shown alone.
 */

import type { AgentSession } from '../../../../src/agents/types.ts';
import { frameAddress } from '../widgets/frame-address.ts';

/** The application's chat permission state as the gateway relays it. */
export interface ApplicationChatAccess {
  /** What the application's code asks for: `chat.read`, `chat.send` or both. */
  requested: string[];
  read: boolean;
  /** Absent from older listeners; absence never means sending is allowed. */
  send: { allowed: boolean; remaining: number; busy: boolean } | null;
  /** Changes with every permission change, code replacement and reopen. */
  revision: string;
}

interface ApplicationBase {
  /** The application's ID (a UUID), stable across code replacement. */
  id: string;
  /** Its library bundle name. */
  name: string;
  /** Its code version: 1 at first, one more for each replacement. */
  version: number;
  /** The text description its code gives (shown when it cannot be). */
  text: string;
}

export type ShownApplication =
  | (ApplicationBase & {
      kind: 'frame';
      /** Its page on the frame origin, exactly as the gateway sent it. */
      address: string;
      /** Its chat permission state, or null when the gateway sent none. */
      chatAccess: ApplicationChatAccess | null;
    })
  | (ApplicationBase & { kind: 'unavailable'; error: string })
  | (ApplicationBase & { kind: 'not-set-up' });

/** The fields of the relayed descriptor read here (all checked again). */
interface RelayedApplication {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  text?: unknown;
  error?: unknown;
  frameUrl?: unknown;
  chatAccess?: unknown;
}

/** The conversation's application as the shell shows it, or null (see above). */
export function shownApplication(session: AgentSession | undefined): ShownApplication | null {
  if (!session) {
    return null;
  }
  // `frameUrl` and the relayed `chatAccess` are not part of the listener's
  // declared session type; the gateway adds and rebuilds them for remote
  // clients (src/remote/README.md, "What a client receives").
  const application = session.application as RelayedApplication | undefined;
  if (!application || typeof application !== 'object') {
    return null;
  }

  const base: ApplicationBase = {
    id: stringOf(application.id),
    name: stringOf(application.name),
    version: versionOf(application.version),
    text: stringOf(application.text),
  };

  if (typeof application.error === 'string' && application.error !== '') {
    return { ...base, kind: 'unavailable', error: application.error };
  }

  const address = frameAddress(application.frameUrl);
  if (!address) {
    return { ...base, kind: 'not-set-up' };
  }

  return {
    ...base,
    kind: 'frame',
    address,
    chatAccess: chatAccessOf(application.chatAccess),
  };
}

/**
 * The key the application-change rule compares (application-view.ts): the
 * application's ID and code version, as the desktop's `seen` map does
 * (`SessionSurface.qml`), or '' for none.
 */
export function applicationKey(application: ShownApplication | null): string {
  if (!application) {
    return '';
  }
  return application.id + ':' + application.version;
}

/** The name and version as the bar shows them: `notes · v2`. */
export function applicationLabel(application: ShownApplication): string {
  return `${application.name} · v${application.version}`;
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function versionOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return 0;
}

/**
 * The relayed permission state, or null when it is absent or malformed
 * (the gateway already rebuilt it field by field; this only guards the
 * types the rows rely on).
 */
function chatAccessOf(value: unknown): ApplicationChatAccess | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const access = value as Record<string, unknown>;
  if (!Array.isArray(access.requested) || typeof access.read !== 'boolean') {
    return null;
  }
  if (typeof access.revision !== 'string' || access.revision === '') {
    return null;
  }

  const requested: string[] = [];
  for (const name of access.requested) {
    if (typeof name === 'string') {
      requested.push(name);
    }
  }

  let send: ApplicationChatAccess['send'] = null;
  const relayedSend = access.send as Record<string, unknown> | undefined;
  if (
    relayedSend &&
    typeof relayedSend === 'object' &&
    typeof relayedSend.allowed === 'boolean' &&
    typeof relayedSend.remaining === 'number' &&
    typeof relayedSend.busy === 'boolean'
  ) {
    send = {
      allowed: relayedSend.allowed,
      remaining: relayedSend.remaining,
      busy: relayedSend.busy,
    };
  }

  return { requested, read: access.read, send, revision: access.revision };
}
