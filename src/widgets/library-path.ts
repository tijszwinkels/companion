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
 */
export const bundledLibraryDirectory = fileURLToPath(
  new URL('../../widget-library/', import.meta.url),
);

export const widgetLibraryVariable = 'COMPANION_WIDGET_LIBRARY';

export function defaultWidgetLibrary(home = homedir()): string {
  return join(home, 'companion', 'widget-library');
}

/**
 * Returns the configured library. An explicit option wins over the environment.
 * Relative paths are refused because they would depend on the launch directory,
 * which differs between terminals, services and agent subprocesses.
 */
export function userWidgetLibrary(
  option?: string,
  environment: string | undefined = process.env[widgetLibraryVariable],
  home = homedir(),
): string {
  const configured = option ?? environment;

  if (configured === undefined || configured === '') {
    return defaultWidgetLibrary(home);
  }

  if (configured.includes('\0') || !isAbsolute(configured)) {
    const source = option === undefined ? widgetLibraryVariable : '--widget-library';
    throw Error(`${source} must be an absolute directory path`);
  }

  // Normalizes "." / ".." segments and trailing slashes without touching disk.
  return resolve(configured);
}
