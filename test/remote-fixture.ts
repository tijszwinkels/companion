import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import { AgentSessions } from '../src/agents/sessions.ts';
import { CaptureStoragePolicy } from '../src/capture-storage/policy.ts';
import type { AgentBackend, ClaudeCodeAgentBackend } from '../src/agents/types.ts';
import { DeviceStore } from '../src/remote/devices.ts';
import { Gateway, type GatewayServiceOptions } from '../src/remote/gateway.ts';
import type { GatewayMessage } from '../src/remote/protocol.ts';
import { desktopFixture, stopped, waitFor } from './desktop-fixture.ts';
import { deferred } from './helpers.ts';

/**
 * A real listener control socket (DesktopRuntime), synthetic agent backend,
 * disposable session store and a gateway on a free loopback port. Nothing
 * reads personal state, calls a model, or binds a non-loopback address.
 */

export type SyntheticRun = {
  request: Parameters<AgentBackend['run']>[0];
  emit: Parameters<AgentBackend['run']>[2];
  publish: NonNullable<Parameters<AgentBackend['run']>[3]>;
  finish(): void;
};

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

export async function remoteFixture(
  options: {
    appDirectory?: string;
    backend?: AgentBackend['run'];
    claudeBackend?: ClaudeCodeAgentBackend['run'];
    gateway?: Partial<GatewayServiceOptions>;
    /** The listener's capture-storage policy; on (as before) by default. */
    captureStorage?: CaptureStoragePolicy;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-remote-'));
  const captureStorage = options.captureStorage ?? CaptureStoragePolicy.enabledForTesting();
  const runs: SyntheticRun[] = [];

  const run: AgentBackend['run'] =
    options.backend ??
    (async (request, runSignal, emit, publish) => {
      const done = deferred<void>();
      runs.push({ request, emit, publish: publish!, finish: () => done.resolve() });
      await Promise.race([done.promise, stopped(runSignal)]);
    });

  const sessions = new AgentSessions(
    {
      pi: {
        id: 'remote-fixture',
        label: 'Remote fixture',
        dependencies: {},
        run,
        async models() {
          return {
            models: ['local/qwen-synthetic', 'cloud/synthetic-large'],
            pinned: ['local/qwen-synthetic'],
            thinkingLevels: {
              'local/qwen-synthetic': ['off', 'low'],
              'cloud/synthetic-large': ['off', 'low', 'medium', 'high'],
            },
          };
        },
      },
      ...(options.claudeBackend
        ? {
            'claude-code': {
              id: 'claude-remote-fixture',
              label: 'Synthetic Claude fixture',
              dependencies: {},
              run: options.claudeBackend,
            },
          }
        : {}),
    },
    () => {},
    directory,
    undefined,
    undefined,
    // Conversation screenshots are saved only while capture storage is on.
    captureStorage,
  );

  const desktop = await desktopFixture(async () => assert.fail('No desktop input'), sessions, {
    captureStorage,
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const stateDirectory = join(directory, 'remote-state');
  const logs: string[] = [];

  const gateway = new Gateway({
    host: '127.0.0.1',
    port,
    origins: [origin],
    stateDirectory,
    controlSocket: desktop.socketPath,
    sessionsDirectory: join(directory, '.companion-sessions'),
    appDirectory: options.appDirectory ?? join(directory, 'no-app'),
    log: (message) => logs.push(message),
    revocationCheckMilliseconds: 50,
    ...options.gateway,
  });
  try {
    await gateway.start();
  } catch (error) {
    // A fixture that cannot start must not leave the listener socket or its
    // temporary directory behind to keep the test process alive.
    await gateway.close();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const devices = new DeviceStore(stateDirectory);

  /** Pair through the real HTTP endpoint and return the device token. */
  async function pair(name = 'Synthetic phone'): Promise<{ token: string; deviceId: string }> {
    const { code } = await devices.createPairingCode();
    const response = await fetch(`${origin}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ code, name }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { token: string; deviceId: string };
  }

  const opened: PhoneClient[] = [];

  async function phone(
    token: string | undefined,
    phoneOrigin = origin,
    incrementalSessions = false,
  ): Promise<PhoneClient> {
    const client = await connectPhone(
      `ws://127.0.0.1:${port}/api/socket`,
      token,
      phoneOrigin,
      incrementalSessions,
    );
    opened.push(client);
    return client;
  }

  async function close() {
    for (const client of opened) {
      client.socket.terminate();
    }
    await gateway.close();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }

  return {
    directory,
    desktop,
    sessions,
    runs,
    gateway,
    devices,
    port,
    origin,
    logs,
    pair,
    phone,
    close,
  };
}

export interface PhoneClient {
  socket: WebSocket;
  messages: GatewayMessage[];
  closed: Promise<{ code: number; reason: string }>;
  send(request: object): void;
  reply(requestId: string, milliseconds?: number): Promise<GatewayMessage>;
  engine(type: string, accept?: (message: any) => boolean): Promise<any>;
}

export async function connectPhone(
  url: string,
  token: string | undefined,
  origin: string,
  incrementalSessions = false,
): Promise<PhoneClient> {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  const messages: GatewayMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  socket.on('message', (data) => messages.push(JSON.parse(String(data))));

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(Error(`HTTP ${response.statusCode}`));
    });
  });

  if (token !== undefined) {
    socket.send(JSON.stringify({ type: 'auth', token, incrementalSessions }));
  }

  return {
    socket,
    messages,
    closed,
    send(request: object) {
      socket.send(JSON.stringify({ type: 'request', ...request }));
    },
    async reply(requestId: string, milliseconds = 3000) {
      const matches = (message: GatewayMessage) =>
        (message.type === 'result' || message.type === 'error') && message.requestId === requestId;
      await waitFor(() => messages.some(matches), milliseconds);
      const index = messages.findIndex(matches);
      return messages.splice(index, 1)[0];
    },
    async engine(type: string, accept: (message: any) => boolean = () => true) {
      let found: any;
      await waitFor(() => {
        found = messages.find(
          (message) =>
            message.type === 'engine' && message.message.type === type && accept(message.message),
        );
        return found !== undefined;
      }, 3000);
      return found.message;
    },
  };
}

/** Reject with `what` if `work` has not settled within `milliseconds`. */
export async function within<T>(work: Promise<T>, milliseconds: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${what}`)), milliseconds);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a raw socket until the first HTTP status line is complete (it may
 * arrive split across several chunks) and return it, e.g. `HTTP/1.1 404 Not
 * Found`. Bounded, so a missing response fails instead of hanging.
 */
export function readStatusLine(socket: Socket, milliseconds = 5000): Promise<string> {
  const statusLine = new Promise<string>((resolve, reject) => {
    let received = '';
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n');
      if (end !== -1) {
        socket.off('data', onData);
        resolve(received.slice(0, end));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => reject(Error('Connection closed before a status line')));
  });
  return within(statusLine, milliseconds, 'an HTTP status line');
}

export { delay, waitFor };
