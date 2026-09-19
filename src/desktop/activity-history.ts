import { randomUUID } from 'node:crypto';

import type { HistoryEntry, IntentFeedback } from './history.ts';

export interface ActivityHistoryEntry extends HistoryEntry, IntentFeedback {
  /** Stable completion order, independent of clock adjustments. */
  sequence: number;
  /** A late page must not overwrite a newer feedback event. */
  revision: number;
}

/**
 * Completed observations from this listener run, retained until shutdown.
 * The database owns durable records; this small index owns the current-session
 * view. Reconnecting UIs fetch bounded pages, and receive single-row updates
 * thereafter, rather than resending the whole run on every microphone event.
 */
export class ActivityHistory {
  readonly sessionId = randomUUID();
  private readonly entries: ActivityHistoryEntry[] = [];
  private readonly positions = new Map<string, number>();
  private revision = 0;

  get count(): number {
    return this.entries.length;
  }

  has(id: string): boolean {
    return this.positions.has(id);
  }

  update(entry: HistoryEntry, feedback: IntentFeedback): ActivityHistoryEntry {
    const position = this.positions.get(entry.id) ?? this.entries.length;
    const completed = {
      ...entry,
      ...feedback,
      sequence: position + 1,
      revision: ++this.revision,
    };
    this.positions.set(entry.id, position);
    this.entries[position] = completed;
    return completed;
  }

  page(after: number, through: number) {
    const end = Math.min(through, this.count);
    const entries = this.entries.slice(after, Math.min(after + 50, end));
    const cursor = after + entries.length;
    return {
      sessionId: this.sessionId,
      entries,
      next: cursor < end ? cursor : null,
      through: end,
    };
  }
}
