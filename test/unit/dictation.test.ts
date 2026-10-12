import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DICTATION_CHARACTER_LIMIT,
  DictationController,
  MAX_WAITING_CHUNKS,
  type DictationAppend,
  type DictationAppendRequest,
  type DictationAppendResult,
  type DictationSummary,
  type DictationTranscribe,
} from '../../src/core/dictation/controller.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { waitFor } from '../desktop-fixture.ts';
import { chunk, scriptedCapture, vad } from '../dictation-fixture.ts';
import { deferred, processor, testDetector, testSensors } from '../helpers.ts';

/**
 * Manual recording into a conversation's text box (core/dictation). Capture,
 * ASR and the panel are scripted: no microphone, model, listener or desktop.
 * Each synthetic chunk is a small buffer filled with its chunk number, and the
 * scripted ASR maps that number to text.
 */

/**
 * A controller with scripted ASR (marker → text) and a scripted panel whose
 * draft starts with `initialDraft`. Appends are recorded in arrival order.
 */
function setup(
  options: {
    texts?: Record<number, string>;
    transcribe?: DictationTranscribe;
    append?: DictationAppend;
    initialDraft?: string;
    pause?: PauseControl;
  } = {},
) {
  const pause = options.pause ?? new PauseControl();
  const lifetime = new AbortController();
  const logs: string[] = [];
  const transcribed: number[] = [];
  const texts = options.texts ?? {};
  const capture = scriptedCapture();

  const transcribe: DictationTranscribe =
    options.transcribe ??
    (async (samples) => {
      transcribed.push(samples[0]);
      return texts[samples[0]] ?? '';
    });

  const appends: DictationAppendRequest[] = [];
  const draft = { text: options.initialDraft ?? '' };
  const append: DictationAppend =
    options.append ??
    (async (request) => {
      appends.push(request);
      draft.text += (draft.text && !/\s$/.test(draft.text) ? ' ' : '') + request.text;
      return { outcome: 'appended', length: draft.text.length };
    });

  const controller = new DictationController(
    transcribe,
    pause,
    (_stage, detail) => logs.push(detail),
    lifetime.signal,
    capture.capture,
  );
  const summaries: DictationSummary[] = [];
  controller.on('finished', (summary: DictationSummary) => summaries.push(summary));

  const start = (draftLength = draft.text.length) =>
    controller.start({ clientId: 7, sessionId: 'conversation', draftLength, append });

  return {
    controller,
    pause,
    lifetime,
    logs,
    transcribed,
    capture,
    appends,
    draft,
    summaries,
    start,
    append,
  };
}

test('Record, chunks, Stop and the final words: appended once, in order, without sending', async () => {
  // Command-shaped speech stays literal text: there is no router here at all.
  const f = setup({
    initialDraft: 'My existing notes.',
    texts: { 1: 'Send the report.', 2: ' close session ', 3: 'stop' },
  });

  const status = f.start();
  assert.equal(status.state, 'starting');
  assert.equal(status.sessionId, 'conversation');
  assert.equal(f.controller.waitingForMicrophone, true);
  assert.equal(f.controller.handoff().aborted, true, 'Ordinary listening hands over');

  const recording = f.controller.record(vad);
  const { sink, stop } = await f.capture.started;
  assert.equal(f.controller.status?.state, 'recording');

  sink.accept(chunk(1));
  sink.accept(chunk(2));
  await waitFor(() => f.appends.length === 2);

  // Stop is a capture boundary: the open candidate becomes the final chunk.
  f.capture.script.tail = chunk(3);
  assert.equal(f.controller.stop('stopped'), true);
  assert.equal(stop.aborted, true);
  await recording;
  await waitFor(() => f.summaries.length === 1);

  assert.deepEqual(
    f.appends.map((request) => [request.sequence, request.text, request.sessionId]),
    [
      [1, 'Send the report.', 'conversation'],
      [2, 'close session', 'conversation'],
      [3, 'stop', 'conversation'],
    ],
  );
  assert.equal(f.draft.text, 'My existing notes. Send the report. close session stop');
  assert.deepEqual(f.transcribed, [1, 2, 3], 'Each chunk is transcribed exactly once');
  assert.equal(f.summaries[0].reason, 'stopped');
  assert.equal(f.summaries[0].complete, true);
  assert.equal(f.summaries[0].message, '');
  assert.equal(f.summaries[0].appendedChunks, 3);
  assert.equal(f.controller.status, undefined);
  assert.equal(f.controller.handoff().aborted, false, 'The next ordinary period can listen');
});

