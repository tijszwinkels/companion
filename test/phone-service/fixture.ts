/**
 * Synthetic world for the phone service tests against a real systemd user
 * manager (`npm run test:phone-service`).
 *
 * Everything is disposable and uniquely named:
 * - a directory under ~/.cache (not /tmp: the service has a private /tmp and
 *   could not see fixtures there) holding the config, pairing state, a fake
 *   `tailscale` that only prints a Serve status file, and a listener socket;
 * - a clone of this repository at the commit under test, used as the pinned
 *   checkout (its node_modules is a symlink to this checkout's, and a stub
 *   phone app page stands in for the build output);
 * - a real listener control socket (DesktopRuntime) with a synthetic agent
 *   backend, which can be stopped and started again at the same path;
 * - unit and runtime directory names `companion-phone-test-<random>`.
 *
 * Nothing here reads or changes the live gateway, its state, the production
 * control socket, installed units or Tailscale.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { stopped } from '../desktop-fixture.ts';

const run = promisify(execFile);

export const repository = resolve(import.meta.dirname, '..', '..');
export const cli = join(repository, 'bin', 'companion-phone');
export const testHostname = 'phone-test.example.ts.net';
export const testOrigin = `https://${testHostname}`;
export const testLogin = 'phone-tester@github';

/** Refuse to run where a user manager is not available, instead of half-running. */
export async function assertUserManager(): Promise<void> {
  const { stdout } = await run('systemctl', ['--user', 'is-system-running']).catch(
    (error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }),
  );
  assert.match(stdout.trim(), /^(running|degraded)$/, 'needs a running systemd user manager');
  assert.ok(process.env.XDG_RUNTIME_DIR, 'needs XDG_RUNTIME_DIR');
}

/** A synthetic desktop listener that can be stopped and started at one path. */
export class SyntheticListener {
  private runtime?: DesktopRuntime;
  private controller?: AbortController;
  private sessions?: AgentSessions;

  constructor(
    readonly socketPath: string,
    private readonly directory: string,
  ) {}

  async start(): Promise<void> {
    const backend: AgentBackend['run'] = async (_request, signal) => {
      await stopped(signal);
    };
    this.sessions = new AgentSessions(
      {
        pi: {
          id: 'phone-service-fixture',
          label: 'Phone service fixture',
          dependencies: {},
          run: backend,
          async models() {
            return { models: ['local/synthetic'], pinned: [], thinkingLevels: {} };
          },
        },
      },
      () => {},
      this.directory,
    );
    this.controller = new AbortController();
    this.runtime = new DesktopRuntime(
      new PauseControl(),
      () => {},
      this.controller.signal,
      {
        database: join(this.directory, 'utterances.sqlite'),
        socket: this.socketPath,
        preview: false,
        sounds: false,
        agents: this.sessions,
      },
      async () => assert.fail('No desktop input in this fixture'),
    );
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.sessions?.close();
    await this.runtime?.close();
    this.runtime = undefined;
  }
}

