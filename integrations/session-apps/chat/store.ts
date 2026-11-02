/**
 * The page's copy of the conversation shown by its native view.
 *
 * The native view (TrustedChatView.qml) owns everything; this store only
 * applies its ordered messages. Rows arrive as an order plus changed rows;
 * a sequence gap or a session change asks for a full resynchronization.
 */

import type { ChatRow, ChatStatus, HostMessage, NativeBridge } from './protocol.ts';

export interface ChatSnapshot {
  rows: ChatRow[];
  status: ChatStatus;
}

type Listener = () => void;

export class ChatStore {
  private bridge: NativeBridge | null = null;
  private rowsByKey = new Map<string, ChatRow>();
  private rowsSessionId = '';
  private lastSequence = 0;
  private listeners = new Set<Listener>();
  private snapshot: ChatSnapshot = { rows: [], status: { sessionId: '' } };
  // The newest known host draft of the shown conversation, updated in the
  // order the host sent things: status updates and this page's accepted
  // edits (which produce no status update). Kept here, synchronously,
  // because component effects run later and could apply an older status
  // after a newer accepted edit.
  private latestHostDraft: { sessionId: string; text: string; cursor: number; revision: number } = {
    sessionId: '',
    text: '',
    cursor: -1,
    revision: 0,
  };
  // Identifies this document for the native view, so a resynchronization of
  // the same page is not mistaken for a reload.
  readonly documentId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  // Input only this page's editor holds (see Composer): at most one, for the
  // conversation it was typed in. The host knows only its length, which
  // keeps that conversation from moving or closing until it is resolved;
  // the page is the only place the text is.
  private unresolvedInput: { sessionId: string; text: string } | null = null;
  // This page's edits whose answers are still outstanding, per conversation:
  // how many, and the serial of that conversation's latest input. Kept for
  // the page, not per editor, because an editor can be replaced (switch,
  // remount) before its answers arrive. Entries go away with their last
  // answer, so this holds at most the conversations with edits in flight.
  private pendingEdits = new Map<string, { count: number; latest: number }>();
  private inputSerial = 0;
  // How many host statuses said Send is not admissible apart from the text
  // (offline, a send or choice awaiting its answer, recording). Counted per
  // received message, so an admission lost and regained before the page
  // renders still counts: a Send held across it is dropped (see Composer).
  private admissionLosses = 0;

  /** See `admissionLosses`; changes only when such a status arrives. */
  admissionLossCount(): number {
    return this.admissionLosses;
  }

  attach(bridge: NativeBridge): void {
    this.bridge = bridge;
    bridge.message.connect((json) => this.receive(json));
    this.resynchronize();
  }

  get native(): NativeBridge | null {
    return this.bridge;
  }

  current(): ChatSnapshot {
    return this.snapshot;
  }

  hostDraft(): { sessionId: string; text: string; cursor: number; revision: number } {
    return this.latestHostDraft;
  }

  /**
   * A new input in `sessionId`, before anything asynchronous can happen;
   * returns its serial. `sent`: an edit for it now awaits its answer. Every
   * input becomes the conversation's latest, so an answer to an older one
   * can no longer change what the page holds.
   */
  beginInput(sessionId: string, sent: boolean): number {
    this.inputSerial++;
    const serial = this.inputSerial;
    const entry = this.pendingEdits.get(sessionId);
    if (entry) {
      entry.latest = serial;
      if (sent) {
        entry.count++;
      }
    } else if (sent) {
      this.pendingEdits.set(sessionId, { count: 1, latest: serial });
    }
    return serial;
  }

  /** The answer to input `serial` arrived: whether it is still the latest. */
  finishInput(sessionId: string, serial: number): boolean {
    const entry = this.pendingEdits.get(sessionId);
    if (!entry) {
      return true;
    }
    entry.count--;
    const latest = entry.latest === serial;
    if (entry.count <= 0) {
      this.pendingEdits.delete(sessionId);
      // An editor of another conversation may be waiting for this (see
      // pendingElsewhere): let it render again.
      if (sessionId !== this.snapshot.status.sessionId) {
        this.snapshot = { rows: this.snapshot.rows, status: this.snapshot.status };
        this.notify();
      }
    }
    return latest;
  }

