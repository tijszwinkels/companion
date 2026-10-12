import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import {
  DICTATION_ENDPOINT_MS,
  recordDictation,
  type DictationSink,
} from '../../src/sensors/audio/dictation-listener.ts';
import { listen } from '../../src/sensors/audio/listener.ts';
import { FRAME_MS } from '../../src/sensors/audio/segmenter.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { testDetector, testSensors } from '../helpers.ts';

// The public speech fixture replaces the microphone; scripted VAD results make
// the chunk boundaries deterministic. Native VAD resources follow the
// production create/reset/close lifetime. No microphone or ASR is used.
const fixture = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url));

function recordingSink() {
  const chunks: number[] = [];
  const ended: unknown[] = [];
  const sink: DictationSink = {
    accept: (samples) => chunks.push(samples.length),
    captureEnded: (error) => ended.push(error),
  };
  return { sink, chunks, ended };
}

test('manual chunks close after 800 ms of silence, so short pauses stay inside one chunk', async (context) => {
  assert.equal(DICTATION_ENDPOINT_MS, 800);
  const config = await loadConfig();
  const vad = await VoiceActivityDetector.create(config.vadModel);
  context.after(() => vad.close());

  // 10 voiced frames, a 320 ms pause, 10 voiced frames, then silence.
  let frame = 0;
  context.mock.method(vad, 'probability', async () => {
    frame++;
    return frame <= 10 || (frame > 20 && frame <= 30) ? 0.95 : 0;
  });

  const { sink, chunks, ended } = recordingSink();
  const logs: string[] = [];
  await recordDictation(
    vad,
    sink,
    (stage, detail) => logs.push(`${stage} ${detail}`),
    new AbortController().signal,
    new AbortController().signal,
    { file: fixture },
  );

  assert.equal(chunks.length, 1, 'The 320 ms pause did not split the chunk');
  const silenceFrames = DICTATION_ENDPOINT_MS / FRAME_MS;
  assert.equal(chunks[0] / 512, 30 + silenceFrames, 'Chunk ends after the 800 ms endpoint');
  assert.deepEqual(ended, [undefined]);
  assert.ok(logs.some((line) => line.startsWith('dictation-vad')));
});

test('Stop keeps the words spoken up to the click as the final chunk', async (context) => {
  const config = await loadConfig();
  const vad = await VoiceActivityDetector.create(config.vadModel);
  context.after(() => vad.close());
  const stop = new AbortController();

  let frames = 0;
  context.mock.method(vad, 'probability', async () => {
    frames++;
    if (frames === 20) {
      stop.abort();
    }
    return 0.95;
  });

  const { sink, chunks, ended } = recordingSink();
  await recordDictation(vad, sink, () => {}, new AbortController().signal, stop.signal, {
    file: fixture,
  });

  assert.equal(frames, 20, 'No frame after the boundary is processed');
  assert.deepEqual(chunks, [20 * 512]);
  assert.deepEqual(ended, [undefined]);
});

test('a VAD failure ends capture but keeps the audio already captured', async (context) => {
  const config = await loadConfig();
  const vad = await VoiceActivityDetector.create(config.vadModel);
  context.after(() => vad.close());

  let frames = 0;
  context.mock.method(vad, 'probability', async () => {
    frames++;
    if (frames === 11) {
      throw Error('VAD failed');
    }
    return 0.95;
  });

  const { sink, chunks, ended } = recordingSink();
  await recordDictation(
    vad,
    sink,
    () => {},
    new AbortController().signal,
    new AbortController().signal,
    { file: fixture },
  );

  assert.deepEqual(chunks, [10 * 512]);
  assert.equal(ended.length, 1);
  assert.match(String(ended[0]), /VAD failed/);
});

test('shutdown discards the open chunk and rethrows', async (context) => {
  const config = await loadConfig();
  const vad = await VoiceActivityDetector.create(config.vadModel);
  context.after(() => vad.close());
  const shutdown = new AbortController();

  let frames = 0;
  context.mock.method(vad, 'probability', async () => {
    frames++;
    if (frames === 10) {
      shutdown.abort(Error('shutdown'));
    }
    return 0.95;
  });

  const { sink, chunks, ended } = recordingSink();
  await assert.rejects(
    recordDictation(vad, sink, () => {}, shutdown.signal, new AbortController().signal, {
      file: fixture,
    }),
    /shutdown/,
  );
  assert.deepEqual(chunks, []);
  assert.deepEqual(ended, [undefined]);
});

for (const accepted of [false, true]) {
  test(`a handoff to manual recording ends ordinary listening without cancelling ${accepted ? 'an accepted utterance' : 'anything'}`, async (context) => {
    const config = await loadConfig();
    const vad = await VoiceActivityDetector.create(config.vadModel);
    context.after(() => vad.close());
    const handoff = new AbortController();
    const listening = new AbortController();
    const logs: { stage: string; detail: string }[] = [];

    // Optionally an utterance closes (10 voiced frames, then the 224 ms
    // endpoint) before speech starts again and the handoff arrives mid-word.
    let frames = 0;
    context.mock.method(vad, 'probability', async () => {
      frames++;
      if (frames === 40) {
        handoff.abort();
      }
      if (accepted) {
        return frames <= 10 || frames > 25 ? 0.95 : 0;
      }
      return 0.95;
    });

    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => assert.fail('No capture expected'),
          transcribe: async () => assert.fail('No transcription expected'),
        }),
        router: new UserSensorRouter(
          { detector: testDetector({ detect: async () => assert.fail('No inference expected') }) },
          () => {},
        ),
      },
      () => {},
      listening.signal,
    );
    const submissions = context.mock.method(pipeline, 'submit', () => true);
    const discarded = context.mock.method(pipeline, 'speechDiscarded');

    await listen(vad, pipeline, (stage, detail) => logs.push({ stage, detail }), listening.signal, {
      file: fixture,
      handoff: handoff.signal,
    });

    assert.equal(frames, 40, 'Listening stopped at the handoff');
    // The open candidate is discarded; an earlier utterance keeps its job,
    // whose signal (pause and shutdown) is not aborted by the handoff.
    assert.equal(submissions.mock.callCount(), accepted ? 1 : 0);
    if (accepted) {
      const jobSignal = submissions.mock.calls[0].arguments[1] as AbortSignal;
      assert.equal(jobSignal.aborted, false);
    }
    assert.ok(discarded.mock.callCount() >= 1, 'Any hold is released');
    assert.equal(logs.find((entry) => entry.stage === 'audio-end')?.detail, 'handed-over');
  });
}
