/**
 * Real-time endpoint evaluation: public fixture → paced Silero → listener →
 * pipeline → real Parakeet → simulated intent LLM → inert processor.
 *
 * Frames from `test/fixtures/speech.wav` (and clips built from it) are released
 * at the live capture rate of one 32 ms frame per 32 ms, so ASR and inference
 * overlap later speech exactly as they do with a microphone. The intent LLM is
 * simulated with a fixed, abortable latency; everything else is production code.
 * No microphone, screenshot, network model, desktop input or database is used.
 *
 * The script uses only interfaces that also exist before provisional endpoints,
 * so the identical file can run in a checkout of the previous revision to
 * produce the 800 ms baseline. Output: one JSON line per run on stdout.
 *
 *   npx tsx test/bench/speech-timing.ts [--latencies 300,700,1500] [--quick]
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { audioFrames } from '../../src/sensors/audio/capture.ts';
import { listen } from '../../src/sensors/audio/listener.ts';
import { encodeWav, FRAME_SAMPLES, VAD_SETTINGS } from '../../src/sensors/audio/segmenter.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { soundSamples } from '../../src/desktop/sounds.ts';
import { processor, screenshot, testDetector, testSensors } from '../helpers.ts';

const FRAME_MS = FRAME_SAMPLES / 16;
const endpointMs = Math.ceil(VAD_SETTINGS.silenceMs / FRAME_MS) * FRAME_MS;

const argumentsList = process.argv.slice(2);
const latencyArgument = argumentsList[argumentsList.indexOf('--latencies') + 1];
const latencies = argumentsList.includes('--latencies')
  ? latencyArgument.split(',').map(Number)
  : [300, 700, 1500];
const quick = argumentsList.includes('--quick');

const config = await loadConfig();
const signal = AbortSignal.timeout(3_600_000);
const directory = await mkdtemp(join(tmpdir(), 'companion-speech-timing-'));
const transcriber = new Transcriber(config.asr);
const vad = await VoiceActivityDetector.create(config.vadModel);
const fixture = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url));

/** Lowercase words only, for word-level comparison. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: word-level edit distance divided by the reference length. */
function wordErrorRate(hypothesis: string, reference: string): number {
  const actual = words(hypothesis);
  const expected = words(reference);
  let previous = Array.from({ length: actual.length + 1 }, (_value, index) => index);

  for (let row = 1; row <= expected.length; row++) {
    const current = [row];
    for (let column = 1; column <= actual.length; column++) {
      const substitution =
        previous[column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[column] + 1, current[column - 1] + 1));
    }
    previous = current;
  }

  return previous[actual.length] / Math.max(1, expected.length);
}

function milliseconds(ms: number): number {
  return Math.round(ms * 16);
}

/** Join audio pieces; numbers are digital silence of that many milliseconds. */
function clip(pieces: (Float32Array | number)[]): Float32Array {
  const parts = pieces.map((piece) =>
    typeof piece === 'number' ? new Float32Array(milliseconds(piece)) : piece,
  );
  const combined = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  return combined;
}

/** Add `sound` into `samples` at `atMs`, as a speaker cue picked up by the microphone. */
function mix(samples: Float32Array, sound: Float32Array, atMs: number, gain: number): Float32Array {
  const mixed = samples.slice();
  const start = milliseconds(atMs);

  for (let index = 0; index < sound.length && start + index < mixed.length; index++) {
    mixed[start + index] += sound[index] * gain;
  }

  return mixed;
}

interface Run {
  scenario: string;
  llmMs: number;
  route: 'inference' | 'shortcut';
  reference: string;
  samples: Float32Array;
  /** Speech parts that a listener would consider one request, for classification. */
  parts: number;
}

interface RunResult {
  endpointMs: number;
  scenario: string;
  llmMs: number;
  route: string;
  dispatches: { utterance: string; latencyMs: number }[];
  segments: number;
  asrCalls: number;
  superseded: number;
  holds: number;
  releases: number;
  /** Dispatched requests: 1 means the parts were joined, 0 that content was lost. */
  requests: number;
  parts: number;
  wer: number;
  failures: number;
}

