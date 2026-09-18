import { mkdir, readFile, readdir, rename, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { Log } from '../core/frame.ts';
import type { AgentMessage, AgentSession, PreviousSession } from './types.ts';

const sessionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Companion's display transcript and screenshot accompany Pi's own resumable
 * conversation. Atomic replacement preserves the last complete snapshot if a
 * write is interrupted. Nothing is created during construction or inspection.
 */
export class SessionStore {
  constructor(private readonly directory: string) {}

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
    const content = JSON.stringify(session, (key, value: unknown) =>
      key === 'screenshotUrl' ? undefined : value,
    );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.replace(this.path(session.id, 'json'), content + '\n');
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
      !Number.isFinite(session.updatedAt) ||
      !Array.isArray(session.messages) ||
      session.messages.length > 200
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
    const messages = session.messages.map((message: AgentMessage): AgentMessage => {
      if (
        !message ||
        typeof message.id !== 'string' ||
        typeof message.text !== 'string' ||
        typeof message.input !== 'string' ||
        typeof message.toolName !== 'string' ||
        typeof message.screenshot !== 'boolean' ||
        !['user', 'assistant', 'tool', 'notice'].includes(message.kind) ||
        !['running', 'done', 'error'].includes(message.state)
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
        state: message.state === 'running' ? 'error' : message.state,
      };
      if (message.screenshot && message.kind === 'user' && screenshotUrl) {
        restored.screenshotUrl = screenshotUrl;
      }

      return restored;
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
      error: session.error,
      updatedAt: session.updatedAt,
      messages,
    };
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
