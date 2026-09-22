import { spawn } from 'node:child_process';

/**
 * Ask Pi's own registry which models are available. This read-only RPC has no
 * prompt, tools, extensions or saved session, and disables startup networking.
 * Only provider/model identifiers leave this adapter; credentials and provider
 * configuration from the full RPC objects are never exposed to the UI.
 */
export async function piModels(
  executable: string,
  directory: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const child = spawn(
    executable,
    [
      '--mode',
      'rpc',
      '--offline',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-tools',
      '--no-approve',
    ],
    { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let buffer = '';
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};

  try {
    return await new Promise<string[]>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(Error('Pi model discovery timed out')), 10000);
      child.once('error', () => reject(Error('Could not start Pi model discovery')));
      child.once('exit', () => reject(Error('Pi exited before returning available models')));
      child.stdin.on('error', () => reject(Error('Pi model discovery connection closed')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) {
          reject(Error('Pi model discovery exceeded its response limit'));
          return;
        }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.type !== 'response' || response.id !== 'companion-models') {
              continue;
            }
            if (response.success !== true || !Array.isArray(response.data?.models)) {
              reject(Error('Pi could not list available models'));
              return;
            }
            const models = new Set<string>();
            for (const model of response.data.models) {
              if (
                typeof model?.provider !== 'string' ||
                typeof model?.id !== 'string' ||
                !model.provider ||
                !model.id ||
                model.provider.includes('/') ||
                /[\s\x00-\x1f]/u.test(model.provider + model.id) ||
                model.provider.length + model.id.length > 299
              ) {
                continue;
              }
              models.add(`${model.provider}/${model.id}`);
            }
            resolve([...models].sort());
          } catch {
            reject(Error('Pi returned invalid model discovery data'));
            return;
          }
        }
      });
      child.stdin.write(
        JSON.stringify({ type: 'get_available_models', id: 'companion-models' }) + '\n',
      );
      if (signal.aborted) {
        abort();
      }
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    // No extensions/tools run in this process. Reap the direct child before
    // releasing the discovery request, including timeout and disconnect paths.
    child.kill('SIGKILL');
    await closed;
  }
}
