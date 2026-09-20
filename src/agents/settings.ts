import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentProfile, AgentSettings } from './types.ts';

export function agentDirectory(): string {
  return join(homedir(), 'companion', 'agents');
}

export const defaultAgentSettings: AgentSettings = {
  executable: 'pi',
  model: 'openai-codex/gpt-6-astra',
  thinking: 'medium',
};

/** Use the same Qwen provider already registered in Pi for intent detection. */
export const defaultQuickQuestionSettings = {
  model: 'pillar-vllm/qwen3.8-128k',
  thinking: 'off',
} satisfies Pick<AgentSettings, 'model' | 'thinking'>;

/**
 * Read afresh for each question so model edits need no Companion restart.
 * Initialize only when a session is requested, never during graph inspection.
 * An exclusive create preserves user edits and handles simultaneous starters.
 */
export async function loadAgentSettings(
  directory: string,
  profile: AgentProfile = 'coding',
): Promise<AgentSettings> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'companion-agent.json');

  try {
    const defaults = { ...defaultAgentSettings, quickQuestion: defaultQuickQuestionSettings };
    await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', {
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
  if (
    Object.keys(settings).some(
      (key) => !['executable', 'model', 'thinking', 'quickQuestion'].includes(key),
    )
  ) {
    throw Error(`${path}: expected only executable, model, thinking, and quickQuestion`);
  }

  const coding = validateSettings(settings, path);
  const overrides = settings.quickQuestion;
  if (
    overrides !== undefined &&
    (!overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.keys(overrides).some((key) => !['model', 'thinking'].includes(key)))
  ) {
    throw Error(`${path}: quickQuestion must be an object containing only model and thinking`);
  }

  // Existing three-field files keep working. The Pi executable is shared;
  // quick questions have their own defaults, never an implicit Astra fallback.
  const quickQuestion = validateSettings(
    {
      ...coding,
      ...defaultQuickQuestionSettings,
      ...(overrides as Record<string, unknown> | undefined),
    },
    `${path}: quickQuestion`,
  );
  return profile === 'quickQuestion' ? quickQuestion : coding;
}

function validateSettings(settings: Record<string, unknown>, path: string): AgentSettings {
  const keys = ['executable', 'model', 'thinking'];
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

  return {
    executable: settings.executable as string,
    model: settings.model as string,
    thinking: settings.thinking as AgentSettings['thinking'],
  };
}
