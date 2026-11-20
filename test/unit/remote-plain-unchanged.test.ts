import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';

import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';

/**
 * A remote connection that does not ask for drafts receives exactly the
 * events and answers it received before remote draft hosts existed.
 *
 * One scripted session: a desktop editor and a remote draft host type, an
 * agent proposes drafts and the draft host sends, while a connection without
 * `drafts` reports its page, tries the draft-only fields and actions, sends a
 * follow-up and reads the model catalogue. Everything that connection
 * receives is recorded, with values that differ between runs (conversation
 * IDs, times, revisions) replaced by stable placeholders, and compared with
 * the transcript the same script produced on the base revision (3b7b115),
 * stored in test/fixtures/remote-plain-transcript.json. Set
 * COMPANION_WRITE_TRANSCRIPT=1 to record it again; only ever do that on a
 * revision whose behavior is the reference.
 *
 * The draft host's own connection is opened by hand (not through the
 * fixture's helper) so the script also runs unchanged on the base revision,
 * where `drafts` in `auth` is ignored.
 */

const transcriptPath = new URL('../fixtures/remote-plain-transcript.json', import.meta.url);

type Message = Record<string, any>;

/** Keys whose values are times, durations or opaque revisions. */
const volatileKeys = new Set([
  'listenerTime',
  'createdAt',
  'updatedAt',
  'savedAt',
  'closedAt',
  'startedAt',
  'turnStartedAt',
  'lastTurnDurationMs',
  'durationMs',
  'revision',
  'sessionOrderRevision',
  'epoch',
  'deviceId',
  'turnId',
  'runId',
  'timestamp',
  'time',
]);

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replace run-specific values with placeholders, numbering IDs by first use. */
function normalize(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(uuidPattern, (id) => {
      if (!ids.has(id)) {
        ids.set(id, `<id-${ids.size + 1}>`);
      }
      return ids.get(id)!;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, ids));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] =
        volatileKeys.has(key) && item !== undefined ? '<volatile>' : normalize(item, ids);
    }
    return result;
  }
  return value;
}

/** Resolve once no new message has arrived for `quietMilliseconds`. */
async function settled(messages: unknown[], quietMilliseconds = 250): Promise<void> {
  let count = -1;
  while (count !== messages.length) {
    count = messages.length;
    await new Promise((resolve) => setTimeout(resolve, quietMilliseconds));
  }
}

test('a remote connection without drafts receives exactly what it received before', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());

  const a = fixture.sessions.start({ ...frame, utterance: 'Conversation A' }, signal());
  const b = fixture.sessions.start({ ...frame, utterance: 'Conversation B' }, signal());
  await fixture.sessions.idle();
  const { token } = await fixture.pair();

  // A desktop editor that hosts drafts.
  const desktop = createConnection(fixture.desktop.socketPath);
  context.after(() => desktop.destroy());
  await once(desktop, 'connect');
  const toDesktop = (request: object) => desktop.write(JSON.stringify(request) + '\n');
  toDesktop({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });

  // A remote draft host (on the base revision `drafts` is ignored).
  const host = new WebSocket(`ws://127.0.0.1:${fixture.port}/api/socket`, {
    headers: { Origin: fixture.origin },
  });
  context.after(() => host.terminate());
  await once(host, 'open');
  host.send(JSON.stringify({ type: 'auth', token, drafts: true }));
  const toHost = (request: object) => host.send(JSON.stringify({ type: 'request', ...request }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  toHost({ requestId: 'h-report', action: 'panel-state', id: '', visible: false });

  // The connection under test.
  const plain: PhoneClient = await fixture.phone(token);
  await plain.engine('state');
  const ask = async (requestId: string, request: object) => {
    plain.send({ requestId, ...request });
    await plain.reply(requestId);
    await settled(plain.messages);
  };
  // `reply` removes answers from `messages`; record everything as it arrives.
  const received: Message[] = [];
  plain.socket.on('message', (data) => received.push(JSON.parse(String(data))));
  const before = [...plain.messages];

  await ask('report', { action: 'panel-state', id: a, visible: true });

  // Draft activity elsewhere.
  toDesktop({ action: 'draft-set', id: a, text: 'typed at the desk', editId: 'd1' });
  toHost({ requestId: 'h-edit', action: 'draft-set', id: b, text: 'typed remotely', editId: 'h1' });
  const draft = (fixture.sessions as any).draftFromAgent.bind(fixture.sessions);
  const origin = { kind: 'agent', sessionId: b, title: 'Planner', depth: 1 };
  await draft(
    { id: a, text: 'agent idea', ifDraftExists: 'append', focus: true, origin },
    signal(),
  );
  await draft(
    { id: b, text: 'agent idea', ifDraftExists: 'reject', focus: false, origin },
    signal(),
  );
  toHost({ requestId: 'h-send', action: 'send-agent', id: b, text: 'typed remotely' });
  await fixture.sessions.idle();
  await settled(plain.messages);

  // Draft-only requests from the connection without drafts.
  await ask('draft-set', { action: 'draft-set', id: a, text: 'mine', editId: 'p1' });
  await ask('pending', { action: 'panel-state', id: a, visible: true, pendingSend: a });
  await ask('host', { action: 'panel-state', id: a, visible: true, draftHost: true });

  // Ordinary use.
  await ask('send', { action: 'send-agent', id: a, text: 'typed at the desk' });
  await fixture.sessions.idle();
  await ask('models', { action: 'agent-models' });
  await settled(plain.messages);

  const ids = new Map<string, string>();
  const transcript = normalize([...before, ...received], ids);

  if (process.env.COMPANION_WRITE_TRANSCRIPT === '1') {
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');
    return;
  }
  const expected = JSON.parse(await readFile(transcriptPath, 'utf8'));
  assert.deepEqual(transcript, expected);
  // The script reached the connection: it is not an empty comparison.
  await waitFor(() => received.length > 5);
});
