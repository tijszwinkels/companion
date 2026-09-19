import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { AsrConfig } from './sensors/audio/transcriber.ts';
import type { LlmConfig } from './core/intent-detector.ts';

export interface Config {
  llm: LlmConfig;
  asr: AsrConfig;
  vadModel: string;
}

/** Read optional overrides and return a complete, validated configuration. */
export async function loadConfig(path?: string): Promise<Config> {
  const defaults: Config = {
    llm: { baseUrl: 'http://127.0.0.1:18081/v1', model: 'qwen3.8-128k', timeoutMs: 15000 },
    asr: {
      workerBinary: fileURLToPath(
        new URL('../native/asr-worker/target/release/companion-asr-worker', import.meta.url),
      ),
      modelDir: `${homedir()}/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8`,
      timeoutMs: 90000,
    },
    // Resolve the bundled model relative to the code, not the launch directory.
    vadModel: fileURLToPath(new URL('../assets/silero_vad_v5.onnx', import.meta.url)),
  };

  let input: Partial<Config> = {};

  try {
    input = JSON.parse(await readFile(path ?? 'companion.config.json', 'utf8'));
  } catch (error) {
    // The default file is optional. An explicitly requested file must exist.
    if (path || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Error('Config must be an object');
  }

  // Reject misspelled keys rather than silently falling back to a default.
  for (const key of Object.keys(input)) {
    if (!(key in defaults)) {
      throw Error(`Unknown config key: ${key}`);
    }
  }

  if (input.asr && typeof input.asr === 'object' && 'binary' in input.asr) {
    throw Error(
      'asr.binary was replaced by asr.workerBinary; remove asr.binary and run npm run asr:build',
    );
  }

  // Merge each nested group independently so a single override keeps its peers.
  const config = {
    ...defaults,
    ...input,
    llm: { ...defaults.llm, ...input.llm },
    asr: { ...defaults.asr, ...input.asr },
  };

  for (const group of ['llm', 'asr'] as const) {
    if (
      input[group] !== undefined &&
      (!input[group] || typeof input[group] !== 'object' || Array.isArray(input[group]))
    ) {
      throw Error(`Invalid ${group} config`);
    }

    for (const key of Object.keys(config[group])) {
      if (!(key in defaults[group])) {
        throw Error(`Unknown ${group} key: ${key}`);
      }
    }

    for (const [key, value] of Object.entries(config[group])) {
      if (key === 'timeoutMs') {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 100 ||
          value > 180000
        ) {
          throw Error(`Invalid ${group}.timeoutMs`);
        }
      } else if (typeof value !== 'string' || !value.trim()) {
        throw Error(`Invalid ${group}.${key}`);
      }
    }
  }

  // Authentication is supplied separately through COMPANION_LLM_API_KEY.
  const url = new URL(config.llm.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw Error('Invalid llm.baseUrl');
  }

  if (typeof config.vadModel !== 'string' || !config.vadModel) {
    throw Error('Invalid vadModel');
  }

  return config;
}
