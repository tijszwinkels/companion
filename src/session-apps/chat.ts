/**
 * A deliberately lossy, bounded projection of canonical conversation text.
 *
 * This module does not grant access. Its caller must check the application
 * version and the user's read grant before obtaining the source conversation.
 * Never pass this projection through application state or persist it implicitly.
 * Once code can read it, however, that code can copy it into its own state.
 *
 * Only a fixed recent row window is inspected. Idle polling returns a digest
 * rather than repeating history; changed snapshots replace the previous window
 * in full, including removals. Message IDs identify streaming replacements.
 */

import { createHash } from 'node:crypto';
import type { AgentMessage, AgentSession } from '../agents/types.ts';

export const applicationChatLimits = {
  /** Also bounds work when the canonical transcript contains mostly tools. */
  scannedRows: 256,
  messages: 24,
  textUnitsPerMessage: 8192,
  /** JSON-encoded rows, including metadata and escaping, not just text bytes. */
  encodedMessagesBytes: 48 * 1024,
  /** The complete response must stay below this bound. */
  responseBytes: 64 * 1024,
  /** Host-enforced per-application rate, including requests that bypass the view JS. */
  readIntervalMilliseconds: 250,
} as const;

export interface ApplicationChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Non-human user-kind rows are never described as human input. */
  source: 'human' | 'assistant' | 'agent' | 'external' | 'scheduled' | 'application' | 'unknown';
  text: string;
  state: AgentMessage['state'];
  /** Text is the newest suffix, not a complete copy of the canonical row. */
  truncated: boolean;
}

export interface ApplicationChatSnapshot {
  /** Digest of this projection, not an application-state revision. */
  revision: string;
  status: AgentSession['status'];
  truncated: boolean;
  messages: ApplicationChatMessage[];
}

export type ApplicationChatResponse =
  (ApplicationChatSnapshot & { changed: true }) | { revision: string; changed: false };

function sourceOf(message: AgentMessage): ApplicationChatMessage['source'] {
  if (message.kind === 'assistant') {
    return 'assistant';
  }
  if (!message.origin) {
    return 'human';
  }
  switch (message.origin.kind) {
    case 'agent':
      return 'agent';
    case 'external':
      return 'external';
    case 'scheduled-wake':
      return 'scheduled';
    case 'application-event':
    case 'application-message':
      return 'application';
    default:
      // Fail closed if a newer origin reaches an older projection.
      return 'unknown';
  }
}

/** Keep complete surrogate pairs at the suffix boundary. No normalization. */
function suffix(text: string, units: number): string {
  let start = Math.max(0, text.length - units);
  if (start > 0 && start < text.length) {
    const previous = text.charCodeAt(start - 1);
    const next = text.charCodeAt(start);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      start++;
    }
  }
  return text.slice(start);
}

/** A very long or malformed archive ID must not defeat the wire-size bound. */
function rowId(id: string): string {
  if (id.length <= 200) {
    return id;
  }
  return 'digest:' + createHash('sha256').update(id).digest('hex');
}

function encodedBytes(message: ApplicationChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

/**
 * Reduce a row until it fits the remaining JSON budget. Binary search operates
 * on at most textUnitsPerMessage code units and also accounts for escaped
 * controls, quotes, astral characters and lone surrogates in archived text.
 */
function fit(
  message: ApplicationChatMessage,
  available: number,
): ApplicationChatMessage | undefined {
  if (encodedBytes(message) <= available) {
    return message;
  }
  const reduced = { ...message, text: '', truncated: true };
  if (encodedBytes(reduced) > available) {
    return undefined;
  }

  let low = 0;
  let high = message.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    reduced.text = suffix(message.text, middle);
    if (encodedBytes(reduced) <= available) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  reduced.text = suffix(message.text, low);
  return reduced;
}

/**
 * Build from the authoritative session, not a UI history page. No timestamps
 * are invented: existing canonical rows do not retain message creation times.
 * `after` is merely an equality cursor; it never selects another conversation
 * or changes the permission required to read this one.
 */
export function applicationChatSnapshot(
  session: Pick<AgentSession, 'messages' | 'status'>,
  after?: string,
): ApplicationChatResponse {
  const messages: ApplicationChatMessage[] = [];
  const oldest = Math.max(0, session.messages.length - applicationChatLimits.scannedRows);
  let truncated = oldest > 0;
  let remaining = applicationChatLimits.encodedMessagesBytes - 2;

  for (let index = session.messages.length - 1; index >= oldest; index--) {
    const row = session.messages[index];
    if ((row.kind !== 'user' && row.kind !== 'assistant') || row.widget) {
      continue;
    }
    if (messages.length === applicationChatLimits.messages) {
      truncated = true;
      break;
    }

    const text = suffix(row.text, applicationChatLimits.textUnitsPerMessage);
    const candidate: ApplicationChatMessage = {
      id: rowId(row.id),
      role: row.kind,
      source: sourceOf(row),
      text,
      state: row.state,
      truncated: text.length !== row.text.length,
    };
    const separatorBytes = messages.length > 0 ? 1 : 0;
    const bounded = fit(candidate, remaining - separatorBytes);
    if (!bounded) {
      truncated = true;
      break;
    }
    remaining -= encodedBytes(bounded) + separatorBytes;
    messages.unshift(bounded);
    truncated ||= bounded.truncated;
    if (bounded.text.length !== candidate.text.length) {
      break;
    }
  }

  const projection = { status: session.status, truncated, messages };
  const revision = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  if (after === revision) {
    return { revision, changed: false };
  }
  return { revision, changed: true, ...projection };
}