test('a slow chunk is never overtaken: delivery waits for each acknowledgement', async () => {
  const gates = new Map([
    [1, deferred<void>()],
    [2, deferred<void>()],
  ]);
  const order: string[] = [];
  const f = setup({
    transcribe: async (samples) => {
      const marker = samples[0];
      order.push(`asr-${marker}`);
      await gates.get(marker)?.promise;
      return `chunk ${marker}`;
    },
  });

  f.start();
  void f.controller.record(vad);
  const { sink } = await f.capture.started;
  sink.accept(chunk(1));
  sink.accept(chunk(2));

  await waitFor(() => order.length === 1);
  assert.deepEqual(order, ['asr-1'], 'One chunk at a time on the ASR worker');
  gates.get(2)!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.appends.length, 0);

  gates.get(1)!.resolve();
  await waitFor(() => f.appends.length === 2);
  assert.deepEqual(
    f.appends.map((request) => request.text),
    ['chunk 1', 'chunk 2'],
  );

  f.controller.stop('stopped');
  await waitFor(() => f.summaries.length === 1);
});

test('empty transcripts add nothing and are not numbered', async () => {
  const f = setup({ texts: { 1: '', 2: '   ', 3: 'words' } });
  f.start();
  void f.controller.record(vad);
  const { sink } = await f.capture.started;
  sink.accept(chunk(1));
  sink.accept(chunk(2));
  f.capture.script.tail = chunk(3);
  f.controller.stop('stopped');
  await waitFor(() => f.summaries.length === 1);

  assert.deepEqual(
    f.appends.map((request) => [request.sequence, request.text]),
    [[1, 'words']],
  );
  assert.equal(f.summaries[0].complete, true);
});

test('Record is refused at and above 8000 characters and accepted below', () => {
  assert.equal(DICTATION_CHARACTER_LIMIT, 8000);

  for (const length of [8000, 8001, 20000]) {
    const f = setup();
    assert.throws(() => f.start(length), /8000 or more characters/);
    assert.equal(f.controller.status, undefined);
  }

  for (const length of [-1, 1.5, Number.NaN]) {
    const f = setup();
    assert.throws(() => f.start(length), /draft length/);
  }

  const f = setup();
  assert.equal(f.start(7999).state, 'starting');
  assert.throws(() => f.start(0), /already running/, 'One recording at a time');
});

for (const [lengthAfterFirst, stops] of [
  [7999, false],
  [8000, true],
  [8150, true],
] as const) {
  test(`a draft of ${lengthAfterFirst} characters ${stops ? 'stops capture and keeps the whole tail' : 'keeps recording'}`, async () => {
    // Below the limit, the second chunk stays below too; the final chunk
    // after a manual Stop may then pass 8000 and is still kept whole.
    const lengths = stops
      ? [lengthAfterFirst, lengthAfterFirst + 40, lengthAfterFirst + 80]
      : [lengthAfterFirst - 9, lengthAfterFirst, lengthAfterFirst + 101];
    const f = setup({
      texts: { 1: 'first', 2: 'second', 3: 'final words' },
      append: async (request) => {
        f.appends.push(request);
        return { outcome: 'appended', length: lengths[request.sequence - 1] };
      },
    });

    f.start(7000);
    const recording = f.controller.record(vad);
    const { sink, stop } = await f.capture.started;

    // Chunk 2 is already queued when chunk 1 reaches the limit, and the
    // open candidate becomes the final chunk at the boundary. Words captured
    // before the boundary are never sliced or dropped.
    f.capture.script.tail = chunk(3);
    sink.accept(chunk(1));
    sink.accept(chunk(2));
    await waitFor(() => f.appends.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stop.aborted, stops);

    if (!stops) {
      await waitFor(() => f.appends.length === 2);
      assert.equal(stop.aborted, false);
      f.controller.stop('stopped');
    }
    await recording;
    await waitFor(() => f.summaries.length === 1);

    assert.deepEqual(
      f.appends.map((request) => request.text),
      ['first', 'second', 'final words'],
    );
    assert.equal(f.summaries[0].reason, stops ? 'limit' : 'stopped');
    assert.equal(f.summaries[0].complete, true);
    if (stops) {
      assert.match(f.summaries[0].message, /8000 characters/);
    }
  });
}