// Set SPEECH_TIMING_DEBUG=<scenario> to print that run's pipeline log to stderr.
let pipelineLogs: unknown;

/** Play one clip in real time through the production listener and pipeline. */
async function play(run: Run): Promise<RunResult> {
  const logs: { stage: string; detail: string; at: number }[] = [];
  const dispatches: { utterance: string; at: number }[] = [];

  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: (_frame, _intents, detectSignal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve('SEND'), run.llmMs);
            detectSignal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(detectSignal.reason);
              },
              { once: true },
            );
          }),
      }),
    },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  const send = processor('SEND', async (frame) => {
    dispatches.push({ utterance: frame.utterance, at: performance.now() });
  });
  if (run.route === 'shortcut') {
    // The fixture begins with "And says", so a test prefix exercises the
    // shortcut path with public audio. The payload is the rest of the phrase.
    Object.assign(send, { prefixes: ['and'] });
  }
  send.subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => assert.fail('Use the real transcriber'),
      }),
      transcriber,
      router,
    },
    (stage, detail) => {
      logs.push({ stage, detail, at: performance.now() });
    },
    signal,
  );

  // Live capture never waits for processing. The listener's file mode waits
  // after each segment to avoid drops; disable that here, then drain at EOF.
  const drain = pipeline.idle.bind(pipeline);
  pipeline.idle = async () => {};

  // Release each frame when it would have finished arriving from a microphone.
  const probability = vad.probability.bind(vad);
  const started = performance.now();
  let frameIndex = 0;
  vad.probability = async (frame) => {
    frameIndex++;
    const dueMs = started + frameIndex * FRAME_MS - performance.now();
    if (dueMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, dueMs));
    }
    return probability(frame);
  };

  const path = join(directory, `${run.scenario}.wav`);
  await writeFile(path, encodeWav(run.samples));

  if (process.env.SPEECH_TIMING_DEBUG === run.scenario) {
    pipelineLogs = logs;
  }

  try {
    await listen(
      vad,
      pipeline,
      (stage, detail) => logs.push({ stage, detail, at: performance.now() }),
      signal,
      { file: path },
    );
    await drain();
  } finally {
    vad.probability = probability;
  }

  // The VAD report of each accepted segment gives its trailing silence, so the
  // speech end is the report time minus that silence (frames are paced).
  const speechEnds = logs
    .filter((entry) => entry.stage === 'vad' && JSON.parse(entry.detail).outcome === 'accepted')
    .map((entry) => entry.at - JSON.parse(entry.detail).trailingSilenceMs);

  const results = dispatches.map((dispatch) => {
    const speechEnd = speechEnds.filter((end) => end < dispatch.at).at(-1)!;
    return { utterance: dispatch.utterance, latencyMs: Math.round(dispatch.at - speechEnd) };
  });

  const dispatched = results.map((entry) => entry.utterance).join(' ');

  if (pipelineLogs === logs) {
    for (const entry of logs) {
      console.error(`${Math.round(entry.at - started)} ${entry.stage} ${entry.detail}`);
    }
  }

  return {
    endpointMs,
    scenario: run.scenario,
    llmMs: run.llmMs,
    route: run.route,
    dispatches: results,
    segments: speechEnds.length,
    asrCalls: logs.filter((entry) => entry.stage === 'asr').length,
    superseded: logs.filter(
      (entry) => entry.stage === 'superseded' && /continued/.test(entry.detail),
    ).length,
    holds: logs.filter((entry) => entry.stage === 'hold').length,
    releases: logs.filter((entry) => entry.stage === 'release').length,
    requests: results.length,
    parts: run.parts,
    wer: Number(wordErrorRate(dispatched, run.reference).toFixed(3)),
    failures: pipeline.failures,
  };
}

