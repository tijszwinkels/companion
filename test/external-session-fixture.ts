/** Synthetic external API fixture shared with its failure-cleanup subprocess. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentSessions } from '../src/agents/sessions.ts';
import { defaultAgentSettings } from '../src/agents/settings.ts';
import { chatMessage, type AgentBackend } from '../src/agents/types.ts';
import { ExternalSessionServer } from '../src/agents/external/server.ts';
import { requestExternal } from '../src/agents/external/client.ts';
import { signal } from './helpers.ts';

export const executable = fileURLToPath(new URL('../bin/companion-session', import.meta.url));

/**
 * A test launched from Companion inherits real internal authority. Synthetic
 * external CLI children must not inherit that authority or discovery path.
 * Copy only: never alter the test runner's environment or any production guard.
 * Explicit overrides are synthetic inputs for discovery/internal-guard tests.
 */
export function externalCliEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    'COMPANION_INTERNAL_AGENT',
    'COMPANION_SESSION_TOOLS_ENDPOINT',
    'COMPANION_SESSION_TOOLS_TOKEN',
    'COMPANION_WIDGET_ENDPOINT',
    'COMPANION_WIDGET_TOKEN',
    'COMPANION_EXTERNAL_SOCKET',
  ]) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

export async function fixture(
  t: Pick<TestContext, 'after'>,
  options: { run?: AgentBackend['run']; deadline?: number; beforeClose?: () => void } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'external-test-'));
  const resources: { sessions?: AgentSessions; server?: ExternalSessionServer } = {};
  // Register before setup can fail. A fixture-owned release runs before close:
  // node:test after hooks run in registration order, so a later test hook cannot
  // unblock sessions.close() while this earlier hook is waiting for a held turn.
  t.after(async () => {
    try {
      options.beforeClose?.();
    } finally {
      try {
        await resources.server?.close();
      } finally {
        try {
          await resources.sessions?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });

  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  const prompts: string[] = [];
  const sessions = new AgentSessions(
    {
      backend: {
        id: 'synthetic-external',
        label: 'Synthetic external',
        dependencies: {},
        async models() {
          return {
            models: ['test/model'],
            pinned: ['test/model'],
            thinkingLevels: { 'test/model': ['off', 'minimal', 'low', 'medium', 'high'] },
          };
        },
        async run(request, signal, emit) {
          prompts.push(request.prompt.text);
          if (options.run) {
            await options.run(request, signal, emit);
          }
          emit(chatMessage(randomUUID(), 'assistant', 'Synthetic answer'));
        },
      },
    },
    () => {},
    directory,
  );
  resources.sessions = sessions;
  await sessions.loadPrevious();
  const path = join(directory, 'api', 'session.sock');
  const server = new ExternalSessionServer(sessions.sessionTools, path, options.deadline);
  resources.server = server;
  await server.start();
  const identity = (time = Date.now()) => `${server.epoch}_${time}_${randomUUID()}`;
  const call = (method: string, args: Record<string, unknown> = {}) =>
    requestExternal(path, { method, label: 'Rowan', requestId: identity(), ...args }, signal());
  const cli = (args: string[]) => runCli(path, args);
  return { directory, path, sessions, server, prompts, identity, call, cli };
}

/** Invoke the shipped executable from an unrelated cwd, like a local MM agent. */
export async function runCli(
  path: string,
  args: string[],
  timeout = 10_000,
  overrides: NodeJS.ProcessEnv = {},
) {
  const child = spawn(executable, [...args, '--socket', path], {
    cwd: '/tmp',
    env: externalCliEnvironment(overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const [code] = await once(child, 'close');
    return { code, stdout, stderr, result: JSON.parse(stdout) as any };
  } finally {
    clearTimeout(timer);
  }
}
