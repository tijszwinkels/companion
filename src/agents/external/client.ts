import { connect } from 'node:net';
import { basename } from 'node:path';
import { checkSocket, openSocketDirectory } from './paths.ts';
import { maximumRequestBytes } from './server.ts';

export class ExternalTransportError extends Error {
  constructor(readonly ambiguous: boolean) {
    super(
      ambiguous
        ? 'Connection ended without a confirmed result; do not retry with a new request ID'
        : 'External socket is unavailable or unsafe',
    );
  }
}

/** No retry: reconnecting a mutation is an explicit caller decision. */
export async function requestExternal(
  path: string,
  command: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const data = JSON.stringify(command) + '\n';
  if (Buffer.byteLength(data) > maximumRequestBytes) {
    throw Error('Request exceeds 32 KiB');
  }
  const directory = await openSocketDirectory(path, false).catch(() => {
    throw new ExternalTransportError(false);
  });
  try {
    const target = `/proc/self/fd/${directory.fd}/${basename(path)}`;
    await checkSocket(target).catch(() => {
      throw new ExternalTransportError(false);
    });
    return await new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const socket = connect(target);
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(result!);
        }
      };
      const abort = () => finish(new ExternalTransportError(sent));
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        if (signal.aborted) {
          abort();
          return;
        }
        sent = true;
        socket.write(data);
      });
      socket.on('error', abort);
      socket.on('end', abort);
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 256 * 1024) {
          abort();
          return;
        }
        const end = received.indexOf(10);
        if (end < 0) {
          return;
        }
        try {
          const value: unknown = JSON.parse(received.subarray(0, end).toString('utf8'));
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof (value as Record<string, unknown>).ok !== 'boolean'
          ) {
            throw Error('Invalid response');
          }
          finish(undefined, value as Record<string, unknown>);
        } catch {
          abort();
        }
      });
      if (signal.aborted) {
        abort();
      }
    });
  } finally {
    await directory.close();
  }
}
