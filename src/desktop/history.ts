import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Transcript, TranscriptSource, UtteranceOutcome } from '../core/activity.ts';
import type { Screenshot, UserSensorFrame } from '../core/frame.ts';
import type {
  CleanupFallbackReason,
  TranscriptionCleanupRecord,
  TranscriptionCleanupStatus,
} from '../core/transcription-cleanup/record.ts';
import { encodeWav } from '../sensors/audio/segmenter.ts';
import { artifactPath, removeArtifacts, saveArtifact } from './artifacts.ts';
import { completePng, completeWav } from './capture-media.ts';

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
  /**
   * `earlier-attempt` when the text is an earlier attempt's transcript stored
   * beside a continued utterance's combined audio (D2 fallback, or a failed
   * final attempt); `audio-only` when such a failed utterance had no usable
   * text at all (empty transcript, WAV kept). Null means unspecified: older
   * rows, typed input and fresh ASR all read null, so it is not proof the
   * whole recording was transcribed.
   */
  transcriptSource: TranscriptSource | null;
  /**
   * The capture-storage decision for this observation (docs/capture-storage.md).
   * `off`: its audio/screenshot were deliberately not saved ("Not saved"); the
   * entry can never be labeled. `on`: they were saved unless a write failed.
   * Null: unknown (rows from before capture storage, or an older checkout).
   */
  captureStorage: 'on' | 'off' | null;
  /** `speech` or `typed` Activity text; null when unknown (older rows). */
  inputKind: 'speech' | 'typed' | null;
  /**
   * Whether this observation's screenshot / WAV was actually published.
   * False after a refusal by capture storage or a failed write; null for
   * rows from before capture storage, where only the files can tell.
   */
  screenshotSaved: boolean | null;
  audioSaved: boolean | null;
  /**
   * Why this entry cannot be labeled from its original capture, as far as
   * the database knows; null when its required originals were saved (or the
   * row is older). Labeling also requires capture storage to be on, and the
   * listener checks the files themselves again before writing a label.
   */
  labelingUnavailable: string | null;
  /**
   * The original screenshot is known to be unusable: never saved, or found
   * missing/corrupt later (the desktop runtime adds those). Nothing that
   * needs the original screenshot may start from this entry.
   */
  screenshotUnavailable: boolean;
}

/** Why an entry's originals cannot be used, and whether the screenshot is affected. */
export interface OriginalProblem {
  reason: string;
  screenshot: boolean;
}

/** Row shape before booleans are decoded; SQLite stores them as integers. */
type HistoryRow = Omit<
  HistoryEntry,
  | 'cleanupEnabled'
  | 'screenshotSaved'
  | 'audioSaved'
  | 'labelingUnavailable'
  | 'screenshotUnavailable'
> & {
  cleanupEnabled: number | null;
  screenshotSaved: number | null;
  audioSaved: number | null;
};

// Every entry query selects the same columns in the same order.
const ENTRY_COLUMNS = `id, observed_at AS observedAt, transcript AS utterance,
      application, recognized_intent AS intent, outcome,
      cleanup_enabled AS cleanupEnabled, cleanup_status AS cleanupStatus,
      cleaned_text AS cleanedText, cleanup_fallback AS cleanupFallback,
      transcript_source AS transcriptSource, capture_storage AS captureStorage,
      input_kind AS inputKind, screenshot_saved AS screenshotSaved, audio_saved AS audioSaved`;

function decodeBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function decodeEntry(row: HistoryRow): HistoryEntry {
  const entry = {
    ...row,
    cleanupEnabled: decodeBoolean(row.cleanupEnabled),
    screenshotSaved: decodeBoolean(row.screenshotSaved),
    audioSaved: decodeBoolean(row.audioSaved),
  };
  return {
    ...entry,
    labelingUnavailable: savedMediaProblem(entry),
    screenshotUnavailable: entry.captureStorage === 'off' || entry.screenshotSaved === false,
  };
}

/**
 * The recorded reason an entry lacks the originals a label needs: its
 * screenshot, and for spoken input its WAV. Typed input needs no WAV.
 */
