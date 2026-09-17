import { execFile } from 'node:child_process';

/** Resolve/reject only after child close, so callers can safely remove its files. */
export function command(file: string, args: string[], signal: AbortSignal, maxBuffer = 3 * 1024 * 1024): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'buffer', maxBuffer }, (error, stdout, stderr) => {
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(Error(`${file}: ${error.message} ${stderr.toString().slice(-300)} ${stdout.toString().slice(-300)}`));
      else resolve(stdout);
    });
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('close', () => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