try {
  const frames: Float32Array[] = [];
  for await (const frame of audioFrames(signal, { file: fixture })) {
    frames.push(frame);
  }
  const source = clip(frames);
  const slice = (fromMs: number, toMs: number) =>
    source.slice(milliseconds(fromMs), milliseconds(toMs));

  await transcriber.start(signal);

  // Two sentences with a natural pause of about 640 ms (VAD: 2048–2688 ms).
  // Sentence A has internal word gaps near 480 ms ("And says, | how …") and
  // 1264 ms ("… how do I | get to Dublin"), where pauses are inserted.
  const sentenceA = slice(0, 2112);
  const sentenceB = slice(2656, 5000);
  const reference = {
    a: await transcriber.transcribe(clip([500, sentenceA, 1000]), signal),
    ab: await transcriber.transcribe(clip([500, sentenceA, 540, sentenceB, 1000]), signal),
  };
  console.error(JSON.stringify({ reference }));

  let runs: Run[] = [];
  const pauses = quick ? [300, 700, 1200] : [150, 300, 450, 600, 750, 900, 1200, 1800];

  for (const llmMs of latencies) {
    // Single utterance, both routes: endpoint latency without any pause.
    runs.push({
      scenario: 'single',
      llmMs,
      route: 'inference',
      reference: reference.a,
      samples: clip([500, sentenceA, 2500]),
      parts: 1,
    });

    for (const pauseMs of pauses) {
      for (const [name, cutMs] of [
        ['comma-pause', 480],
        ['mid-sentence-pause', 1264],
      ] as const) {
        runs.push({
          scenario: `${name}-${pauseMs}`,
          llmMs,
          route: 'inference',
          reference: reference.a,
          samples: clip([500, slice(0, cutMs), pauseMs, slice(cutMs, 2112), 2500]),
          parts: 2,
        });
      }

      runs.push({
        scenario: `two-sentences-${pauseMs}`,
        llmMs,
        route: 'inference',
        reference: reference.ab,
        samples: clip([500, sentenceA, pauseMs, sentenceB, 2500]),
        parts: 2,
      });
    }

    // The unmodified fixture, with its natural ~640 ms pause between sentences.
    runs.push({
      scenario: 'fixture-natural',
      llmMs,
      route: 'inference',
      reference: reference.ab,
      samples: clip([500, source, 2500]),
      parts: 2,
    });
  }

  // The shortcut route has no inference, so it is independent of LLM latency.
  runs.push({
    scenario: 'single-shortcut',
    llmMs: 0,
    route: 'shortcut',
    reference: reference.a,
    samples: clip([500, sentenceA, 2500]),
    parts: 1,
  });
  for (const pauseMs of pauses) {
    runs.push({
      scenario: `shortcut-comma-pause-${pauseMs}`,
      llmMs: 0,
      route: 'shortcut',
      reference: reference.a,
      samples: clip([500, slice(0, 480), pauseMs, slice(480, 2112), 2500]),
      parts: 2,
    });
  }

  // Sounds after the endpoint that must not change the result: the processing
  // cue as picked up by the microphone at three gains, and brief speech bursts
  // (64 and 96 ms of loud fixture speech) that VAD must reject as too short.
  const cueLlmMs = 700;
  const speechEndMs = 500 + 2016;
  for (const gain of [1, 0.3, 0.1]) {
    runs.push({
      scenario: `processing-cue-${gain}`,
      llmMs: cueLlmMs,
      route: 'inference',
      reference: reference.a,
      samples: mix(
        clip([500, sentenceA, 2500]),
        soundSamples('processing'),
        speechEndMs + endpointMs,
        gain,
      ),
      parts: 1,
    });
  }
  for (const burstMs of [64, 96]) {
    for (const afterEndpointMs of [100, 400]) {
      runs.push({
        scenario: `burst-${burstMs}ms-at-${afterEndpointMs}`,
        llmMs: cueLlmMs,
        route: 'inference',
        reference: reference.a,
        samples: mix(
          clip([500, sentenceA, 2500]),
          slice(320, 320 + burstMs),
          speechEndMs + 224 + afterEndpointMs,
          1,
        ),
        parts: 1,
      });
    }
  }

  if (process.env.SPEECH_TIMING_DEBUG) {
    runs = runs.filter((run) => run.scenario === process.env.SPEECH_TIMING_DEBUG);
  }

  for (const run of runs) {
    console.log(JSON.stringify(await play(run)));
  }
} finally {
  await transcriber.close();
  await vad.close();
  await rm(directory, { recursive: true, force: true });
}
