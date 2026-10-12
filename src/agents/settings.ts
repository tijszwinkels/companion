import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  agentHarnesses,
  agentThinkingLevels,
  claudeCodeEffortLevels,
  type AgentHarness,
  type AgentProfile,
  type AgentSettings,
  type ClaudeCodeEffort,
  type ClaudeCodeSettings,
} from './types.ts';

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

/** New coding conversations keep using Pi unless the user opts into Claude Code. */
export const defaultCodingHarness: AgentHarness = 'pi';

/** Claude Code settings used when the file has no `claudeCode` object, or omits a field. */
export const defaultClaudeCodeSettings: ClaudeCodeSettings = {
  executable: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
};

/**
 * The whole validated `companion-agent.json`. Every load validates every
 * section, so a mistake in one section also blocks turns that use another.
 * This matches the existing rule for the quick-question section.
 */
export interface AgentConfiguration {
  /** Pi settings for coding conversations (the top-level fields). */
  coding: AgentSettings;
  /** Pi settings for quick questions; always Pi, sharing the Pi executable. */
  quickQuestion: AgentSettings;
  /** Harness for newly created coding conversations only. */
  codingDefaultHarness: AgentHarness;
  /**
   * Pi model given to each newly created Pi coding conversation as its own
   * model choice (`modelOverride`), so a later change affects only newer
   * conversations. Absent: new conversations follow `coding.model` on every
   * turn, as conversations created before this setting existed still do.
   */
  codingDefaultPiModel: string | undefined;
  claudeCode: ClaudeCodeSettings;
}

const topLevelKeys = [
  'executable',
  'model',
  'thinking',
  'quickQuestion',
  'codingDefaultHarness',
  'codingDefaultPiModel',
  'claudeCode',
];

/**
 * Read afresh for each question so model edits need no Companion restart.
 * Initialize only when a session is requested, never during graph inspection.
 * An exclusive create preserves user edits and handles simultaneous starters.
 */
export async function loadAgentSettings(
  directory: string,
  profile: AgentProfile = 'coding',
  initialize = true,
): Promise<AgentSettings> {
  const configuration = await loadAgentConfiguration(directory, initialize);
  return configuration[profile];
}

/** Claude Code settings from the same file, with the same validation and initialization. */
export async function loadClaudeCodeSettings(
  directory: string,
  initialize = true,
): Promise<ClaudeCodeSettings> {
  const configuration = await loadAgentConfiguration(directory, initialize);
  return configuration.claudeCode;
}

/**
 * The contents of a newly created `companion-agent.json`: every section's
 * defaults. `codingDefaultPiModel` is deliberately absent (see its field).
 */
export function initialAgentConfigurationFile(): Record<string, unknown> {
  return {
    ...defaultAgentSettings,
    quickQuestion: { ...defaultQuickQuestionSettings },
    codingDefaultHarness: defaultCodingHarness,
    claudeCode: { ...defaultClaudeCodeSettings },
  };
}

/**
 * Load and validate the whole file. With `initialize`, a missing file is first
 * created with every section's defaults; an existing file is never rewritten.
 * Without `initialize`, a missing file yields the defaults and creates nothing.
 */
export async function loadAgentConfiguration(
  directory: string,
  initialize = true,
): Promise<AgentConfiguration> {
  const path = join(directory, 'companion-agent.json');

  if (initialize) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify(initialAgentConfigurationFile(), null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!initialize && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfiguration();
    }
    throw error;
  }

  return parseAgentConfiguration(value, path);
}

/**
 * Validate the parsed contents of `companion-agent.json`. `path` only labels
 * errors. Shared by the loader and by the writer of new-session defaults, so
 * both accept exactly the same files.
 */
export function parseAgentConfiguration(value: unknown, path: string): AgentConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`${path}: expected an object`);
  }

  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => !topLevelKeys.includes(key))) {
    throw Error(
      `${path}: expected only executable, model, thinking, quickQuestion, codingDefaultHarness, codingDefaultPiModel, and claudeCode`,
    );
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

  const codingDefaultHarness = validateHarness(settings.codingDefaultHarness, path);
  const codingDefaultPiModel = validateDefaultPiModel(settings.codingDefaultPiModel, path);
  const claudeCode = validateClaudeCodeSettings(settings.claudeCode, `${path}: claudeCode`);

  return { coding, quickQuestion, codingDefaultHarness, codingDefaultPiModel, claudeCode };
}

