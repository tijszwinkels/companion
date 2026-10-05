/**
 * `companion-remote`: run the opt-in phone gateway and manage paired devices.
 *
 * Nothing here starts, restarts or reconfigures the listener, Tailscale or
 * any system service. `serve` binds only the address and port, or the Unix
 * socket, it is given. `--check-tailscale-serve` only reads Serve status.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseAppOriginOption } from '../apps/origins.ts';
import { defaultAppsDirectory } from '../apps/registry.ts';
import { DeviceStore } from './devices.ts';
import {
  Gateway,
  isLoopbackHost,
  loopbackOrigins,
  type GatewayAppOptions,
  type GatewayListenOptions,
} from './gateway.ts';
import {
  checkServeRouteAtStartup,
  expectedServeRoute,
  ServeRouteWatch,
  type ExpectedServeRoute,
} from './tailscale-serve-check.ts';

/**
 * How often `--check-tailscale-serve` re-reads the Serve configuration.
 * Tests may shorten (never lengthen) it through
 * COMPANION_REMOTE_SERVE_CHECK_MILLISECONDS, so the runtime-mismatch path can
 * be exercised end to end without waiting a minute.
 */
const serveCheckIntervalMilliseconds = shortenedInterval(
  60_000,
  process.env.COMPANION_REMOTE_SERVE_CHECK_MILLISECONDS,
);

function shortenedInterval(defaultMilliseconds: number, override: string | undefined): number {
  const requested = Number(override);
  if (!Number.isInteger(requested) || requested < 10) {
    return defaultMilliseconds;
  }
  return Math.min(requested, defaultMilliseconds);
}

/**
 * Unreadable Serve status (e.g. tailscaled restarting) is retried before
 * giving up: at startup 5 reads 3 s apart, at runtime 3 minute-ticks in a row.
 * A readable status that does not match is never retried.
 */
const serveStartupRetry = { attempts: 5, delayMilliseconds: 3000 };
const serveMaximumConsecutiveUnreadable = 3;

/**
 * Once shutdown begins (signal or Serve mismatch), the process must be gone
 * within this time. Normally closing takes milliseconds and the process then
 * exits because its event loop is empty; a connection or handle that does not
 * let go must not keep a gateway that decided to stop looking alive to a
 * supervisor, or keep it reachable.
 */
const shutdownDeadlineMilliseconds = 5000;

