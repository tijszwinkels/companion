import { spawn } from 'node:child_process';
import { FRAME_SAMPLES } from './segmenter.ts';

/** Pipe reads may split samples or frames at any byte boundary. */
export async function* pcmFrames(chunks: AsyncIterable<Buffer>): AsyncGenerator<Float32Array> {
  let remainder = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    let offset = 0;
    for (; offset + FRAME_SAMPLES * 2 <= data.length; offset += FRAME_SAMPLES * 2) {
      const frame = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) frame[i] = data.readInt16LE(offset + i * 2) / 32768;
      yield frame;
    }
    remainder = Buffer.from(data.subarray(offset));
  }
  if (remainder.length % 2) throw Error('Truncated PCM sample');
  if (remainder.length) {
    const frame = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < remainder.length / 2; i++) frame[i] = remainder.readInt16LE(i * 2) / 32768;
    yield frame;
  }
}

export async function* audioFrames(signal: AbortSignal, options: { file?: string; device?: string } = {}): AsyncGenerator<Float32Array> {
  signal.throwIfAborted();
  const binary = options.file ? 'ffmpeg' : 'pw-record';
  const args = options.file
    ? ['-nostdin', '-v', 'error', '-i', options.file, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1']
    : ['--raw', '--format', 's16', '--rate', '16000', '--channels', '1', '--latency', '32ms',
      ...(options.device ? ['--target', options.device] : []), '-'];
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let error: Error | undefined, stderr = '';
  child.on('error', value => { error = value; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  const stop = () => { child.kill('SIGKILL'); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    yield* pcmFrames(child.stdout);
    const code = await closed;
    signal.throwIfAborted();
    if (error) throw error;
    if (code !== 0) throw Error(`${binary} exited ${code}: ${stderr}`);
  } finally {
    stop(); await closed; signal.removeEventListener('abort', stop);
  }
}
