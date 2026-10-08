/**
 * Pi extension loaded into every Companion-run Pi process.
 *
 * It writes one custom entry into the conversation's transcript saying that
 * Companion drives this conversation:
 *
 *   {"type":"custom","customType":"agent-harness.live-state-owner",
 *    "data":{"source":"companion"}}
 *
 * agent-harness accepts Companion's live busy/idle reports (see
 * `harness-live-state.ts`) only for sessions whose own transcript carries this
 * entry, so a reporting bug can never change the status of an unrelated Pi
 * session, such as one started in a terminal.
 *
 * Custom entries are stored but never sent to the model. The entry is written
 * once per conversation: a later Pi process for the same conversation (each
 * Companion turn starts one) sees it among the existing entries and skips it.
 */

export const liveStateOwnerEntryType = 'agent-harness.live-state-owner';

interface SessionEntry {
  type?: string;
  customType?: string;
}

interface OwnerExtensionApi {
  on(
    event: 'session_start',
    handler: (
      event: unknown,
      context: { sessionManager: { getEntries(): SessionEntry[] } },
    ) => void | Promise<void>,
  ): void;
  appendEntry(customType: string, data?: unknown): void;
}

export default function registerLiveStateOwner(pi: OwnerExtensionApi): void {
  pi.on('session_start', (_event, context) => {
    const alreadyMarked = context.sessionManager
      .getEntries()
      .some((entry) => entry.type === 'custom' && entry.customType === liveStateOwnerEntryType);

    if (!alreadyMarked) {
      pi.appendEntry(liveStateOwnerEntryType, { source: 'companion' });
    }
  });
}
