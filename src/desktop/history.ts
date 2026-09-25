import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Transcript, UtteranceOutcome } from '../core/activity.ts';
import type { Screenshot, UserSensorFrame } from '../core/frame.ts';
import type {
  CleanupFallbackReason,
  TranscriptionCleanupRecord,
  TranscriptionCleanupStatus,
} from '../core/transcription-cleanup/record.ts';
import { encodeWav } from '../sensors/audio/segmenter.ts';
import { artifactPath, removeArtifacts, saveArtifact } from './artifacts.ts';

export interface IntentFeedback {
  correct: boolean | null;
  actualIntent: string | null;
}

export interface HistoryEntry {
  id: string;
  observedAt: number;
  /** The raw ASR transcript (or typed Activity text), always unchanged. */
  utterance: string;
  application: string | null;
  intent: string | null;
  outcome: UtteranceOutcome | 'processing' | 'delivering';
  /**
   * Transcription cleanup for this utterance: null when unknown (older rows,
   * rows written by an older checkout, or utterances that never reached
   * routing), otherwise whether the switch was on.
   */
  cleanupEnabled: boolean | null;
  /** Null while cleanup was off or unknown. */
  cleanupStatus: TranscriptionCleanupStatus | null;
  /** The cleaned text a text route received instead of `utterance`. */
  cleanedText: string | null;
  /** Why a text route received the raw text although cleanup was on. */
  cleanupFallback: CleanupFallbackReason | null;
}

/** Row shape before booleans are decoded; SQLite stores them as integers. */
type HistoryRow = Omit<HistoryEntry, 'cleanupEnabled'> & { cleanupEnabled: number | null };

// Every entry query selects the same columns in the same order.
const ENTRY_COLUMNS = `id, observed_at AS observedAt, transcript AS utterance,
      application, recognized_intent AS intent, outcome,
      cleanup_enabled AS cleanupEnabled, cleanup_status AS cleanupStatus,
      cleaned_text AS cleanedText, cleanup_fallback AS cleanupFallback`;

function decodeEntry(row: HistoryRow): HistoryEntry {
  return {
    ...row,
    cleanupEnabled: row.cleanupEnabled === null ? null : row.cleanupEnabled === 1,
  };
}

/**
 * Permanent evaluation records, with a bounded recent view for desktop pickers.
 * The database belongs to Companion. Each small synchronous transaction commits
 * before observers see its result, so the UI never refers to unsaved text.
 * Screenshots and utterance audio live beside the database, linked by their UUID
 * filenames. Explicit feedback is separate from the original prediction.
 */
export class UtteranceHistory {
  private database?: DatabaseSync;
  private readonly frameEntries = new Map<number, string>();
  private readonly deleting = new Set<string>();

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    this.database = new DatabaseSync(this.path);
    await chmod(this.path, 0o600);

    const version = this.database.prepare('PRAGMA user_version').get()?.user_version;

    if (typeof version !== 'number' || version > 5) {
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

    // Migrate the schema atomically. The owner holds the database's process
    // lock during schema changes, crash recovery, and every later write.
    this.database.exec('BEGIN IMMEDIATE');

    try {
      // A crash during the old first-time setup could leave either table at
      // version 0. Inspect each table instead of assuming version 0 is empty.
      const utteranceColumns = this.database.prepare('PRAGMA table_info(utterances)').all();
      const pasteColumns = this.database.prepare('PRAGMA table_info(paste_events)').all();

      // Capture evidence for every attempted classification, not just examples
      // labeled later. Legacy rows and shortcut-only routes remain NULL.
      if (!utteranceColumns.some((column) => column.name === 'intent_request')) {
        this.database.exec('ALTER TABLE utterances ADD COLUMN intent_request TEXT');
      }

      // The filename already contains the utterance UUID. Retire earlier path
      // columns without touching recorded files or changing their identities.
      if (utteranceColumns.some((column) => column.name === 'screenshot_path')) {
        this.database.exec('ALTER TABLE utterances DROP COLUMN screenshot_path');
      }

      if (utteranceColumns.some((column) => column.name === 'audio_path')) {
        this.database.exec('ALTER TABLE utterances DROP COLUMN audio_path');
      }

      // Transcription cleanup, stored beside the unchanged raw transcript.
      // These nullable columns are additive and deliberately do not change
      // the schema version: older checkouts keep opening this database and
      // simply ignore them (their new rows read as "unknown"), so switching
      // back to a build without cleanup needs no migration. They live in the
      // utterances row itself, so deleting an utterance also deletes them.
      const cleanupColumns: [string, string][] = [
        ['cleanup_enabled', 'INTEGER CHECK (cleanup_enabled IN (0, 1))'],
        ['cleanup_status', "TEXT CHECK (cleanup_status IN ('cleaned', 'fallback', 'no-text'))"],
        ['cleaned_text', 'TEXT'],
        ['cleanup_fallback', 'TEXT'],
      ];
      for (const [name, definition] of cleanupColumns) {
        if (!utteranceColumns.some((column) => column.name === name)) {
          this.database.exec(`ALTER TABLE utterances ADD COLUMN ${name} ${definition}`);
        }
      }

      // No rows are inferred from delivery, recovery, or lack of complaints.
      // A row exists only after explicit feedback on this utterance's intent.
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS intent_feedback (
          id TEXT PRIMARY KEY NOT NULL REFERENCES utterances(id),
          correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
          recognized_intent TEXT NOT NULL,
          actual_intent TEXT DEFAULT NULL
        );
      `);

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
      this.database.exec('PRAGMA user_version = 5; COMMIT;');
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
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM utterances
      ORDER BY observed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as unknown as HistoryRow[];
    return rows.map((row) => decodeEntry(row));
  }

  find(id: string): HistoryEntry | undefined {
    const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM utterances WHERE id = ?`).get(id) as
      HistoryRow | undefined;
    return row ? decodeEntry(row) : undefined;
  }

