/**
 * The few `systemctl --user` / `systemd-run --user` calls the phone service
 * needs, and nothing broader: it only ever names its own unit. There is no
 * process matching, no `pkill`, and nothing here touches system units,
 * other users' units, installed unit files or Tailscale.
 *
 * Commands run without a shell (`execFile`) with bounded time and output.
 * `systemctl` and `systemd-run` are found on PATH; tests put fakes first.
 */

import { execFile } from 'node:child_process';

import {
  descriptionMarker,
  fingerprintVariable,
  systemdRunArguments,
  type TransientServicePlan,
} from './transient-unit.ts';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  file: string,
  args: string[],
  timeoutMilliseconds = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMilliseconds, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          code = typeof error.code === 'number' ? error.code : 127;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
      },
    );
  });
}

/** What `systemctl --user show` reports about the unit. */
export interface UnitState {
  /** `loaded`, `not-found`, ... */
  loadState: string;
  /** `active`, `activating`, `deactivating`, `inactive`, `failed`, ... */
  activeState: string;
  /** e.g. `running`, `start-pre`, `auto-restart`, `dead`, `failed`. */
  subState: string;
  /** Why it last stopped: `success`, `exit-code`, `start-limit-hit`, ... */
  result: string;
  description: string;
  transient: boolean;
  /** The unit's definition file; for transient units under `$XDG_RUNTIME_DIR/systemd/transient/`. */
  fragmentPath: string;
  mainPid: number;
  restarts: number;
  /** Fingerprint from the unit's environment, if it was started by this tool. */
  fingerprint?: string;
}

const shownProperties = [
  'LoadState',
  'ActiveState',
  'SubState',
  'Result',
  'Description',
  'Transient',
  'FragmentPath',
  'MainPID',
  'NRestarts',
  'Environment',
];

/** Parse `KEY=VALUE` lines; values may contain `=`. */
function parseShow(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return values;
}

export async function unitState(unit: string): Promise<UnitState> {
  const result = await runCommand('systemctl', [
    '--user',
    'show',
    unit,
    `--property=${shownProperties.join(',')}`,
  ]);
  if (result.code !== 0) {
    throw Error(`systemctl --user show failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  const values = parseShow(result.stdout);
  const environment = values.get('Environment') ?? '';
  const fingerprint = environment
    .split(' ')
    .find((assignment) => assignment.startsWith(`${fingerprintVariable}=`))
    ?.slice(fingerprintVariable.length + 1);

  return {
    loadState: values.get('LoadState') ?? 'unknown',
    activeState: values.get('ActiveState') ?? 'unknown',
    subState: values.get('SubState') ?? 'unknown',
    result: values.get('Result') ?? '',
    description: values.get('Description') ?? '',
    transient: values.get('Transient') === 'yes',
    fragmentPath: values.get('FragmentPath') ?? '',
    mainPid: Number(values.get('MainPID') ?? 0),
    restarts: Number(values.get('NRestarts') ?? 0),
    fingerprint,
  };
}

/**
 * A unit this tool may start over, stop or report as its own: a transient
 * service carrying our description marker. An installed unit file of the
 * same name is never transient (systemd keeps transient definitions under
 * the runtime directory's systemd/transient/, which is not "installed").
 */
export function isOurUnit(state: UnitState): boolean {
  return state.transient && state.description.startsWith(descriptionMarker);
}

/** Running or on its way there (including a pending automatic restart). */
export function unitRunning(state: UnitState): boolean {
  if (['active', 'activating', 'reloading'].includes(state.activeState)) {
    return true;
  }
  return state.subState === 'auto-restart';
}

export async function startTransientService(plan: TransientServicePlan): Promise<void> {
  const result = await runCommand('systemd-run', systemdRunArguments(plan), 60_000);
  if (result.code !== 0) {
    throw Error(
      `systemd-run could not start ${plan.unit}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
}

/** Stop the unit and wait for the stop job (systemctl waits; TimeoutStopSec bounds it). */
export async function stopUnit(unit: string): Promise<CommandResult> {
  return runCommand('systemctl', ['--user', 'stop', unit], 60_000);
}

/** Forget a failed unit, so a transient unit of this name can be created again. */
export async function resetFailedUnit(unit: string): Promise<void> {
  await runCommand('systemctl', ['--user', 'reset-failed', unit]);
}
