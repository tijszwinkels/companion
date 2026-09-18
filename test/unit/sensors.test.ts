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

test('VAD rejects short sounds, keeps preroll, ends on silence and caps continuous speech', () => {
  const frame = new Float32Array(512).fill(0.1),
    segmenter = new Segmenter();
  for (let i = 0; i < 10; i++) {
    assert.equal(segmenter.push(0.95, frame), undefined);
  }
  for (let i = 0; i < 30; i++) {
    assert.equal(segmenter.push(0, frame), undefined);
  }
  for (let i = 0; i < 16; i++) {
    segmenter.push(0.95, frame);
  }
  let segment;
  for (let i = 0; i < 25; i++) {
    segment = segmenter.push(0, frame);
  }
  assert.equal(segment?.reason, 'silence');
  assert.ok(segment!.samples.length > 16 * 512);
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
