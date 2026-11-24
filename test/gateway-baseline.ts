/**
 * A normalized recording of what a gateway without frame options sends: HTTP
 * responses (status, every header except Date, body) for a fixed set of
 * requests, and the relay's messages to a phone for a fixed scenario with a
 * widget, an application, an action and a history page.
 *
 * `test/fixtures/gateway-base-output.json` holds this recording made on the
 * revision before the frame origin existed (see that file's `recordedOn`).
 * `test/unit/remote-frames-headers.test.ts` records the current code the same
 * way and requires an identical result. To re-record on another revision:
 *
 *   npx tsx test/gateway-baseline.ts > test/fixtures/gateway-base-output.json
 *
 * Volatile values (UUIDs, 64-hex capabilities, ports, temporary paths, clock
 * readings, random revision strings) are replaced by placeholders so that two
 * runs of the same code compare equal.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { frameFixture } from './frame-fixture.ts';

type Json = Record<string, any>;

export interface GatewayRecording {
  http: Array<{ request: string; status: number; headers: string[][]; body: string }>;
  relay: { snapshot: unknown; event: unknown; historyPage: unknown };
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replace run-specific values with placeholders, recursively. */
export function normalize(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>')
      .replace(uuid, '<uuid>')
      .replace(/\b[0-9a-f]{64}\b/g, '<hex64>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\b[0-9a-f]{16,63}\b/g, '<hex>');
  }
  if (typeof value === 'number' && /(Time|At|Ms|Milliseconds)$/.test(key)) {
    return '<number>';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, key));
  }
  if (value && typeof value === 'object') {
    const result: Json = {};
    for (const [name, entry] of Object.entries(value)) {
      result[name] = normalize(entry, name);
    }
    return result;
  }
  return value;
}

/** Record a gateway started without frame options. */
export async function recordGateway(
  options: { allowMicrophone?: boolean } = {},
): Promise<GatewayRecording> {
  const appDirectory = await mkdtemp(join(tmpdir(), 'companion-baseline-app-'));
  await writeFile(join(appDirectory, 'index.html'), '<!doctype html><title>App</title>');
  await writeFile(join(appDirectory, 'app.js'), 'console.log(1);\n');
  const fixture = await frameFixture({ frames: false, appDirectory, ...options });

  try {
    const http: GatewayRecording['http'] = [];
    const record = async (name: string, path: string, init: RequestInit = {}) => {
      const response = await fetch(fixture.origin + path, { redirect: 'manual', ...init });
      const headers = [...response.headers.entries()]
        .filter(([header]) => header !== 'date')
        .map(([header, value]) => [header, String(normalize(value))]);
      http.push({
        request: name,
        status: response.status,
        headers,
        body: String(normalize(await response.text())),
      });
    };

    await record('GET /', '/');
    await record('GET /app.js', '/app.js');
    await record('GET /missing.js', '/missing.js');
    await record('GET /f/<handle>/', `/f/${'a'.repeat(43)}/`);
    await record('GET /f/<handle>/state', `/f/${'a'.repeat(43)}/state`);
    await record('GET /api/pair', '/api/pair');
    await record('POST /api/pair without Origin', '/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await record('GET /api/apps without token', '/api/apps');
    await record('GET /api/screenshots/x without token', '/api/screenshots/x');
    await record('GET /api/unknown', '/api/unknown');
    await record('DELETE /', '/', { method: 'DELETE' });

    // The relay: a conversation with a widget and an application.
    const { id, run } = await fixture.conversation();
    const widgetId = await fixture.publishCounter(run);
    await fixture.applyNotes(run);
    const { token } = await fixture.pair();
    const phone = await fixture.phone(token, fixture.origin, true);
    const snapshot = await phone.engine('state', (message) =>
      message.sessions?.some(
        (session: Json) =>
          session.id === id &&
          session.application &&
          session.messages.some((row: Json) => row.widget?.id === widgetId),
      ),
    );

    // A widget action through the listener's own loopback view (the desktop
    // path), observed by the phone as an incremental event.
    const viewUrl = fixture.sessions
      .snapshot()
      .find((session) => session.id === id)!
      .messages.find((row) => row.widget?.id === widgetId)!.widget!.viewUrl!;
    const action = await fetch(viewUrl + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'increment', args: {}, requestId: 'baseline' }),
    });
    await action.arrayBuffer();
    const event = await phone.engine('agent-session', (message) =>
      message.session.messages.some((row: Json) => row.widget?.revision === 2),
    );

    phone.send({ requestId: 'select', action: 'panel-state', id });
    await phone.reply('select');
    const session = snapshot.sessions.find((entry: Json) => entry.id === id);
    phone.send({
      requestId: 'page',
      action: 'agent-history-page',
      id,
      epoch: session.toolEpoch,
      direction: 'after',
      index: 0,
      offset: 0,
    });
    const historyPage = await phone.reply('page');

    return {
      http,
      relay: {
        snapshot: normalize(session),
        event: normalize(event),
        historyPage: normalize(historyPage),
      },
    };
  } finally {
    await fixture.close();
    await rm(appDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const recording = await recordGateway();
  process.stdout.write(
    JSON.stringify(
      { recordedOn: process.env.BASELINE_REVISION ?? 'unknown', ...recording },
      null,
      2,
    ) + '\n',
  );
}