const help = `Usage: companion-remote <serve|pair|devices|revoke> [options]

serve     Run the phone gateway until interrupted.
  --host ADDRESS        Bind address (default 127.0.0.1). Non-loopback requires TLS.
  --port N              Port (default 8787).
  --tls-cert PATH       PEM certificate, e.g. from \`tailscale cert\`.
  --tls-key PATH        PEM private key for that certificate.
  --listen unix:PATH    Listen on a Unix socket instead of --host/--port, for
                        \`tailscale serve ... unix:PATH\`. The directory must be
                        owned by you and private (0700); the socket is 0600.
                        Requires at least one https --origin; no loopback defaults.
  --origin URL          Allowed app origin, exactly scheme://host[:port]; repeatable.
                        Loopback HTTP defaults to http://127.0.0.1:PORT and
                        http://localhost:PORT and http://[::1]:PORT.
  --require-tailscale-login LOGIN
                        Refuse requests whose Tailscale-User-Login header (set by
                        Tailscale Serve) is not exactly LOGIN, e.g. user@github.
                        Only trustworthy with --listen unix:.
  --check-tailscale-serve
                        With --listen unix: and one https origin, refuse to start
                        and stop serving (exit 1) unless \`tailscale serve status\`
                        shows exactly that one route. Rechecked every minute.
  --control-socket PATH Listener socket (default $XDG_RUNTIME_DIR/companion/control.sock).
  --sessions-directory PATH
                        Saved conversations, for screenshots
                        (default ~/companion/agents/.companion-sessions).
  --app-directory PATH  Built phone app (default: this checkout's integrations/mobile/dist).
  --apps-listen HOST:PORT
                        Serve registered local apps to paired phones from a separate
                        loopback listener (off unless given). See docs/local-apps.md.
  --app-origin ID=URL   Public origin for one app, exactly scheme://host[:port]; repeatable.
                        Each app needs its own host name, distinct from this gateway's.
                        Only apps with \`companion-app phone ID on\` are offered.
  --apps-directory PATH App registry (default ~/companion/apps).

pair      Print a one-time pairing code (10 minutes, 5 attempts).
devices   List paired devices as JSON.
revoke ID Remove a paired device; its live connections close within seconds.

Common:
  --state-directory PATH  Private gateway state (default ~/companion/remote).
  --help

The gateway is off unless you run \`serve\`. It never changes Tailscale settings.
Tailscale restricts who can reach the port; pairing decides which device may act.
Requests marked as Tailscale Funnel (public internet) are always refused.`;

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      // host and port have no parser defaults so that --listen can tell
      // whether they were given; the TCP defaults are applied below.
      host: { type: 'string' },
      port: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      listen: { type: 'string' },
      origin: { type: 'string', multiple: true },
      'require-tailscale-login': { type: 'string' },
      'check-tailscale-serve': { type: 'boolean' },
      'control-socket': { type: 'string' },
      'sessions-directory': { type: 'string' },
      'app-directory': { type: 'string' },
      'apps-listen': { type: 'string' },
      'app-origin': { type: 'string', multiple: true },
      'apps-directory': { type: 'string' },
      'state-directory': { type: 'string' },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(help);
    return values.help ? 0 : 2;
  }

  const stateDirectory = values['state-directory'] ?? join(homedir(), 'companion', 'remote');
  const devices = new DeviceStore(stateDirectory);

  if (command === 'pair') {
    await devices.prepare();
    const { code, expiresAt } = await devices.createPairingCode();
    const grouped = code.slice(0, 5) + '-' + code.slice(5);
    console.log(`Pairing code: ${grouped}`);
    console.log(`Valid until ${new Date(expiresAt).toLocaleTimeString()} for one phone.`);
    return 0;
  }

  if (command === 'devices') {
    const list = (await devices.devices()).map(({ tokenHash: _hidden, ...device }) => device);
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }

  if (command === 'revoke') {
    const id = rest[0];
    if (!id) {
      console.error('revoke requires a device ID from `companion-remote devices`');
      return 2;
    }
    const removed = await devices.revoke(id);
    console.log(removed ? `Revoked ${id}` : `No device ${id}`);
    return removed ? 0 : 1;
  }

  if (command !== 'serve') {
    console.error(help);
    return 2;
  }

  const listenAddress = await listenOptions(values);
  if (typeof listenAddress === 'string') {
    console.error(listenAddress);
    return 2;
  }

  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const controlSocket =
    values['control-socket'] ??
    (runtimeDirectory ? join(runtimeDirectory, 'companion', 'control.sock') : undefined);
  if (!controlSocket) {
    console.error('XDG_RUNTIME_DIR is not set; pass --control-socket');
    return 2;
  }

  // Loopback HTTP gets its own origins by default. A Unix socket is only
  // reached through Tailscale Serve, so it gets no defaults at all.
  let origins: string[] = [];
  if (values.origin) {
    origins = values.origin;
  } else if (
    listenAddress.host !== undefined &&
    isLoopbackHost(listenAddress.host) &&
    !listenAddress.tls
  ) {
    origins = loopbackOrigins(listenAddress.port);
  }

  // Resolve the expected Serve route before binding anything, so a wrong
  // flag combination fails fast.
  let serveRoute: ExpectedServeRoute | undefined;
  if (values['check-tailscale-serve']) {
    try {
      serveRoute = expectedServeRoute(origins, listenAddress.socketPath);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  let apps: GatewayAppOptions | undefined;
  if (values['apps-listen']) {
    const listen = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(values['apps-listen']);
    const appsPort = Number(listen?.[2]);
    if (!listen || !Number.isInteger(appsPort) || appsPort < 1 || appsPort > 65535) {
      console.error('--apps-listen must be a loopback HOST:PORT such as 127.0.0.1:8790');
      return 2;
    }

    apps = {
      host: listen[1] === '[::1]' ? '::1' : listen[1],
      port: appsPort,
      origins: (values['app-origin'] ?? []).map(parseAppOriginOption),
      registryDirectory: values['apps-directory'] ?? defaultAppsDirectory(),
    };
  } else if (values['app-origin'] || values['apps-directory']) {
    console.error('--app-origin and --apps-directory need --apps-listen');
    return 2;
  }

  const gateway = new Gateway({
    ...listenAddress,
    origins,
    requireTailscaleLogin: values['require-tailscale-login'],
    stateDirectory,
    controlSocket,
    sessionsDirectory:
      values['sessions-directory'] ?? join(homedir(), 'companion', 'agents', '.companion-sessions'),
    appDirectory: values['app-directory'] ?? join(checkout, 'integrations', 'mobile', 'dist'),
    apps,
    log: (message) => console.error(`[remote] ${message}`),
  });

  // Never serve under a Serve configuration we have not verified.
  if (serveRoute) {
    const check = await checkServeRouteAtStartup(serveRoute, 'tailscale', serveStartupRetry);
    if (check.status !== 'match') {
      console.error(`[remote] Not starting: ${check.reason}`);
      return 1;
    }
  }

  await gateway.start();
  console.error(`[remote] Serving on ${gateway.address}`);
  console.error(`[remote] Allowed origins: ${origins.join(', ')}`);
  logTailscaleSafeguards(values, listenAddress, serveRoute !== undefined);
  if (apps && gateway.apps) {
    console.error(`[remote] Local apps on ${values['apps-listen']} (port ${gateway.apps.port})`);
    for (const [id, origin] of apps.origins) {
      console.error(`[remote]   ${id}: ${origin}`);
    }
  }
  console.error('[remote] Pair a phone with: companion-remote pair');

  // Run until a signal, or until the Serve route stops matching. The exit
  // code tells a supervisor (systemd Restart=on-failure) which one happened.
  let watch: ServeRouteWatch | undefined;
  const exitCode = await new Promise<number>((resolveStop) => {
    process.once('SIGINT', () => resolveStop(0));
    process.once('SIGTERM', () => resolveStop(0));

    if (serveRoute) {
      watch = new ServeRouteWatch(serveRoute, {
        tailscaleCommand: 'tailscale',
        intervalMilliseconds: serveCheckIntervalMilliseconds,
        maximumConsecutiveUnreadable: serveMaximumConsecutiveUnreadable,
        onMismatch: (reason) => {
          console.error(`[remote] Stopping: ${reason}`);
          resolveStop(1);
        },
      });
      watch.start();
    }
  });

  // Armed before closing, so it also bounds a close() that never finishes.
  // unref(): the timer itself never keeps the process alive.
  const deadline = setTimeout(() => {
    console.error('[remote] Shutdown did not finish in time; exiting');
    process.exit(exitCode);
  }, shutdownDeadlineMilliseconds);
  deadline.unref();

  // The watch timer would otherwise keep the process alive after close.
  watch?.stop();
  await gateway.close();
  return exitCode;
}

/**
 * Turn --listen or --host/--port/--tls-* into gateway listen options, or a
 * usage error message. The two forms cannot be mixed.
 */
async function listenOptions(values: {
  host?: string;
  port?: string;
  'tls-cert'?: string;
  'tls-key'?: string;
  listen?: string;
}): Promise<GatewayListenOptions | string> {
  if (values.listen !== undefined) {
    if (!values.listen.startsWith('unix:')) {
      return '--listen must be unix:/absolute/path';
    }
    const usesTcpFlags =
      values.host !== undefined ||
      values.port !== undefined ||
      values['tls-cert'] !== undefined ||
      values['tls-key'] !== undefined;
    if (usesTcpFlags) {
      return '--listen cannot be combined with --host, --port, --tls-cert or --tls-key';
    }
    return { socketPath: values.listen.slice('unix:'.length) };
  }

  const host = values.host ?? '127.0.0.1';
  const port = Number(values.port ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '--port must be 1–65535';
  }
  if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
    return '--tls-cert and --tls-key must be given together';
  }

  if (values['tls-cert'] && values['tls-key']) {
    const tls = {
      cert: await readFile(values['tls-cert'], 'utf8'),
      key: await readFile(values['tls-key'], 'utf8'),
    };
    return { host, port, tls };
  }
  return { host, port };
}

