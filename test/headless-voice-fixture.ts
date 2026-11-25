// A Companion without a desktop that listens through a paired browser, for
// the voice rows of "Running without a desktop" (src/desktop/README.md).
//
// The real listener (`src/cli.ts --headless`) and the real gateway run as
// child processes on a machine without desktop programs
// (test/headless-fixture.ts). The browser is a WebSocket client paired with
// a code from `companion-remote pair`, with two tabs (connections) of one
// device: the listening tab streams sound like a browser's Listen here, the
// other tab only shows a conversation.
//
// The sound is real speech, the first 0.6 s of the public fixture
// test/fixtures/speech.wav followed by silence, so the real Silero voice
// detector in the listener finds exactly one utterance in it. The words are
// the test recogniser's: it answers with the phrase the case chose. The
// agent is the synthetic Claude Code. With `intentModel`, a synthetic
// OpenAI-compatible model on loopback answers the intent requests: the
// follow-up intent when it is offered, IGNORE otherwise; its requests are
// kept for inspection.
//
// Every wait is for the state it means. The only timer is the microphone's
// own: it sends 100 ms of sound every 100 ms, as a browser does, with
// silence between utterances.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { waitFor } from './desktop-fixture.ts';
import { headlessMachine, root, startHeadlessCompanion } from './headless-fixture.ts';
import { connectPhone, type PhoneClient } from './remote-fixture.ts';

type Context = { after(callback: () => Promise<unknown>): void };
type Json = Record<string, any>;

/** 100 ms of 16 kHz 16-bit mono sound, as the shell sends it. */
const pieceBytes = 3200;

/** 0.6 s of the public speech fixture, then 0.4 s of silence: one utterance. */
async function spokenClip(): Promise<Buffer> {
  const wav = await readFile(join(root, 'test/fixtures/speech.wav'));
  let offset = 12;
  let data: Buffer | undefined;
  while (offset < wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') {
      data = wav.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size;
  }
  assert.ok(data, 'speech.wav has a data chunk');

  const speech = data.subarray(0, 19_200);
  const silence = Buffer.alloc(12_800);
  return Buffer.concat([speech, silence]);
}

