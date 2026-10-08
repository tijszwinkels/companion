import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessions } from '../src/agents/sessions.ts';
import type { CaptureStoragePolicy } from '../src/capture-storage/policy.ts';
import type { SessionLiveState } from '../src/agents/harness-live-state.ts';
import { defaultAgentSettings } from '../src/agents/settings.ts';
import { sessionTools } from '../src/agents/session-tools.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentHarness,
  type AgentMessage,
  type AgentSettings,
  type ClaudeCodeAgentBackend,
  type ClaudeCodeSettings,
  type NativeTitleExport,
} from '../src/agents/types.ts';

/** One recorded backend invocation, from either harness. */
export interface HarnessRun {
  harness: AgentHarness;
  id: string;
  text: string;
  resume: boolean;
  screenshot: boolean;
  /** The live screenshot bytes the backend received, if any. */
  png?: Buffer;
  /** Pi receives `AgentSettings`; Claude Code receives `ClaudeCodeSettings`. */
  settings: AgentSettings | ClaudeCodeSettings;
  /** Claude Code only: the previous turn's model after a picker switch. */
  previousModel?: string;
  sessionTools?: { endpoint: string; token: string };
  /** Claude Code only: the conversation's native name export at turn start. */
  nativeTitle?: NativeTitleExport;
  signal: AbortSignal;
  emit: (message: AgentMessage) => void;
  renameSession?: (title: string) => void;
  /** Claude Code only. */
  exportTitle?: (title: NativeTitleExport) => void;
}

/** A turn handler. It runs before the scripted answer is emitted. */
export type HarnessScript = (run: HarnessRun) => Promise<void>;

/**
 * Synthetic conversations with scripted Pi and Claude Code backends. No real
 * Pi or Claude process runs, and every file lives in a temporary directory.
 * `configuration` is written to companion-agent.json before anything starts.
 * `claudeCode: false` leaves the Claude Code backend unwired.
 */
export async function harnessFixture(
  context: { after(callback: () => Promise<unknown>): void },
  options: {
    configuration?: Record<string, unknown>;
    claudeCode?: boolean;
    liveState?: SessionLiveState;
    /** Gates conversation screenshot copies; absent means always off. */
    captureStorage?: CaptureStoragePolicy;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-harness-'));
  const configurationPath = join(directory, 'companion-agent.json');
  await writeFile(
    configurationPath,
    JSON.stringify(options.configuration ?? { ...defaultAgentSettings }),
  );

  const runs: HarnessRun[] = [];
  // Scripts are queued per conversation and consumed by its turns in order.
  const scripts = new Map<string, HarnessScript[]>();

  async function record(run: HarnessRun): Promise<void> {
    runs.push(run);
    const script = scripts.get(run.id)?.shift();
    if (script) {
      await script(run);
    }
    run.signal.throwIfAborted();
    run.emit(chatMessage(`answer-${runs.length}`, 'assistant', `${run.harness} answer`));
  }

  const pi: AgentBackend = {
    id: 'harness-pi-fixture',
    label: 'Scripted Pi',
    dependencies: {},
    async models() {
      const models = ['configured/one', 'configured/two'];
      return {
        models,
        pinned: models,
        thinkingLevels: Object.fromEntries(
          models.map((model) => [model, ['off', 'minimal', 'low', 'medium', 'high']]),
        ),
      };
    },
    async run(request, signal, emit, _replaceChoices, renameSession, exportTitle) {
      assert.equal(exportTitle, undefined, 'Pi has no native name export');
      await record({
        harness: 'pi',
        id: request.id,
        text: request.prompt.text,
        resume: request.resume,
        screenshot: request.prompt.screenshot !== undefined,
        png: request.prompt.screenshot?.png,
        settings: request.settings,
        sessionTools: request.sessionTools,
        signal,
        emit,
        renameSession,
      });
    },
  };

  // Deliberately no `models`: the Claude picker uses a fixed allowlist.
  const claude: ClaudeCodeAgentBackend = {
    id: 'harness-claude-fixture',
    label: 'Scripted Claude Code',
    dependencies: {},
    async run(request, signal, emit, _replaceChoices, renameSession, exportTitle) {
      await record({
        harness: 'claude-code',
        id: request.id,
        text: request.prompt.text,
        resume: request.resume,
        screenshot: request.prompt.screenshot !== undefined,
        png: request.prompt.screenshot?.png,
        settings: request.settings,
        previousModel: request.previousModel,
        sessionTools: request.sessionTools,
        nativeTitle: request.nativeTitle,
        signal,
        emit,
        renameSession,
        exportTitle,
      });
    },
  };

  const backends = options.claudeCode === false ? { pi } : { pi, 'claude-code': claude };
  const opened: AgentSessions[] = [];

  /** A listener instance over the same directory, as after a restart. */
  function open(): AgentSessions {
    const sessions = new AgentSessions(
      backends,
      () => {},
      directory,
      undefined,
      options.liveState,
      options.captureStorage,
    );
    opened.push(sessions);
    return sessions;
  }

  const sessions = open();
  context.after(async () => {
    for (const instance of opened) {
      await instance.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  return {
    directory,
    configurationPath,
    sessions,
    runs,
    open,
    /** Queue handlers for the next turns of one conversation, in order. */
    script(id: string, ...turns: HarnessScript[]) {
      scripts.set(id, [...(scripts.get(id) ?? []), ...turns]);
    },
    view(id: string, instance: AgentSessions = sessions) {
      const view = instance.snapshot().find((session) => session.id === id);
      assert.ok(view, `Expected open session ${id}`);
      return view;
    },
    async configure(configuration: Record<string, unknown>) {
      await writeFile(configurationPath, JSON.stringify(configuration));
    },
  };
}

/** Invoke a session tool exactly as an agent does, through the turn's lease. */
export async function callTool(
  run: HarnessRun,
  name: string,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assert.ok(run.sessionTools, 'The turn must receive a session tool lease');
  const tool = sessionTools(run.sessionTools.endpoint, run.sessionTools.token).find(
    (definition) => definition.name === name,
  );
  assert.ok(tool, `Unknown tool ${name}`);
  const result = await tool.execute(randomUUID(), parameters);
  return result.details;
}

/** Return the thrown tool error message, which ends with its stable code. */
export async function toolRefusal(
  run: HarnessRun,
  name: string,
  parameters: Record<string, unknown>,
): Promise<string> {
  try {
    await callTool(run, name, parameters);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`${name} unexpectedly succeeded`);
}
