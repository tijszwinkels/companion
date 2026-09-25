import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { AgentModelCatalog } from './types.ts';

/**
 * Ask Pi's own registry which models are available. This read-only RPC has no
 * prompt, tools or saved session, and disables startup networking. One explicit
 * metadata-only extension reports Pi-resolved pins; automatic extensions stay off.
 * Only identifiers and supported effort levels leave this adapter; credentials and provider
 * configuration from the full RPC objects are never exposed to the UI.
 */
export async function piModels(
  executable: string,
  directory: string,
  signal: AbortSignal,
): Promise<AgentModelCatalog> {
  signal.throwIfAborted();
  const extension = fileURLToPath(new URL('./model-pins-extension.ts', import.meta.url));
  const child = spawn(
    executable,
    [
      '--mode',
      'rpc',
      '--offline',
      '--no-session',
      '--no-extensions',
      '--extension',
      extension,
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-tools',
      '--no-approve',
    ],
    {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      env: { ...process.env, COMPANION_MODEL_PINS_FD: '3' },
    },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  // The stdio tuple above always creates these two pipes; the extra metadata
  // descriptor prevents Node's three-pipe overload from expressing that type.
  const input = child.stdin!;
  const output = child.stdout!;
  let buffer = '';
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};

  try {
    return await new Promise<AgentModelCatalog>((resolve, reject) => {
      let catalog: Omit<AgentModelCatalog, 'pinned'> | undefined;
      let pins: string[] | undefined;
      let pinsUnavailable = false;
      const complete = () => {
        if (catalog && (pins || pinsUnavailable)) {
          const available = catalog;
          resolve({
            ...available,
            ...(pinsUnavailable
              ? { warning: 'Pi pinned models unavailable; showing all models.' }
              : { pinned: [...new Set(pins)].filter((id) => available.models.includes(id)) }),
          });
        }
      };
      // A wrapper may close our extra descriptor, or Pi may reject the helper.
      // Optional scope metadata must never disable the working RPC catalogue.
      const unavailablePins = () => {
        pinsUnavailable = true;
        complete();
      };
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        if (catalog) {
          unavailablePins();
        } else {
          reject(Error('Pi model discovery timed out'));
        }
      }, 10000);
      child.once('error', () => reject(Error('Could not start Pi model discovery')));
      child.once('exit', () => {
        if (catalog) {
          unavailablePins();
        } else {
          reject(Error('Pi exited before returning available models'));
        }
      });
      input.on('error', () => reject(Error('Pi model discovery connection closed')));
      const metadata = child.stdio[3] as Readable;
      let metadataBuffer = '';
      metadata.setEncoding('utf8');
      metadata.on('error', unavailablePins);
      metadata.on('end', () => {
        if (!pins) {
          unavailablePins();
        }
      });
      metadata.on('data', (chunk: string) => {
        if (pinsUnavailable) {
          return;
        }
        metadataBuffer += chunk;
        if (Buffer.byteLength(metadataBuffer) > 128 * 1024) {
          metadataBuffer = '';
          unavailablePins();
          return;
        }
        if (!metadataBuffer.includes('\n')) {
          return;
        }
        try {
          const response = JSON.parse(metadataBuffer.trim());
          if (
            response.type !== 'companion-model-pins' ||
            !Array.isArray(response.pinned) ||
            response.pinned.some((id: unknown) => typeof id !== 'string')
          ) {
            throw Error('Invalid pinned model metadata');
          }
          pins = response.pinned;
          complete();
        } catch {
          unavailablePins();
        }
      });
      output.setEncoding('utf8');
      output.on('data', (chunk: string) => {
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
            if (response.type === 'extension_error' && response.extensionPath === extension) {
              unavailablePins();
              continue;
            }
            if (response.type !== 'response' || response.id !== 'companion-models') {
              continue;
            }
            if (response.success !== true || !Array.isArray(response.data?.models)) {
              reject(Error('Pi could not list available models'));
              return;
            }
            const models = new Set<string>();
            const thinkingLevels: AgentModelCatalog['thinkingLevels'] = Object.create(null);
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
              const id = `${model.provider}/${model.id}`;
              models.add(id);
              thinkingLevels[id] = getSupportedThinkingLevels(model as Model<Api>);
            }
            catalog = { models: [...models].sort(), thinkingLevels };
            complete();
          } catch {
            reject(Error('Pi returned invalid model discovery data'));
            return;
          }
        }
      });
      input.write(JSON.stringify({ type: 'get_available_models', id: 'companion-models' }) + '\n');
      if (signal.aborted) {
        abort();
      }
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    // Only our metadata extension runs; no conversation tools. Reap the child before
    // releasing the discovery request, including timeout and disconnect paths.
    child.kill('SIGKILL');
    await closed;
  }
}
