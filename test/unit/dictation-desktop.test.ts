import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';

import {
  DictationController,
  type DictationTranscribe,
} from '../../src/core/dictation/controller.ts';
import { desktopFixture, waitFor, type DesktopMessage } from '../desktop-fixture.ts';
import { chunk, scriptedCapture, vad } from '../dictation-fixture.ts';
import { harnessFixture } from '../harness-fixture.ts';
import { frame, signal } from '../helpers.ts';

/**
 * The desktop protocol for manual recording: a real private socket and
 * SQLite database, scripted conversations, scripted capture and ASR. No
 * microphone, model, provider, compositor or live listener is involved.
 */

type Message = DesktopMessage & Record<string, unknown>;

async function setup(
  context: { after(callback: () => Promise<unknown>): void },
  texts: Record<number, string> = {},
) {
  const harness = await harnessFixture(context);
  const id = harness.sessions.start(frame, signal());
  const other = harness.sessions.start(frame, signal());
  await harness.sessions.idle();

  const desktop = await desktopFixture(
    async () => assert.fail('No desktop commands expected'),
    harness.sessions,
  );
  context.after(() => desktop.close());

  const transcribed: number[] = [];
  const transcribe: DictationTranscribe = async (samples) => {
    transcribed.push(samples[0]);
    return texts[samples[0]] ?? '';
  };
  const capture = scriptedCapture();
  const dictation = new DictationController(
    transcribe,
    desktop.pause,
    () => {},
    desktop.controller.signal,
    capture.capture,
  );
  desktop.runtime.connectDictation(dictation);
  const messages = desktop.messages as Message[];

  /** Remove and return the next event of `type`. */
  async function next(type: string): Promise<Message> {
    await waitFor(() => messages.some((message) => message.type === type));
    const index = messages.findIndex((message) => message.type === type);
    return messages.splice(index, 1)[0];
  }

  /** The latest state snapshot's recording field. */
  function latestRecording(): unknown {
    const states = messages.filter((message) => message.type === 'state');
    return states.at(-1)?.recording;
  }

  async function show(conversation: string) {
    desktop.send({
      action: 'panel-state',
      id: conversation,
      composerFocused: false,
      draftHost: true,
    });
    assert.equal((await desktop.reply('panel-state')).type, 'result');
  }

  async function startRecording(draftLength = 0) {
    desktop.send({ action: 'start-recording', id, draftLength });
    const reply = (await desktop.reply('start-recording')) as Message;
    assert.equal(reply.type, 'result', String(reply.message));
    const result = reply.result as unknown as { outcome: string; recordingId: string; id: string };
    assert.equal(result.outcome, 'recording');
    assert.equal(result.id, id);
    const recording = dictation.record(vad);
    const { sink, stop } = await capture.started;
    return { recordingId: result.recordingId, recording, sink, stop };
  }

  async function answer(append: Message, outcome: 'appended' | 'unavailable', length = 0) {
    desktop.send({
      action: 'recording-append-result',
      requestId: append.requestId,
      outcome,
      ...(outcome === 'appended' ? { length } : { reason: 'synthetic refusal' }),
    });
    assert.equal((await desktop.reply('recording-append-result')).type, 'result');
  }

  return {
    ...harness,
    id,
    other,
    desktop,
    dictation,
    capture,
    transcribed,
    messages,
    next,
    latestRecording,
    show,
    startRecording,
    answer,
  };
}

