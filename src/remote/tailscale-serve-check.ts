/**
 * Read-only check that Tailscale Serve still routes exactly one tailnet HTTPS
 * name to this gateway's Unix socket, and nothing else (review items M5/M7).
 *
 * Why: the persistent Serve route is configured once by the user with sudo.
 * If it later changes (Funnel turned on, an extra port, handler or target, a
 * foreground session added), the gateway may be exposed differently than
 * reviewed. The gateway cannot fix that without root, and must not try; it
 * stops serving instead, and the user decides what to do.
 *
 * Input: the expected hostname and socket path; `tailscale serve status
 * --json` output (read through the unprivileged LocalAPI, no sudo).
 * Output: a match, a mismatch or an unreadable status, with a short reason.
 * Reasons name the mismatching part but never copy the configuration itself.
 *
 * The accepted configuration, and nothing more:
 *
 *   { "TCP": { "443": { "HTTPS": true } },
 *     "Web": { "<hostname>:443": { "Handlers": { "/": { "Proxy": "unix:<socket>" } } } } }
 *
 * Empty values (null, false, "", {} or []) are ignored so that harmless
 * serialization differences between Tailscale versions do not fail the
 * check. Every other key, such as Foreground, AllowFunnel or Services, fails
 * closed.
 */

import { execFile } from 'node:child_process';

export interface ExpectedServeRoute {
  /** Tailnet HTTPS name without port, e.g. `desk.tailnet-name.ts.net`. */
  hostname: string;
  /** Absolute path of the gateway's Unix socket. */
  socketPath: string;
}

/** How long `tailscale serve status --json` may take before we give up. */
const statusTimeoutMilliseconds = 10_000;

/** Serve status is a few hundred bytes; anything huge is not what we expect. */
const statusMaximumBytes = 1024 * 1024;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

/** Keys whose values are not empty, sorted for comparison. */
function presentKeys(object: JsonObject): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (!isEmpty(value)) {
      keys.push(key);
    }
  }
  return keys.sort();
}

