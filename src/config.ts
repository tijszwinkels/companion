import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AsrConfig } from './asr.ts';
import type { LlmConfig } from './intent-detector.ts';

export interface Config { llm: LlmConfig; asr: AsrConfig; vadModel: string }

export async function loadConfig(path?: string): Promise<Config> {
  const defaults: Config = {
    llm: { baseUrl: 'http://127.0.0.1:18081/v1', model: 'qwen3.8-128k', timeoutMs: 15000 },
    asr: { binary: `${homedir()}/.local/bin/voxtype`,
      modelDir: `${homedir()}/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8`, timeoutMs: 90000 },
    vadModel: fileURLToPath(new URL('../assets/silero_vad_v5.onnx', import.meta.url)),
  };
  let input: Partial<Config> = {};
  try { input = JSON.parse(await readFile(path ?? 'companion.config.json', 'utf8')); }
  catch (error) { if (path || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Config must be an object');
  for (const key of Object.keys(input)) if (!(key in defaults)) throw Error(`Unknown config key: ${key}`);
  const config = { ...defaults, ...input, llm: { ...defaults.llm, ...input.llm }, asr: { ...defaults.asr, ...input.asr } };
  for (const group of ['llm', 'asr'] as const) {
    if (input[group] !== undefined && (!input[group] || typeof input[group] !== 'object' || Array.isArray(input[group]))) throw Error(`Invalid ${group} config`);
    for (const key of Object.keys(config[group])) if (!(key in defaults[group])) throw Error(`Unknown ${group} key: ${key}`);
    for (const [key, value] of Object.entries(config[group])) {
      if (key === 'timeoutMs') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 180000) throw Error(`Invalid ${group}.timeoutMs`);
      } else if (typeof value !== 'string' || !value.trim()) throw Error(`Invalid ${group}.${key}`);
    }
  }
  const url = new URL(config.llm.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid llm.baseUrl');
  if (typeof config.vadModel !== 'string' || !config.vadModel) throw Error('Invalid vadModel');
  return config;
}