export interface PhoneServiceWorld {
  base: string;
  checkout: string;
  revision: string;
  configFile: string;
  stateDirectory: string;
  unitName: string;
  unit: string;
  runtimeDirectoryName: string;
  socketPath: string;
  serveStatusFile: string;
  binDirectory: string;
  listener: SyntheticListener;
  /** Environment for `companion-phone` subprocesses. */
  environment: NodeJS.ProcessEnv;
  setServeStatus(value: unknown): Promise<void>;
  exactRoute(): unknown;
  phoneCli(args: string[], timeoutMilliseconds?: number): Promise<CliResult>;
  cleanup(): Promise<void>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function createWorld(): Promise<PhoneServiceWorld> {
  await mkdir(join(homedir(), '.cache'), { recursive: true });
  const base = await realpath(await mkdtemp(join(homedir(), '.cache', 'companion-phone-test-')));
  const suffix = randomBytes(4).toString('hex');
  const unitName = `companion-phone-test-${suffix}`;
  const runtimeDirectoryName = unitName;
  const socketPath = join(process.env.XDG_RUNTIME_DIR!, runtimeDirectoryName, 'gateway.sock');

  // The pinned checkout: a clone at the commit under test.
  const revision = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const checkout = join(base, 'checkout');
  await run('git', ['clone', '--quiet', '--shared', '--no-checkout', repository, checkout]);
  await run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', revision]);
  await symlink(join(repository, 'node_modules'), join(checkout, 'node_modules'));
  await mkdir(join(checkout, 'integrations', 'mobile', 'dist'), { recursive: true });
  await writeFile(
    join(checkout, 'integrations', 'mobile', 'dist', 'index.html'),
    '<!doctype html><title>Synthetic phone app</title>\n',
  );

  // A fake tailscale that can only print the status file.
  const binDirectory = join(base, 'bin');
  const serveStatusFile = join(base, 'serve-status.json');
  await mkdir(binDirectory);
  await writeFile(
    join(binDirectory, 'tailscale'),
    [
      '#!/bin/sh',
      '# Synthetic: answers only `tailscale serve status --json`.',
      'if [ "$*" != "serve status --json" ]; then echo "fake tailscale: unsupported $*" >&2; exit 64; fi',
      `exec cat ${serveStatusFile}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const listenerDirectory = join(base, 'listener');
  await mkdir(listenerDirectory, { mode: 0o700 });
  const listener = new SyntheticListener(
    join(listenerDirectory, 'control.sock'),
    listenerDirectory,
  );

  const stateDirectory = join(base, 'state');
  const configFile = join(base, 'config', 'phone-gateway.json');
  const environment = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH}`,
    COMPANION_PHONE_CONFIG: configFile,
  };

  const world: PhoneServiceWorld = {
    base,
    checkout,
    revision,
    configFile,
    stateDirectory,
    unitName,
    unit: `${unitName}.service`,
    runtimeDirectoryName,
    socketPath,
    serveStatusFile,
    binDirectory,
    listener,
    environment,
    async setServeStatus(value: unknown) {
      await writeFile(serveStatusFile, JSON.stringify(value));
    },
    exactRoute() {
      return {
        TCP: { '443': { HTTPS: true } },
        Web: { [`${testHostname}:443`]: { Handlers: { '/': { Proxy: `unix:${socketPath}` } } } },
      };
    },
    phoneCli(args: string[], timeoutMilliseconds = 120_000) {
      return runCli(args, environment, timeoutMilliseconds);
    },
    async cleanup() {
      await run('systemctl', ['--user', 'stop', world.unit]).catch(() => {});
      await run('systemctl', ['--user', 'reset-failed', world.unit]).catch(() => {});
      await listener.stop();
      await rm(base, { recursive: true, force: true });
    },
  };

  await world.setServeStatus({});
  return world;
}

export function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMilliseconds = 120_000,
): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cli, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function systemctlShow(
  unit: string,
  properties: string[],
): Promise<Record<string, string>> {
  const { stdout } = await run('systemctl', [
    '--user',
    'show',
    unit,
    `--property=${properties.join(',')}`,
  ]);
  const values: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return values;
}

export async function waitUntil(
  condition: () => Promise<boolean>,
  milliseconds: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await delay(200);
  }
}

/** An HTTP request over the gateway socket, as Tailscale Serve would send it. */
export function socketRequest(
  socketPath: string,
  options: { method?: string; path: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { socketPath, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

export const tailnetHeaders = {
  Host: testHostname,
  Origin: testOrigin,
  'Tailscale-User-Login': testLogin,
};

export interface SocketPhone {
  socket: WebSocket;
  messages: { type: string; message?: { type: string } }[];
  closed: Promise<{ code: number }>;
}

/** Open the phone WebSocket through the gateway socket and authenticate. */
export async function socketPhone(socketPath: string, token: string): Promise<SocketPhone> {
  const socket = new WebSocket(`ws+unix:${socketPath}:/api/socket`, { headers: tailnetHeaders });
  const messages: SocketPhone['messages'] = [];
  const closed = new Promise<{ code: number }>((resolvePromise) => {
    socket.once('close', (code) => resolvePromise({ code }));
  });
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));

  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(Error(`HTTP ${response.statusCode}`));
    });
  });
  socket.send(JSON.stringify({ type: 'auth', token }));
  return { socket, messages, closed };
}

/** True once the phone has received the listener's state through the gateway. */
export function receivedState(phone: SocketPhone): boolean {
  return phone.messages.some(
    (message) => message.type === 'engine' && message.message?.type === 'state',
  );
}