test('a growing backlog stops capture early enough that the final chunk still fits', async () => {
  const release = deferred<void>();
  const f = setup({
    transcribe: async (samples) => {
      await release.promise;
      f.transcribed.push(samples[0]);
      return `chunk ${samples[0]}`;
    },
  });

  f.start();
  const recording = f.controller.record(vad);
  const { sink, stop } = await f.capture.started;

  // Chunk 1 is in progress; chunks 2..4 wait. At MAX_WAITING_CHUNKS - 1
  // waiting, capture stops, leaving one slot for the final chunk.
  for (let marker = 1; marker <= MAX_WAITING_CHUNKS; marker++) {
    sink.accept(chunk(marker));
  }
  assert.equal(stop.aborted, true);
  assert.equal(f.controller.status?.state, 'finishing');

  f.capture.script.tail = chunk(MAX_WAITING_CHUNKS + 1);
  await recording;
  release.resolve();
  await waitFor(() => f.summaries.length === 1);

  assert.deepEqual(f.transcribed, [1, 2, 3, 4, 5]);
  assert.equal(f.appends.length, 5, 'Nothing was dropped');
  assert.equal(f.summaries[0].reason, 'overload');
  assert.equal(f.summaries[0].complete, true);
  assert.match(f.summaries[0].message, /Everything recorded so far was added/);
});

test('a transcription failure stops recording, keeps earlier text and never retries', async () => {
  let calls = 0;
  const f = setup({
    transcribe: async (samples) => {
      calls++;
      if (samples[0] === 2) {
        throw Error('ASR operation timed out');
      }
      return `chunk ${samples[0]}`;
    },
  });

  f.start();
  const recording = f.controller.record(vad);
  const { sink, stop } = await f.capture.started;
  sink.accept(chunk(1));
  await waitFor(() => f.appends.length === 1);
  sink.accept(chunk(2));
  sink.accept(chunk(3));

  await recording;
  await waitFor(() => f.summaries.length === 1);
  assert.equal(stop.aborted, true);
  assert.equal(calls, 2, 'The failed chunk is not retried and later chunks are discarded');
  assert.deepEqual(
    f.appends.map((request) => request.text),
    ['chunk 1'],
  );
  assert.equal(f.summaries[0].reason, 'transcription');
  assert.equal(f.summaries[0].complete, false);
  assert.match(f.summaries[0].message, /incomplete/);
});

for (const outcome of ['unconfirmed', 'unavailable', 'offline'] as const) {
  test(`an ${outcome} append is never resent and stops recording as incomplete`, async () => {
    let attempts = 0;
    const f = setup({
      texts: { 1: 'one', 2: 'two', 3: 'three' },
      append: async (request): Promise<DictationAppendResult> => {
        attempts++;
        f.appends.push(request);
        if (request.sequence === 2) {
          return { outcome, reason: 'synthetic' };
        }
        return { outcome: 'appended', length: 10 };
      },
    });

    f.start();
    const recording = f.controller.record(vad);
    const { sink } = await f.capture.started;
    sink.accept(chunk(1));
    sink.accept(chunk(2));
    sink.accept(chunk(3));
    await recording;
    await waitFor(() => f.summaries.length === 1);

    assert.equal(attempts, 2);
    assert.deepEqual(
      f.appends.map((request) => request.sequence),
      [1, 2],
    );
    assert.equal(f.summaries[0].reason, 'delivery');
    assert.equal(f.summaries[0].complete, false);
    assert.equal(f.controller.closeRefusal('conversation'), undefined);
  });
}

