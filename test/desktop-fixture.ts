import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { PauseControl } from '../src/core/pause-control.ts';
import { DesktopRuntime } from '../src/desktop/runtime.ts';
import type { RunCommand } from '../src/sensors/screen/capture.ts';
import { frame } from './helpers.ts';
import type { AgentSessions } from '../src/agents/sessions.ts';
import type { AgentSession } from '../src/agents/types.ts';

export interface DesktopMessage {
  type: string;
  action?: string;
  result?: string;
  message?: string;
  soundsEnabled?: boolean;
  history?: { id: string; utterance: string }[];
  sessions?: AgentSession[];
  session?: AgentSession;
}

export async function waitFor(check: () => boolean, milliseconds = 2000): Promise<void> {
  const until = Date.now() + milliseconds;

  while (!check()) {
    assert.ok(Date.now() < until, 'Timed out waiting for fixture state');
    await delay(5);
  }
}

export function stopped(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function windowReply(address = frame.screenshot.window.address): Buffer {
  return Buffer.from(
    JSON.stringify({
      address,
      class: 'fixture',
      title: 'Disposable field',
      at: [0, 0],
      size: [600, 400],
      mapped: true,
      hidden: false,
    }),
  );
}

/** Real private socket/SQLite, injected desktop commands, and no microphone. */
export async function desktopFixture(run: RunCommand, agents?: AgentSessions) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-regression-'));
  const path = join(directory, 'control.sock');
  const databasePath = join(directory, 'utterances.sqlite');
  const controller = new AbortController();
  const pause = new PauseControl();
  const runtime = new DesktopRuntime(
    pause,
    () => {},
    controller.signal,
    { database: databasePath, socket: path, preview: false, sounds: false, agents },
    run,
  );
  await runtime.start();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const client = createConnection(path);
  const messages: DesktopMessage[] = [];
  let buffered = '';
  client.setEncoding('utf8');
  client.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;

    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(client, 'connect');

  return {
    client,
    socketPath: path,
    runtime,
    pause,
    controller,
    database,
    messages,
    seed(id = frame.id) {
      runtime.activity.transcribed?.({ ...frame, id });
      return database.prepare('SELECT id FROM utterances ORDER BY rowid DESC LIMIT 1').get()!.id;
    },
    send(request: object) {
      client.write(JSON.stringify(request) + '\n');
    },
    async reply(action: string, milliseconds = 2000) {
      const matches = (message: DesktopMessage) => {
        return message.action === action && ['result', 'error'].includes(message.type);
      };
      await waitFor(() => messages.some(matches), milliseconds);
      const index = messages.findIndex(matches);
      return messages.splice(index, 1)[0];
    },
    async close() {
      controller.abort();
      await agents?.close();
      client.destroy();
      await runtime.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
