import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseOrigin } from '../agent-origin.ts';
import {
  maximumLeadMilliseconds,
  nextOccurrence,
  seriesContinues,
  validRecurrence,
  withReason,
} from './recurrence.ts';
import { unstarted, wakeStates, type WakeRecord } from './types.ts';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * Small synchronous transactions give mutations and dispatch one ordering point
 * on the session event loop. FULL SQLite commits precede acknowledgements.
 * A kernel lock lives with this process, including through a crashed child.
 */
export class WakeStore {
  private database?: DatabaseSync;
  private lock?: number;

  constructor(
    private readonly directory: string,
    private readonly warning: (text: string) => void,
  ) {}

  open(now: number): void {
    if (this.database) {
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(this.directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.uid !== process.getuid!() ||
      (directoryStat.mode & 0o777) !== 0o700
    ) {
      throw Error('Wake directory must be a private owned directory');
    }
    try {
      this.lock = this.privateFile('owner.lock');
      const lock = spawnSync('flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', this.lock],
        timeout: 2000,
      });
      if (lock.status !== 0) {
        throw Error('Wake store already owned, or flock unavailable');
      }
      const file = this.privateFile('timers.sqlite');
      closeSync(file);
      const db = new DatabaseSync(join(this.directory, 'timers.sqlite'));
      this.database = db;
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quarantine (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admissions (id TEXT PRIMARY KEY, timer TEXT NOT NULL, turn TEXT NOT NULL);`);
      // Preserve the new database/directory names as well as SQLite's synced
      // contents before a schedule can be acknowledged.
      for (const path of [this.directory, dirname(this.directory)]) {
        const fd = openSync(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      let quarantined = 0;
      this.transaction(() => {
        // First set malformed rows aside, so the conversion below (which may
        // look up other occurrences of a series) only reads valid records.
        const valid: WakeRecord[] = [];
        for (const row of db.prepare('SELECT id, body FROM timers').all()) {
          let record: WakeRecord;
          try {
            record = validateRecord(JSON.parse(String(row.body)));
            if (record.id !== row.id) {
              throw Error('Mismatched timer identity');
            }
          } catch {
            db.prepare('INSERT OR REPLACE INTO quarantine VALUES (?, ?)').run(row.id, row.body);
            db.prepare('DELETE FROM timers WHERE id=?').run(row.id);
            quarantined++;
            continue;
          }
          valid.push(record);
        }
        // A claimed occurrence whose outcome was never saved is uncertain. A
        // repeating series still moves on to its next future slot.
        for (const record of valid) {
          if (record.state === 'dispatching' || record.state === 'started') {
            this.finish(
              {
                ...record,
                state: 'delivery-uncertain',
                reason: 'Listener stopped across dispatch; never replayed automatically',
                revision: record.revision + 1,
                transitionedAt: now,
              },
              now,
              false,
            );
          }
        }
      });
      if (quarantined) {
        this.warning(`${quarantined} malformed wake records quarantined; none will run.`);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private privateFile(name: string): number {
    const fd = openSync(
      join(this.directory, name),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    ) {
      closeSync(fd);
      throw Error('Unsafe wake store file');
    }
    return fd;
  }

  transaction<T>(action: () => T): T {
    const db = this.database!;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  all(): WakeRecord[] {
    return this.database!.prepare('SELECT body FROM timers')
      .all()
      .map((row) => validateRecord(JSON.parse(String(row.body))));
  }

  get(id: string): WakeRecord | undefined {
    const row = this.database!.prepare('SELECT body FROM timers WHERE id=?').get(id);
    return row ? validateRecord(JSON.parse(String(row.body))) : undefined;
  }

  put(record: WakeRecord): void {
    this.database!.prepare('INSERT OR REPLACE INTO timers VALUES (?, ?)').run(
      record.id,
      JSON.stringify(record),
    );
  }

  /**
   * Save an occurrence's terminal state. When it continues a repeating series,
   * also insert the series' next occurrence. Must run inside `transaction()`:
   * the terminal state and the successor commit together, so a crash can
   * neither lose the successor nor, through a repeated transition, create two.
   *
   * `endSeries` stops a series even from a state that would otherwise continue.
   * An occurrence that ends its series says so in its reason. Returns the
   * successor, if one was created, for the caller to publish.
   */
  finish(record: WakeRecord, now: number, endSeries: boolean): WakeRecord | undefined {
    if (!record.recurrence) {
      this.put(record);
      return undefined;
    }

    if (!seriesContinues(record, endSeries)) {
      const clause = record.cancellationRequested
        ? 'series ended (cancelled during this run)'
        : 'series ended';
      this.put({ ...record, reason: withReason(record.reason, clause) });
      return undefined;
    }

    // Defensive: a series never has two live occurrences, even if an earlier
    // version or a manual edit left one behind.
    if (this.otherLiveOccurrence(record)) {
      this.put(record);
      return undefined;
    }

    const successor = nextOccurrence(record, now);
    if (!successor) {
      const clause = 'series ended: the clock moved too far back for a valid next slot';
      this.put({ ...record, reason: withReason(record.reason, clause) });
      return undefined;
    }

    this.put(record);
    this.put(successor);
    return successor;
  }

  private otherLiveOccurrence(record: WakeRecord): boolean {
    const seriesId = record.recurrence!.seriesId;
    return this.all().some((other) => {
      if (other.id === record.id || other.recurrence?.seriesId !== seriesId) {
        return false;
      }
      return unstarted(other) || other.state === 'dispatching' || other.state === 'started';
    });
  }

  /** All stored occurrences of one owner's series, oldest first. */
  series(owner: string, seriesId: string): WakeRecord[] {
    return this.all()
      .filter((record) => record.owner === owner && record.recurrence?.seriesId === seriesId)
      .sort((first, second) => first.recurrence!.occurrence - second.recurrence!.occurrence);
  }

  receipt(id: string): Record<string, unknown> | undefined {
    const row = this.database!.prepare('SELECT body FROM receipts WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }

  saveReceipt(id: string, owner: string, receipt: Record<string, unknown>): void {
    this.database!.prepare('INSERT INTO receipts VALUES (?, ?, ?)').run(
      id,
      owner,
      JSON.stringify(receipt),
    );
  }

  /** Claim and turn admission are durable together, before any backend call. */
  claim(record: WakeRecord, now: number): WakeRecord | undefined {
    return this.transaction(() => {
      const current = this.get(record.id);
      if (
        !current ||
        current.revision !== record.revision ||
        !unstarted(current) ||
        now < current.dueAt ||
        now > current.expiresAt
      ) {
        return undefined;
      }
      const claim: WakeRecord = {
        ...current,
        state: 'dispatching',
        revision: current.revision + 1,
        transitionedAt: now,
        reason: '',
        turnId: randomUUID(),
        attemptId: randomUUID(),
      };
      this.put(claim);
      this.database!.prepare('INSERT INTO admissions VALUES (?, ?, ?)').run(
        claim.attemptId!,
        claim.id,
        claim.turnId!,
      );
      return claim;
    });
  }

  /** Retain bounded diagnostics without limiting how many future wakes may run. */
  prune(owner: string): void {
    const terminal = this.all()
      .filter(
        (record) =>
          record.owner === owner &&
          !unstarted(record) &&
          record.state !== 'dispatching' &&
          record.state !== 'started',
      )
      .sort((a, b) => b.transitionedAt - a.transitionedAt);
    for (const record of terminal.slice(100)) {
      this.database!.prepare('DELETE FROM timers WHERE id=?').run(record.id);
      this.database!.prepare('DELETE FROM admissions WHERE timer=?').run(record.id);
    }
    // At most six mutations per active turn: this cannot evict a live lease's
    // receipt, even after many successor turns under the same purpose key.
    this.database!.prepare(
      'DELETE FROM receipts WHERE owner=? AND rowid NOT IN (SELECT rowid FROM receipts WHERE owner=? ORDER BY rowid DESC LIMIT 1000)',
    ).run(owner, owner);
    this.database!.exec(
      'DELETE FROM quarantine WHERE rowid NOT IN (SELECT rowid FROM quarantine ORDER BY rowid DESC LIMIT 100)',
    );
  }

  deleteOwner(owner: string): void {
    this.transaction(() => {
      for (const record of this.all().filter((record) => record.owner === owner)) {
        this.database!.prepare('DELETE FROM admissions WHERE timer=?').run(record.id);
        this.database!.prepare('DELETE FROM timers WHERE id=?').run(record.id);
      }
      this.database!.prepare('DELETE FROM receipts WHERE owner=?').run(owner);
      // Quarantined content cannot be safely assigned; erase it on data deletion.
      this.database!.exec('DELETE FROM quarantine');
    });
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    if (this.lock !== undefined) {
      closeSync(this.lock);
      this.lock = undefined;
    }
  }
}

function validateRecord(value: unknown): WakeRecord {
  const record = value as WakeRecord;
  // Version 1 is a one-shot without recurrence; version 2 must carry one.
  const versionMatchesShape =
    !!record &&
    ((record.version === 1 && record.recurrence === undefined) ||
      (record.version === 2 && validRecurrence(record, uuid)));
  if (
    !record ||
    !versionMatchesShape ||
    !uuid.test(record.id) ||
    !uuid.test(record.owner) ||
    !uuid.test(record.schedulingTurn) ||
    typeof record.receipt !== 'string' ||
    !record.receipt ||
    typeof record.label !== 'string' ||
    !record.label.trim() ||
    record.label.length > 120 ||
    typeof record.message !== 'string' ||
    !record.message.trim() ||
    record.message.length > 4000 ||
    !['pi', 'claude-code'].includes(record.harness) ||
    !wakeStates.includes(record.state) ||
    !Number.isInteger(record.depth) ||
    record.depth < 0 ||
    record.depth > 16 ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    ![record.createdAt, record.dueAt, record.expiresAt, record.transitionedAt].every(
      Number.isFinite,
    ) ||
    record.dueAt - record.createdAt < 60_000 ||
    record.dueAt - record.createdAt > maximumLeadMilliseconds(record.recurrence) ||
    record.expiresAt - record.dueAt < 1000 ||
    record.expiresAt - record.dueAt > 86400_000 ||
    !Number.isFinite(new Date(record.expiresAt).getTime()) ||
    typeof record.reason !== 'string' ||
    record.reason.length > 600 ||
    (record.key !== undefined &&
      (typeof record.key !== 'string' || !record.key || record.key.length > 120)) ||
    (record.ancestry !== undefined && !parseOrigin(record.ancestry)) ||
    ((record.state === 'dispatching' || record.state === 'started') &&
      (!uuid.test(record.turnId ?? '') || !uuid.test(record.attemptId ?? '')))
  ) {
    throw Error('Malformed wake record');
  }
  return record;
}