  /**
   * Remove a completed observation and its evaluation records. Files go first:
   * a filesystem failure leaves the row available for an explicit retry. The
   * SQLite transaction then removes dependants and the row together. Missing
   * files are harmless, including after a partially completed earlier attempt.
   */
  async delete(id: string): Promise<void> {
    this.assertNotDeleting(id);
    const entry = this.find(id);
    if (!entry) {
      throw Error('Utterance not found');
    }
    const pendingPaste = this.db
      .prepare("SELECT 1 FROM paste_events WHERE utterance_id = ? AND outcome = 'pending' LIMIT 1")
      .get(id);
    if (
      this.activeFrameId(id) !== undefined ||
      entry.outcome === 'processing' ||
      entry.outcome === 'delivering' ||
      pendingPaste
    ) {
      throw Error('Wait for this utterance to finish processing or pasting before deleting it');
    }

    // Claim the row before filesystem awaits. No paste, label or history-agent
    // request may begin using it while its recordings are being removed.
    this.deleting.add(id);
    try {
      await removeArtifacts(dirname(this.path), id);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM intent_feedback WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM paste_events WHERE utterance_id = ?').run(id);
        this.db.prepare('DELETE FROM utterances WHERE id = ?').run(id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.deleting.delete(id);
    }
  }

  private assertNotDeleting(id: string): void {
    if (this.deleting.has(id)) {
      throw Error('This utterance is being deleted');
    }
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

  /**
   * Store what transcription cleanup did for an active utterance. The router
   * reports once per routed utterance; the first record is kept. The raw
   * transcript column is never touched.
   */
  saveCleanup(frameId: number, record: TranscriptionCleanupRecord): void {
    const id = this.frameEntries.get(frameId);
    if (!id) {
      return;
    }

    let status: TranscriptionCleanupStatus | null = null;
    let cleanedText: string | null = null;
    let fallback: CleanupFallbackReason | null = null;
    if (record.enabled) {
      status = record.status;
      if (record.status === 'cleaned') {
        cleanedText = record.text;
      }
      if (record.status === 'fallback') {
        fallback = record.reason;
      }
    }

    this.db
      .prepare(
        `UPDATE utterances SET cleanup_enabled = ?, cleanup_status = ?, cleaned_text = ?,
        cleanup_fallback = ? WHERE id = ? AND cleanup_enabled IS NULL`,
      )
      .run(Number(record.enabled), status, cleanedText, fallback, id);
  }

  /** The first prepared request is immutable, including after failures/feedback. */
  saveIntentRequest(frameId: number, serializedRequest: string): void {
    const id = this.frameEntries.get(frameId);
    if (!id) {
      throw Error('No active utterance for intent request recording');
    }
    const result = this.db
      .prepare('UPDATE utterances SET intent_request = ? WHERE id = ? AND intent_request IS NULL')
      .run(serializedRequest, id);
    if (result.changes !== 1) {
      throw Error('Intent request already recorded or utterance no longer exists');
    }
  }

  async saveScreenshot(frameId: number, screenshot: Screenshot): Promise<void> {
    const id = this.frameEntries.get(frameId);

    if (!id) {
      return;
    }

    const entry = this.find(id)!;
    await saveArtifact(dirname(this.path), id, entry.observedAt, 'screenshots', screenshot.png);
  }

  async saveAudio(frameId: number, samples: Float32Array): Promise<void> {
    const id = this.frameEntries.get(frameId);

    if (!id) {
      return;
    }

    const entry = this.find(id)!;
    // Use the same PCM16 encoding as Voxtype's input, without resampling or
    // trimming. The pipeline retains ownership until this write settles.
    const wav = encodeWav(samples);
    await saveArtifact(dirname(this.path), id, entry.observedAt, 'audio', wav);
  }

  /**
   * Label the preceding non-label utterance, even across a restart. Use insertion
   * order rather than the wall clock, which can move backwards. Repeated feedback
   * corrects the same target instead of evaluating the labeling command itself.
   */
  labelPrevious(frameId: number, correct: boolean): string | undefined {
    const commandId = this.frameEntries.get(frameId);

    if (!commandId) {
      return undefined;
    }

    const previous = this.db
      .prepare(
        `SELECT id, recognized_intent FROM utterances
        WHERE rowid < (SELECT rowid FROM utterances WHERE id = ?)
          AND (recognized_intent IS NULL OR recognized_intent NOT IN
            ('LABEL_PREVIOUS_CORRECT', 'LABEL_PREVIOUS_INCORRECT'))
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(commandId) as { id: string; recognized_intent: string | null } | undefined;

    // A capture/inference failure has no selected intent to evaluate. Do not
    // silently jump past it and apply the user's feedback to older speech.
    if (!previous?.recognized_intent) {
      return undefined;
    }

    this.label(previous.id, correct);
    return previous.id;
  }

  feedback(id: string): IntentFeedback {
    const row = this.db
      .prepare('SELECT correct, actual_intent FROM intent_feedback WHERE id = ?')
      .get(id) as { correct: number; actual_intent: string | null } | undefined;
    return { correct: row ? Boolean(row.correct) : null, actualIntent: row?.actual_intent ?? null };
  }

  /** Explicit correction preserves the detected intent and delivery outcome. */
  label(id: string, correct: boolean, actualIntent: string | null = null): void {
    this.assertNotDeleting(id);
    const entry = this.find(id);
    if (!entry?.intent) {
      throw Error('This utterance has no detected intent to label');
    }
    if (correct && actualIntent !== null && actualIntent !== entry.intent) {
      throw Error('A correct label must match the detected intent');
    }
    if (!correct && actualIntent === entry.intent) {
      throw Error('Choose a different intended intent, or label this detection correct');
    }
    this.db
      .prepare(
        `INSERT INTO intent_feedback (id, correct, recognized_intent, actual_intent)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          correct = excluded.correct,
          recognized_intent = excluded.recognized_intent,
          actual_intent = excluded.actual_intent`,
      )
      .run(id, Number(correct), entry.intent, correct ? entry.intent : actualIntent);
  }

  /** Start a question from its original observation, not today's active screen. */
  async recordedFrame(id: string): Promise<UserSensorFrame> {
    this.assertNotDeleting(id);
    const entry = this.find(id);
    if (!entry) {
      throw Error('Utterance not found');
    }
    const row = this.db
      .prepare('SELECT window_address, window_title FROM utterances WHERE id = ?')
      .get(id) as { window_address: string | null; window_title: string | null };
    const path = artifactPath(dirname(this.path), entry.id, entry.observedAt, 'screenshots');
    let png: Buffer;
    try {
      png = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Error('The original screenshot is unavailable for this utterance');
      }
      throw error;
    }
    // Reading the screenshot yields. Deletion may have begun or completed
    // since the first lookup; do not start a new agent from that stale read.
    this.assertNotDeleting(id);
    if (!this.find(id)) {
      throw Error('Utterance not found');
    }
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw Error('The recorded screenshot is not a valid PNG');
    }
    return {
      id: 0, // Explicit history action; it is not a new sensor observation.
      observedAt: entry.observedAt,
      utterance: entry.utterance,
      screenshot: {
        png,
        capturedAt: entry.observedAt,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        window: {
          address: row.window_address ?? '',
          app: entry.application ?? '',
          title: row.window_title ?? '',
        },
      },
    };
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

  finish(frameId: number): HistoryEntry | undefined {
    const id = this.frameEntries.get(frameId);
    this.frameEntries.delete(frameId);
    return id ? this.find(id) : undefined;
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
    this.assertNotDeleting(utteranceId);
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
