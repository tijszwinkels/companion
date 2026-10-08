import assert from 'node:assert/strict';
import fsPromises, { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { CaptureStoragePreference } from '../../src/capture-storage/preference.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { artifactPath } from '../../src/desktop/artifacts.ts';
import { completePng, completeWav } from '../../src/desktop/capture-media.ts';
import { LabelPreviousCorrect } from '../../src/processors/label-previous-correct.ts';
import { encodeWav } from '../../src/sensors/audio/segmenter.ts';
import { listen } from '../../src/sensors/audio/listener.ts';
import type { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { harnessFixture } from '../harness-fixture.ts';
import { deferred, frame, processor, screenshot, testDetector, testSensors } from '../helpers.ts';

// Capture-storage boundaries found by the round-1 independent review
// (reports/review-r1-2026-10-08.md): acquisition-time admission of buffered
// audio, history-agent admission before its read, complete-original checks,
// a failed enable after its file was replaced, and per-entry projection.
// Synthetic PCM/PNG, a fake recorder program and temporary directories only.

type Setup = Awaited<ReturnType<typeof desktopFixture>>;

/** A finished, labelable-looking row whose originals were saved. */
async function savedRow(setup: Setup, id: number, input: 'typed' | 'speech') {
  const activity = setup.runtime.activity;
  activity.transcribed?.({ ...frame, id, input, storage: activity.admitCapture?.() });
  await activity.screenshotCaptured?.(id, screenshot);
  if (input === 'speech') {
    await activity.audioCaptured?.(id, new Float32Array(1600).fill(0.1));
  }
  activity.intentRecognized?.(id, 'IGNORE');
  activity.outcome?.(id, 'ignored');
  activity.finished?.(id);
  return setup.database
    .prepare('SELECT id, observed_at FROM utterances ORDER BY rowid DESC LIMIT 1')
    .get() as { id: string; observed_at: number };
}

async function ignoreRouter(setup: Setup, onIgnored?: (id: number) => Promise<void>) {
  const activity = setup.runtime.activity;
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
    activity,
  );
  processor('IGNORE', async (received) => {
    activity.outcome?.(received.id, 'ignored');
    await onIgnored?.(received.id);
  }).subscribe(router);
  new LabelPreviousCorrect(() => {}, false, activity).subscribe(router);
  await setup.runtime.connectRouter(router);
  return router;
}

/**
 * The real listener with a fake `pw-record` that writes `frames` VAD frames
 * of synthetic PCM at once, and a VAD whose first call is held until the
 * test releases it. Speech is reported for the first four frames.
 */
async function bufferedListener(setup: Setup, context: { after(callback: () => void): void }) {
  const binaries = join(setup.directory, 'bin');
  await mkdir(binaries, { recursive: true });
  await writeFile(
    join(binaries, 'pw-record'),
    `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(11 * 512 * 2, 17));\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath}`;
  context.after(() => {
    process.env.PATH = originalPath;
  });

  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const vad = {
    reset() {},
    async probability() {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return calls <= 4 ? 1 : 0;
    },
  } as unknown as VoiceActivityDetector;
  return { vad, entered, release };
}

for (const variant of ['opt-in during VAD delay', 'on before the recorder started'] as const) {
  test(`T2: buffered recorder audio and the listener (${variant})`, async (context) => {
    const time = { now: 0 };
    const policy = new CaptureStoragePolicy(undefined, () => time.now);
    const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
      captureStorage: policy,
    });
    context.after(setup.close);
    const router = await ignoreRouter(setup);
    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => screenshot,
          transcribe: async () => 'Synthetic buffered speech',
        }),
        router,
      },
      () => {},
      setup.controller.signal,
      setup.runtime.activity,
    );
    setup.runtime.connectPipeline(pipeline);
    const recorder = await bufferedListener(setup, context);

    if (variant === 'on before the recorder started') {
      await policy.setEnabled(true);
      time.now = 5000;
    }
    const listening = listen(
      recorder.vad,
      pipeline,
      () => {},
      setup.controller.signal,
      {},
      setup.runtime.activity,
    );
    await recorder.entered.promise;
    if (variant === 'opt-in during VAD delay') {
      // The recorder already delivered every sample while storage was off.
      time.now = 1000;
      await policy.setEnabled(true);
      time.now = 10000;
    }
    recorder.release.resolve();
    await listening;
    await pipeline.idle();

    const entry = setup.database
      .prepare('SELECT id, capture_storage AS storage, audio_saved AS audio FROM utterances')
      .get() as { id: string; storage: string; audio: number };
    const files = await readdir(join(setup.directory, 'data')).catch(() => []);
    if (variant === 'opt-in during VAD delay') {
      assert.equal(entry.storage, 'off', 'Off-period audio stays unsaved');
      assert.deepEqual(files, [], 'No WAV or PNG at all');
    } else {
      // Control: audio acquired after an opt-in is archived as before.
      assert.equal(entry.storage, 'on');
      assert.equal(entry.audio, 1);
    }
  });
}