/**
 * Say which Tailscale safeguards are active, and warn where a flag gives less
 * protection than it seems. The login itself is never printed.
 */
function logTailscaleSafeguards(
  values: { 'require-tailscale-login'?: string },
  listenAddress: GatewayListenOptions,
  checkingServe: boolean,
): void {
  const requiresLogin = values['require-tailscale-login'] !== undefined;

  if (requiresLogin && listenAddress.socketPath === undefined) {
    console.error(
      '[remote] Warning: --require-tailscale-login on a TCP port is only a second layer; ' +
        'any local user can connect and send that header. Use --listen unix: for a real check.',
    );
  } else if (requiresLogin) {
    console.error('[remote] Requiring the configured Tailscale login');
  }

  if (listenAddress.socketPath !== undefined && (!requiresLogin || !checkingServe)) {
    console.error(
      '[remote] Warning: serving a Unix socket without --require-tailscale-login and ' +
        '--check-tailscale-serve; any tailnet device Serve admits can reach pairing.',
    );
  }

  if (checkingServe) {
    console.error('[remote] Tailscale Serve route verified; rechecking every minute');
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`companion-remote: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    // A failed start may leave the app proxy waiting on a peer that holds a
    // connection open; the process must still end, as after a shutdown.
    setTimeout(() => process.exit(1), shutdownDeadlineMilliseconds).unref();
  },
);
