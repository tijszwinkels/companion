/**
 * The two systemd user units that start Companion after a desktop login: the
 * listener and the native UI. This module only renders unit text from an
 * explicit plan; it reads and writes nothing. `cli.ts` gathers the plan,
 * writes the files and talks to systemd.
 *
 * Both units belong to `graphical-session.target`, which Omarchy's session
 * manager (uwsm) starts once Hyprland has exported its environment
 * (`WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, D-Bus) to the systemd user
 * manager, and stops at logout. Services inherit that environment, so the
 * listener can call `hyprctl`, `grim`, `wtype` and PipeWire as it would from a
 * desktop terminal.
 *
 * Every path is absolute and fixed when the units are written: systemd does
 * not read shell startup files, so a version manager's PATH changes or a
 * terminal-only `export` would otherwise be invisible to the services.
 */

/** Unit names; also the names of the files in the user unit directory. */
export const listenerUnit = 'companion-listener.service';
export const uiUnit = 'companion-ui.service';

/**
 * First line of every file this tool writes. A unit file without it belongs to
 * somebody else: `enable` never overwrites it and `disable` never deletes it.
 */
export const managedMarker = '# Managed by Companion bin/companion-login.';

/** Everything a rendered unit depends on. All paths are absolute. */
export interface LoginStartupPlan {
  /** Source checkout containing `src/cli.ts`, `node_modules/` and the UI build. */
  checkout: string;
  /** Node.js executable that runs the listener (and, through PATH, Pi). */
  node: string;
  /** The listener's `companion.config.json`. */
  config: string;
  /** Standalone UI executable, normally `<checkout>/native/window/build/companion-ui`. */
  ui: string;
  /** Complete PATH for both services, in lookup order. */
  path: string[];
  /** Optional private `KEY=value` file for credentials; may not exist. */
  environmentFile: string;
  /** Directory for the two log files, which are truncated at each start. */
  logDirectory: string;
  /** Start listening at login. Off (paused) unless explicitly requested. */
  listening: boolean;
}

/**
 * Characters that systemd would interpret inside a unit file value: `%`
 * specifiers, `$` variable expansion, quoting and escapes. Whitespace is
 * refused too, so no value ever needs quoting rules to be read correctly.
 */
const unsafeCharacters = /[\s%$"'\\;]|[\u0000-\u001f\u007f]/;

/** Reject a path that is relative or that systemd could read differently. */
export function assertUnitPath(label: string, path: string): void {
  if (!path.startsWith('/')) {
    throw Error(`${label} must be an absolute path: ${JSON.stringify(path)}`);
  }

  if (unsafeCharacters.test(path)) {
    throw Error(
      `${label} contains a space or a character systemd treats specially (% $ quotes \\ ;): ` +
        JSON.stringify(path),
    );
  }
}

function assertPlan(plan: LoginStartupPlan): void {
  assertUnitPath('Checkout', plan.checkout);
  assertUnitPath('Node.js executable', plan.node);
  assertUnitPath('Listener config', plan.config);
  assertUnitPath('UI executable', plan.ui);
  assertUnitPath('Environment file', plan.environmentFile);
  assertUnitPath('Log directory', plan.logDirectory);

  if (plan.path.length === 0) {
    throw Error('PATH must contain at least one directory');
  }
  for (const directory of plan.path) {
    assertUnitPath('PATH entry', directory);
  }
}

/** The listener's command line, exactly as the unit runs it. */
export function listenerArguments(plan: LoginStartupPlan): string[] {
  // Run node directly rather than `npm start`: one process receives systemd's
  // single SIGTERM and performs Companion's normal graceful stop. Wrappers
  // that forward or duplicate signals are what cut that stop short (F5).
  const args = [plan.node, '--import', 'tsx', 'src/cli.ts', '--config', plan.config];

  if (!plan.listening) {
    args.push('--paused');
  }

  // No window may be open yet at login; see the option in src/cli.ts.
  args.push('--no-startup-capture');

  return args;
}

/** Lines shared by both units: lifetime, restarts and logging. */
function commonUnitLines(plan: LoginStartupPlan, description: string): string[] {
  return [
    managedMarker,
    `# Regenerate with ${plan.checkout}/bin/companion-login enable; remove with … disable.`,
    '# Manual edits are replaced the next time it is enabled.',
    '[Unit]',
    `Description=${description}`,
    // Start with the desktop session, stop at logout, and never outside it.
    'PartOf=graphical-session.target',
    'After=graphical-session.target',
    'Requisite=graphical-session.target',
    // At most three starts (including the first) in five minutes, manual starts
    // included, not an endless loop. Then the unit stays failed until
    // `systemctl --user reset-failed` (or the interval passes) and a new start.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=3',
    '',
    '[Service]',
    'Type=exec',
    `WorkingDirectory=${plan.checkout}`,
    `Environment=PATH=${plan.path.join(':')}`,
    // The leading "-" makes the file optional. It is read by systemd itself,
    // so keys never appear in the unit file or on a command line.
    `EnvironmentFile=-${plan.environmentFile}`,
    'Restart=on-failure',
    'RestartSec=5',
    // SIGTERM only to the main process, so it can stop its own children in
    // order; anything left after it exits (or after the timeout) is killed.
    'KillMode=mixed',
    'TimeoutStopSec=30',
  ];
}

export function renderListenerUnit(plan: LoginStartupPlan): string {
  assertPlan(plan);

  const mode = plan.listening ? 'listening' : 'paused';
  const lines = [
    ...commonUnitLines(plan, `Companion listener (starts ${mode})`),
    `ExecStart=${listenerArguments(plan).join(' ')}`,
    // Log lines can contain transcripts and window titles. Keep them in a
    // user-owned file replaced at each start, not in the persistent journal.
    `StandardOutput=truncate:${plan.logDirectory}/listener.log`,
    'StandardError=inherit',
    '',
    '[Install]',
    'WantedBy=graphical-session.target',
    '',
  ];

  return lines.join('\n');
}

export function renderUiUnit(plan: LoginStartupPlan): string {
  assertPlan(plan);

  const lines = [
    ...commonUnitLines(plan, 'Companion native UI (starts hidden)'),
    // Hidden: Super+Alt+C, the bar button or `npm run ui` shows it. A second
    // start while one is running only asks the running UI to show itself.
    `ExecStart=${plan.ui} --hidden`,
    `StandardOutput=truncate:${plan.logDirectory}/ui.log`,
    'StandardError=inherit',
    '',
    '[Install]',
    'WantedBy=graphical-session.target',
    '',
  ];

  return lines.join('\n');
}
