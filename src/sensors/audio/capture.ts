import { spawn } from 'node:child_process';

import { FRAME_SAMPLES } from './segmenter.ts';

/**
 * Turn arbitrary pipe chunks into the fixed 512-sample frames Silero expects.
 * Incoming samples are signed PCM16; outgoing floats are normalized to [-1, 1).
 */
export async function* pcmFrames(chunks: AsyncIterable<Buffer>): AsyncGenerator<Float32Array> {
  let remainder = Buffer.alloc(0);

  for await (const chunk of chunks) {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    let offset = 0;

    for (; offset + FRAME_SAMPLES * 2 <= data.length; offset += FRAME_SAMPLES * 2) {
      const frame = new Float32Array(FRAME_SAMPLES);

      for (let i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = data.readInt16LE(offset + i * 2) / 32768;
      }

      yield frame;
    }

    // Copy the small tail so it does not retain the entire pipe chunk in memory.
    remainder = Buffer.from(data.subarray(offset));
  }

  if (remainder.length % 2) {
    throw Error('Truncated PCM sample');
  }

  // At end-of-file, keep the final partial frame and pad its unused samples with
  // silence. Never pad between chunks: that would insert gaps into live speech.
  if (remainder.length) {
    const frame = new Float32Array(FRAME_SAMPLES);

    for (let i = 0; i < remainder.length / 2; i++) {
      frame[i] = remainder.readInt16LE(i * 2) / 32768;
    }

    yield frame;
  }
}

/** Both microphone and file input produce the same mono, 16 kHz PCM stream. */
export async function* audioFrames(
  signal: AbortSignal,
  options: { file?: string; device?: string } = {},
): AsyncGenerator<Float32Array> {
  signal.throwIfAborted();

  const binary = options.file ? 'ffmpeg' : 'pw-record';
  const args = options.file
    ? [
        '-nostdin',
        '-v',
        'error',
        '-i',
        options.file,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        '16000',
        'pipe:1',
      ]
    : [
        '--raw',
        '--format',
        's16',
        '--rate',
        '16000',
        '--channels',
        '1',
        '--latency',
        '32ms',
        ...(options.device ? ['--target', options.device] : []),
        '-',
      ];

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let error: Error | undefined;
  let stderr = '';

  child.on('error', (value) => {
    error = value;
  });
  child.stderr.on('data', (chunk) => {
    // Retain enough diagnostics for an error without growing indefinitely.
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const stop = () => {
    child.kill('SIGKILL');
  };

  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) {
    stop();
  }

  try {
    yield* pcmFrames(child.stdout);

    const code = await closed;
    signal.throwIfAborted();

    if (error) {
      throw error;
    }
    if (code !== 0) {
      throw Error(`${binary} exited ${code}: ${stderr}`);
    }
  } finally {
    // This also runs when the caller breaks out of the async iterator early.
    stop();
    await closed;
    signal.removeEventListener('abort', stop);
  }
}
