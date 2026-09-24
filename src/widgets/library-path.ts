import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Chooses which directory supplies widget source.
 *
 * The listener discovers and publishes widgets from one **user widget library**.
 * It lives outside the source checkout so authored widgets are scratch space: a
 * Git checkout, worktree switch or reinstall neither hides nor versions them.
 *
 * Resolution order, highest first:
 *   1. `--widget-library PATH` on the listener command line.
 *   2. The `COMPANION_WIDGET_LIBRARY` environment variable.
 *   3. `~/companion/widget-library`, next to the agents' working directory.
 *
 * The result is only a lexical, absolute path. It is deliberately not passed
 * through realpath: the registry opens every component itself and refuses
 * symlinks, so resolving links here would silently defeat that protection.
 * A missing directory is valid; discovery then reports an empty library.
 */

/**
 * Widgets tracked in this source checkout. They are examples and test fixtures;
 * the running listener does not read them unless explicitly configured to.
 * Library parameters below the listener entry point (AgentSessions,
 * WidgetService, WidgetRegistry) default to this directory, so tests and
 * harnesses never read the user's real library unless they pass it in.
 */
export const bundledLibraryDirectory = fileURLToPath(
  new URL('../../widget-library/', import.meta.url),
);

export const widgetLibraryVariable = 'COMPANION_WIDGET_LIBRARY';

export function defaultWidgetLibrary(home = homedir()): string {
  return join(home, 'companion', 'widget-library');
}

/**
 * Returns the configured library. A supplied option always wins, even over a
 * valid environment value, and must itself be valid: `--widget-library ''` is an
 * error, not a request for the default. An empty environment variable counts as
 * unset, the usual shell convention for clearing an inherited value.
 * Relative paths are refused because they would depend on the launch directory,
 * which differs between terminals, services and agent subprocesses.
 */
export function userWidgetLibrary(
  option?: string,
  environment: string | undefined = process.env[widgetLibraryVariable],
  home = homedir(),
): string {
  let configured: string;
  let source: string;

  if (option !== undefined) {
    configured = option;
    source = '--widget-library';
  } else if (environment !== undefined && environment !== '') {
    configured = environment;
    source = widgetLibraryVariable;
  } else {
    return defaultWidgetLibrary(home);
  }

  if (configured.includes('\0') || !isAbsolute(configured)) {
    throw Error(`${source} must be an absolute directory path`);
  }

  // Normalizes "." / ".." segments and trailing slashes without touching disk.
  return resolve(configured);
}