function defaultConfiguration(): AgentConfiguration {
  return {
    coding: { ...defaultAgentSettings },
    quickQuestion: { ...defaultAgentSettings, ...defaultQuickQuestionSettings },
    codingDefaultHarness: defaultCodingHarness,
    codingDefaultPiModel: undefined,
    claudeCode: { ...defaultClaudeCodeSettings },
  };
}

function validateSettings(settings: Record<string, unknown>, path: string): AgentSettings {
  const keys = ['executable', 'model', 'thinking'];

  for (const key of keys) {
    if (typeof settings[key] !== 'string' || !settings[key].trim()) {
      throw Error(`${path}: ${key} must be a nonempty string`);
    }
  }
  if (!agentThinkingLevels.includes(settings.thinking as AgentSettings['thinking'])) {
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

function validateHarness(value: unknown, path: string): AgentHarness {
  if (value === undefined) {
    return defaultCodingHarness;
  }

  if (!agentHarnesses.includes(value as AgentHarness)) {
    throw Error(`${path}: codingDefaultHarness must be "pi" or "claude-code"`);
  }

  return value as AgentHarness;
}

/**
 * The optional Pi model for new coding conversations. It becomes each new
 * conversation's saved `modelOverride`, so it must also satisfy the session
 * store's rules for that field (provider prefix, at most 300 characters);
 * otherwise those conversations would fail to load after a restart.
 */
function validateDefaultPiModel(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim() || /\s/u.test(value)) {
    throw Error(`${path}: codingDefaultPiModel must be a Pi model ID without spaces`);
  }
  if (!value.includes('/')) {
    throw Error(
      `${path}: codingDefaultPiModel must include its provider, for example openai-codex/gpt-6-astra`,
    );
  }
  if (value.length > 300) {
    throw Error(`${path}: codingDefaultPiModel must be at most 300 characters`);
  }

  return value;
}

/**
 * The optional `claudeCode` object may omit any field; omitted fields use the
 * defaults. Present fields must be valid. The model is passed to Claude Code as
 * a separate argument (never through a shell), but a value starting with "-"
 * could still be read as a flag, so it is rejected together with whitespace.
 * Pi's "provider/model" form is rejected so a Pi model cannot be mistaken for
 * a Claude one.
 */
function validateClaudeCodeSettings(value: unknown, path: string): ClaudeCodeSettings {
  if (value === undefined) {
    return { ...defaultClaudeCodeSettings };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`${path} must be an object containing only executable, model, and effort`);
  }

  const overrides = value as Record<string, unknown>;
  if (Object.keys(overrides).some((key) => !['executable', 'model', 'effort'].includes(key))) {
    throw Error(`${path} must be an object containing only executable, model, and effort`);
  }

  const merged: Record<string, unknown> = { ...defaultClaudeCodeSettings, ...overrides };

  for (const key of ['executable', 'model', 'effort']) {
    const field = merged[key];
    if (typeof field !== 'string' || !field.trim()) {
      throw Error(`${path}: ${key} must be a nonempty string`);
    }
  }

  const model = merged.model as string;
  if (model.startsWith('-') || /\s/u.test(model) || model.includes('/')) {
    throw Error(`${path}: model must be a Claude model ID such as claude-opus-5-5`);
  }
  // The session store refuses to read archives whose captured Claude model
  // exceeds this bound, so an over-long configured model must fail here
  // rather than produce conversations that disappear after a restart.
  if (model.length > 300) {
    throw Error(`${path}: model must be at most 300 characters`);
  }

  const effort = merged.effort as string;
  if (!claudeCodeEffortLevels.includes(effort as ClaudeCodeEffort)) {
    throw Error(`${path}: effort must be one of ${claudeCodeEffortLevels.join(', ')}`);
  }

  return {
    executable: merged.executable as string,
    model,
    effort: effort as ClaudeCodeEffort,
  };
}
