/**
 * Opt-in configuration of the Pi-parity tools for Claude Code conversations.
 *
 * Pi conversations get desktop, OpenRig and web tools from the user's own Pi
 * extensions. Claude conversations get Companion-owned equivalents through
 * the MCP bridge, but only the groups named in `claude-tools.json` in the
 * agent directory:
 *
 * ```json
 * {
 *   "desktop": { "pointerHelper": "/absolute/path/to/pointer-click" },
 *   "openRig": { "directory": "/absolute/path/to/openrig-companion-demo" },
 *   "web": {}
 * }
 * ```
 *
 * - A missing file enables no parity tools. Companion never creates it.
 * - Every section is optional; an absent section leaves its tools out.
 * - Unknown keys and invalid values are errors. The bridge then exits and
 *   the turn fails visibly (Claude Code reports the `companion` MCP server as
 *   failed), rather than silently running with fewer tools.
 *
 * The file is separate from `companion-agent.json` so that its user-approved
 * schema stays unchanged. Claude Code starts the bridge in its own working
 * directory, which Companion sets to the agent directory; the bridge reads the
 * file from there (verified with Claude Code 2.1.280).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const claudeToolsFileName = 'claude-tools.json';

export interface ClaudeToolSettings {
  /** `list_windows`, `focus_window`, `screenshot_active_window`, `click_active_window`. */
  desktop?: {
    /** The `pointer-click` helper. Without it, clicks only support `dry_run`. */
    pointerHelper?: string;
  };
  /** `openrig_submit`, `openrig_progress`, `openrig_preview`. */
  openRig?: {
    /** Checkout of the OpenRig demo whose `lib/` modules implement the tools. */
    directory: string;
  };
  /** Retained-content web tools. */
  web?: Record<string, never>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw Error(`${claudeToolsFileName}: unknown key ${JSON.stringify(key)} in ${where}`);
    }
  }
}

function absolutePath(value: unknown, where: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw Error(`${claudeToolsFileName}: ${where} must be an absolute path`);
  }

  return value;
}

/** Validate a parsed file. Exported for tests. */
export function parseClaudeToolSettings(value: unknown): ClaudeToolSettings {
  if (!isObject(value)) {
    throw Error(`${claudeToolsFileName} must contain a JSON object`);
  }
  rejectUnknownKeys(value, ['desktop', 'openRig', 'web'], 'the file');

  const settings: ClaudeToolSettings = {};

  if (value.desktop !== undefined) {
    if (!isObject(value.desktop)) {
      throw Error(`${claudeToolsFileName}: desktop must be an object`);
    }
    rejectUnknownKeys(value.desktop, ['pointerHelper'], 'desktop');

    settings.desktop = {};
    if (value.desktop.pointerHelper !== undefined) {
      settings.desktop.pointerHelper = absolutePath(
        value.desktop.pointerHelper,
        'desktop.pointerHelper',
      );
    }
  }

  if (value.openRig !== undefined) {
    if (!isObject(value.openRig)) {
      throw Error(`${claudeToolsFileName}: openRig must be an object`);
    }
    rejectUnknownKeys(value.openRig, ['directory'], 'openRig');
    settings.openRig = { directory: absolutePath(value.openRig.directory, 'openRig.directory') };
  }

  if (value.web !== undefined) {
    if (!isObject(value.web)) {
      throw Error(`${claudeToolsFileName}: web must be an object`);
    }
    rejectUnknownKeys(value.web, [], 'web');
    settings.web = {};
  }

  return settings;
}

/**
 * Read `claude-tools.json` from `directory`. A missing file means no parity
 * tools; any other read or validation failure throws.
 */
export async function loadClaudeToolSettings(directory: string): Promise<ClaudeToolSettings> {
  let text: string;
  try {
    text = await readFile(join(directory, claudeToolsFileName), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw Error(`${claudeToolsFileName} is not valid JSON: ${(error as Error).message}`);
  }

  return parseClaudeToolSettings(parsed);
}
