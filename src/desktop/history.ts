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
  outcome: UtteranceOutcome | 'processing' | 'delivering';
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

    if (typeof version !== 'number' || version > 2) {
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
        completed_at INTEGER,
        delivery_started_at INTEGER,
        legacy_outcome TEXT
      );

      CREATE INDEX IF NOT EXISTS utterances_recent ON utterances(observed_at DESC);

      CREATE TABLE IF NOT EXISTS paste_events (
        id TEXT PRIMARY KEY,
        utterance_id TEXT NOT NULL REFERENCES utterances(id),
        attempted_at INTEGER NOT NULL,
        target_address TEXT NOT NULL,
        target_application TEXT,
        outcome TEXT NOT NULL,
        completed_at INTEGER,
        delivery_started_at INTEGER,
        legacy_outcome TEXT
      );

      CREATE INDEX IF NOT EXISTS paste_events_utterance ON paste_events(utterance_id);
    `);

    // Migrate both tables atomically. The owner holds the database's process
    // lock during schema changes, crash recovery, and every later write.
    this.database.exec('BEGIN IMMEDIATE');

    try {
      // A crash during the old first-time setup could leave either table at
      // version 0. Inspect each table instead of assuming version 0 is empty.
      const utteranceColumns = this.database.prepare('PRAGMA table_info(utterances)').all();
      const pasteColumns = this.database.prepare('PRAGMA table_info(paste_events)').all();
      const legacyUtterances = !utteranceColumns.some(
        (column) => column.name === 'delivery_started_at',
      );
      const legacyPastes = !pasteColumns.some((column) => column.name === 'delivery_started_at');
      const unclassifiedUtterances = !utteranceColumns.some(
        (column) => column.name === 'legacy_outcome',
      );
      const unclassifiedPastes = !pasteColumns.some((column) => column.name === 'legacy_outcome');

      if (unclassifiedUtterances) {
        this.database.exec('ALTER TABLE utterances ADD COLUMN legacy_outcome TEXT');
      }

      if (unclassifiedPastes) {
        this.database.exec('ALTER TABLE paste_events ADD COLUMN legacy_outcome TEXT');
      }

      if (legacyUtterances) {
        this.database.exec('ALTER TABLE utterances ADD COLUMN delivery_started_at INTEGER');
      }

      if (unclassifiedUtterances || legacyUtterances) {
        // Old cancellation/error labels could include partially inserted text.
        // We cannot reconstruct whether typing began, so retain the original
        // completion time and label for evaluation, while making uncertainty
        // explicit in the current outcome.
        // The first version-2 migration added delivery markers but did not
        // repair old completed rows. Missing provenance identifies that mixed
        // population too; its ambiguous failures need conservative treatment.
        this.database.exec(`
          UPDATE utterances SET legacy_outcome = outcome, outcome = 'interrupted'
          WHERE recognized_intent = 'SEND_TEXT_TO_APPLICATION'
          AND outcome IN ('cancelled', 'error');
        `);
      }

      if (legacyPastes) {
        this.database.exec('ALTER TABLE paste_events ADD COLUMN delivery_started_at INTEGER');
      }

      if (unclassifiedPastes || legacyPastes) {
        this.database.exec(`
          UPDATE paste_events SET legacy_outcome = outcome, outcome = 'interrupted'
          WHERE outcome IN ('cancelled', 'error');
        `);
      }

      // Version 1 did not record when typing began. Conservatively preserve
      // uncertainty for its unfinished sends/pastes; newer records are precise.
      // Commit recovery and the schema version together so a crash mid-migration
      // cannot forget that the old rows had no delivery-start marker.
      this.database
        .prepare(
          `UPDATE utterances SET legacy_outcome = CASE WHEN ? = 1 THEN outcome ELSE legacy_outcome END,
        outcome = CASE
        WHEN delivery_started_at IS NOT NULL OR (? = 1 AND recognized_intent = 'SEND_TEXT_TO_APPLICATION')
          THEN 'interrupted' ELSE 'cancelled' END, completed_at = ?
      WHERE outcome IN ('processing', 'delivering')`,
        )
        .run(Number(legacyUtterances), Number(legacyUtterances), Date.now());
      this.database
        .prepare(
          `UPDATE paste_events SET legacy_outcome = CASE WHEN ? = 1 THEN outcome ELSE legacy_outcome END,
        outcome = CASE
        WHEN delivery_started_at IS NOT NULL OR ? = 1 THEN 'interrupted' ELSE 'cancelled' END,
        completed_at = ?
      WHERE outcome = 'pending'`,
        )
        .run(Number(legacyPastes), Number(legacyPastes), Date.now());
      this.database.exec('PRAGMA user_version = 2; COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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

  markDeliveryStarted(frameId: number): void {
    const id = this.frameEntries.get(frameId);

    if (id) {
      this.db
        .prepare(
          "UPDATE utterances SET delivery_started_at = ?, outcome = 'delivering' WHERE id = ?",
        )
        .run(Date.now(), id);
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

  markPasteStarted(id: string, targetApplication: string | null): void {
    this.db
      .prepare(
        'UPDATE paste_events SET delivery_started_at = ?, target_application = ? WHERE id = ?',
      )
      .run(Date.now(), targetApplication, id);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
