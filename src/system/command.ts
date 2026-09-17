import { execFile } from 'node:child_process';

/**
 * Execute a bounded command without a shell and return its stdout as bytes.
 * Resolve/reject after the child closes, so callers can remove its input files.
 */
export function command(
  file: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 3 * 1024 * 1024,
): Promise<Buffer> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'buffer', maxBuffer },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else if (error) {
          reject(
            Error(
              `${file}: ${error.message} ${stderr.toString().slice(-300)} ${stdout.toString().slice(-300)}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );

    // Killing the child is separate from rejecting the promise: execFile's
    // completion callback above waits until the process and its pipes close.
    const abort = () => {
      child.kill('SIGKILL');
    };

    signal.addEventListener('abort', abort, { once: true });
    child.once('close', () => signal.removeEventListener('abort', abort));

    // Cover cancellation that arrives between the initial check and subscription.
    if (signal.aborted) {
      abort();
    }
  });
}
