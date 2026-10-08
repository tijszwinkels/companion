/** Prerecorded, local-only capture → Silero → Parakeet → inert routing regression. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { audioFrames } from '../../src/sensors/audio/capture.ts';
import { listen } from '../../src/sensors/audio/listener.ts';
import { encodeWav, ENDPOINT_MS } from '../../src/sensors/audio/segmenter.ts';
import { LEGACY_ENDPOINT_MS } from '../../src/core/utterance-continuation.ts';
import { Transcriber, type TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { recordingDate } from '../../src/desktop/artifacts.ts';
import { saveEmptyAudioClip } from '../../src/desktop/empty-audio-clips.ts';
import { processor, screenshot, testDetector, testSensors } from '../helpers.ts';

const config = await loadConfig();
const signal = AbortSignal.timeout(120000);
const directory = await mkdtemp(join(tmpdir(), 'companion-short-phrases-'));
const transcriber = new Transcriber(config.asr);
const vad = await VoiceActivityDetector.create(config.vadModel);
const fixture = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url));

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

try {
  const frames: Float32Array[] = [];
  for await (const frame of audioFrames(signal, { file: fixture })) {
    frames.push(frame);
  }
  const source = new Float32Array(frames.length * 512);
  frames.forEach((frame, index) => source.set(frame, index * 512));

  await transcriber.start(signal);
  const baseline = await transcriber.transcribe(source, signal);
  assert.match(baseline, /Dublin/i);

  const cases: {
    name: string;
    samples: Float32Array;
    expected: string;
    allowEmpty?: boolean;
  }[] = [];
  for (const gain of [1, 0.01]) {
    for (const offset of [0, 127, 511]) {
      // The first 500 ms of the public fixture says "and says". Add ordinary
      // lead-in and ending silence before PCM16 encoding and actual decoding.
      const samples = new Float32Array(8000 + offset + 8000 + 16000);
      samples.set(
        source.slice(0, 8000).map((sample) => sample * gain),
        8000 + offset,
      );
      // At this acoustic boundary the delayed VAD onset and ASR still yield
      // no words at offset 127. Keep that limit visible instead of treating
      // every accepted quiet segment as a successful recognition.
      cases.push({
        name: `short-gain-${gain}-offset-${offset}`,
        samples,
        expected: 'and says',
        allowEmpty: gain === 0.01 && offset === 127,
      });
    }
  }
  cases.push({ name: 'long', samples: source, expected: words(baseline) });
  cases.push({ name: 'silence', samples: new Float32Array(32000), expected: '' });

  // Deterministic broadband noise exercises the real VAD, not an assumed low
  // volume. Even above the energy floor, nonspeech must not acquire an ASR job.
  let random = 12345;
  const noise = new Float32Array(32000);
  for (let index = 0; index < noise.length; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    noise[index] = (random / 2 ** 32 - 0.5) * 0.04;
  }
  cases.push({ name: 'noise', samples: noise, expected: '' });

  for (const entry of cases) {
    const path = join(directory, `${entry.name}.wav`);
    await writeFile(path, encodeWav(entry.samples));
    const diagnostics: TranscriptionDiagnostic[] = [];
    const delivered: string[] = [];
    const captured: Float32Array[] = [];
    const vadReports: unknown[] = [];
    let retainedEmpty = 0;
    const router = new UserSensorRouter(
      { detector: testDetector({ detect: async () => 'IGNORE' }) },
      () => {},
    );
    processor('IGNORE', async (frame) => {
      delivered.push(frame.utterance);
    }).subscribe(router);

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
        if (stage === 'asr') {
          diagnostics.push(JSON.parse(detail));
        }
      },
      signal,
      {
        audioCaptured: async (_id, samples) => {
          captured.push(samples.slice());
        },
        emptyAudioCaptured: async (clip) => {
          const id = await saveEmptyAudioClip(directory, clip, () => true);
          const saved = join(directory, 'asr-empty', recordingDate(clip.observedAt), id!);

          // Exercise real empty-result persistence only with this public fixture.
          // The pipeline must still own intact samples until publication finishes.
          assert.deepEqual(await readFile(join(saved, 'audio.wav')), encodeWav(clip.samples));
          const metadata = JSON.parse(await readFile(join(saved, 'metadata.json'), 'utf8'));
          assert.deepEqual(metadata.diagnostic, clip.diagnostic);
          retainedEmpty++;
          return id;
        },
      },
    );

    await listen(
      vad,
      pipeline,
      (stage, detail) => {
        if (stage === 'vad') {
          vadReports.push(JSON.parse(detail));
        }
      },
      signal,
      { file: path },
    );
    await pipeline.idle();
    console.log(
      JSON.stringify({
        name: entry.name,
        vad: vadReports,
        asr: diagnostics,
        delivered,
        retainedEmpty,
      }),
    );
    assert.equal(pipeline.failures, 0, entry.name);
    assert.equal(retainedEmpty, diagnostics.filter((report) => report.outcome === 'empty').length);
    if (!entry.allowEmpty || delivered.length) {
      assert.equal(words(delivered.join(' ')), entry.expected, entry.name);
    }

    if (entry.name === 'silence' || entry.name === 'noise') {
      assert.equal(diagnostics.length, 0, 'Nonspeech must not reach ASR');
    }

    if (entry.name.startsWith('short-gain-0.01')) {
      assert.equal(diagnostics.length, 1);
      // The 224 ms provisional endpoint leaves less trailing silence in the
      // segment, so its whole-buffer RMS alone no longer shows the old defect.
      // The legacy 800 ms segment shape is reproduced below by direct ASR.
      assert.ok(diagnostics[0].speechWindowRms >= 0.0005);
      assert.equal(diagnostics[0].outcome, delivered.length ? 'text' : 'empty');

      // Padded retries of these near-floor phrases mostly produced wrong words
      // during evaluation, so an empty result here must not be retried.
      if (!delivered.length) {
        assert.equal(diagnostics[0].emptyRetry, 'quiet');
      }
    }

    if (entry.name === 'short-gain-0.01-offset-0') {
      // Restore the legacy endpoint's segment shape first: the old whole-buffer
      // guard rejected exactly that segment, while the windowed guard keeps it.
      const legacyShapeMs = LEGACY_ENDPOINT_MS - ENDPOINT_MS;
      for (const addedSilenceMs of [legacyShapeMs, 800, 3200]) {
        const padded = new Float32Array(captured[0].length + addedSilenceMs * 16);
        padded.set(captured[0]);
        const text = await transcriber.transcribe(padded, signal, (diagnostic) => {
          assert.ok(diagnostic.outcome === 'text' || diagnostic.outcome === 'empty');
          assert.equal(diagnostic.speechWindowRms, diagnostics[0].speechWindowRms);
          if (addedSilenceMs === legacyShapeMs) {
            assert.ok(diagnostic.rms < 0.0005, 'The old whole-buffer guard rejected this shape');
          }
          console.log(JSON.stringify({ name: 'extra-silence', addedSilenceMs, asr: diagnostic }));
        });
        // The guard is invariant to both paddings. At +3200 ms the current
        // native model returns empty text; that model limit must not be confused
        // with skipping inference. Accept correct words if the model improves.
        if (addedSilenceMs !== 3200 || text) {
          assert.equal(words(text), 'and says');
        }
      }
    }
  }

  // Loud speech clipped after 1.2 s, framed with ordinary preroll and ending
  // silence. The unpadded first pass returns empty text with the current model;
  // the single padded retry recovers the leading words. The last word is not
  // required: the clip ends inside a word, and recovery can mishear it.
  {
    const clipped = new Float32Array(4096 + 19200 + 12800);
    clipped.set(source.slice(0, 19200), 4096);
    const original = clipped.slice();
    let report: TranscriptionDiagnostic | undefined;
    const text = await transcriber.transcribe(clipped, signal, (diagnostic) => {
      report = diagnostic;
    });
    console.log(JSON.stringify({ name: 'loud-clipped', asr: report, text }));
    assert.deepEqual(clipped, original, 'The retry must not alter the caller’s samples');
    assert.equal(report?.outcome, 'text');
    // Accept a future model that needs no retry, but never a failed recovery.
    assert.ok(report.emptyRetry === 'recovered' || report.emptyRetry === undefined);
    assert.match(words(text), /^and says how do i get/);
  }

  // A longer request after repeated short requests must retain its words, and
  // digital silence must not contaminate the next use of the resident model.
  assert.equal(await transcriber.transcribe(source, signal), baseline);
} finally {
  await transcriber.close();
  await vad.close();
  await rm(directory, { recursive: true, force: true });
}
