import { readFileSync } from 'node:fs';
import { legacyToolGroups, legacyToolSummary, legacyToolPage } from './legacy-tool-transcripts.ts';
import type { ToolPage, ToolPageRequest } from './tool-transcripts.ts';
import { mkdir, readFile, readdir, rename, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { attachment } from '../widgets/types.ts';
import type { Log } from '../core/frame.ts';
import {
  agentThinkingLevels,
  type AgentMessage,
  type AgentSession,
  type PreviousSession,
} from './types.ts';
import { toolCallLimit, ToolTranscripts } from './tool-transcripts.ts';
import { panelMessageLimit } from './transcript-limits.ts';
import { parseOrigin } from './agent-origin.ts';

const sessionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Companion's display transcript and screenshot accompany Pi's own resumable
 * conversation. Atomic replacement preserves the last complete snapshot if a
 * write is interrupted. Nothing is created during construction or inspection.
 */
export class SessionStore {
  private readonly writes = new Map<string, Promise<void>>();
  readonly tools: ToolTranscripts;
  constructor(private readonly directory: string) {
    this.tools = new ToolTranscripts(directory);
  }

  private path(id: string, extension: string): string {
    if (!sessionId.test(id)) {
      throw Error('Invalid saved session id');
    }

    return join(this.directory, `${id}.${extension}`);
  }

  async screenshot(id: string, png: Buffer): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id, 'png');
    await this.replace(path, png);
    return pathToFileURL(path).href;
  }

  private async replace(path: string, content: string | Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async save(session: AgentSession): Promise<void> {
    // Capture one coherent view before yielding to filesystem operations. URLs
    // are derived when reading; the saved file cannot redirect image loading.
    const hasLegacyTools = session.messages.some((message) => message.toolGroup?.legacy);
    const content = JSON.stringify(session, (key, value: unknown) =>
      [
        'screenshotUrl',
        'viewUrl',
        'choices',
        'runId',
        'toolEpoch',
        'acceptsFollowUp',
        'completedTurnId',
        'openInBackground',
      ].includes(key)
        ? undefined
        : value,
    );
    // Capture order is write order, including widget clicks racing the end of
    // an agent turn. An older snapshot cannot replace a newer one afterward.
    const previous = this.writes.get(session.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        let savedContent = content;
        if (hasLegacyTools) {
          // If migration failed, preserve the original inline records on disk.
          // Read inside the serialized save queue, never retain them in a live
          // session or overwrite the only copy with a body-free placeholder.
          const original = JSON.parse(
            await readFile(this.path(session.id, 'json'), 'utf8'),
          ) as AgentSession;
          const sources = legacyToolGroups(session.id, original.messages);
          const captured = JSON.parse(content) as AgentSession;
          captured.messages = captured.messages.flatMap((message) => {
            if (!message.toolGroup?.legacy) return [message];
            const entries = sources.get(message.id);
            if (
              !entries ||
              legacyToolSummary(session.id, entries).toolGroup!.revision !==
                message.toolGroup.revision
            ) {
              throw Error('Legacy tool archive changed; reopen before saving');
            }
            return entries;
          });
          savedContent = JSON.stringify(captured);
        }
        await this.replace(this.path(session.id, 'json'), savedContent + '\n');
      });
    this.writes.set(session.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(session.id) === write) {
        this.writes.delete(session.id);
      }
    }
  }

  async read(id: string): Promise<AgentSession> {
    const value: unknown = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'));
    if (!value || typeof value !== 'object') {
      throw Error('Invalid saved conversation');
    }
    const session = value as AgentSession;
    const statuses = ['starting', 'running', 'completed', 'cancelled', 'error'];
    if (
      session.id !== id ||
      typeof session.title !== 'string' ||
      typeof session.model !== 'string' ||
      typeof session.error !== 'string' ||
      !statuses.includes(session.status) ||
      (session.profile !== undefined && !['coding', 'quickQuestion'].includes(session.profile)) ||
      (session.modelOverride !== undefined &&
        (typeof session.modelOverride !== 'string' ||
          !session.modelOverride.includes('/') ||
          session.modelOverride.length > 300)) ||
      (session.thinkingOverride !== undefined &&
        !agentThinkingLevels.includes(session.thinkingOverride)) ||
      !Number.isFinite(session.updatedAt) ||
      !Array.isArray(session.messages) ||
      session.messages.length > panelMessageLimit + toolCallLimit
    ) {
      throw Error('Invalid saved conversation');
    }

    let screenshotUrl: string | undefined;
    try {
      await access(this.path(id, 'png'));
      screenshotUrl = pathToFileURL(this.path(id, 'png')).href;
    } catch {
      // A missing attachment must not prevent reopening the conversation.
    }
    let messages = session.messages.map((message: AgentMessage): AgentMessage => {
      if (
        !message ||
        typeof message.id !== 'string' ||
        typeof message.text !== 'string' ||
        typeof message.input !== 'string' ||
        typeof message.toolName !== 'string' ||
        typeof message.screenshot !== 'boolean' ||
        !['user', 'assistant', 'tool', 'notice'].includes(message.kind) ||
        !['queued', 'running', 'done', 'error'].includes(message.state)
      ) {
        throw Error('Invalid saved message');
      }
      // Never trust an arbitrary file/remote URL from serialized chat content.
      const restored: AgentMessage = {
        id: message.id,
        kind: message.kind,
        text: message.text,
        toolName: message.toolName,
        input: message.input,
        screenshot: message.screenshot,
        // Queued messages are display history, never instructions to replay
        // after reopening a tab or restarting Companion.
        state: ['queued', 'running'].includes(message.state) ? 'error' : message.state,
      };
      if (message.kind === 'tool' && message.toolGroup) {
        const group = message.toolGroup;
        if (
          !sessionId.test(message.id) ||
          !Number.isSafeInteger(group.count) ||
          group.count < 1 ||
          group.count > toolCallLimit ||
          typeof group.revision !== 'string' ||
          !sessionId.test(group.revision)
        ) {
          throw Error('Invalid saved tool group');
        }
        // Retain a content-free fallback so a missing detail database cannot
        // hide ordinary answers, screenshots or widgets in this conversation.
        return {
          ...restored,
          text: '',
          input: '',
          toolName: '',
          screenshot: false,
          toolGroup: { count: group.count, revision: group.revision },
        };
      }
      if (message.screenshot && message.kind === 'user' && screenshotUrl) {
        restored.screenshotUrl = screenshotUrl;
      }

      // Agent provenance must survive reopening; an invalid label is dropped
      // rather than shown, and the text remains an ordinary saved message.
      const origin = message.kind === 'user' ? parseOrigin(message.origin) : undefined;
      if (origin) {
        restored.origin = origin;
      }

      if (message.widget && message.kind === 'assistant') {
        try {
          restored.widget = attachment(message.widget);
        } catch {
          // A damaged visual retains its ordinary readable text fallback.
        }
      }
      return restored;
    });
    // Migrate legacy inline tools without rewriting the original archive. A
    // later normal save persists compact groups; a failed migration leaves the
    // original JSON intact and readable by the old version.
    const grouped: AgentMessage[] = [];
    const legacyGroups = legacyToolGroups(id, messages);
    const legacyByFirst = new Map(
      [...legacyGroups.values()].map((entries) => [entries[0].id, entries]),
    );
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const entries = legacyByFirst.get(message.id);
      if (!entries || message.kind !== 'tool' || message.toolGroup) {
        grouped.push(message);
        continue;
      }
      const fallback = legacyToolSummary(id, entries);
      try {
        const groupId = this.tools.groupFor(id, entries[0].id) ?? fallback.id;
        let summary = fallback;
        for (const entry of entries) {
          summary = this.tools.put(id, entry, groupId);
        }
        grouped.push(summary);
      } catch {
        // Storage failure must not hide a legacy conversation. Its original
        // JSON still owns every byte; expansion reads it only when requested.
        grouped.push(fallback);
      }
      index += entries.length - 1;
    }
    if (grouped.length > panelMessageLimit) {
      throw Error('Invalid saved conversation');
    }
    let toolRecoveryFailed = false;
    if (grouped.some((message) => message.toolGroup && !message.toolGroup.legacy)) {
      try {
        this.tools.stop(id);
      } catch {
        toolRecoveryFailed = true;
      }
    }
    messages = grouped.map((message) => {
      if (!message.toolGroup || message.toolGroup.legacy) {
        return message;
      }
      try {
        const summary = this.tools.summary(id, message.id);
        return toolRecoveryFailed ? { ...summary, state: 'error' as const } : summary;
      } catch {
        // Expansion reports the storage error; the surrounding chat stays
        // readable. Keep the reference for recovery if its database returns.
        return { ...message, toolGroup: { ...message.toolGroup, unavailable: true } };
      }
    });
    if (session.status === 'starting' || session.status === 'running') {
      session.status = 'cancelled';
      session.error = 'Companion stopped before this answer finished.';
    }
    return {
      id,
      title: session.title,
      status: session.status,
      model: session.model,
      ...(session.profile !== undefined ? { profile: session.profile } : {}),
      ...(session.modelOverride !== undefined ? { modelOverride: session.modelOverride } : {}),
      ...(session.thinkingOverride !== undefined
        ? { thinkingOverride: session.thinkingOverride }
        : {}),
      error: session.error,
      updatedAt: session.updatedAt,
      messages,
    };
  }

  legacyPage(request: ToolPageRequest): ToolPage {
    // This fallback is only for existing legacy JSON when migration cannot
    // write SQLite. Parsing is temporary; ordinary snapshots remain body-free.
    const original = JSON.parse(
      readFileSync(this.path(request.id, 'json'), 'utf8'),
    ) as AgentSession;
    const entries = legacyToolGroups(request.id, original.messages).get(request.groupId);
    if (original.id !== request.id || !entries) {
      throw Error('Legacy tool details are unavailable');
    }
    return legacyToolPage(request, entries);
  }

  async previous(log: Log): Promise<PreviousSession[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const entries: PreviousSession[] = [];
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (!file.endsWith('.json') || !sessionId.test(id)) {
        continue;
      }
      try {
        const { messages: _messages, ...summary } = await this.read(id);
        entries.push(summary);
      } catch (error) {
        // One damaged file should not hide every other saved conversation.
        log('agent-history', `Could not load ${file}: ${String(error)}`);
      }
    }
    return entries;
  }
}
