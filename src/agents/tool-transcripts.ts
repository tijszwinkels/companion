import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { chatMessage, type AgentMessage } from './types.ts';

// A page's worst-case JSON escaping is below 50 KiB, well below the desktop
// socket's 2 MiB backpressure threshold. Only one page is retained by the UI.
export const toolPageUnits = 8192;
// Tool storage admission is independent of ordinary history display paging.
// Reject explicitly before writing; never truncate a tool to fit this budget.
export const toolCallLimit = 100_000;
export const toolStorageBytes = 256 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface ToolPageRequest {
  id: string;
  groupId: string;
  epoch: string;
  revision: string;
  callRevision?: string;
  index: number;
  offset: number;
}

export interface ToolPage extends ToolPageRequest {
  callRevision: string;
  text: string;
  state: AgentMessage['state'];
  next: { index: number; offset: number } | null;
}

/**
 * Tool bodies live in private SQLite blobs, never in the session JSON or a
 * second in-memory transcript. The session manager coalesces running partials;
 * each actual write commits synchronously, and write failures fail its turn.
 * UTF-16LE preserves the exact JS strings (including NUL and lone surrogates).
 */
export class ToolTranscripts {
  private database?: DatabaseSync;
  constructor(private readonly directory: string) {}

  private db(): DatabaseSync {
    if (!this.database) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      const path = join(this.directory, 'tool-transcripts.sqlite');
      const db = new DatabaseSync(path);
      try {
        chmodSync(path, 0o600);
        db.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS tools (
          owner TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT NOT NULL,
          position INTEGER NOT NULL, state TEXT NOT NULL, body BLOB NOT NULL,
          revision TEXT NOT NULL,
          PRIMARY KEY (owner, id), UNIQUE (owner, group_id, position)
        );
        CREATE TABLE IF NOT EXISTS tool_groups (
          owner TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL,
          PRIMARY KEY (owner, id)
        );
      `);
        // Upgrade archives made by an earlier build of this feature without
        // rewriting their bodies. New writes receive independent call revisions.
        if (
          !db
            .prepare('PRAGMA table_info(tools)')
            .all()
            .some((column) => column.name === 'revision')
        ) {
          db.exec("ALTER TABLE tools ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
          db.prepare('UPDATE tools SET revision = ?').run(randomUUID());
        }
        this.database = db;
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return this.database;
  }

  groupFor(owner: string, id: string): string | undefined {
    return this.db().prepare('SELECT group_id FROM tools WHERE owner = ? AND id = ?').get(owner, id)
      ?.group_id as string | undefined;
  }

  put(owner: string, message: AgentMessage, groupId: string): AgentMessage {
    const db = this.db();
    const bodyBytes =
      (message.toolName.length + message.input.length + message.text.length + 4) * 2;
    const old = db
      .prepare('SELECT position, length(body) AS size FROM tools WHERE owner = ? AND id = ?')
      .get(owner, message.id);
    const used = db
      .prepare(
        'SELECT count(*) AS count, coalesce(sum(length(body)), 0) AS size FROM tools WHERE owner = ?',
      )
      .get(owner)!;
    if (!old && Number(used.count) >= toolCallLimit) {
      throw Error(
        'Tool detail storage limit (100,000 calls per conversation) reached. Full model history remains in Pi.',
      );
    }
    if (Number(used.size) - Number(old?.size ?? 0) + bodyBytes > toolStorageBytes) {
      throw Error(
        'Tool detail storage limit (256 MiB per conversation) reached. Full model history remains in Pi.',
      );
    }
    const body = Buffer.from(
      message.toolName + '\n\n' + message.input + '\n\n' + message.text,
      'utf16le',
    );
    const count = db
      .prepare('SELECT count(*) AS count FROM tools WHERE owner = ? AND group_id = ?')
      .get(owner, groupId)!;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO tools VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner, id) DO UPDATE SET state = excluded.state, body = excluded.body, revision = excluded.revision`,
      ).run(
        owner,
        message.id,
        groupId,
        Number(old?.position ?? count.count),
        message.state,
        body,
        randomUUID(),
      );
      db.prepare('INSERT OR REPLACE INTO tool_groups VALUES (?, ?, ?)').run(
        owner,
        groupId,
        randomUUID(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.summary(owner, groupId);
  }

  summary(owner: string, groupId: string): AgentMessage {
    if (!uuid.test(owner) || !uuid.test(groupId)) {
      throw Error('Invalid tool group');
    }
    if (!this.database && !existsSync(join(this.directory, 'tool-transcripts.sqlite'))) {
      throw Error('Tool details are unavailable');
    }
    const db = this.db();
    const group = db
      .prepare('SELECT revision FROM tool_groups WHERE owner = ? AND id = ?')
      .get(owner, groupId);
    const counts = db
      .prepare(
        `SELECT count(*) AS count,
      sum(state = 'running') AS running, sum(state = 'error') AS errors
      FROM tools WHERE owner = ? AND group_id = ?`,
      )
      .get(owner, groupId)!;
    if (!group || !counts.count) {
      throw Error('Tool details are unavailable');
    }
    return {
      ...chatMessage(groupId, 'tool', ''),
      state: counts.running ? 'running' : counts.errors ? 'error' : 'done',
      toolGroup: { count: Number(counts.count), revision: String(group.revision) },
    };
  }

  stop(owner: string): void {
    if (!this.database && !existsSync(join(this.directory, 'tool-transcripts.sqlite'))) {
      return;
    }
    const db = this.db();
    // Rotate revisions for interrupted calls so outstanding pages expire too.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE tool_groups SET revision = ? WHERE owner = ? AND id IN
        (SELECT group_id FROM tools WHERE owner = ? AND state = 'running')`,
      ).run(randomUUID(), owner, owner);
      db.prepare(
        "UPDATE tools SET state = 'error', revision = ? WHERE owner = ? AND state = 'running'",
      ).run(randomUUID(), owner);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  page(request: ToolPageRequest): ToolPage {
    const group = this.summary(request.id, request.groupId).toolGroup!;
    if (
      !Number.isSafeInteger(request.index) ||
      request.index < 0 ||
      request.index >= group.count ||
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      request.offset > toolStorageBytes / 2
    ) {
      throw Error('Invalid tool detail position');
    }
    const row = this.db()
      .prepare(
        `SELECT state, revision, length(body) / 2 AS units,
      substr(body, ?, ?) AS part FROM tools WHERE owner = ? AND group_id = ? AND position = ?`,
      )
      .get(request.offset * 2 + 1, toolPageUnits * 2, request.id, request.groupId, request.index)!;
    if (!row || request.offset >= Number(row.units)) {
      throw Error('Invalid tool detail offset');
    }
    if (
      request.callRevision
        ? request.callRevision !== row.revision
        : request.revision !== group.revision
    ) {
      throw Error('Tool output changed; reload this page');
    }
    let text = Buffer.from(row.part as Uint8Array).toString('utf16le');
    // Never split a surrogate pair at the outgoing page boundary.
    const last = text.charCodeAt(text.length - 1);
    if (request.offset + text.length < Number(row.units) && last >= 0xd800 && last <= 0xdbff) {
      text = text.slice(0, -1);
    }
    const offset = request.offset + text.length;
    const next =
      offset < Number(row.units)
        ? { index: request.index, offset }
        : request.index + 1 < group.count
          ? { index: request.index + 1, offset: 0 }
          : null;
    return {
      ...request,
      revision: group.revision,
      callRevision: String(row.revision),
      text,
      state: row.state as AgentMessage['state'],
      next,
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
