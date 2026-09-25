import assert from 'node:assert/strict';
import test from 'node:test';
import { pcmFrames } from '../../src/sensors/audio/capture.ts';
import { Segmenter, encodeWav } from '../../src/sensors/audio/segmenter.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { loadConfig } from '../../src/config.ts';
import { captureActiveWindow, type RunCommand } from '../../src/sensors/screen/capture.ts';
import { screenshot, signal } from '../helpers.ts';

test('PCM decoding preserves samples across odd chunk boundaries and pads only the final frame', async () => {
  const pcm = Buffer.alloc(1024 + 6);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(i - 257, i * 2);
  }
  async function* chunks() {
    for (let i = 0; i < pcm.length; i += 7) {
      yield pcm.subarray(i, i + 7);
    }
  }
  const frames: Float32Array[] = [];
  for await (const frame of pcmFrames(chunks())) {
    frames.push(frame);
  }
  assert.equal(frames.length, 2);
  const all = [...frames[0], ...frames[1]];
  for (let i = 0; i < 515; i++) {
    assert.equal(all[i], (i - 257) / 32768);
  }
  assert.ok(all.slice(515).every((value) => value === 0));
});

test('VAD keeps short-word speech with its lead-in and still waits for ending silence', () => {
  const silence = new Float32Array(512);
  const speech = new Float32Array(512).fill(0.1);

  // Four to twelve voiced frames represent 128–384 ms of speech: all were
  // discarded by the old 400 ms gate, regardless of confidence or word content.
  for (const voicedFrames of [4, 6, 12]) {
    const segmenter = new Segmenter();
    for (let index = 0; index < 10; index++) {
      assert.equal(segmenter.push(0, silence), undefined);
    }
    for (let index = 0; index < voicedFrames; index++) {
      // A clear onset can continue below the starting threshold, as before.
      assert.equal(segmenter.push(index === 0 ? 0.95 : 0.5, speech), undefined);
    }
    // The provisional endpoint is 7 silent frames (224 ms): 6 frames are not enough.
    for (let index = 0; index < 6; index++) {
      assert.equal(segmenter.push(0, silence), undefined);
    }

    const segment = segmenter.push(0, silence);
    assert.ok(segment, `${voicedFrames * 32} ms of speech must reach transcription`);
    assert.equal(segment.reason, 'silence');
    assert.equal(segment.samples.length, (8 + voicedFrames + 7) * 512);
    assert.deepEqual(segment.samples.slice(0, 8 * 512), new Float32Array(8 * 512));
    assert.deepEqual(segment.samples.slice(8 * 512, 9 * 512), speech);
    assert.equal(segmenter.finish(), undefined, 'The utterance is emitted only once');
  }
});

test('VAD rejects isolated spikes without counting lead-in or trailing silence as speech', () => {
  const silence = new Float32Array(512);
  const sound = new Float32Array(512).fill(0.1);
  const segmenter = new Segmenter();
  for (const voicedFrames of [1, 2, 3]) {
    for (let index = 0; index < 10; index++) {
      assert.equal(segmenter.push(0, silence), undefined);
    }
    for (let index = 0; index < voicedFrames; index++) {
      assert.equal(segmenter.push(0.95, sound), undefined);
    }
    for (let index = 0; index < 25; index++) {
      assert.equal(segmenter.push(0, silence), undefined);
    }
    assert.equal(segmenter.finish(), undefined);
  }

  // Each rejected burst resets the counters. A subsequent short word is kept,
  // including at EOF when there is no final endpoint silence.
  for (let index = 0; index < 4; index++) {
    segmenter.push(0.95, sound);
  }
  const tail = segmenter.finish();
  assert.equal(tail?.reason, 'end');
  assert.equal(tail?.samples.length, 4 * 512);
});

test('VAD caps continuous speech without losing independent subsequent segments', () => {
  const frame = new Float32Array(512).fill(0.1);
  const segmenter = new Segmenter();
  const lengths: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const result = segmenter.push(0.95, frame);
    if (result) {
      assert.equal(result.reason, 'limit');
      lengths.push(result.samples.length);
    }
  }
  assert.equal(lengths.length, 2);
  assert.ok(lengths.every((length) => length <= 16000 * 30 + 512));
});

test('local Silero model loads and classifies digital silence as non-speech', async () => {
  const config = await loadConfig();
  const vad = await VoiceActivityDetector.create(config.vadModel);
  try {
    for (let i = 0; i < 10; i++) {
      assert.ok((await vad.probability(new Float32Array(512))) < 0.35);
    }
  } finally {
    await vad.close();
  }
});

test('ASR WAV format and silence filtering', async () => {
  const wav = encodeWav(new Float32Array([-1, 0, 1]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual(
    [wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)],
    [-32768, 0, 32767],
  );
  assert.equal(
    await new Transcriber({
      workerBinary: '/nonexistent',
      modelDir: '',
      timeoutMs: 100,
    }).transcribe(new Float32Array(16000), signal()),
    '',
  );
});

test('screenshot is cropped to the active window and rejects focus changes during capture', async () => {
  const window = {
    address: '0xabc',
    class: 'editor',
    title: 'Document',
    mapped: true,
    hidden: false,
    at: [-20, 10],
    size: [800, 600],
    monitor: 0,
  };
  let changed = false,
    reads = 0;
  const run: RunCommand = async (file, args) => {
    if (file === 'grim') {
      assert.equal(args[args.indexOf('-g') + 1], '0,10 780x600');
      assert.equal(args.at(-1), '-');
      return screenshot.png;
    }
    if (args.includes('monitors')) {
      return Buffer.from(
        JSON.stringify([{ id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0 }]),
      );
    }
    return Buffer.from(
      JSON.stringify({ ...window, address: changed && ++reads === 2 ? '0xdef' : '0xabc' }),
    );
  };
  assert.equal((await captureActiveWindow(signal(), run)).window.address, '0xabc');
  changed = true;
  await assert.rejects(captureActiveWindow(signal(), run), /changed during capture/);
});
