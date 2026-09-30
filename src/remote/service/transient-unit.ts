/**
 * The exact systemd transient service that runs the phone gateway.
 *
 * Why transient (`systemd-run --user`) instead of an installed unit file:
 * nothing is installed, enabled or left behind. The service exists only from
 * an explicit `companion-phone start` until `stop`, a failure, logout of a
 * non-lingering user, or reboot. It therefore can never start at boot or login
 * on its own; there is no `[Install]` section to enable by mistake. Durable
 * pairing state lives outside it, so a later start needs no re-pairing.
 *
 * Input: a validated config, absolute tool paths and the runtime root.
 * Output: a plan (unit name, properties, command) that `systemd.ts` passes to
 * `systemd-run`, plus a fingerprint so a running service can be recognized as
 * the one this config describes.
 *
 * Sandbox (checked against a real user manager by test/phone-service/):
 * - The whole file system is read-only (`ProtectSystem=strict` plus
 *   `ProtectHome=read-only`: on some systems /home is a separate mount that
 *   `ProtectSystem` alone leaves writable). Writable are only the pairing
 *   state directory, the private runtime directory and a private /tmp (tsx
 *   caches compiled files there).
 * - Only Unix sockets: the gateway talks to the listener and tailscaled, and
 *   Tailscale Serve talks to it. No TCP/UDP at all, so the optional
 *   `--apps-listen` local-app proxy is not available in this mode.
 * - No privileges, capabilities, namespaces, realtime or SUID; the
 *   @system-service system call set; no device nodes.
 * - `MemoryDenyWriteExecute` is deliberately absent: Node's JIT needs it off.
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { configHostname, gatewaySocketPath, type PhoneServiceConfig } from './config.ts';
import { pinCheckCommand } from './pin.ts';

/** Absolute paths of the helpers the gateway and pin check run. */
export interface ServiceTools {
  git: string;
  tailscale: string;
  flock: string;
}

export interface TransientServicePlan {
  /** Full unit name including `.service`. */
  unit: string;
  /** `NAME=VALUE` properties for `systemd-run -p`. */
  properties: string[];
  /** The gateway command line, absolute paths only. */
  command: string[];
  /** Stable hash of properties and command; stored in the unit's environment. */
  fingerprint: string;
  /** Where the gateway listens; Tailscale Serve must proxy exactly here. */
  socketPath: string;
}

/** Marker in the unit Description that identifies services started by this tool. */
export const descriptionMarker = 'Companion phone gateway (companion-phone';

/** Environment variable carrying the fingerprint inside the unit. */
export const fingerprintVariable = 'COMPANION_PHONE_SERVICE';

/**
 * How systemd supervises the gateway. The gateway exits 1 when the Serve route
 * stops matching (fail closed) and 0 on a normal stop, so `on-failure` restarts
 * crashes and transient failures but at most 3 times a minute; after that the
 * unit stays failed until someone looks at it.
 */
const supervision = [
  'Type=exec',
  'Restart=on-failure',
  'RestartSec=2',
  'StartLimitIntervalSec=60',
  'StartLimitBurst=3',
  // The gateway itself exits within 5 seconds of SIGTERM.
  'TimeoutStopSec=10',
];

const sandbox = [
  'UMask=0077',
  'NoNewPrivileges=yes',
  'CapabilityBoundingSet=',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectSystem=strict',
  'ProtectHome=read-only',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'RestrictAddressFamilies=AF_UNIX',
  'RestrictNamespaces=yes',
  'RestrictRealtime=yes',
  'RestrictSUIDSGID=yes',
  'LockPersonality=yes',
  'SystemCallArchitectures=native',
  'SystemCallFilter=@system-service',
];

/** The directories of the helper binaries, in a fixed order, without repeats. */
function searchPath(tools: ServiceTools): string {
  const directories: string[] = [];
  for (const tool of [tools.tailscale, tools.flock, tools.git]) {
    const directory = dirname(tool);
    if (!directories.includes(directory)) {
      directories.push(directory);
    }
  }
  return directories.join(':');
}

export function transientServicePlan(
  config: PhoneServiceConfig,
  tools: ServiceTools,
  root: string,
): TransientServicePlan {
  const socketPath = gatewaySocketPath(config, root);

  const command = [
    config.nodeExecutable,
    join(config.checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(config.checkout, 'src', 'remote', 'cli.ts'),
    'serve',
    '--listen',
    `unix:${socketPath}`,
    '--origin',
    config.origin,
    '--require-tailscale-login',
    config.tailscaleLogin,
    '--check-tailscale-serve',
    '--state-directory',
    config.stateDirectory,
    '--control-socket',
    config.controlSocket,
    '--sessions-directory',
    config.sessionsDirectory,
  ];

  const baseProperties = [
    `Description=${descriptionMarker}, ${config.revision.slice(0, 12)}, ${configHostname(config)})`,
    ...supervision,
    `WorkingDirectory=${config.checkout}`,
    `ExecStartPre=${pinCheckCommand(config.checkout, config.revision, tools.git)}`,
    `RuntimeDirectory=${config.runtimeDirectoryName}`,
    'RuntimeDirectoryMode=0700',
    `ReadWritePaths=${config.stateDirectory}`,
    ...sandbox,
  ];

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ baseProperties, command, path: searchPath(tools) }))
    .digest('hex')
    .slice(0, 32);

  const properties = [
    ...baseProperties,
    `Environment=PATH=${searchPath(tools)} GIT_OPTIONAL_LOCKS=0 ${fingerprintVariable}=${fingerprint}`,
  ];

  return {
    unit: `${config.unitName}.service`,
    properties,
    command,
    fingerprint,
    socketPath,
  };
}

/**
 * Arguments for `systemd-run`. `--expand-environment=no` keeps systemd from
 * treating `$` in the command as a variable (none is allowed anyway), and
 * there is no `--wait`: the service keeps running after we return.
 */
export function systemdRunArguments(plan: TransientServicePlan): string[] {
  const args = ['--user', `--unit=${plan.unit}`, '--quiet', '--expand-environment=no'];
  for (const property of plan.properties) {
    args.push(`--property=${property}`);
  }
  args.push('--', ...plan.command);
  return args;
}