test('pipeline admission prefers the listener bound over now minus the audio span', async (context) => {
  const time = { now: 10_000 };
  const policy = new CaptureStoragePolicy(undefined, () => time.now);
  await policy.setEnabled(true); // enabled at 10 000
  const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(setup.close);
  const router = await ignoreRouter(setup);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({ capture: async () => screenshot, transcribe: async () => 'Bound' }),
      router,
    },
    () => {},
    setup.controller.signal,
    setup.runtime.activity,
  );
  time.now = 60_000;
  // 0.1 s of audio, but the listener says its first sample may date from 9 s.
  pipeline.submit(new Float32Array(1600).fill(0.2), undefined, undefined, 0, 9_000);
  await pipeline.idle();
  // Without a bound, the same audio would be admitted from 59.9 s.
  pipeline.submit(new Float32Array(1600).fill(0.2));
  await pipeline.idle();
  const rows = setup.database
    .prepare('SELECT capture_storage AS storage FROM utterances ORDER BY rowid')
    .all() as { storage: string }[];
  assert.deepEqual(
    rows.map((row) => row.storage),
    ['off', 'on'],
  );
});

for (const remote of [false, true]) {
  for (const sequence of ['off→on', 'on→off→on'] as const) {
    test(`T2/W2: a ${remote ? 'phone' : 'desktop'} history-agent start keeps the admission from before its read (${sequence})`, async (context) => {
      const policy = CaptureStoragePolicy.enabledForTesting();
      const harness = await harnessFixture(context, { captureStorage: policy });
      const setup = await desktopFixture(async () => Buffer.alloc(0), harness.sessions, {
        captureStorage: policy,
      });
      context.after(setup.close);
      const entry = await savedRow(setup, 1, 'typed');
      if (remote) {
        setup.send({ action: 'client-role', role: 'remote' });
        await setup.reply('client-role');
      }
      if (sequence === 'off→on') {
        await policy.setEnabled(false);
      }

      // Hold only the history read, at its real asynchronous boundary.
      const history = (
        setup.runtime as unknown as {
          history: { recordedFrame(id: string): Promise<typeof frame> };
        }
      ).history;
      const original = history.recordedFrame.bind(history);
      const entered = deferred<void>();
      const release = deferred<void>();
      history.recordedFrame = async (id) => {
        entered.resolve();
        await release.promise;
        return original(id);
      };
      setup.send({ action: 'start-history-agent', id: entry.id });
      await entered.promise;
      if (sequence === 'on→off→on') {
        await policy.setEnabled(false);
      }
      await policy.setEnabled(true);
      release.resolve();
      assert.equal((await setup.reply('start-history-agent')).result, 'started');
      await harness.sessions.idle();

      // The live request still uses the saved original; no new copy is kept.
      assert.equal(harness.runs.length, 1);
      assert.deepEqual(harness.runs[0].png, screenshot.png);
      const files = await readdir(join(harness.directory, '.companion-sessions'));
      assert.deepEqual(
        files.filter((name) => name.endsWith('.png')),
        [],
      );

      // Control: a request made while on (and staying on) keeps its copy.
      history.recordedFrame = original;
      setup.send({ action: 'start-history-agent', id: entry.id });
      assert.equal((await setup.reply('start-history-agent')).result, 'started');
      await harness.sessions.idle();
      const after = await readdir(join(harness.directory, '.companion-sessions'));
      assert.equal(after.filter((name) => name.endsWith('.png')).length, 1);
    });
  }
}

