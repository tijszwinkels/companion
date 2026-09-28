/**
 * `companion-remote`: run the opt-in phone gateway and manage paired devices.
 *
 * Nothing here starts, restarts or reconfigures the listener, Tailscale or
 * any system service. `serve` binds only the address and port it is given.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseAppOriginOption } from '../apps/origins.ts';
import { defaultAppsDirectory } from '../apps/registry.ts';
import { DeviceStore } from './devices.ts';
import { Gateway, isLoopbackHost, loopbackOrigins, type GatewayAppOptions } from './gateway.ts';

const help = `Usage: companion-remote <serve|pair|devices|revoke> [options]

serve     Run the phone gateway until interrupted.
  --host ADDRESS        Bind address (default 127.0.0.1). Non-loopback requires TLS.
  --port N              Port (default 8787).
  --tls-cert PATH       PEM certificate, e.g. from \`tailscale cert\`.
  --tls-key PATH        PEM private key for that certificate.
  --origin URL          Allowed app origin, exactly scheme://host[:port]; repeatable.
                        Loopback HTTP defaults to http://127.0.0.1:PORT and
                        http://localhost:PORT and http://[::1]:PORT.
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
Tailscale restricts who can reach the port; pairing decides which device may act.`;

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      origin: { type: 'string', multiple: true },
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

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('--port must be 1–65535');
    return 2;
  }
  if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
    console.error('--tls-cert and --tls-key must be given together');
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

  const tls =
    values['tls-cert'] && values['tls-key']
      ? {
          cert: await readFile(values['tls-cert'], 'utf8'),
          key: await readFile(values['tls-key'], 'utf8'),
        }
      : undefined;

  const origins =
    values.origin ?? (isLoopbackHost(values.host) && !tls ? loopbackOrigins(port) : []);

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
    host: values.host,
    port,
    tls,
    origins,
    stateDirectory,
    controlSocket,
    sessionsDirectory:
      values['sessions-directory'] ?? join(homedir(), 'companion', 'agents', '.companion-sessions'),
    appDirectory: values['app-directory'] ?? join(checkout, 'integrations', 'mobile', 'dist'),
    apps,
    log: (message) => console.error(`[remote] ${message}`),
  });

  await gateway.start();
  console.error(`[remote] Serving on ${tls ? 'https' : 'http'}://${values.host}:${gateway.port}`);
  console.error(`[remote] Allowed origins: ${origins.join(', ')}`);
  if (apps && gateway.apps) {
    console.error(`[remote] Local apps on ${values['apps-listen']} (port ${gateway.apps.port})`);
    for (const [id, origin] of apps.origins) {
      console.error(`[remote]   ${id}: ${origin}`);
    }
  }
  console.error('[remote] Pair a phone with: companion-remote pair');

  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop);
    process.once('SIGTERM', resolveStop);
  });
  await gateway.close();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`companion-remote: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