function hasExactlyKeys(object: JsonObject, expected: string[]): boolean {
  const actual = presentKeys(object);
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** Compare a parsed Serve config with the single expected route. */
export function serveConfigMismatch(
  config: unknown,
  expected: ExpectedServeRoute,
): string | undefined {
  if (!isObject(config)) {
    return 'Serve status is not a JSON object';
  }
  if (!hasExactlyKeys(config, ['TCP', 'Web'])) {
    return 'Serve has settings other than one background HTTPS route (for example Funnel or a foreground session)';
  }

  // TCP: only port 443, terminated as HTTPS by Tailscale.
  const tcp = config.TCP;
  if (!isObject(tcp) || !hasExactlyKeys(tcp, ['443'])) {
    return 'Serve listens on ports other than 443';
  }
  const port = tcp['443'];
  if (!isObject(port) || port.HTTPS !== true || !hasExactlyKeys(port, ['HTTPS'])) {
    return 'Serve port 443 is not a plain HTTPS listener';
  }

  // Web: one host, one handler at "/", proxying to our socket.
  const web = config.Web;
  const hostKey = `${expected.hostname}:443`;
  if (!isObject(web) || !hasExactlyKeys(web, [hostKey])) {
    return 'Serve routes a different or additional host name';
  }
  const host = web[hostKey];
  if (!isObject(host) || !hasExactlyKeys(host, ['Handlers'])) {
    return 'Serve host entry has unexpected settings';
  }
  const handlers = host.Handlers;
  if (!isObject(handlers) || !hasExactlyKeys(handlers, ['/'])) {
    return 'Serve has handlers other than "/"';
  }
  const root = handlers['/'];
  if (!isObject(root) || !hasExactlyKeys(root, ['Proxy'])) {
    return 'Serve "/" handler is not a plain proxy';
  }
  if (root.Proxy !== `unix:${expected.socketPath}`) {
    return 'Serve "/" proxies to a different target than this gateway socket';
  }

  return undefined;
}

/** Run `tailscale serve status --json` without a shell and parse stdout. */
export function readServeConfig(tailscaleCommand: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      tailscaleCommand,
      ['serve', 'status', '--json'],
      { timeout: statusTimeoutMilliseconds, maxBuffer: statusMaximumBytes },
      (error, stdout) => {
        if (error) {
          reject(Error(`Could not read Tailscale Serve status: ${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Error('Tailscale Serve status was not valid JSON'));
        }
      },
    );
  });
}

/**
 * Result of one check. `unreadable` (the CLI failed, timed out or printed
 * something that is not JSON) is kept apart from `mismatch` (a parsed
 * configuration that is not the expected route): only the former may be a
 * passing hiccup, such as tailscaled restarting after an upgrade.
 */
export type ServeCheck =
  | { status: 'match' }
  | { status: 'mismatch'; reason: string }
  | { status: 'unreadable'; reason: string };

/** Read the Serve status once and compare it with the expected route. */
export async function checkServeRoute(
  expected: ExpectedServeRoute,
  tailscaleCommand: string,
): Promise<ServeCheck> {
  let config: unknown;
  try {
    config = await readServeConfig(tailscaleCommand);
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  const mismatch = serveConfigMismatch(config, expected);
  if (mismatch !== undefined) {
    return { status: 'mismatch', reason: mismatch };
  }
  return { status: 'match' };
}

/**
 * The startup check: a mismatch is final at once, but an unreadable status
 * is retried a few times so that a supervisor restarting the gateway while
 * tailscaled restarts does not burn through its start limit. The result is
 * still fail-closed: if the status never becomes readable, the last
 * `unreadable` result is returned and the gateway does not start.
 */
export async function checkServeRouteAtStartup(
  expected: ExpectedServeRoute,
  tailscaleCommand: string,
  retry: { attempts: number; delayMilliseconds: number },
): Promise<ServeCheck> {
  let result = await checkServeRoute(expected, tailscaleCommand);

  for (let attempt = 1; attempt < retry.attempts && result.status === 'unreadable'; attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retry.delayMilliseconds));
    result = await checkServeRoute(expected, tailscaleCommand);
  }

  return result;
}

/**
 * Re-check Serve periodically and call `onMismatch` once when it stops
 * matching. A parsed mismatch reports at once. An unreadable status reports
 * only after `maximumConsecutiveUnreadable` unreadable checks in a row, and a
 * readable matching status resets that count. While the status is unreadable
 * the gateway keeps serving under the configuration it last verified; this
 * adds no exposure, because a request still needs Tailscale to deliver it and
 * every Funnel request is refused per request anyway.
 *
 * Checks never overlap; `stop()` cancels the timer, and a check still in
 * flight when stopped does not report.
 */
export class ServeRouteWatch {
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private stopped = false;
  private consecutiveUnreadable = 0;

  constructor(
    private readonly expected: ExpectedServeRoute,
    private readonly options: {
      tailscaleCommand: string;
      intervalMilliseconds: number;
      maximumConsecutiveUnreadable: number;
      onMismatch(reason: string): void;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.checkOnce(), this.options.intervalMilliseconds);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** One check, as the timer runs it; public so tests can step it directly. */
  async checkOnce(): Promise<void> {
    if (this.checking || this.stopped) {
      return;
    }

    this.checking = true;
    let result: ServeCheck;
    try {
      result = await checkServeRoute(this.expected, this.options.tailscaleCommand);
    } finally {
      this.checking = false;
    }

    if (this.stopped) {
      return;
    }

    if (result.status === 'match') {
      this.consecutiveUnreadable = 0;
      return;
    }

    if (result.status === 'unreadable') {
      this.consecutiveUnreadable++;
      if (this.consecutiveUnreadable < this.options.maximumConsecutiveUnreadable) {
        return;
      }
    }

    this.stop();
    this.options.onMismatch(result.reason);
  }
}

/**
 * Derive the expected route from the gateway's options. The check only makes
 * sense for one tailnet name on the default HTTPS port, served over a Unix
 * socket; anything else is refused so the check cannot silently pass.
 */
export function expectedServeRoute(
  origins: string[],
  socketPath: string | undefined,
): ExpectedServeRoute {
  if (socketPath === undefined) {
    throw Error('--check-tailscale-serve requires --listen unix:PATH');
  }
  if (origins.length !== 1) {
    throw Error('--check-tailscale-serve requires exactly one --origin');
  }

  const origin = new URL(origins[0]);
  if (origin.protocol !== 'https:' || origin.port !== '') {
    throw Error('--check-tailscale-serve requires an https origin on the default port 443');
  }

  return { hostname: origin.hostname, socketPath };
}
