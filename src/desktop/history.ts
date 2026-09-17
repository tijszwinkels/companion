import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Transcript, UtteranceOutcome } from '../core/activity.ts';

export interface HistoryEntry {
  id: string;
  observedAt: number;
  utterance: string;
  application: string | null;
  intent: string | null;
  outcome: UtteranceOutcome | 'processing';
}

/**
 * Permanent evaluation records, with a bounded recent view for desktop pickers.
 * The database belongs to Companion. Each small synchronous transaction commits
 * before observers see its result, so the UI never refers to unsaved text.
 * Raw audio and screenshots are not stored here.
 */
export class UtteranceHistory {
  private database?: DatabaseSync;
  private readonly frameEntries = new Map<number, string>();

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    this.database = new DatabaseSync(this.path);
    await chmod(this.path, 0o600);

    const version = this.database.prepare('PRAGMA user_version').get()?.user_version;

    if (typeof version !== 'number' || version > 1) {
      throw Error('Unsupported Companion database schema version');
    }

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;

      CREATE TABLE IF NOT EXISTS utterances (
        id TEXT PRIMARY KEY,
        observed_at INTEGER NOT NULL,
        transcript TEXT NOT NULL,
        application TEXT,
        window_title TEXT,
        window_address TEXT,
        recognized_intent TEXT,
        outcome TEXT NOT NULL DEFAULT 'processing',
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS utterances_recent ON utterances(observed_at DESC);

      CREATE TABLE IF NOT EXISTS paste_events (
        id TEXT PRIMARY KEY,
        utterance_id TEXT NOT NULL REFERENCES utterances(id),
        attempted_at INTEGER NOT NULL,
        target_address TEXT NOT NULL,
        target_application TEXT,
        outcome TEXT NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS paste_events_utterance ON paste_events(utterance_id);
      PRAGMA user_version = 1;
    `);

    // Interrupted work remains useful for evaluation. Do not guess whether a
    // paste landed if the previous process exited before recording completion.
    this.database
      .prepare(
        `UPDATE utterances SET outcome = 'cancelled', completed_at = ?
      WHERE outcome = 'processing'`,
      )
      .run(Date.now());
    this.database
      .prepare(
        `UPDATE paste_events SET outcome = 'interrupted', completed_at = ?
      WHERE outcome = 'pending'`,
      )
      .run(Date.now());
  }

  private get db(): DatabaseSync {
    if (!this.database) {
      throw Error('Utterance database is not open');
    }

    return this.database;
  }

  snapshot(limit = 100): HistoryEntry[] {
    return this.db
      .prepare(
        `SELECT id, observed_at AS observedAt, transcript AS utterance,
      application, recognized_intent AS intent, outcome FROM utterances
      ORDER BY observed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as unknown as HistoryEntry[];
  }

  find(id: string): HistoryEntry | undefined {
    return this.db
      .prepare(
        `SELECT id, observed_at AS observedAt, transcript AS utterance,
      application, recognized_intent AS intent, outcome FROM utterances WHERE id = ?`,
      )
      .get(id) as unknown as HistoryEntry | undefined;
  }

  add(transcript: Transcript): void {
    if (!transcript.utterance.trim() || this.frameEntries.has(transcript.id)) {
      return;
    }

    const id = randomUUID();
    const application = transcript.application;

    this.db
      .prepare(
        `INSERT INTO utterances
      (id, observed_at, transcript, application, window_title, window_address)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        transcript.observedAt,
        transcript.utterance,
        application?.app ?? null,
        application?.title ?? null,
        application?.address ?? null,
      );

    this.frameEntries.set(transcript.id, id);
  }

  setIntent(frameId: number, intent: string): void {
    const id = this.frameEntries.get(frameId);

    if (id) {
      this.db.prepare('UPDATE utterances SET recognized_intent = ? WHERE id = ?').run(intent, id);
    }
  }

  setOutcome(frameId: number, outcome: UtteranceOutcome): void {
    const id = this.frameEntries.get(frameId);

    if (id) {
      this.db
        .prepare('UPDATE utterances SET outcome = ?, completed_at = ? WHERE id = ?')
        .run(outcome, Date.now(), id);
    }
  }

  finish(frameId: number): void {
    this.frameEntries.delete(frameId);
  }

  activeFrameId(id: string): number | undefined {
    for (const [frameId, entryId] of this.frameEntries) {
      if (id === entryId) {
        return frameId;
      }
    }

    return undefined;
  }

  /** Failed recovery is not evidence that the user successfully corrected intent. */
  beginPaste(utteranceId: string, targetAddress: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO paste_events
      (id, utterance_id, attempted_at, target_address, outcome) VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(id, utteranceId, Date.now(), targetAddress);
    return id;
  }

  finishPaste(id: string, outcome: string, targetApplication: string | null): void {
    this.db
      .prepare(
        `UPDATE paste_events SET outcome = ?, target_application = ?, completed_at = ?
      WHERE id = ?`,
      )
      .run(outcome, targetApplication, Date.now(), id);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
