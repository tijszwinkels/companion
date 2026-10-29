/**
 * The authoritative unsent text ("draft") of each conversation's text box.
 *
 * One in-memory map in the listener, keyed by the conversation's stable ID.
 * Every trusted editor (the native view and the HTML chat, in the sidebar or
 * a pop-out window) reads and writes this same record; no view keeps its own
 * copy. The rule is deliberately simple: the last write the listener receives
 * wins. There is no edit history, no merge and no refusal because an edit was
 * based on an older text.
 *
 * Inputs: writes from trusted editors (`write`), agent proposals (`propose`,
 * with the existing "never overwrite, append only when asked" policy),
 * recorded words (`append`), and a confirmed send (`clearIfEqual`).
 * Outputs: the current text per conversation (`read`, `snapshot`) and one
 * change notification per accepted change, carrying a listener-wide sequence
 * number. The sequence only orders what views display; it is never used to
 * refuse a write.
 *
 * Lifetime: drafts live as long as the listener process. They are not saved
 * to disk, transcripts or logs, and they survive views being destroyed and
 * conversations being closed and reopened while the listener runs. Empty
 * drafts are removed. Unknown conversation IDs are refused, so the map holds
 * at most one entry per conversation the listener knows.
 *
 * Bounds (UTF-16 code units, like JavaScript strings and Qt):
 * - an editor write may hold at most `editLimit` units (16,000: twice the
 *   8,000-unit Send limit, the text box's existing editing envelope);
 * - recorded words may grow a draft up to `storageLimit` units (64,000), so a
 *   long final dictation chunk is never cut to fit the editing envelope.
 * Nothing is ever truncated: a write past its bound is refused and the
 * previous draft stays as it was.
 */

export const draftEditLimit = 16_000;
export const draftStorageLimit = 64_000;

/** Who changed a draft. Editors pass their client and their own edit ID. */
export interface DraftWriter {
  kind: 'editor' | 'agent' | 'recording' | 'send';
  /** The connected UI that wrote it, if any. */
  clientId?: number;
  /** The editor's own ID for this edit, echoed back so it can ignore it. */
  editId?: string;
}

/** One accepted change, in the order the listener accepted them. */
export interface DraftChange {
  sessionId: string;
  text: string;
  sequence: number;
  writer: DraftWriter;
  /** Agent provenance shown with the draft until the person edits it. */
  source: string;
}

export type DraftWriteResult =
  { accepted: true; sequence: number } | { accepted: false; reason: string };

export interface DraftProposal {
  sessionId: string;
  text: string;
  /** `reject` never changes existing text; `append` adds below it. */
  ifDraftExists: 'reject' | 'append';
  /** Shown as "Drafted by agent · <source>" until the person edits it. */
  source: string;
}

export type DraftProposalResult =
  { outcome: 'inserted' | 'appended'; sequence: number } | { outcome: 'conflict'; reason: string };

interface DraftEntry {
  text: string;
  source: string;
  sequence: number;
}

export class DraftStore {
  private readonly entries = new Map<string, DraftEntry>();
  private readonly listeners = new Set<(change: DraftChange) => void>();
  private sequence = 0;

  /**
   * `isKnown` says whether a conversation ID belongs to a conversation the
   * listener knows (open or saved). Writes for any other ID are refused.
   */
  constructor(
    private readonly isKnown: (sessionId: string) => boolean,
    private readonly editLimit = draftEditLimit,
    private readonly storageLimit = draftStorageLimit,
  ) {}

