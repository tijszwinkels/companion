import { choiceTool } from '../choice-tool.ts';
import { sessionNameTool } from '../session-name-tool.ts';
import { sessionTools } from '../session-tools.ts';
import { widgetTools } from '../widget-tools.ts';
import { parityTools } from './parity/parity-tools.ts';
import type { ClaudeToolSettings } from './parity/settings.ts';
import type { ToolOutput } from './tool-output.ts';
import type { TurnResult } from './turn-results.ts';

/**
 * A Companion tool as the MCP bridge offers it to Claude Code. The name,
 * description, schema and prompt hints are taken from the native Pi tool
 * definitions, so both harnesses show the model the same tools.
 */
export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments (the Pi tool's TypeBox schema, serialized). */
  inputSchema: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /**
   * Run one call. `toolUseId` is Claude Code's tool-use ID for this call.
   * The result is text, or text plus images (see `tool-output.ts`).
   * A thrown error becomes a failed tool result, as with Pi.
   */
  execute(
    toolUseId: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string | ToolOutput>;
}

/** Connection details the bridge process received from its per-turn config. */
export interface BridgeToolConnections {
  results?: { endpoint: string; token: string };
  widgets?: { endpoint: string; token: string };
  /** `capabilities`: optional tools the listener announced (see session-tools.ts). */
  sessionTools?: { endpoint: string; token: string; capabilities?: readonly string[] };
}

/** The shape shared by Pi's native tool definitions. */
interface PiToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    callId: string,
    parameters: never,
    signal?: AbortSignal,
  ): Promise<{ content: readonly { type: 'text'; text: string }[] }>;
}

/** Deadline for reporting a choice or name to the backend's loopback route. */
const resultReportTimeoutMilliseconds = 5000;

/**
 * Build the tools for this turn. Choices and naming need the result route;
 * widgets and session tools are present only when the turn has their lease,
 * exactly like Pi's conditional `--extension` arguments. `toolSettings`
 * (from the opt-in `claude-tools.json`) adds the Pi-parity tool groups.
 */
export function bridgeTools(
  connections: BridgeToolConnections,
  toolSettings: ClaudeToolSettings = {},
): BridgeTool[] {
  const tools: BridgeTool[] = [];

  if (connections.results) {
    tools.push(choicesTool(connections.results));
    tools.push(nameTool(connections.results));
  }

  if (connections.widgets) {
    const { endpoint, token } = connections.widgets;
    for (const tool of widgetTools(endpoint, token)) {
      tools.push(fromPiTool(tool as unknown as PiToolDefinition));
    }
  }

  if (connections.sessionTools) {
    const { endpoint, token, capabilities } = connections.sessionTools;
    for (const tool of sessionTools(endpoint, token, capabilities)) {
      tools.push(fromPiTool(tool as unknown as PiToolDefinition));
    }
  }

  // Equivalents of the user's Pi extension tools, only as configured.
  tools.push(...parityTools(toolSettings));

  return tools;
}

/**
 * Pi's widget and session tools already call their loopback services and
 * return text. The tool-use ID becomes their request ID, so receipts,
 * deduplication and source links behave exactly as with Pi's tool-call IDs.
 */
function fromPiTool(tool: PiToolDefinition): BridgeTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: serializedSchema(tool.parameters),
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    async execute(toolUseId, parameters, signal) {
      const result = await tool.execute(toolUseId, parameters as never, signal);
      return resultText(result.content);
    },
  };
}

/**
 * `companion_choices`: Pi's tool validates and formats the choices; the
 * bridge then reports them to the backend before returning. If the report
 * fails, the tool fails, so Claude Code never shows a success that the
 * backend did not receive.
 */
function choicesTool(results: { endpoint: string; token: string }): BridgeTool {
  return {
    name: choiceTool.name,
    description: choiceTool.description,
    inputSchema: serializedSchema(choiceTool.parameters),
    promptSnippet: choiceTool.promptSnippet,
    promptGuidelines: choiceTool.promptGuidelines,
    async execute(toolUseId, parameters, signal) {
      const result = await choiceTool.execute(toolUseId, { options: parameters.options }, signal);
      const options = result.details.companionChoices.options;
      await reportResult(results, toolUseId, { kind: 'choices', options }, signal);
      return resultText(result.content);
    },
  };
}

/**
 * `companion_name_session`: Pi's tool validates the title and calls its
 * setter. A fresh tool instance per call captures that title, which is then
 * reported to the backend so it can rename the conversation.
 */
function nameTool(results: { endpoint: string; token: string }): BridgeTool {
  const description = sessionNameTool(() => {});

  return {
    name: description.name,
    description: description.description,
    inputSchema: serializedSchema(description.parameters),
    promptSnippet: description.promptSnippet,
    promptGuidelines: description.promptGuidelines,
    async execute(toolUseId, parameters, signal) {
      let title = '';
      const tool = sessionNameTool((validTitle) => {
        title = validTitle;
      });

      const result = await tool.execute(toolUseId, { title: parameters.title }, signal);
      await reportResult(results, toolUseId, { kind: 'name', title }, signal);
      return resultText(result.content);
    },
  };
}

async function reportResult(
  results: { endpoint: string; token: string },
  toolUseId: string,
  result: TurnResult,
  signal: AbortSignal,
): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/results$/.test(results.endpoint)) {
    throw Error('Companion choices and names require an active Companion conversation');
  }

  const deadline = AbortSignal.timeout(resultReportTimeoutMilliseconds);
  const response = await fetch(results.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${results.token}`,
    },
    body: JSON.stringify({ ...result, toolUseId }),
    signal: AbortSignal.any([signal, deadline]),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw Error(String(body.error || 'Companion did not accept the result'));
  }
}

/** TypeBox schemas are JSON Schema plus symbol keys; JSON keeps only the schema. */
function serializedSchema(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function resultText(content: readonly { type: 'text'; text: string }[]): string {
  const texts: string[] = [];
  for (const block of content) {
    texts.push(block.text);
  }
  return texts.join('\n\n');
}