function savedMediaProblem(
  entry: Pick<HistoryEntry, 'captureStorage' | 'inputKind' | 'screenshotSaved' | 'audioSaved'>,
): string | null {
  if (entry.captureStorage === 'off') {
    return 'This entry was not saved, so it cannot be labeled';
  }
  if (entry.screenshotSaved === false) {
    return 'The original screenshot for this entry was not saved';
  }
  if (entry.inputKind === 'speech' && entry.audioSaved === false) {
    return 'The original audio for this entry was not saved';
  }
  return null;
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
  // Superseded attempts whose continuation has not settled yet. The desktop
  // runtime holds them from their `finished` until it retires or keeps them.
  private readonly awaitingRetirement = new Set<string>();

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

      // Transcription cleanup, stored beside the unchanged raw transcript, and
      // the transcript source of continued utterances (see HistoryEntry).
      // These nullable columns are additive and deliberately do not change
      // the schema version: older checkouts keep opening this database and
      // simply ignore them (their new rows read as "unknown"), so switching
      // back to a build without cleanup needs no migration. They live in the
      // utterances row itself, so deleting an utterance also deletes them.
      const additiveColumns: [string, string][] = [
        ['cleanup_enabled', 'INTEGER CHECK (cleanup_enabled IN (0, 1))'],
        ['cleanup_status', "TEXT CHECK (cleanup_status IN ('cleaned', 'fallback', 'no-text'))"],
        ['cleaned_text', 'TEXT'],
        ['cleanup_fallback', 'TEXT'],
        [
          'transcript_source',
          "TEXT CHECK (transcript_source IN ('earlier-attempt', 'audio-only'))",
        ],
        // Capture storage (see HistoryEntry.captureStorage): additive for the
        // same reason. Existing rows stay NULL ("unknown"); nothing is inferred
        // from existing files and no recording is touched.
        ['capture_storage', "TEXT CHECK (capture_storage IN ('on', 'off'))"],
        ['input_kind', "TEXT CHECK (input_kind IN ('speech', 'typed'))"],
        ['screenshot_saved', 'INTEGER CHECK (screenshot_saved IN (0, 1))'],
        ['audio_saved', 'INTEGER CHECK (audio_saved IN (0, 1))'],
      ];
      for (const [name, definition] of additiveColumns) {
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
    this.assertAvailable(id);
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

    await this.removeClaimed(id, () => {
      this.db.prepare('DELETE FROM intent_feedback WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM paste_events WHERE utterance_id = ?').run(id);
      this.db.prepare('DELETE FROM utterances WHERE id = ?').run(id);
    });
  }

  /**
   * Remove a provisional attempt that a continuation replaced, once the
   * continuation's own record owns the whole utterance (the desktop runtime
   * decides that). This is not a user deletion and is deliberately narrower:
   * only a finished row whose outcome is exactly `superseded`, with no paste
   * attempt and no feedback, is removed. Anything the user has already used
   * or referenced stays, and the caller keeps it visible. The same claim,
   * files-first order and transaction as `delete` apply. Throws instead of
   * reporting success when the row was kept.
   */
  async retireSuperseded(id: string): Promise<void> {
    // The retirement hold is expected here; only a concurrent deletion stops it.
    if (this.deleting.has(id)) {
      throw Error('This utterance is being deleted');
    }
    const entry = this.find(id);
    if (!entry) {
      throw Error('Utterance not found');
    }
    if (entry.outcome !== 'superseded' || this.activeFrameId(id) !== undefined) {
      throw Error('Only a finished superseded attempt can be retired');
    }
    if (this.referenced(id)) {
      throw Error('This superseded attempt was pasted or labeled; keeping it');
    }

    await this.removeClaimed(id, () => {
      // The claim blocks new pastes and labels, so these conditions still hold;
      // the statement checks them again rather than relying on that.
      const result = this.db
        .prepare(
          `DELETE FROM utterances WHERE id = ? AND outcome = 'superseded'
          AND NOT EXISTS (SELECT 1 FROM paste_events WHERE utterance_id = ?)
          AND NOT EXISTS (SELECT 1 FROM intent_feedback WHERE id = ?)`,
        )
        .run(id, id, id);
      if (result.changes !== 1) {
        throw Error('The superseded attempt changed while it was being retired');
      }
    });
  }

  private referenced(id: string): boolean {
    const paste = this.db
      .prepare('SELECT 1 FROM paste_events WHERE utterance_id = ? LIMIT 1')
      .get(id);
    const feedback = this.db.prepare('SELECT 1 FROM intent_feedback WHERE id = ?').get(id);
    return paste !== undefined || feedback !== undefined;
  }

  /**
   * Claim the row before filesystem awaits, so no paste, label or history-agent
   * request may begin using it while its recordings are removed. Files go
   * first; `removeRows` then runs in one SQLite transaction.
   */
  private async removeClaimed(id: string, removeRows: () => void): Promise<void> {
    this.deleting.add(id);
    try {
      await removeArtifacts(dirname(this.path), id);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        removeRows();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.deleting.delete(id);
    }
  }

  /**
   * No paste, label, history-agent question or user deletion may start from a
   * row that is being deleted, or from a superseded attempt that is waiting
   * for its continuation to settle (it is about to be retired or kept).
   */
  private assertAvailable(id: string): void {
    if (this.deleting.has(id)) {
      throw Error('This utterance is being deleted');
    }
    if (this.awaitingRetirement.has(id)) {
      throw Error('This attempt was replaced by a continuing utterance; use the final utterance');
    }
  }

  /** An audio-only record has nothing to paste or ask about. */
  private assertHasText(id: string): void {
    if (this.find(id)?.transcriptSource === 'audio-only') {
      throw Error('This record has audio only; no speech was recognized');
    }
  }

  /** Hold a finished superseded attempt until its continuation settles. */
  holdForRetirement(id: string): void {
    this.awaitingRetirement.add(id);
  }

  /** The continuation settled: the attempt was retired, or is kept as an ordinary row. */
  releaseRetirement(id: string): void {
    this.awaitingRetirement.delete(id);
  }

  /**
   * Create the row for an observation. `captureStorage` is the storage
   * decision the desktop runtime made for it (see HistoryEntry).
   */
  add(transcript: Transcript, captureStorage: 'on' | 'off'): void {
    if (this.frameEntries.has(transcript.id)) {
      return;
    }

    // Only an explicitly audio-only record has no text; it never invents any.
    const audioOnly = transcript.source === 'audio-only';
    if (audioOnly ? transcript.utterance !== '' : !transcript.utterance.trim()) {
      return;
    }

    const id = randomUUID();
    const application = transcript.application;

    this.db
      .prepare(
        `INSERT INTO utterances
      (id, observed_at, transcript, application, window_title, window_address, transcript_source,
        capture_storage, input_kind, screenshot_saved, audio_saved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        id,
        transcript.observedAt,
        transcript.utterance,
        application?.app ?? null,
        application?.title ?? null,
        application?.address ?? null,
        transcript.source ?? null,
        captureStorage,
        transcript.input ?? null,
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

  /**
   * Publish the PNG. `current` is the capture-storage check (see
   * saveArtifact). Resolves `saved` once published, `no-row` when the frame
   * has no row, and undefined when capture storage stopped it.
   */
  async saveScreenshot(
    frameId: number,
    screenshot: Screenshot,
    current: () => boolean,
  ): Promise<'saved' | 'no-row' | undefined> {
    const id = this.frameEntries.get(frameId);

    if (!id) {
      return 'no-row';
    }

    const entry = this.find(id)!;
    const directory = dirname(this.path);
    const saved = await saveArtifact(
      directory,
      id,
      entry.observedAt,
      'screenshots',
      screenshot.png,
      current,
    );
    if (!saved) {
      return undefined;
    }
    this.db.prepare('UPDATE utterances SET screenshot_saved = 1 WHERE id = ?').run(id);
    return 'saved';
  }

  /** Publish the WAV; results as for `saveScreenshot`. */
  async saveAudio(
    frameId: number,
    samples: Float32Array,
    current: () => boolean,
  ): Promise<'saved' | 'no-row' | undefined> {
    const id = this.frameEntries.get(frameId);

    if (!id) {
      return 'no-row';
    }

    const entry = this.find(id)!;
    // Use the same PCM16 encoding as Voxtype's input, without resampling or
    // trimming. The pipeline retains ownership until this write settles.
    const wav = encodeWav(samples);
    const saved = await saveArtifact(
      dirname(this.path),
      id,
      entry.observedAt,
      'audio',
      wav,
      current,
    );
    if (!saved) {
      return undefined;
    }
    this.db.prepare('UPDATE utterances SET audio_saved = 1 WHERE id = ?').run(id);
    return 'saved';
  }

  /**
   * Capture storage was turned off before any of this observation's files
   * were published. Record that honestly ("Not saved") instead of `on`.
   */
  markCaptureNotSaved(frameId: number): void {
    const id = this.frameEntries.get(frameId);

    if (id) {
      this.db.prepare("UPDATE utterances SET capture_storage = 'off' WHERE id = ?").run(id);
    }
  }

  /**
   * Why this entry cannot be labeled from its original capture, or undefined
   * when it can. Called only while capture storage is on. The recorded state
   * comes first (`HistoryEntry.labelingUnavailable`): an entry recorded with
   * storage off never qualifies, even if storage is on now (no backfill).
   * Then the files themselves: the original screenshot must be a complete
   * PNG, and spoken input also needs a complete WAV. Typed input has no WAV,
   * and rows from before capture storage (unknown input) are only held to
   * the screenshot, because typed and spoken rows cannot be told apart there.
   */
  async labelingUnavailable(id: string): Promise<OriginalProblem | undefined> {
    const entry = this.find(id);
    if (!entry) {
      return { reason: 'Utterance not found', screenshot: false };
    }
    if (entry.captureStorage === 'off' || entry.screenshotSaved === false) {
      return { reason: entry.labelingUnavailable!, screenshot: entry.screenshotUnavailable };
    }

    const directory = dirname(this.path);
    const png = await readOriginal(artifactPath(directory, id, entry.observedAt, 'screenshots'));
    if (!png || !completePng(png)) {
      return { reason: screenshotUnavailableReason, screenshot: true };
    }

    if (entry.inputKind === 'speech') {
      if (entry.audioSaved === false) {
        return { reason: entry.labelingUnavailable!, screenshot: false };
      }
      const wav = await readOriginal(artifactPath(directory, id, entry.observedAt, 'audio'));
      if (!wav || !completeWav(wav)) {
        return { reason: audioUnavailableReason, screenshot: false };
      }
    }

    return undefined;
  }

  /** The row UUID of a frame that is still being processed. */
  entryId(frameId: number): string | undefined {
    return this.frameEntries.get(frameId);
  }

  /**
   * The utterance a spoken "label previous" command refers to: the preceding
   * non-label utterance, even across a restart. Use insertion order rather
   * than the wall clock, which can move backwards. Repeated feedback corrects
   * the same target instead of evaluating the labeling command itself.
   * Undefined when there is no eligible target; nothing is written.
   */
  previousLabelTarget(frameId: number): string | undefined {
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
    this.assertAvailable(id);
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
    this.assertAvailable(id);
    this.assertHasText(id);
    const entry = this.find(id);
    if (!entry) {
      throw Error('Utterance not found');
    }
    if (entry.screenshotUnavailable) {
      throw Error('The original screenshot is unavailable for this utterance');
    }
    const row = this.db
      .prepare('SELECT window_address, window_title FROM utterances WHERE id = ?')
      .get(id) as { window_address: string | null; window_title: string | null };
    const path = artifactPath(dirname(this.path), entry.id, entry.observedAt, 'screenshots');
    const png = await readOriginal(path);
    if (!png) {
      throw Error('The original screenshot is unavailable for this utterance');
    }
    // Reading the screenshot yields. Deletion may have begun or completed
    // since the first lookup; do not start a new agent from that stale read.
    this.assertAvailable(id);
    if (!this.find(id)) {
      throw Error('Utterance not found');
    }
    if (!completePng(png)) {
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
    this.assertAvailable(utteranceId);
    this.assertHasText(utteranceId);
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

const screenshotUnavailableReason = 'The original screenshot for this entry is unavailable';
const audioUnavailableReason = 'The original audio for this entry is unavailable';

/** Bound reads too: a damaged file must not allocate arbitrary memory. */
const maximumOriginalBytes = 256 * 1024 * 1024;

/** A bounded, regular saved original, or undefined when it cannot be used. */
async function readOriginal(path: string): Promise<Buffer | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const status = await file.stat();
    if (!status.isFile() || status.size === 0 || status.size > maximumOriginalBytes) {
      return undefined;
    }
    // Read only the declared size from this descriptor, even if another
    // process grows or replaces the path. A truncated read is unavailable.
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        return undefined;
      }
      offset += bytesRead;
    }
    return bytes;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}