test('F3: truncated or damaged originals are refused for direct and spoken labels', async (context) => {
  const setup = await desktopFixture(async () => Buffer.alloc(0));
  context.after(setup.close);
  await ignoreRouter(setup);

  const damages: [string, 'typed' | 'speech', 'screenshots' | 'audio', Buffer][] = [
    ['PNG signature only', 'typed', 'screenshots', screenshot.png.subarray(0, 8)],
    ['PNG without IEND', 'typed', 'screenshots', screenshot.png.subarray(0, 45)],
    [
      'PNG with a damaged CRC',
      'typed',
      'screenshots',
      Buffer.concat([
        screenshot.png.subarray(0, 29),
        Buffer.from([0]),
        screenshot.png.subarray(30),
      ]),
    ],
    ['WAV signature only', 'speech', 'audio', Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')],
    [
      'WAV cut inside its data',
      'speech',
      'audio',
      encodeWav(new Float32Array(1600).fill(0.1)).subarray(0, 100),
    ],
  ];
  let frameId = 10;
  for (const [name, input, kind, content] of damages) {
    const entry = await savedRow(setup, frameId++, input);
    await writeFile(artifactPath(setup.directory, entry.id, entry.observed_at, kind), content);
    setup.send({ action: 'label-history', id: entry.id, correct: true });
    const reply = await setup.reply('label-history');
    assert.equal(reply.type, 'error', name);
    assert.match(reply.message!, /unavailable/, name);
  }

  // A spoken label targeting a damaged entry is skipped, not "labeled".
  const target = await savedRow(setup, 50, 'speech');
  await writeFile(
    artifactPath(setup.directory, target.id, target.observed_at, 'audio'),
    Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'),
  );
  const activity = setup.runtime.activity;
  activity.transcribed?.({
    ...frame,
    id: 51,
    utterance: 'label previous correct',
    input: 'typed',
    storage: activity.admitCapture?.(),
  });
  activity.intentRecognized?.(51, 'LABEL_PREVIOUS_CORRECT');
  const result = await activity.labelPrevious?.(51, true);
  assert.deepEqual(result, {
    outcome: 'skipped',
    reason: 'The original audio for this entry is unavailable',
  });
  activity.finished?.(51);
  assert.equal(setup.database.prepare('SELECT COUNT(*) AS n FROM intent_feedback').get()!.n, 0);

  // The checks accept what Companion writes, including bytes after IEND.
  assert.ok(completePng(screenshot.png));
  assert.ok(completePng(Buffer.concat([screenshot.png, Buffer.from('trailer')])));
  assert.ok(completeWav(encodeWav(new Float32Array(3).fill(0.5))));
  assert.ok(!completeWav(encodeWav(new Float32Array(0))), 'An empty recording is not usable');
});

test('F3/U3: partly saved entries are projected as not labelable and without a screenshot', async (context) => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
    captureStorage: policy,
  });
  context.after(setup.close);
  const activity = setup.runtime.activity;

  // A WAV published before an Off, its PNG refused after it.
  activity.transcribed?.({ ...frame, id: 1, input: 'speech', storage: activity.admitCapture?.() });
  await activity.audioCaptured?.(1, new Float32Array(160).fill(0.1));
  await policy.setEnabled(false);
  await activity.screenshotCaptured?.(1, screenshot);
  activity.intentRecognized?.(1, 'IGNORE');
  activity.outcome?.(1, 'ignored');
  activity.finished?.(1);
  await policy.setEnabled(true);
  // A complete legacy-like typed entry, for contrast.
  await savedRow(setup, 2, 'typed');

  await waitFor(
    () => setup.messages.filter((message) => message.type === 'activity-entry').length === 2,
  );
  const cards = setup.messages.filter((message) => message.type === 'activity-entry');
  const partial = cards[0].entry!;
  assert.equal(partial.captureStorage, 'on');
  assert.equal(partial.screenshotSaved, false);
  assert.equal(partial.audioSaved, true);
  assert.equal(partial.labelingUnavailable, 'The original screenshot for this entry was not saved');
  const complete = cards[1].entry!;
  assert.deepEqual(
    [complete.screenshotSaved, complete.audioSaved, complete.labelingUnavailable],
    [true, false, null],
    'Typed input needs no WAV',
  );

  // A history question needs the screenshot; it is refused, never substituted.
  setup.send({ action: 'start-history-agent', id: partial.id });
  assert.equal((await setup.reply('start-history-agent')).type, 'error');
});

