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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private resynchronize(): void {
    // The native side answers with a full rows message and the status.
    this.lastSequence = 0;
    this.bridge?.ready();
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
