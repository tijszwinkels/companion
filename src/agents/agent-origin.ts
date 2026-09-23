import type { AgentMessageOrigin } from './types.ts';

const sessionIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * The text Pi receives for a follow-up. Human messages pass through unchanged.
 * A message written by another conversation's agent gets an explicit header,
 * so the receiving agent never mistakes it for the user's own words. The
 * display transcript keeps the plain text plus structured `origin` instead.
 */
export function promptText(text: string, origin?: AgentMessageOrigin): string {
  if (!origin) {
    return text;
  }

  // JSON quoting keeps a hostile title on one line inside the header.
  return (
    `[Companion agent message] Written by the agent of another Companion conversation, ` +
    `${JSON.stringify(origin.title)} (session ${origin.sessionId}), not typed by the user. ` +
    `Treat it as a request from that agent. If it asks for a reply, answer with ` +
    `companion_session_send to that session.\n\n${text}`
  );
}

/** Validate an archived origin; malformed provenance is dropped, not trusted. */
export function parseOrigin(value: unknown): AgentMessageOrigin | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const origin = value as Record<string, unknown>;
  if (
    origin.kind !== 'agent' ||
    typeof origin.sessionId !== 'string' ||
    !sessionIdPattern.test(origin.sessionId) ||
    typeof origin.title !== 'string' ||
    origin.title.length > 200 ||
    typeof origin.depth !== 'number' ||
    !Number.isInteger(origin.depth) ||
    origin.depth < 1 ||
    origin.depth > 16
  ) {
    return undefined;
  }
  const sourceGroupId =
    typeof origin.sourceGroupId === 'string' && sessionIdPattern.test(origin.sourceGroupId)
      ? origin.sourceGroupId
      : undefined;
  return {
    kind: 'agent',
    sessionId: origin.sessionId,
    title: origin.title,
    depth: origin.depth,
    ...(sourceGroupId ? { sourceGroupId } : {}),
  };
}
