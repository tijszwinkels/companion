import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureDiagnostics } from '../../src/sensors/audio/capture-diagnostics.ts';
import { audioLevels } from '../../src/sensors/audio/levels.ts';
import {
  ENDPOINT_MS,
  Segmenter,
  type SegmentDiagnostic,
} from '../../src/sensors/audio/segmenter.ts';

test('capture summaries include undetected audio with bounded output and independent windows', () => {
  const reports: Record<string, number>[] = [];
  const diagnostics = new CaptureDiagnostics((stage, detail) => {
    assert.equal(stage, 'audio-levels');
    reports.push(JSON.parse(detail));
  });

  // A sound below Silero's onset threshold still needs evidence in the log.
  for (let index = 0; index < 157; index++) {
    diagnostics.push(new Float32Array(512).fill(0.25), 0.6);
  }
  assert.deepEqual(reports, [{ audioMs: 5024, rms: 0.25, peak: 0.25, peakProbability: 0.6 }]);

  diagnostics.push(new Float32Array(512), 0.01);
  diagnostics.finish();
  diagnostics.finish();
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1], { audioMs: 32, rms: 0, peak: 0, peakProbability: 0.01 });
});

test('VAD reports rejected duration separately from accepted silence, EOF and limit boundaries', () => {
  const reports: SegmentDiagnostic[] = [];
  const segmenter = new Segmenter((entry) => reports.push(entry));
  const frame = new Float32Array(512);

  for (const voicedFrames of [3, 4]) {
    for (let index = 0; index < 10; index++) {
      segmenter.push(0, frame);
    }
    for (let index = 0; index < voicedFrames; index++) {
      segmenter.push(0.9, frame);
    }
    for (let index = 0; index < 25; index++) {
      segmenter.push(0, frame);
    }
  }

  assert.deepEqual(
    reports.map((entry) => entry.outcome),
    ['too-short', 'accepted'],
  );
  assert.deepEqual(
    reports.map((entry) => entry.speechMs),
    [96, 128],
  );
  assert.deepEqual(
    reports.map((entry) => entry.audioMs),
    // 8 preroll frames, the voiced frames, then the 7-frame (224 ms) endpoint.
    [576, 608],
  );
  assert.equal(ENDPOINT_MS, 224);
  assert.ok(reports.every((entry) => entry.trailingSilenceMs === ENDPOINT_MS));
  assert.ok(reports.every((entry) => entry.peakProbability === 0.9));

  for (let index = 0; index < 4; index++) {
    segmenter.push(0.8, frame);
  }
  segmenter.finish();
  assert.equal(reports.at(-1)?.reason, 'end');
  // The earlier candidate closed 18 frames before the loop ended, so this one
  // starts with the full 256 ms preroll before its 128 ms of speech.
  assert.equal(reports.at(-1)?.audioMs, 384);

  for (let index = 0; index < 938; index++) {
    segmenter.push(0.8, frame);
  }
  assert.equal(reports.at(-1)?.reason, 'limit');
  assert.equal(reports.at(-1)?.audioMs, 30016);
  segmenter.finish();
  assert.equal(reports.length, 4, 'Empty EOF does not repeat the last report');
});

test('speech energy measurement is independent of position and rejects nonfinite audio', () => {
  const word = new Float32Array(2048).fill(0.125);
  for (const offset of [0, 1, 511, 4096]) {
    const samples = new Float32Array(16000);
    samples.set(word, offset);
    const levels = audioLevels(samples);
    assert.equal(levels.speechWindowRms, 0.125);
    assert.equal(levels.peak, 0.125);
    assert.equal(levels.rms, Math.sqrt((2048 * 0.125 ** 2) / 16000));
  }

  assert.deepEqual(audioLevels(new Float32Array()), { rms: 0, peak: 0, speechWindowRms: 0 });
  assert.equal(audioLevels(new Float32Array([0.125])).speechWindowRms, 0.125);
  assert.throws(() => audioLevels(new Float32Array([Infinity])), /nonfinite/);
});
