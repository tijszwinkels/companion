/**
 * Defaults for newly created coding conversations, as shown and changed by the
 * desktop panel's "Start a coding session" card.
 *
 * Input: the agent directory holding `companion-agent.json`, and for a change
 * the harness, optionally that harness's default model, and the revision the
 * panel was showing. Output: the defaults as stored afterwards.
 *
 * Only three keys are ever written: `codingDefaultHarness`, the Pi default
 * `codingDefaultPiModel` and `claudeCode.model`. Every other key, including
 * the Pi executable/model/thinking, `quickQuestion` and `claudeCode.effort`,
 * is copied unchanged. Each of these keys applies to new conversations only;
 * see `AgentConfiguration` and `AgentSessions` for how existing conversations
 * keep their harness and model.
 *
 * Concurrency: the user may edit the file by hand at any time. A change is
 * refused when the file no longer matches the revision the panel showed, and
 * the file is compared once more just before it is replaced. The replacement
 * itself is atomic (temporary file, then rename), so a reader never sees a
 * partial file. A hand edit landing in the few microseconds between that last
 * comparison and the rename would still be replaced; that remaining window is
 * accepted. Callers serialize their own changes (see `AgentSessions`).
 */

import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  initialAgentConfigurationFile,
  parseAgentConfiguration,
  type AgentConfiguration,
} from './settings.ts';
import type { AgentHarness } from './types.ts';

/** The defaults the panel shows for the next new coding conversation. */
export interface CodingDefaults {
  harness: AgentHarness;
  /** `codingDefaultPiModel`, or the Pi coding model when that key is absent. */
  piModel: string;
  claudeModel: string;
  /** Identifies the file contents these defaults were read from. */
  revision: string;
}

/** A change requested by the panel. */
export interface CodingDefaultsChange {
  harness: AgentHarness;
  /** The new default model for `harness`; absent keeps that harness's default. */
  model?: string;
  /** The `revision` of the defaults the panel was showing. */
  revision: string;
}

/** The revision of a configuration file that does not exist yet. */
const missingRevision = 'missing';

/** The file's contents, or undefined when it does not exist. */
async function readConfigurationText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function revisionOf(text: string | undefined): string {
  if (text === undefined) {
    return missingRevision;
  }

  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

function defaultsFrom(configuration: AgentConfiguration, revision: string): CodingDefaults {
  return {
    harness: configuration.codingDefaultHarness,
    piModel: configuration.codingDefaultPiModel ?? configuration.coding.model,
    claudeModel: configuration.claudeCode.model,
    revision,
  };
}

/** The refusal when the file no longer matches the revision the panel showed. */
export function codingDefaultsConflict(): Error {
  return Error(
    'companion-agent.json changed outside this panel. Check the refreshed defaults and choose again.',
  );
}

/**
 * Read the current defaults without creating the file. A missing file yields
 * the built-in defaults; an invalid file is reported, never repaired.
 */
export async function readCodingDefaults(directory: string): Promise<CodingDefaults> {
  const path = join(directory, 'companion-agent.json');
  const text = await readConfigurationText(path);

  let value: unknown = initialAgentConfigurationFile();
  if (text !== undefined) {
    value = JSON.parse(text);
  }

  return defaultsFrom(parseAgentConfiguration(value, path), revisionOf(text));
}

/**
 * Store one change and return the defaults as now saved. The caller has
 * already checked that `change.model` is available for `change.harness`.
 * Throws, leaving the file untouched, when the file changed since the panel
 * read it, is invalid, is not a regular file, or cannot be written.
 */
export async function saveCodingDefaults(
  directory: string,
  change: CodingDefaultsChange,
): Promise<CodingDefaults> {
  const path = join(directory, 'companion-agent.json');
  const text = await readConfigurationText(path);
  if (revisionOf(text) !== change.revision) {
    throw codingDefaultsConflict();
  }

  // Start from the file exactly as the user left it, so that only the keys
  // named below change. JSON.parse keeps the key order for the rewrite.
  let contents: Record<string, unknown> = initialAgentConfigurationFile();
  if (text !== undefined) {
    // Refuse to rewrite a file that is already invalid: the user's own
    // mistake should be fixed by hand, not silently replaced. Validation
    // only reads the parsed value.
    const parsed: unknown = JSON.parse(text);
    parseAgentConfiguration(parsed, path);
    contents = parsed as Record<string, unknown>;
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  contents.codingDefaultHarness = change.harness;
  if (change.model !== undefined && change.harness === 'pi') {
    contents.codingDefaultPiModel = change.model;
  } else if (change.model !== undefined) {
    const claudeCode = (contents.claudeCode ?? {}) as Record<string, unknown>;
    contents.claudeCode = { ...claudeCode, model: change.model };
  }

  const configuration = parseAgentConfiguration(contents, path);
  const replacement = JSON.stringify(contents, null, 2) + '\n';
  if (replacement === text) {
    return defaultsFrom(configuration, revisionOf(text));
  }

  await replaceConfiguration(directory, path, text, replacement);
  return defaultsFrom(configuration, revisionOf(replacement));
}

/**
 * Atomically replace `path` (or create it when `previous` is undefined) with
 * `replacement`, keeping the existing file's permission bits. Fails without
 * touching `path` when its contents differ from `previous` just before the
 * replacement, or when any step before the replacement fails.
 *
 * Everything that can fail is done before the link/rename that commits the
 * change. Only the final flush of the directory entry comes after it; if that
 * fails the new file is already in use, so the error says it was saved rather
 * than pretending nothing changed. Rolling back is not attempted: it could
 * overwrite a hand edit made meanwhile.
 */
async function replaceConfiguration(
  directory: string,
  path: string,
  previous: string | undefined,
  replacement: string,
): Promise<void> {
  // A new file gets the same private mode as the loader's initialization.
  let mode = 0o600;
  if (previous !== undefined) {
    const status = await lstat(path);
    // A rename would replace a symbolic link with a plain file and leave its
    // target unchanged; the user should edit such a setup by hand.
    if (!status.isFile()) {
      throw Error('companion-agent.json is not a regular file; edit it by hand instead');
    }
    mode = status.mode & 0o777;
  }

  // Opened now, because the new directory entry is flushed through it after
  // the commit; failing to open it afterwards would be too late.
  const folder = await open(directory, 'r');

  // The temporary file lives in the same directory, so the rename below
  // stays on one filesystem and is atomic. `wx` never reuses another file.
  const temporary = join(directory, `.companion-agent.json.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      // `open` applies the umask; set the exact bits of the file we replace.
      await file.chmod(mode);
      await file.writeFile(replacement, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    // Last comparison before replacing; see the module comment.
    const current = await readConfigurationText(path);
    if (current !== previous) {
      throw codingDefaultsConflict();
    }

    if (previous === undefined) {
      // `link` fails if another writer created the file meanwhile, where
      // `rename` would silently replace it.
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw codingDefaultsConflict();
        }
        throw error;
      }
    } else {
      await rename(temporary, path);
    }

    // The change is committed. Make the new directory entry durable as well
    // as the file contents.
    try {
      await folder.sync();
    } catch (error) {
      throw Error(
        `Saved the new defaults, but could not confirm they reached the disk: ${String(error)}`,
      );
    }
  } finally {
    // Closing a read-only directory handle changes nothing on disk.
    await folder.close().catch(() => {});
    // After a rename the temporary name no longer exists; after a link or a
    // failure it does. Nothing else uses that unique name. A failed removal
    // only leaves a stray hidden file; it must not turn a completed
    // replacement into a reported failure, or hide the original error.
    await unlink(temporary).catch(() => {});
  }
}
