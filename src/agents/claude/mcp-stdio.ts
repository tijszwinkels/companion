import { Ajv, type ValidateFunction } from 'ajv';

import { object } from '../pi-transcript.ts';
import type { BridgeTool } from './bridge-tools.ts';

/**
 * MCP protocol versions this server understands. Claude Code 2.1.280 requests
 * 2025-11-25; the server answers with the client's version when supported.
 */
const supportedProtocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Largest accepted JSON-RPC line. Widget props are bounded far below this. */
const maximumMessageLength = 8 * 1024 * 1024;

/** JSON-RPC error codes used here. */
const parseErrorCode = -32700;
const invalidRequestCode = -32600;
const methodNotFoundCode = -32601;
const invalidParametersCode = -32602;

/** Where the server reads and writes; process stdio in production, streams in tests. */
export interface McpStdio {
  input: NodeJS.ReadableStream;
  /** Protocol messages only; nothing else may be written to stdout. */
  write(line: string): void;
}

/**
 * A minimal Model Context Protocol server over newline-delimited JSON-RPC on
 * stdio: `initialize`, `ping`, `tools/list`, `tools/call` and cancellation.
 * It exposes only tools and has no resources, prompts or sampling. That is
 * all Claude Code needs from the bridge, and avoids a new dependency.
 *
 * Concurrency: calls run concurrently, each with its own AbortController.
 * Claude Code's `notifications/cancelled` aborts one call; the end of stdin
 * (Claude Code exiting or being killed) aborts every call still running.
 */
export class McpStdioServer {
  private readonly toolsByName = new Map<string, BridgeTool>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly running = new Map<string | number, AbortController>();
  private buffered = '';

  constructor(
    private readonly tools: readonly BridgeTool[],
    private readonly instructions: string,
    private readonly stdio: McpStdio,
  ) {
    // Pi validates tool arguments against the same schemas before running a
    // tool. `strict: false` accepts TypeBox's annotation keywords.
    const ajv = new Ajv({ allErrors: false, strict: false });
    for (const tool of tools) {
      this.toolsByName.set(tool.name, tool);
      this.validators.set(tool.name, ajv.compile(tool.inputSchema));
    }
  }

  /** Serve until stdin ends. Resolves after aborting any calls still running. */
  serve(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.stdio.input.setEncoding('utf8');
      this.stdio.input.on('data', (chunk: string) => {
        this.receiveChunk(chunk);
      });
      this.stdio.input.once('end', () => {
        for (const controller of this.running.values()) {
          controller.abort(Error('Claude Code closed the MCP connection'));
        }
        this.running.clear();
        resolve();
      });
    });
  }

  private receiveChunk(chunk: string): void {
    this.buffered += chunk;

    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim()) {
        this.receiveLine(line);
      }
      newline = this.buffered.indexOf('\n');
    }

    // An unterminated oversized message can never become valid; drop it.
    if (this.buffered.length > maximumMessageLength) {
      this.buffered = '';
      this.sendError(null, invalidRequestCode, 'Message too large');
    }
  }

  private receiveLine(line: string): void {
    if (line.length > maximumMessageLength) {
      this.sendError(null, invalidRequestCode, 'Message too large');
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = object(JSON.parse(line));
    } catch {
      this.sendError(null, parseErrorCode, 'Parse error');
      return;
    }

    const id = message.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    const method = message.method;
    const parameters = object(message.params);

    if (method === 'notifications/cancelled') {
      const requestId = parameters.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.running.get(requestId)?.abort(Error('Claude Code cancelled the tool call'));
      }
      return;
    }

    // Other notifications (for example notifications/initialized) need no answer.
    if (!hasId) {
      return;
    }

    if (method === 'initialize') {
      this.sendResult(id, this.initializeResult(parameters));
      return;
    }

    if (method === 'ping') {
      this.sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      this.sendResult(id, { tools: this.toolList() });
      return;
    }

    if (method === 'tools/call') {
      void this.callTool(id, parameters);
      return;
    }

    this.sendError(id, methodNotFoundCode, `Method not found: ${String(method)}`);
  }

  private initializeResult(parameters: Record<string, unknown>): Record<string, unknown> {
    const requested = parameters.protocolVersion;
    let protocolVersion = supportedProtocolVersions[0];
    if (typeof requested === 'string' && supportedProtocolVersions.includes(requested)) {
      protocolVersion = requested;
    }

    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'companion', version: '1.0.0' },
      instructions: this.instructions,
    };
  }

  private toolList(): Record<string, unknown>[] {
    const list: Record<string, unknown>[] = [];
    for (const tool of this.tools) {
      list.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    return list;
  }

  /**
   * Run one tool. Failures are ordinary tool results with `isError`, which
   * Claude Code reports to the model like Pi's thrown tool errors. Results
   * contain text only: Claude Code would replace text with `structuredContent`.
   */
  private async callTool(id: string | number, parameters: Record<string, unknown>): Promise<void> {
    const name = String(parameters.name ?? '');
    const tool = this.toolsByName.get(name);
    if (tool === undefined) {
      this.sendError(id, invalidParametersCode, `Unknown tool: ${name}`);
      return;
    }

    const toolArguments = object(parameters.arguments);
    const validate = this.validators.get(name)!;
    if (!validate(toolArguments)) {
      const details = validate.errors?.[0];
      const where = details?.instancePath || 'arguments';
      this.sendToolFailure(id, `Invalid arguments for ${name}: ${where} ${details?.message ?? ''}`);
      return;
    }

    // Claude Code identifies the model's tool call in the request metadata.
    // Every Companion tool depends on it: choices and names are correlated by
    // it, and session tools use it as their receipt and source-link ID, like
    // Pi's tool-call ID. Without it the call fails rather than guessing.
    const meta = object(parameters._meta);
    const toolUseId = meta['claudecode/toolUseId'];
    if (typeof toolUseId !== 'string' || !toolUseId) {
      this.sendToolFailure(id, 'Companion tools need Claude Code’s tool-use ID');
      return;
    }

    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const text = await tool.execute(toolUseId, toolArguments, controller.signal);
      this.sendResult(id, { content: [{ type: 'text', text }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendToolFailure(id, message);
    } finally {
      this.running.delete(id);
    }
  }

  private sendToolFailure(id: string | number, message: string): void {
    this.sendResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }

  private sendResult(id: unknown, result: Record<string, unknown>): void {
    this.stdio.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private sendError(id: unknown, code: number, message: string): void {
    this.stdio.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }
}

/**
 * Pi puts each tool's snippet and guidelines into its system prompt. Claude
 * Code puts an MCP server's `instructions` there, so the same text goes here.
 */
export function bridgeInstructions(tools: readonly BridgeTool[]): string {
  const lines: string[] = [
    'Companion conversation tools. Claude Code lists them as mcp__companion__<name>; the guidance below uses their short names.',
    '',
  ];

  for (const tool of tools) {
    if (tool.promptSnippet) {
      lines.push(`- ${tool.name}: ${tool.promptSnippet}`);
    }
  }

  const guidelines: string[] = [];
  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      guidelines.push(`- ${guideline}`);
    }
  }
  if (guidelines.length > 0) {
    lines.push('', 'Guidelines:', ...guidelines);
  }

  return lines.join('\n');
}