/** A synthetic intent model: the follow-up when offered, IGNORE otherwise. */
async function syntheticIntentModel(context: Context) {
  const requests: Json[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    const parsed = JSON.parse(body) as Json;
    requests.push(parsed);

    const system = JSON.stringify(parsed.messages?.[0] ?? '');
    const offered = system.includes('Name: CONTINUE_OPEN_AGENT_CONVERSATION');
    const answer = offered ? 'CONTINUE_OPEN_AGENT_CONVERSATION' : 'IGNORE';

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { role: 'assistant', content: answer };
    const chunk = { choices: [{ index: 0, delta, finish_reason: 'stop' }] };
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  return { requests, baseUrl: `http://127.0.0.1:${port}/v1` };
}

/** One request through the gateway, answered with its reply. */
export async function remote(phone: PhoneClient, request: Json): Promise<Json> {
  const requestId = randomUUID();
  phone.send({ requestId, ...request });
  return (await phone.reply(requestId, 10_000)) as Json;
}

/**
 * The listening tab's microphone: opens a stream (`audio-start`) and sends
 * 100 ms of sound every 100 ms until it is stopped or the listener ends the
 * stream (`audio-ended`): queued speech first (`say`), silence otherwise.
 * Real time, as a browser sends it: the gateway refuses sound that arrives
 * faster than its two seconds of burst allow.
 */
class BrowserMicrophone {
  streamId = '';
  private queue: Buffer[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly tab: PhoneClient) {
    tab.socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Json;
      if (message.type === 'audio-ended' && message.streamId === this.streamId) {
        this.halt();
      }
    });
  }

  /** `audio-start`; the reply as the gateway gave it. */
  async start(): Promise<Json> {
    const reply = await remote(this.tab, { action: 'audio-start' });
    if (reply.type !== 'result') {
      return reply;
    }
    this.streamId = reply.result.streamId;
    this.queue = [];
    const silence = Buffer.alloc(pieceBytes);
    this.timer = setInterval(() => {
      const piece = this.queue.shift() ?? silence;
      this.tab.socket.send(piece);
    }, 100);
    return reply;
  }

  /** Queue `sound`; it is sent at real time, before further silence. */
  say(sound: Buffer): void {
    assert.ok(this.timer, 'the microphone is listening');
    for (let offset = 0; offset < sound.length; offset += pieceBytes) {
      this.queue.push(sound.subarray(offset, offset + pieceBytes));
    }
  }

  get listening(): boolean {
    return this.timer !== undefined;
  }

  async stop(): Promise<void> {
    if (!this.timer) {
      return;
    }
    this.halt();
    await remote(this.tab, { action: 'audio-stop' });
  }

  private halt(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The world of one table: listener, gateway, one device with two tabs, X and Y. */
export async function headlessVoiceWorld(context: Context, options: { intentModel: boolean }) {
  const model = options.intentModel ? await syntheticIntentModel(context) : undefined;
  const machine = await headlessMachine(context, { llmBaseUrl: model?.baseUrl });
  const companion = await startHeadlessCompanion(context, machine, {
    intentModel: options.intentModel,
  });
  const clip = await spokenClip();

  // Pair one device; both tabs use its token.
  const paired = await fetch(`${companion.origin}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: companion.origin },
    body: JSON.stringify({ code: await companion.pairingCode(), name: 'Browser A' }),
  });
  assert.equal(paired.status, 200);
  const { token } = (await paired.json()) as { token: string };
  const socketUrl = `ws://127.0.0.1:${companion.port}/api/socket`;
  const listeningTab = await connectPhone(socketUrl, token, companion.origin);
  const otherTab = await connectPhone(socketUrl, token, companion.origin);
  context.after(async () => {
    listeningTab.socket.terminate();
    otherTab.socket.terminate();
  });
  await listeningTab.engine('state');
  await otherTab.engine('state');

  const microphone = new BrowserMicrophone(listeningTab);

  // The latest state of every conversation, from the other tab's events.
  // An event carries the messages that changed, so every message each
  // conversation ever showed is collected separately, by its ID.
  const sessions = new Map<string, Json>();
  const shownMessages = new Map<string, Map<string, Json>>();
  otherTab.socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as Json;
    if (message.type !== 'engine') {
      return;
    }
    const event = message.message as Json;
    if (event.type === 'agent-session' || event.type === 'agent-restored') {
      const session = event.session as Json;
      sessions.set(session.id, session);
      const shown = shownMessages.get(session.id) ?? new Map<string, Json>();
      for (const item of session.messages ?? []) {
        shown.set(item.id, item);
      }
      shownMessages.set(session.id, shown);
    }
    if (event.type === 'agent-removed') {
      sessions.delete(event.id);
    }
  });

  /** Start a typed conversation and wait for its first answer. */
  async function conversation(text: string): Promise<string> {
    const started = await remote(otherTab, { action: 'start-agent', text, profile: 'coding' });
    assert.equal(started.type, 'result', JSON.stringify(started));
    const id = started.result.id as string;
    await waitFor(() => sessions.get(id)?.status === 'completed', 20_000);
    return id;
  }

  const x = await conversation('X conversation');
  const y = await conversation('Y conversation');

  /** No conversation is starting or running. */
  async function idle(): Promise<void> {
    const busy = (session: Json) => session.status === 'starting' || session.status === 'running';
    await waitFor(() => ![...sessions.values()].some(busy), 20_000);
  }

  /** A tab's report of what it shows ('' for Activity). */
  async function shows(tab: PhoneClient, id: string): Promise<void> {
    const reply = await remote(tab, { action: 'panel-state', id, visible: true });
    assert.equal(reply.type, 'result', JSON.stringify(reply));
  }

  /** Every Activity entry the listening tab received so far. */
  function entries(): Json[] {
    return listeningTab.messages
      .filter((message: Json) => message.type === 'engine')
      .map((message: Json) => message.message)
      .filter((event: Json) => event.type === 'activity-entry')
      .map((event: Json) => event.entry);
  }

  /**
   * Say `phrase` (the recogniser's words for the clip) and return its
   * finished Activity entry.
   */
  async function say(phrase: string): Promise<Json> {
    const before = entries().length;
    await machine.nextPhrase(phrase);
    microphone.say(clip);

    const finished = (entry: Json) =>
      entry.utterance === phrase &&
      entry.outcome !== 'processing' &&
      entry.outcome !== 'delivering';
    await waitFor(() => entries().slice(before).some(finished), 20_000);
    return entries().slice(before).find(finished)!;
  }

  /**
   * Everything the listener sent before now has reached both tabs: a request
   * answered through each tab's ordered connection.
   */
  async function settled(): Promise<void> {
    for (const tab of [listeningTab, otherTab]) {
      const reply = await remote(tab, {
        action: 'activity-history',
        sessionId: 'x',
        after: 0,
        through: 0,
      });
      assert.ok(reply.type === 'result' || reply.type === 'error');
    }
  }

  /** The `agent-select` messages a tab received since `from`. */
  function selects(tab: PhoneClient, from: number): Json[] {
    return (tab.messages as Json[])
      .slice(from)
      .filter(
        (message) =>
          message.type === 'agent-select' ||
          (message.type === 'engine' && message.message.type === 'agent-select'),
      );
  }

  /** Conversations whose messages include a user message `text`. */
  function receivedBy(text: string): string[] {
    return [...shownMessages]
      .filter(([, shown]) =>
        [...shown.values()].some((item) => item.kind === 'user' && item.text === text),
      )
      .map(([id]) => id);
  }

  /** How many messages of conversation `id` ever had the text `text`. */
  function messagesWith(id: string, text: string): number {
    const shown = [...(shownMessages.get(id)?.values() ?? [])];
    return shown.filter((item) => item.text === text).length;
  }

  return {
    machine,
    companion,
    model,
    listeningTab,
    otherTab,
    microphone,
    sessions,
    ids: { x, y },
    conversation,
    idle,
    shows,
    entries,
    say,
    settled,
    selects,
    receivedBy,
    messagesWith,
  };
}

export type HeadlessVoiceWorld = Awaited<ReturnType<typeof headlessVoiceWorld>>;