  /** The current draft of a conversation, '' when it has none. */
  read(sessionId: string): { text: string; source: string; sequence: number } {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return { text: '', source: '', sequence: this.sequence };
    }
    return { text: entry.text, source: entry.source, sequence: entry.sequence };
  }

  /** Every nonempty draft, for a trusted editor that (re)connects. */
  snapshot(): DraftChange[] {
    const changes: DraftChange[] = [];
    for (const [sessionId, entry] of this.entries) {
      changes.push({
        sessionId: sessionId,
        text: entry.text,
        sequence: entry.sequence,
        writer: { kind: 'editor' },
        source: entry.source,
      });
    }
    return changes;
  }

  /** The latest sequence number handed out. */
  latestSequence(): number {
    return this.sequence;
  }

  subscribe(listener: (change: DraftChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A trusted editor's edit: replaces the conversation's draft, whatever it
   * was based on. The person's own edit removes any agent provenance.
   */
  write(
    sessionId: string,
    text: string,
    writer: DraftWriter,
    ceiling: 'edit' | 'storage' = 'edit',
  ): DraftWriteResult {
    if (!this.isKnown(sessionId)) {
      return { accepted: false, reason: 'unknown conversation' };
    }
    if (typeof text !== 'string') {
      return { accepted: false, reason: 'invalid text' };
    }
    // Recorded words (`storage`) may pass the editing envelope, so a long
    // final dictation chunk is kept whole; nothing is ever cut.
    const limit = ceiling === 'storage' ? this.storageLimit : this.editLimit;
    if (text.length > limit) {
      return {
        accepted: false,
        reason: `The text would be ${text.length} characters; at most ${limit} can be kept.`,
      };
    }
    const sequence = this.store(sessionId, text, '', writer);
    return { accepted: true, sequence: sequence };
  }

  /**
   * An agent's proposed draft. Never changes text the person already wrote
   * unless the agent asked to append, and then only below it. Applied in one
   * step, so no other write can interleave between reading and writing.
   */
  propose(proposal: DraftProposal): DraftProposalResult {
    if (!this.isKnown(proposal.sessionId)) {
      return { outcome: 'conflict', reason: 'unknown conversation' };
    }
    const current = this.read(proposal.sessionId).text;
    let next = proposal.text;
    let outcome: 'inserted' | 'appended' = 'inserted';
    if (current.trim() !== '') {
      if (proposal.ifDraftExists !== 'append') {
        return { outcome: 'conflict', reason: '' };
      }
      next = current + (current.endsWith('\n') ? '\n' : '\n\n') + proposal.text;
      outcome = 'appended';
    }
    if (next.length > this.editLimit) {
      return {
        outcome: 'conflict',
        reason: `The combined draft would exceed ${this.editLimit} characters.`,
      };
    }
    const sequence = this.store(proposal.sessionId, next, proposal.source, { kind: 'agent' });
    return { outcome: outcome, sequence: sequence };
  }

  /**
   * Recorded words added at the end. Allowed up to the storage ceiling, not
   * just the editing envelope, so the final chunk of a long dictation is kept
   * whole; past the ceiling it is refused, never cut.
   */
  append(sessionId: string, text: string, writer: DraftWriter): DraftWriteResult {
    if (!this.isKnown(sessionId)) {
      return { accepted: false, reason: 'unknown conversation' };
    }
    const current = this.read(sessionId);
    const next = current.text + text;
    if (next.length > this.storageLimit) {
      return {
        accepted: false,
        reason: `The draft would be ${next.length} characters; at most ${this.storageLimit} can be kept.`,
      };
    }
    const sequence = this.store(sessionId, next, current.source, writer);
    return { accepted: true, sequence: sequence };
  }

  /**
   * After a send was confirmed: clear the draft only if it still is exactly
   * the text that was sent. Text typed (or recorded) since then stays.
   */
  clearIfEqual(sessionId: string, sentText: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.text !== sentText) {
      return false;
    }
    this.store(sessionId, '', '', { kind: 'send' });
    return true;
  }

  private store(sessionId: string, text: string, source: string, writer: DraftWriter): number {
    this.sequence += 1;
    const sequence = this.sequence;
    if (text === '') {
      this.entries.delete(sessionId);
    } else {
      this.entries.set(sessionId, { text: text, source: source, sequence: sequence });
    }
    const change: DraftChange = {
      sessionId: sessionId,
      text: text,
      sequence: sequence,
      writer: writer,
      source: text === '' ? '' : source,
    };
    for (const listener of this.listeners) {
      listener(change);
    }
    return sequence;
  }
}
