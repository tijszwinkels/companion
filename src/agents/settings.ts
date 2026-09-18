import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentSettings } from './types.ts';

export function agentDirectory(): string {
  return join(homedir(), 'companion', 'agents');
}

export const defaultAgentSettings: AgentSettings = {
  executable: 'pi',
  model: 'openai-codex/gpt-6-astra',
  thinking: 'medium',
};

/**
 * Read afresh for each question so model edits need no Companion restart.
 * Initialize only when a session is requested, never during graph inspection.
 * An exclusive create preserves user edits and handles simultaneous starters.
 */
export async function loadAgentSettings(directory: string): Promise<AgentSettings> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'companion-agent.json');

  try {
    await writeFile(path, JSON.stringify(defaultAgentSettings, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`${path}: expected an object`);
  }

  const settings = value as Record<string, unknown>;
  const keys = ['executable', 'model', 'thinking'];
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  if (Object.keys(settings).some((key) => !keys.includes(key))) {
    throw Error(`${path}: expected only executable, model, and thinking`);
  }
  for (const key of keys) {
    if (typeof settings[key] !== 'string' || !settings[key].trim()) {
      throw Error(`${path}: ${key} must be a nonempty string`);
    }
  }
  if (!levels.includes(settings.thinking as string)) {
    throw Error(`${path}: unsupported thinking level`);
  }
  if (!(settings.model as string).includes('/')) {
    throw Error(`${path}: model must include its provider, for example openai-codex/gpt-6-astra`);
  }

  return settings as unknown as AgentSettings;
}
