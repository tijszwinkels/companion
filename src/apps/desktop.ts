/**
 * Desktop presentation: a dedicated Chromium app window per registered app.
 *
 * Each registration gets its own persistent browser profile under the apps directory,
 * so its cookies, localStorage, IndexedDB, service workers and permissions are
 * separate from every other app, from the user's personal browser and from
 * Companion's own UI (which uses Qt WebEngine profiles, not Chromium). The
 * profile survives window close, backend restarts and Companion restarts.
 *
 * The window loads the backend's real loopback origin directly, so the app sees
 * its own origin and root paths with no proxy in between. Everything else is an
 * ordinary browser: HTTP, WebSocket, cookies, storage, file selection, dialogs,
 * same-origin policy and Chromium's sandbox are all left enabled. No debugging
 * port, extension, native bridge or Companion credential is added.
 *
 * The system binary `/usr/lib/chromium/chromium` is started directly, bypassing
 * distribution wrappers that would apply the user's personal Chromium flags
 * file. A second `open` of the same app hands off to the already running
 * browser for that profile and opens another window.
 */

import { spawn } from 'node:child_process';

import { checkPrivateDirectory, parseUpstream, type RegisteredApp } from './registry.ts';

export const defaultChromium = '/usr/lib/chromium/chromium';

export interface BrowserCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Chromium's command line for one app window.
 *
 * Deliberately absent: `--no-sandbox`, `--disable-web-security`, any
 * `--remote-debugging-*` option, `--load-extension` and proxy settings.
 */
export function appBrowserArguments(app: RegisteredApp, profileDirectory: string): string[] {
  const upstream = parseUpstream(app.upstream);

  return [
    '--user-data-dir=' + profileDirectory,
    '--app=' + upstream.origin + '/',
    // Lets the compositor and window list distinguish app windows.
    '--class=companion-app-' + app.id,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--ozone-platform-hint=auto',
  ];
}

/**
 * The browser's environment: the caller's desktop environment (display,
 * D-Bus for file choosers, locale) without Companion's internal variables and
 * without Chromium overrides that could, for example, replace its sandbox
 * helper or inject flags.
 */
export function browserEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (
      name.startsWith('COMPANION_') ||
      name.startsWith('CHROME_') ||
      name.startsWith('CHROMIUM_')
    ) {
      continue;
    }
    environment[name] = value;
  }

  return environment;
}

export function appBrowserCommand(
  app: RegisteredApp,
  profileDirectory: string,
  executable = defaultChromium,
): BrowserCommand {
  return {
    executable,
    args: appBrowserArguments(app, profileDirectory),
    env: browserEnvironment(),
  };
}

/**
 * Open the app window and return once Chromium has been started. The browser
 * is detached: it is the user's window from then on and outlives this command.
 *
 * `profileDirectory` comes from `AppRegistry.prepareProfile`; it is checked
 * again here so a directory swapped for a symlink or opened up to other users
 * in the meantime is refused rather than used.
 */
export async function openAppWindow(
  app: RegisteredApp,
  profileDirectory: string,
  executable = defaultChromium,
): Promise<void> {
  await checkPrivateDirectory(profileDirectory);

  const command = appBrowserCommand(app, profileDirectory, executable);
  const child = spawn(command.executable, command.args, {
    env: command.env,
    detached: true,
    stdio: 'ignore',
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}