for (const failure of ['after rename', 'before rename'] as const) {
  test(`P4: a failed enable ${failure} reports what a restart would load`, async (context) => {
    const setup = await desktopFixture(async () => Buffer.alloc(0));
    context.after(setup.close);
    const path = join(setup.directory, 'capture-storage.json');
    const policy = new CaptureStoragePolicy(new CaptureStoragePreference(path));
    await policy.setEnabled(false);

    const originalOpen = fsPromises.open;
    const patched = mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof originalOpen>) => {
        const target = String(args[0]);
        if (failure === 'before rename' && target.endsWith('.tmp')) {
          throw Error('Synthetic temporary-file failure');
        }
        const handle = await originalOpen(...args);
        if (failure === 'after rename' && target === setup.directory) {
          handle.sync = async () => {
            throw Error('Synthetic directory fsync failure after rename');
          };
        }
        return handle;
      },
    );
    syncBuiltinESMExports();
    context.after(() => {
      patched.mock.restore();
      syncBuiltinESMExports();
    });

    await assert.rejects(policy.setEnabled(true), /could not be saved/);
    patched.mock.restore();
    syncBuiltinESMExports();
    assert.equal(policy.enabled, false, 'Never effectively on after a failed enable');

    const restarted = new CaptureStoragePolicy(new CaptureStoragePreference(path));
    await restarted.load();
    if (failure === 'after rename') {
      assert.equal(restarted.enabled, true, 'The new file is already visible');
      assert.equal(policy.state.saved, false);
      assert.match(policy.state.warning, /may now say on.*restart/);
    } else {
      assert.equal(restarted.enabled, false);
      assert.deepEqual(policy.state, { enabled: false, pending: '', saved: true, warning: '' });
    }
  });
}

// ---------------------------------------------------------------------------
// Round 2 (reports/review-r2-2026-10-08.md)
// ---------------------------------------------------------------------------

/**
 * The real listener in file mode (--wav) with a fake `ffmpeg` that decodes
 * two utterances at once, and a VAD whose first call is held. Frames 61–64
 * and 132–135 are speech; all samples are delivered before opt-in.
 */
