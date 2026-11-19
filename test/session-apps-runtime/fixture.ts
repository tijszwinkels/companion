/**
 * Synthetic conversations for session application tests.
 *
 * Real: AgentSessions (turn FIFO, leases, persistence), WidgetService and its
 * loopback HTTP server, the guarded library loader, the isolated Chromium
 * renderer that runs authored bundles, and the exact agent tool definitions
 * that Pi loads (`widgetTools`) and that the Claude Code MCP bridge exposes
 * (`bridgeTools`).
 *
 * Injected: the model. Each backend runs a test script instead of Pi or
 * Claude Code; no model provider is contacted. Every file lives in a
 * temporary directory, and the widget library is a temporary copy of the
 * checkout's examples plus any synthetic bundles a test writes.
 */

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { widgetTools } from '../../src/agents/widget-tools.ts';
import { bridgeTools } from '../../src/agents/claude/bridge-tools.ts';
import { libraryDirectory } from '../../src/widgets/registry.ts';
import {
  chatMessage,
  type AgentBackend,
  type AgentHarness,
  type AgentRunRequest,
  type ClaudeCodeAgentBackend,
} from '../../src/agents/types.ts';

/** One turn as the scripted model sees it. */
export interface ApplicationTurn {
  harness: AgentHarness;
  id: string;
  /** The exact prompt text the backend received. */
  text: string;
  signal: AbortSignal;
  /** Call a tool through this turn's lease, exactly as the harness would. */
  tool(name: string, parameters?: Record<string, unknown>): Promise<Record<string, any>>;
  /** The tool names this turn's harness exposes to the model. */
  toolNames: string[];
}

export type ApplicationScript = (turn: ApplicationTurn) => Promise<void>;

/** Thrown by a script to simulate a failing model turn on purpose. */
export class ModelFailure extends Error {}

let calls = 0;

function turnTools(harness: AgentHarness, request: AgentRunRequest<unknown>, signal: AbortSignal) {
  const lease = request.widgets;
  if (!lease) {
    return { names: [], call: async () => assert.fail('The turn must receive a widget lease') };
  }

  if (harness === 'pi') {
    // The Pi extension registers exactly these definitions.
    const tools = widgetTools(lease.endpoint, lease.token);
    return {
      names: tools.map((tool) => tool.name),
      async call(name: string, parameters: Record<string, unknown>) {
        const tool = tools.find((entry) => entry.name === name);
        assert.ok(tool, `Pi has no tool ${name}`);
        const result = await tool.execute(`pi-call-${++calls}`, parameters, signal);
        return JSON.parse(result.content[0].text) as Record<string, any>;
      },
    };
  }

  // Claude Code receives the same tools through the Companion MCP bridge.
  const tools = bridgeTools({ widgets: lease });
  return {
    names: tools.map((tool) => tool.name),
    async call(name: string, parameters: Record<string, unknown>) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `Claude Code has no tool ${name}`);
      const result = await tool.execute(`toolu_${++calls}`, parameters, signal);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return JSON.parse(text) as Record<string, any>;
    },
  };
}

export async function applicationFixture(context: {
  after(callback: () => Promise<unknown>): void;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-apps-'));
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  const library = join(directory, 'library');
  await cp(libraryDirectory, library, { recursive: true });

  const turns: ApplicationTurn[] = [];
  const scriptFailures: Error[] = [];
  const scripts = new Map<string, ApplicationScript[]>();

  async function record(
    harness: AgentHarness,
    request: AgentRunRequest<unknown>,
    signal: AbortSignal,
    emit: (message: ReturnType<typeof chatMessage>) => void,
  ): Promise<void> {
    const tools = turnTools(harness, request, signal);
    const turn: ApplicationTurn = {
      harness,
      id: request.id,
      text: request.prompt.text,
      signal,
      toolNames: tools.names,
      tool: (name, parameters = {}) => tools.call(name, parameters),
    };
    turns.push(turn);
    const script = scripts.get(request.id)?.shift();
    if (script) {
      try {
        await script(turn);
      } catch (error) {
        // Any error inside a script would otherwise only fail that model
        // turn, silently skipping the rest of its assertions. Keep it, so the
        // test itself fails (see context.after), unless the script meant to
        // fail the turn (modelFailure) or the turn was stopped.
        if (!signal.aborted && !(error instanceof ModelFailure)) {
          scriptFailures.push(error as Error);
        }
        throw error;
      }
    }
    signal.throwIfAborted();
    emit(chatMessage(`answer-${turns.length}`, 'assistant', `${harness} answer ${turns.length}`));
  }

  const pi: AgentBackend = {
    id: 'session-apps-pi-fixture',
    label: 'Scripted Pi',
    dependencies: {},
    async run(request, signal, emit) {
      await record('pi', request, signal, emit);
    },
  };
  const claude: ClaudeCodeAgentBackend = {
    id: 'session-apps-claude-fixture',
    label: 'Scripted Claude Code',
    dependencies: {},
    async run(request, signal, emit) {
      await record('claude-code', request, signal, emit);
    },
  };

  const opened: AgentSessions[] = [];
  function open(): AgentSessions {
    const sessions = new AgentSessions({ pi, 'claude-code': claude }, () => {}, directory, library);
    // Short debounce so immediate-mode tests do not wait 1.5 s per batch.
    sessions.applicationEventDelayMilliseconds = 40;
    opened.push(sessions);
    return sessions;
  }
  const sessions = open();

  context.after(async () => {
    for (const instance of opened) {
      await instance.close();
    }
    await rm(directory, { recursive: true, force: true });
    if (scriptFailures.length) {
      throw scriptFailures[0];
    }
  });

  return {
    directory,
    library,
    sessions,
    turns,
    open,
    /** Queue handlers for the next turns of one conversation, in order. */
    script(id: string, ...handlers: ApplicationScript[]) {
      scripts.set(id, [...(scripts.get(id) ?? []), ...handlers]);
    },
    view(id: string, instance: AgentSessions = sessions) {
      const view = instance.snapshot().find((session) => session.id === id);
      assert.ok(view, `Expected open session ${id}`);
      return view;
    },
    /** Write a synthetic library bundle (an ordinary directory of three files). */
    async bundle(name: string, manifest: Record<string, unknown>, javascript: string, css = '') {
      const target = join(library, name);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'widget.json'), JSON.stringify({ name, ...manifest }));
      await writeFile(join(target, 'widget.js'), javascript);
      await writeFile(join(target, 'style.css'), css);
    },
  };
}

/** Wait until `predicate` holds, polling briefly; fails after `timeout` ms. */
export async function eventually(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail('Condition was not reached in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