test('pausing stops manual capture; Record may start while already paused', async () => {
  const pause = new PauseControl();
  pause.toggle();
  assert.equal(pause.paused, true);

  const f = setup({ pause, texts: { 1: 'while paused', 2: 'tail' } });

  // The microphone is free for manual recording while ordinary listening is paused.
  const waiting = f.controller.waitForMicrophone(new AbortController().signal);
  f.start();
  await waiting;
  const recording = f.controller.record(vad);
  const { sink, stop } = await f.capture.started;
  sink.accept(chunk(1));
  await waitFor(() => f.appends.length === 1);
  assert.equal(pause.reason, 'manual', 'The saved pause choice is unchanged');

  // Resuming does not stop it; pausing again (manual or media) does.
  pause.toggle();
  assert.equal(stop.aborted, false);
  pause.setMediaPlaying(true);
  assert.equal(pause.reason, 'media');
  assert.equal(stop.aborted, true);

  f.capture.script.tail = chunk(2);
  await recording;
  await waitFor(() => f.summaries.length === 1);
  assert.deepEqual(
    f.appends.map((request) => request.text),
    ['while paused', 'tail'],
  );
  assert.equal(f.summaries[0].reason, 'paused');
  assert.equal(f.summaries[0].complete, true);
});

test('waitForMicrophone resolves for ordinary listening or a waiting recording', async () => {
  const pause = new PauseControl();
  const f = setup({ pause });
  await f.controller.waitForMicrophone(new AbortController().signal);

  pause.toggle();
  let resolved = false;
  const waiting = f.controller.waitForMicrophone(new AbortController().signal).then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);
  pause.toggle();
  await waiting;

  const shutdown = new AbortController();
  pause.toggle();
  const cancelled = f.controller.waitForMicrophone(shutdown.signal);
  shutdown.abort();
  await assert.rejects(cancelled);
});

test('Stop before the microphone was handed over ends the recording without capture', async () => {
  const f = setup();
  f.start();
  const handoff = f.controller.handoff();
  assert.equal(handoff.aborted, true);
  f.controller.stop('navigation');

  await waitFor(() => f.summaries.length === 1);
  assert.equal(f.summaries[0].reason, 'navigation');
  assert.equal(f.controller.waitingForMicrophone, false);
  await f.controller.record(vad);
  assert.equal(f.capture.script.calls, 0, 'No recorder was opened');
  assert.equal(f.controller.handoff().aborted, false);
});

test('a disconnected owner gets nothing more: queued chunks are dropped and close is allowed', async () => {
  const release = deferred<void>();
  const f = setup({
    transcribe: async (samples) => {
      f.transcribed.push(samples[0]);
      if (samples[0] === 2) {
        await release.promise;
      }
      return `chunk ${samples[0]}`;
    },
  });

  f.start();
  const recording = f.controller.record(vad);
  const { sink } = await f.capture.started;
  assert.match(f.controller.closeRefusal('conversation') ?? '', /Stop recording/);
  assert.equal(f.controller.closeRefusal('another conversation'), undefined);

  sink.accept(chunk(1));
  await waitFor(() => f.appends.length === 1);
  sink.accept(chunk(2));
  sink.accept(chunk(3));
  await waitFor(() => f.transcribed.length === 2);

  f.controller.abandon('disconnected');
  assert.equal(f.controller.closeRefusal('conversation'), undefined);
  await recording;

  // The chunk in progress finishes on the ASR worker; its text is dropped.
  release.resolve();
  await waitFor(() => f.summaries.length === 1);
  assert.deepEqual(f.transcribed, [1, 2]);
  assert.equal(f.appends.length, 1);
  assert.equal(f.summaries[0].reason, 'disconnected');
  assert.equal(f.summaries[0].complete, false);
});

