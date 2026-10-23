import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { audioFrames, CaptureLostError } from '../../src/sensors/audio/capture.ts';
import { recordDictation, type DictationSink } from '../../src/sensors/audio/dictation-listener.ts';
import type { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';

// Fake `pw-record` and `ffmpeg` executables on PATH replace the microphone and
// the decoder: each writes synthetic PCM, optionally some stderr, then exits
// with a chosen status or stays alive until killed. No audio device, PipeWire,
// VAD model or ASR is used. Everything lives in a temporary directory.

const FRAME_BYTES = 512 * 2;

interface FakeRecorder {
  frames: number;
  exitCode?: number;
  stderr?: string;
  /** Keep running after writing, like a healthy recorder. */
  hang?: boolean;
}

async function fakeBinaries(context: { after(callback: () => Promise<void> | void): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-capture-lost-test-'));
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath}`;
  context.after(async () => {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  const pidFile = join(directory, 'pid');

  /** Install `name` (pw-record or ffmpeg) with this behavior. */
  const install = async (name: string, recorder: FakeRecorder) => {
    const lines = [
      `#!${process.execPath}`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.stdout.write(Buffer.alloc(${recorder.frames * FRAME_BYTES}, 17));`,
    ];
    if (recorder.stderr) {
      lines.push(`process.stderr.write(${JSON.stringify(recorder.stderr)});`);
    }
    if (recorder.hang) {
      lines.push('setInterval(() => {}, 1 << 30);');
    } else {
      lines.push(`process.stdout.end(() => process.exit(${recorder.exitCode ?? 0}));`);
    }
    await writeFile(join(directory, name), lines.join('\n') + '\n', { mode: 0o700 });
  };

  const childAlive = async () => {
    const pid = Number(await readFile(pidFile, 'utf8'));
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return { directory, install, childAlive };
}

async function drain(frames: AsyncIterable<Float32Array>): Promise<number> {
  let count = 0;
  for await (const _frame of frames) {
    count++;
  }
  return count;
}

test('a microphone recorder that exits with an error is lost capture, after its audio', async (context) => {
  const fake = await fakeBinaries(context);
  await fake.install('pw-record', { frames: 3, exitCode: 1, stderr: 'Host is down' });

  let frames = 0;
  await assert.rejects(
    (async () => {
      for await (const _frame of audioFrames(new AbortController().signal)) {
        frames++;
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof CaptureLostError);
      assert.equal(error.message, 'pw-record exited 1: Host is down');
      assert.ok(error.cause instanceof Error, 'The original failure is kept');
      return true;
    },
  );
  assert.equal(frames, 3, 'Audio before the failure is still delivered');
  assert.equal(await fake.childAlive(), false);
});

test('a microphone recorder that cannot start is lost capture', async (context) => {
  const fake = await fakeBinaries(context);
  // PATH holds only the empty fake directory, so there is no pw-record at all.
  const originalPath = process.env.PATH;
  process.env.PATH = fake.directory;
  context.after(() => {
    process.env.PATH = originalPath;
  });

  await assert.rejects(drain(audioFrames(new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof CaptureLostError);
    assert.match(error.message, /ENOENT/);
    return true;
  });
});

test('a microphone recorder that ends successfully yields its audio and returns', async (context) => {
  const fake = await fakeBinaries(context);
  await fake.install('pw-record', { frames: 4 });

  // The microphone loop and manual recording interpret this end as lost.
  assert.equal(await drain(audioFrames(new AbortController().signal)), 4);
});

test('a requested stop of the microphone is not lost capture and kills the recorder', async (context) => {
  const fake = await fakeBinaries(context);
  await fake.install('pw-record', { frames: 2, hang: true });
  const stop = new AbortController();

  await assert.rejects(
    (async () => {
      for await (const _frame of audioFrames(stop.signal)) {
        stop.abort(Error('paused'));
      }
    })(),
    (error: unknown) => {
      assert.ok(!(error instanceof CaptureLostError));
      assert.match(String(error), /paused/);
      return true;
    },
  );
  assert.equal(await fake.childAlive(), false, 'The recorder exited before the generator ended');
});

test('--wav decoding keeps its plain errors, never lost capture', async (context) => {
  const fake = await fakeBinaries(context);
  await fake.install('ffmpeg', { frames: 2, exitCode: 1, stderr: 'Invalid data' });

  await assert.rejects(
    drain(audioFrames(new AbortController().signal, { file: '/synthetic/input.wav' })),
    (error: unknown) => {
      assert.ok(!(error instanceof CaptureLostError));
      assert.equal((error as Error).message, 'ffmpeg exited 1: Invalid data');
      return true;
    },
  );

  // And a file still simply ends at EOF.
  await fake.install('ffmpeg', { frames: 5 });
  assert.equal(
    await drain(audioFrames(new AbortController().signal, { file: '/synthetic/input.wav' })),
    5,
  );
});

/** Every frame is speech, so the recorded audio becomes one final chunk. */
const speechVad = {
  reset() {},
  async probability() {
    return 0.95;
  },
} as unknown as VoiceActivityDetector;

function recordingSink() {
  const chunks: number[] = [];
  const ended: unknown[] = [];
  const sink: DictationSink = {
    accept: (samples) => chunks.push(samples.length),
    captureEnded: (error) => ended.push(error),
  };
  return { sink, chunks, ended };
}

for (const ending of ['exits with an error', 'ends successfully'] as const) {
  test(`manual recording whose recorder ${ending} ends as lost capture and keeps its words`, async (context) => {
    const fake = await fakeBinaries(context);
    await fake.install('pw-record', {
      frames: 6,
      exitCode: ending === 'exits with an error' ? 1 : 0,
      stderr: 'Broken pipe',
    });
    const { sink, chunks, ended } = recordingSink();

    await recordDictation(
      speechVad,
      sink,
      () => {},
      new AbortController().signal,
      new AbortController().signal,
    );

    assert.deepEqual(chunks, [6 * 512], 'The words before the loss are the final chunk');
    assert.equal(ended.length, 1);
    assert.ok(ended[0] instanceof CaptureLostError);
    assert.match(
      (ended[0] as Error).message,
      ending === 'exits with an error' ? /pw-record exited 1: Broken pipe/ : /ended unexpectedly/,
    );
  });
}

test('manual recording of a file still ends normally at EOF', async (context) => {
  const fake = await fakeBinaries(context);
  await fake.install('ffmpeg', { frames: 3 });
  const { sink, ended } = recordingSink();

  await recordDictation(
    speechVad,
    sink,
    () => {},
    new AbortController().signal,
    new AbortController().signal,
    { file: '/synthetic/input.wav' },
  );

  assert.deepEqual(ended, [undefined]);
});