test('recorded chunks reach only the owning panel, in order, as literal draft text', async (context) => {
  const f = await setup(context, {
    1: 'Send this to the agent.',
    2: 'Close session.',
    3: 'New session, please.',
  });

  // A second desktop panel sees the recording state but never its text.
  const observer = createConnection(f.desktop.socketPath);
  const observed: Message[] = [];
  let buffered = '';
  observer.setEncoding('utf8');
  observer.on('data', (data: string) => {
    buffered += data;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      observed.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(observer, 'connect');
  context.after(async () => observer.destroy());

  await waitFor(() =>
    f.messages.some((message) => message.type === 'state' && message.recordingAvailable === true),
  );

  await f.show(f.id);
  const { recordingId, recording, sink } = await f.startRecording(12);
  await waitFor(() => (f.latestRecording() as { state?: string })?.state === 'recording');
  assert.deepEqual(f.latestRecording(), { recordingId, sessionId: f.id, state: 'recording' });

  sink.accept(chunk(1));
  sink.accept(chunk(2));
  const first = await f.next('recording-append');
  assert.deepEqual(
    [first.id, first.recordingId, first.sequence, first.text],
    [f.id, recordingId, 1, 'Send this to the agent.'],
  );
  // The next chunk waits for this acknowledgement.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.messages.filter((message) => message.type === 'recording-append').length, 0);
  await f.answer(first, 'appended', 36);

  const second = await f.next('recording-append');
  assert.deepEqual([second.sequence, second.text], [2, 'Close session.']);

  // The conversation being recorded into cannot be closed meanwhile.
  f.desktop.send({ action: 'close-agent', id: f.id });
  const refused = await f.desktop.reply('close-agent');
  assert.equal(refused.type, 'error');
  assert.match(String(refused.message), /recording into its text box/);
  assert.equal(f.sessions.has(f.id), true);

  await f.answer(second, 'appended', 51);
  f.capture.script.tail = chunk(3);
  f.desktop.send({ action: 'stop-recording', id: f.id });
  assert.equal((await f.desktop.reply('stop-recording')).result, 'finishing');
  await recording;

  const third = await f.next('recording-append');
  assert.deepEqual([third.sequence, third.text], [3, 'New session, please.']);
  await f.answer(third, 'appended', 72);

  const finished = await f.next('recording-finished');
  assert.deepEqual(
    [finished.recordingId, finished.id, finished.reason, finished.complete, finished.message],
    [recordingId, f.id, 'stopped', true, ''],
  );
  await waitFor(() => f.latestRecording() === null);

  // No agent turn, history row or recording file came from recorded speech.
  assert.equal(f.runs.length, 2, 'Only the two synthetic conversations ran');
  const rows = f.desktop.database.prepare('SELECT COUNT(*) AS count FROM utterances').get();
  assert.equal(rows!.count, 0);
  assert.equal(
    observed.some((message) => String(message.type).startsWith('recording-')),
    false,
  );
  assert.ok(observed.some((message) => message.type === 'state' && message.recording !== null));

  f.desktop.send({ action: 'close-agent', id: f.id });
  assert.equal((await f.desktop.reply('close-agent')).type, 'result');
});

test('recording requests are refused unless this panel shows the conversation and has room', async (context) => {
  const f = await setup(context);

  f.desktop.send({ action: 'start-recording', id: f.id, draftLength: 0 });
  assert.match(
    String((await f.desktop.reply('start-recording')).message),
    /Open this conversation/,
  );

  await f.show(f.other);
  f.desktop.send({ action: 'start-recording', id: f.id, draftLength: 0 });
  assert.match(
    String((await f.desktop.reply('start-recording')).message),
    /Open this conversation/,
  );

  await f.show(f.id);
  for (const draftLength of [8000, 8001]) {
    f.desktop.send({ action: 'start-recording', id: f.id, draftLength });
    assert.match(String((await f.desktop.reply('start-recording')).message), /8000 or more/);
  }
  for (const draftLength of [-1, '5', undefined]) {
    f.desktop.send({ action: 'start-recording', id: f.id, draftLength });
    assert.match(String((await f.desktop.reply('start-recording')).message), /draft length/);
  }

  f.desktop.send({ action: 'stop-recording', id: f.id });
  assert.equal((await f.desktop.reply('stop-recording')).type, 'error');
  f.desktop.send({
    action: 'recording-append-result',
    requestId: 'unknown',
    outcome: 'appended',
    length: 1,
  });
  assert.match(String((await f.desktop.reply('recording-append-result')).message), /expired/);
  assert.equal(f.dictation.status, undefined);

  // 7999 is still below the limit.
  f.desktop.send({ action: 'start-recording', id: f.id, draftLength: 7999 });
  assert.equal((await f.desktop.reply('start-recording')).type, 'result');
  f.desktop.send({ action: 'start-recording', id: f.id, draftLength: 0 });
  assert.match(String((await f.desktop.reply('start-recording')).message), /already running/);
});

test('a remote panel can neither start, stop nor answer a recording', async (context) => {
  const f = await setup(context);
  const remote = createConnection(f.desktop.socketPath);
  const replies: Message[] = [];
  let buffered = '';
  remote.setEncoding('utf8');
  remote.on('data', (data: string) => {
    buffered += data;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(remote, 'connect');
  context.after(async () => remote.destroy());

  const write = (request: object) => remote.write(JSON.stringify(request) + '\n');
  write({ action: 'client-role', role: 'remote' });
  write({ action: 'panel-state', id: f.id, composerFocused: false });
  for (const action of ['start-recording', 'stop-recording', 'recording-append-result']) {
    write({ action, id: f.id, draftLength: 0, requestId: 'x', outcome: 'appended', length: 1 });
    await waitFor(() => replies.some((message) => message.action === action));
    const reply = replies.find((message) => message.action === action)!;
    assert.equal(reply.type, 'error');
    assert.match(String(reply.message), /only available on the desktop/);
  }
  assert.equal(f.dictation.status, undefined);
});

test('switching tabs stops capture and the final words still go to the original draft', async (context) => {
  const f = await setup(context, { 1: 'before switching', 2: 'final words' });
  await f.show(f.id);
  const { recording, sink, stop } = await f.startRecording();

  sink.accept(chunk(1));
  const first = await f.next('recording-append');
  f.capture.script.tail = chunk(2);
  await f.show(f.other);
  assert.equal(stop.aborted, true);
  await recording;

  await f.answer(first, 'appended', 16);
  const second = await f.next('recording-append');
  assert.deepEqual([second.id, second.text], [f.id, 'final words']);
  await f.answer(second, 'appended', 28);

  const finished = await f.next('recording-finished');
  assert.equal(finished.reason, 'navigation');
  assert.equal(finished.complete, true);
});

test('a hidden panel also stops capture', async (context) => {
  const f = await setup(context);
  await f.show(f.id);
  const { recording, stop } = await f.startRecording();
  await f.show('');
  assert.equal(stop.aborted, true);
  await recording;
  assert.equal((await f.next('recording-finished')).reason, 'navigation');
});

test('reaching 8000 characters stops capture; the queued chunk and final words are kept', async (context) => {
  const f = await setup(context, { 1: 'one', 2: 'two', 3: 'three' });
  await f.show(f.id);
  const { recording, sink, stop } = await f.startRecording(7990);

  f.capture.script.tail = chunk(3);
  sink.accept(chunk(1));
  sink.accept(chunk(2));
  await f.answer(await f.next('recording-append'), 'appended', 8000);
  await recording;
  assert.equal(stop.aborted, true);

  await f.answer(await f.next('recording-append'), 'appended', 8004);
  const last = await f.next('recording-append');
  assert.equal(last.text, 'three');
  await f.answer(last, 'appended', 8010);

  const finished = await f.next('recording-finished');
  assert.equal(finished.reason, 'limit');
  assert.equal(finished.complete, true);
  assert.match(String(finished.message), /8000 characters/);
});

test('a refused append stops recording as incomplete and is never resent', async (context) => {
  const f = await setup(context, { 1: 'one', 2: 'two' });
  await f.show(f.id);
  const { recording, sink } = await f.startRecording();

  sink.accept(chunk(1));
  sink.accept(chunk(2));
  await f.answer(await f.next('recording-append'), 'unavailable');
  await recording;

  const finished = await f.next('recording-finished');
  assert.equal(finished.reason, 'delivery');
  assert.equal(finished.complete, false);
  assert.equal(
    f.messages.some((message) => message.type === 'recording-append'),
    false,
  );
  assert.deepEqual(f.transcribed, [1], 'The queued chunk was discarded');
});

test('the owning panel disconnecting abandons the recording; another panel cannot answer', async (context) => {
  const f = await setup(context, { 1: 'one' });
  await f.show(f.id);
  const { recording, sink, stop } = await f.startRecording();

  sink.accept(chunk(1));
  const append = await f.next('recording-append');
  f.desktop.client.destroy();
  await recording;
  assert.equal(stop.aborted, true);
  await waitFor(() => f.dictation.status === undefined);

  // The request expired with its connection; a reconnected panel cannot answer it.
  const replacement = createConnection(f.desktop.socketPath);
  const replies: Message[] = [];
  replacement.setEncoding('utf8');
  replacement.on('data', (data: string) => {
    for (const line of data.split('\n').filter(Boolean)) {
      replies.push(JSON.parse(line));
    }
  });
  await once(replacement, 'connect');
  context.after(async () => replacement.destroy());
  replacement.write(
    JSON.stringify({
      action: 'recording-append-result',
      requestId: append.requestId,
      outcome: 'appended',
      length: 3,
    }) + '\n',
  );
  await waitFor(() => replies.some((message) => message.action === 'recording-append-result'));
  assert.match(
    String(replies.find((message) => message.action === 'recording-append-result')?.message),
    /expired/,
  );

  // Closing is allowed again once nothing can be delivered.
  assert.equal(f.dictation.closeRefusal(f.id), undefined);
});

test('global pause stops recording; the saved pause choice is untouched', async (context) => {
  const f = await setup(context, { 1: 'tail words' });
  await f.show(f.id);
  const { recording, stop } = await f.startRecording();
  f.capture.script.tail = chunk(1);

  f.desktop.send({ action: 'toggle-pause' });
  assert.equal((await f.desktop.reply('toggle-pause')).result, 'paused');
  assert.equal(stop.aborted, true);
  await recording;
  await f.answer(await f.next('recording-append'), 'appended', 10);

  const finished = await f.next('recording-finished');
  assert.equal(finished.reason, 'paused');
  assert.equal(f.desktop.pause.reason, 'manual');
});

test('listener shutdown abandons the recording without delivering more text', async (context) => {
  const f = await setup(context, { 1: 'never delivered' });
  await f.show(f.id);
  const { recording, sink } = await f.startRecording();
  f.desktop.controller.abort(Error('shutdown'));
  sink.accept(chunk(1));
  await assert.rejects(recording, /shutdown/);
  await f.dictation.idle();
  assert.equal(
    f.messages.some((message) => message.type === 'recording-append'),
    false,
  );
});