test('navigation by the owner stops capture and drains to the original conversation', async () => {
  const f = setup({ texts: { 1: 'before', 2: 'tail' } });
  f.start();
  const recording = f.controller.record(vad);
  const { sink, stop } = await f.capture.started;
  sink.accept(chunk(1));

  // Another panel's report, or the same conversation, changes nothing.
  f.controller.ownerViewChanged(8, 'elsewhere');
  f.controller.ownerViewChanged(7, 'conversation');
  assert.equal(stop.aborted, false);

  f.controller.ownerViewChanged(7, 'elsewhere');
  assert.equal(stop.aborted, true);
  f.capture.script.tail = chunk(2);
  await recording;
  await waitFor(() => f.summaries.length === 1);
  assert.deepEqual(
    f.appends.map((request) => request.sessionId),
    ['conversation', 'conversation'],
  );
  assert.equal(f.summaries[0].reason, 'navigation');
});

test('a microphone failure keeps the audio captured so far and reports the gap', async () => {
  const f = setup({ texts: { 1: 'kept' } });
  f.start();
  const recording = f.controller.record(vad);
  await f.capture.started;
  f.capture.script.tail = chunk(1);
  f.capture.script.failure = Error('pw-record exited 1');
  f.capture.end();
  await recording;
  await waitFor(() => f.summaries.length === 1);

  assert.deepEqual(
    f.appends.map((request) => request.text),
    ['kept'],
  );
  assert.equal(f.summaries[0].reason, 'microphone');
  assert.equal(f.summaries[0].complete, false);
});

test('shutdown abandons the recording and rethrows from capture', async () => {
  const f = setup({ texts: { 1: 'never sent' } });
  f.start();
  const recording = f.controller.record(vad);
  const { sink } = await f.capture.started;
  f.lifetime.abort(Error('shutdown'));
  sink.accept(chunk(1));
  await assert.rejects(recording, /shutdown/);
  await f.controller.idle();
  await waitFor(() => f.summaries.length === 1);
  assert.equal(f.appends.length, 0);
  assert.equal(f.summaries[0].reason, 'shutdown');
  assert.throws(() => f.start(), /shutting down/);
});

test('manual chunks share the ASR worker with the pipeline and bypass routing entirely', async () => {
  let active = 0;
  let maximum = 0;
  const gate = deferred<void>();
  const calls: string[] = [];
  const activity = {
    processing: () => calls.push('processing'),
    transcribed: () => calls.push('transcribed'),
    audioCaptured: async () => {
      calls.push('audio');
    },
  };
  const routed: string[] = [];
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          routed.push('inference');
          return 'IGNORE';
        },
      }),
    },
    () => {},
  );
  router.register(processor('IGNORE', async (frame) => void routed.push(frame.utterance)));
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => {
          calls.push('screenshot');
          throw Error('No desktop in this test');
        },
        transcribe: async (samples) => {
          active++;
          maximum = Math.max(maximum, active);
          await gate.promise;
          active--;
          return `text ${samples[0]}`;
        },
      }),
      router,
    },
    () => {},
    new AbortController().signal,
    activity,
  );

  // A manual chunk takes the worker first; ordinary speech waits its turn.
  const manual = pipeline.transcribeInTurn(chunk(1), new AbortController().signal);
  pipeline.submit(chunk(2));
  const cancelled = new AbortController();
  const abandoned = pipeline.transcribeInTurn(chunk(3), cancelled.signal);
  const later = pipeline.transcribeInTurn(chunk(4), new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(active, 1);

  // Leaving the queue while waiting never lets a later caller overtake.
  cancelled.abort(Error('left the queue'));
  await assert.rejects(abandoned, /left the queue/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(active, 1);

  gate.resolve();
  assert.equal(await manual, 'text 1');
  assert.equal(await later, 'text 4');
  await pipeline.idle();
  assert.equal(maximum, 1, 'The single ASR worker never receives concurrent requests');

  // Only the ordinary job used Activity callbacks and screen capture.
  assert.equal(calls.filter((call) => call === 'processing').length, 1);
  assert.equal(calls.filter((call) => call === 'screenshot').length, 1);
});