  /**
   * Another conversation's edits still await answers. A refusal among them
   * leaves that input only in this page, which keeps one such input; so an
   * editor of any other conversation waits (read-only) until they settled.
   */
  pendingElsewhere(sessionId: string): boolean {
    for (const pendingSession of this.pendingEdits.keys()) {
      if (pendingSession !== sessionId) {
        return true;
      }
    }
    return false;
  }

  unresolved(): { sessionId: string; text: string } | null {
    return this.unresolvedInput;
  }

  /** Keep (or, with null, release) the editor-only input and tell the host. */
  setUnresolved(entry: { sessionId: string; text: string } | null): void {
    const previous = this.unresolvedInput;
    this.unresolvedInput = entry;
    if (this.bridge) {
      if (entry) {
        this.bridge.inputUnresolved(entry.sessionId, entry.text.length);
      } else if (previous) {
        this.bridge.inputUnresolved(previous.sessionId, 0);
      }
    }
    // A new snapshot object, so every view of the store renders again.
    this.snapshot = { rows: this.snapshot.rows, status: this.snapshot.status };
    this.notify();
  }

  /** The host accepted this page's edit: its draft is now that text. */
  acceptedEdit(sessionId: string, text: string, cursor: number): void {
    if (this.latestHostDraft.sessionId === sessionId) {
      this.latestHostDraft = { ...this.latestHostDraft, text: text, cursor: cursor };
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private resynchronize(): void {
    // The native side answers with a full rows message and the status.
    this.lastSequence = 0;
    this.bridge?.ready(this.documentId);
  }

  private receive(json: string): void {
    let message: HostMessage;
    try {
      message = JSON.parse(json) as HostMessage;
    } catch {
      this.resynchronize();
      return;
    }

    // `ready()` restarts nothing on the native side: sequence numbers keep
    // increasing. After asking, accept the next full rows message as a base.
    const expected = this.lastSequence + 1;
    const gap = this.lastSequence !== 0 && message.seq !== expected;
    if (gap && !(message.type === 'rows' && message.full)) {
      this.resynchronize();
      return;
    }
    this.lastSequence = message.seq;

    if (message.type === 'rows') {
      this.applyRows(message);
    } else {
      this.snapshot = { rows: this.snapshot.rows, status: message.status };
      if (!sendAdmitted(message.status)) {
        this.admissionLosses++;
      }
      const draft = message.status.draft;
      this.latestHostDraft = {
        sessionId: message.status.sessionId,
        text: draft ? draft.text : '',
        cursor: draft ? draft.cursor : -1,
        revision: draft ? draft.revision : 0,
      };
    }
    this.notify();
  }

  private applyRows(message: Extract<HostMessage, { type: 'rows' }>): void {
    if (message.full || message.sessionId !== this.rowsSessionId) {
      this.rowsByKey.clear();
    }
    this.rowsSessionId = message.sessionId;

    for (const row of message.changed) {
      this.rowsByKey.set(row.key, row);
    }

    const rows: ChatRow[] = [];
    const next = new Map<string, ChatRow>();
    for (const key of message.order) {
      const row = this.rowsByKey.get(key);
      if (!row) {
        // A row the page never received: its copy is incomplete.
        this.resynchronize();
        return;
      }
      rows.push(row);
      next.set(key, row);
    }

    this.rowsByKey = next;
    this.snapshot = { rows: rows, status: this.snapshot.status };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * The host's Send admission apart from its copy of the text, which lags
 * behind an edit on its way: connected, no send or choice awaiting its
 * answer, no words being recorded.
 */
export function sendAdmitted(status: ChatStatus): boolean {
  return (
    status.online === true &&
    status.pendingSend !== true &&
    status.pendingChoice !== true &&
    status.recording?.busy !== true
  );
}