async function bufferedFile(setup: Setup, context: { after(callback: () => void): void }) {
  const binaries = join(setup.directory, 'bin');
  await mkdir(binaries, { recursive: true });
  await writeFile(
    join(binaries, 'ffmpeg'),
    `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(142 * 512 * 2, 17));\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath}`;
  context.after(() => {
    process.env.PATH = originalPath;
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const vad = {
    reset() {},
    async probability() {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return (calls > 60 && calls <= 64) || (calls > 131 && calls <= 135) ? 1 : 0;
    },
  } as unknown as VoiceActivityDetector;
  return { vad, entered, release };
}

for (const variant of [
  'opt-in during decoding',
  'off→on during decoding',
  'same-clock opt-in',
  'same-clock off→on',
  'opt-in between segments',
  'off→on between segments',
  'on before',
] as const) {
  test(`T2: a --wav replay is admitted as of its start (${variant})`, async (context) => {
    const time = { now: 0 };
    const policy = new CaptureStoragePolicy(undefined, () => time.now);
    const startsOff = variant.includes('opt-in');
    if (!startsOff) {
      await policy.setEnabled(true);
    }
    const setup = await desktopFixture(async () => Buffer.alloc(0), undefined, {
      captureStorage: policy,
    });
    context.after(setup.close);
    const betweenSegments = variant.endsWith('between segments');
    const router = await ignoreRouter(setup, async (id) => {
      if (betweenSegments && id === 1) {
        time.now = 1200;
        if (!startsOff) {
          await policy.setEnabled(false);
        }
        await policy.setEnabled(true);
      }
    });
    const pipeline = new SensorPipeline(
      {
        ...testSensors({ capture: async () => screenshot, transcribe: async () => 'Replayed' }),
        router,
      },
      () => {},
      setup.controller.signal,
      setup.runtime.activity,
    );
    setup.runtime.connectPipeline(pipeline);
    const decoder = await bufferedFile(setup, context);

    time.now = 500;
    const listening = listen(
      decoder.vad,
      pipeline,
      () => {},
      setup.controller.signal,
      { file: join(setup.directory, 'synthetic.wav') },
      setup.runtime.activity,
    );
    await decoder.entered.promise;
    // A timestamp alone can revive a replay if a quick transition shares
    // the start clock tick. Retaining the original token must cover it too.
    time.now = variant.startsWith('same-clock') ? 500 : 1000;
    if (!betweenSegments && variant !== 'on before') {
      if (!startsOff) {
        await policy.setEnabled(false);
      }
      await policy.setEnabled(true);
    }
    time.now = 1100;
    decoder.release.resolve();
    await listening;
    await pipeline.idle();

    const entries = setup.database
      .prepare(
        'SELECT capture_storage AS storage, audio_saved AS audio FROM utterances ORDER BY rowid',
      )
      .all() as { storage: string; audio: number }[];
    assert.equal(entries.length, 2, 'Live processing keeps every file segment');
    const expected =
      variant === 'on before'
        ? ['on', 'on']
        : variant === 'off→on between segments'
          ? ['on', 'off']
          : ['off', 'off'];
    assert.deepEqual(
      entries.map((entry) => entry.storage),
      expected,
    );
    assert.deepEqual(
      entries.map((entry) => entry.audio),
      expected.map((storage) => Number(storage === 'on')),
    );
    if (expected.every((storage) => storage === 'off')) {
      assert.deepEqual(await readdir(join(setup.directory, 'data')).catch(() => []), []);
    }
  });
}

/** One synthetic PNG chunk, including its CRC. */
function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody));
  return Buffer.concat([length, typeAndBody, crc]);
}