for (const boundary of ['stopped', 'navigation', 'limit', 'paused'] as const) {
  for (const failure of ['transcription', 'delivery'] as const) {
    test(`a ${failure} failure while finishing after ${boundary} is reported as a failure`, async () => {
      const release = deferred<void>();
      const f = setup({
        transcribe: async (samples) => {
          if (samples[0] === 2) {
            await release.promise;
            if (failure === 'transcription') {
              throw Error('ASR operation timed out');
            }
          }
          return `chunk ${samples[0]}`;
        },
        append: async (request): Promise<DictationAppendResult> => {
          f.appends.push(request);
          if (failure === 'delivery' && request.sequence === 2) {
            return { outcome: 'unconfirmed', reason: 'synthetic' };
          }
          // The limit boundary comes from the first append's resulting length.
          return { outcome: 'appended', length: boundary === 'limit' ? 8000 : 10 };
        },
      });

      f.start();
      const recording = f.controller.record(vad);
      const { sink, stop } = await f.capture.started;
      sink.accept(chunk(1));
      sink.accept(chunk(2));
      f.capture.script.tail = chunk(3);
      await waitFor(() => f.appends.length === 1);

      if (boundary === 'stopped') {
        f.controller.stop('stopped');
      } else if (boundary === 'navigation') {
        f.controller.ownerViewChanged(7, 'elsewhere');
      } else if (boundary === 'paused') {
        f.pause.toggle();
      }
      await waitFor(() => stop.aborted);
      await recording;
      release.resolve();
      await waitFor(() => f.summaries.length === 1);

      const summary = f.summaries[0];
      assert.equal(summary.reason, failure);
      assert.equal(summary.complete, false);
      assert.match(summary.message, /incomplete|may be missing/);
      assert.doesNotMatch(summary.message, /was added here|Everything recorded/);
    });
  }
}

test('capturing stays true from Record until the recorder exits, on every path', async () => {
  // Ordinary Stop: still capturing until the capture loop reports its end.
  const f = setup({ texts: { 1: 'words' } });
  f.start();
  assert.equal(f.controller.status?.capturing, true, 'starting');
  const recording = f.controller.record(vad);
  const { sink } = await f.capture.started;
  assert.equal(f.controller.status?.capturing, true, 'recording');

  f.controller.stop('stopped');
  assert.equal(f.controller.status?.state, 'finishing');
  assert.equal(f.controller.status?.capturing, true, 'The recorder may still be open');
  sink.accept(chunk(1));
  await recording;
  await waitFor(() => f.summaries.length === 1);
  assert.equal(f.controller.status, undefined);

  // Stop before the microphone was handed over: no capture, nothing left on.
  const g = setup();
  g.start();
  g.controller.stop('navigation');
  assert.equal(g.controller.status, undefined);

  // Owner disconnect and microphone failure end capturing too.
  for (const ending of ['disconnected', 'microphone'] as const) {
    const h = setup();
    h.start();
    const run = h.controller.record(vad);
    await h.capture.started;
    if (ending === 'disconnected') {
      h.controller.abandon('disconnected');
    } else {
      h.capture.script.failure = Error('pw-record exited 1');
      h.capture.end();
    }
    await run;
    await waitFor(() => h.summaries.length === 1);
    assert.equal(h.controller.status, undefined, ending);
  }
});

test('capturing is false while queued chunks are still being transcribed', async () => {
  const release = deferred<void>();
  const f = setup({
    transcribe: async (samples) => {
      await release.promise;
      return `chunk ${samples[0]}`;
    },
  });
  f.start();
  const recording = f.controller.record(vad);
  const { sink } = await f.capture.started;
  sink.accept(chunk(1));
  f.controller.stop('stopped');
  await recording;
  assert.deepEqual(
    { state: f.controller.status?.state, capturing: f.controller.status?.capturing },
    { state: 'finishing', capturing: false },
  );
  release.resolve();
  await waitFor(() => f.summaries.length === 1);
});