/** A PNG from raw (already filtered) image bytes, with correct CRCs. */
function png(
  header: { width: number; height: number; depth: number; colourType: number },
  raw: Buffer,
  options: { interlace?: number; palette?: boolean; compression?: number } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr[8] = header.depth;
  ihdr[9] = header.colourType;
  ihdr[10] = options.compression ?? 0;
  ihdr[12] = options.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    ...(options.palette ? [pngChunk('PLTE', Buffer.alloc(3))] : []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('F3: complete PNG/WAV checks cover encoding, compressed data and the RIFF extent', () => {
  const rgba = { width: 3, height: 2, depth: 8, colourType: 6 };
  const rgbaRaw = Buffer.alloc(2 * (1 + 3 * 4));
  assert.ok(completePng(png(rgba, rgbaRaw)), 'Valid RGBA');
  // Adam7, 3 × 3 grey: pass rows 2 + 2 + 3 + 4 + 4 bytes including filters.
  const grey = { width: 3, height: 3, depth: 8, colourType: 0 };
  assert.ok(completePng(png(grey, Buffer.alloc(15), { interlace: 1 })), 'Valid interlaced');
  assert.ok(
    completePng(png({ ...grey, colourType: 3 }, Buffer.alloc(3 * 4), { palette: true })),
    'Valid palette image',
  );

  assert.ok(!completePng(png(rgba, rgbaRaw, { compression: 1 })), 'Unsupported compression');
  assert.ok(!completePng(png({ ...rgba, depth: 4 }, rgbaRaw)), 'Invalid depth for RGBA');
  assert.ok(!completePng(png(rgba, rgbaRaw, { interlace: 2 })), 'Unknown interlace');
  assert.ok(!completePng(png({ ...grey, colourType: 3 }, Buffer.alloc(12))), 'Palette missing');
  assert.ok(!completePng(png(rgba, rgbaRaw.subarray(1))), 'Image data too short');
  assert.ok(!completePng(png(rgba, Buffer.concat([rgbaRaw, Buffer.alloc(1)]))), 'Too long');
  const badFilter = Buffer.from(rgbaRaw);
  badFilter[0] = 9;
  assert.ok(!completePng(png(rgba, badFilter)), 'Unknown scanline filter');
  assert.ok(!completePng(png({ ...rgba, width: 0x7fffffff }, rgbaRaw)), 'Oversized image claim');
  assert.ok(!completePng(png(rgba, Buffer.alloc(100_000))), 'Inflation stops at the declared size');

  const valid = png(rgba, rgbaRaw);
  const signature = valid.subarray(0, 8);
  const header = valid.subarray(8, 33);
  const image = valid.subarray(33, valid.length - 12);
  const end = valid.subarray(valid.length - 12);
  const assemble = (...chunks: Buffer[]) => Buffer.concat([signature, header, ...chunks, end]);
  assert.ok(!completePng(assemble(header, image)), 'Repeated IHDR');
  assert.ok(
    !completePng(assemble(pngChunk('BADX', Buffer.alloc(0)), image)),
    'Unknown critical chunk',
  );
  assert.ok(!completePng(assemble(pngChunk('PLTE', Buffer.alloc(2)), image)), 'Malformed palette');
  assert.ok(!completePng(assemble(image, pngChunk('PLTE', Buffer.alloc(3)))), 'Palette after data');
  assert.ok(!completePng(assemble(image, pngChunk('IEND', Buffer.alloc(1)))), 'Nonempty IEND');
  const compressed = deflateSync(rgbaRaw);
  const first = pngChunk('IDAT', compressed.subarray(0, 3));
  const second = pngChunk('IDAT', compressed.subarray(3));
  assert.ok(completePng(assemble(first, second)), 'Consecutive IDAT chunks');
  assert.ok(
    !completePng(assemble(first, pngChunk('tEXt', Buffer.from('k\0v')), second)),
    'Interrupted IDAT run',
  );
  assert.ok(
    !completePng(assemble(pngChunk('IDAT', Buffer.concat([compressed, Buffer.from([0])])))),
    'Extra bytes after the compressed stream',
  );

  // Valid chunk CRC around a damaged zlib checksum.
  const damaged = png(rgba, rgbaRaw);
  const idat = damaged.indexOf('IDAT');
  const length = damaged.readUInt32BE(idat - 4);
  damaged[idat + 4 + length - 1] ^= 1;
  damaged.writeUInt32BE(crc32(damaged.subarray(idat, idat + 4 + length)), idat + 4 + length);
  assert.ok(!completePng(damaged), 'Broken zlib checksum');

  const wav = encodeWav(new Float32Array(1600).fill(0.1));
  assert.ok(completeWav(wav));
  const outside = Buffer.from(wav);
  outside.writeUInt32LE(4, 4);
  assert.ok(!completeWav(outside), 'fmt/data outside the declared RIFF size');
  const wrongRate = Buffer.from(wav);
  wrongRate.writeUInt32LE(48000, 28);
  assert.ok(!completeWav(wrongRate), 'Inconsistent byte rate');
  const wrongAlignment = Buffer.from(wav);
  wrongAlignment.writeUInt16LE(4, 32);
  assert.ok(!completeWav(wrongAlignment), 'Inconsistent sample alignment');
  const incompleteContainer = Buffer.concat([wav, Buffer.from([1])]);
  incompleteContainer.writeUInt32LE(incompleteContainer.length - 8, 4);
  assert.ok(!completeWav(incompleteContainer), 'Incomplete chunk after valid data');
});

for (const loss of ['removed PNG', 'damaged PNG', 'removed WAV', 'damaged WAV'] as const) {
  test(`F3/U3: an original lost after saving is reflected in refreshed Activity (${loss})`, async (context) => {
    const setup = await desktopFixture(async () => Buffer.alloc(0));
    context.after(setup.close);
    await ignoreRouter(setup);
    const audio = loss.endsWith('WAV');
    const entry = await savedRow(setup, 1, audio ? 'speech' : 'typed');
    const kind = audio ? 'audio' : 'screenshots';
    const path = artifactPath(setup.directory, entry.id, entry.observed_at, kind);
    if (loss.startsWith('damaged')) {
      await writeFile(
        path,
        audio ? Buffer.from('RIFF\0\0\0\0WAVE', 'latin1') : screenshot.png.subarray(0, 40),
      );
    } else {
      await rm(path);
    }

    await waitFor(() =>
      setup.messages.some((message) => message.type === 'state' && message.activityHistoryCount),
    );
    const state = setup.messages.filter((message) => message.type === 'state').at(-1)!;
    setup.send({
      action: 'activity-history',
      sessionId: state.activitySessionId,
      after: 0,
      through: state.activityHistoryCount,
    });
    const reply = await setup.reply('activity-history');
    const page = reply.result as {
      entries: {
        screenshotSaved: boolean;
        screenshotUnavailable: boolean;
        labelingUnavailable: string | null;
      }[];
    };
    const [card] = page.entries;
    assert.equal(card.screenshotSaved, true, 'Publication history is kept');
    assert.match(card.labelingUnavailable!, /unavailable/);
    assert.equal(card.screenshotUnavailable, !audio);

    // A refusal followed by another page read stays truthful as well.
    setup.send({ action: 'label-history', id: entry.id, correct: true });
    const refusal = await setup.reply('label-history');
    assert.equal(refusal.type, 'error');
    assert.match(refusal.message!, audio ? /audio.*unavailable/ : /screenshot.*unavailable/);
    setup.send({
      action: 'activity-history',
      sessionId: state.activitySessionId,
      after: 0,
      through: state.activityHistoryCount,
    });
    const refreshed = (await setup.reply('activity-history')).result as typeof page;
    assert.equal(refreshed.entries[0].labelingUnavailable, card.labelingUnavailable);
    assert.equal(setup.database.prepare('SELECT COUNT(*) AS n FROM intent_feedback').get()!.n, 0);

    // Other clients receive the corrected card too.
    await waitFor(() =>
      setup.messages.some(
        (message) =>
          message.type === 'activity-entry' &&
          message.entry?.id === entry.id &&
          message.entry.labelingUnavailable !== null,
      ),
    );
    const history = (
      setup.runtime as unknown as { history: { recordedFrame(id: string): Promise<typeof frame> } }
    ).history;
    if (!audio) {
      await assert.rejects(history.recordedFrame(entry.id), /screenshot/i);
    } else {
      assert.deepEqual(
        (await history.recordedFrame(entry.id)).screenshot.png,
        screenshot.png,
        'A history question only needs the intact screenshot',
      );
    }

    // Revalidating a restored original updates current availability without
    // changing the durable publication record or creating a new capture.
    await writeFile(path, audio ? encodeWav(new Float32Array(1600).fill(0.1)) : screenshot.png);
    setup.send({
      action: 'activity-history',
      sessionId: state.activitySessionId,
      after: 0,
      through: state.activityHistoryCount,
    });
    const restored = (await setup.reply('activity-history')).result as typeof page;
    assert.equal(restored.entries[0].labelingUnavailable, null);
    assert.equal(restored.entries[0].screenshotUnavailable, false);
    assert.equal(restored.entries[0].screenshotSaved, true);
  });
}
