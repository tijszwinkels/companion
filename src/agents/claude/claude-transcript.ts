import { object } from '../pi-transcript.ts';
import { chatMessage, type AgentMessage } from '../types.ts';

/**
 * Name of Companion's MCP server in the per-turn Claude Code configuration.
 * Claude Code exposes its tools to the model as `mcp__companion__<tool>`.
 */
export const companionMcpServerName = 'companion';

const companionToolPrefix = `mcp__${companionMcpServerName}__`;

/**
 * Stored tool bubbles, choices and session-tool source links use the same tool
 * names as Pi's native extensions, so the MCP prefix is removed. Other tools
 * (Bash, Read, other MCP servers) keep Claude Code's name.
 */
export function companionToolName(claudeToolName: string): string {
  if (claudeToolName.startsWith(companionToolPrefix)) {
    return claudeToolName.slice(companionToolPrefix.length);
  }

  return claudeToolName;
}

/** Called when a top-level tool call has its result. */
export type ToolFinishedListener = (
  toolUseId: string,
  toolName: string,
  succeeded: boolean,
) => void;

/** Text of a tool result: a plain string or the text blocks of a block array. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const texts: string[] = [];
  for (const block of content) {
    const fields = object(block);
    if (fields.type === 'text') {
      texts.push(String(fields.text ?? ''));
    }
  }

  return texts.join('\n\n');
}

/** Content-block indexes come from the wire; reject anything but a small integer. */
function contentIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw Error('Claude Code sent an invalid content index');
  }

  return value;
}

/**
 * Maps Claude Code's `--output-format stream-json` events to Companion's
 * portable `AgentMessage` shapes, matching what `PiTranscript` emits for Pi:
 *
 * - `assistant-<n>`: one bubble per model API message. Partial text streams
 *   from `stream_event` text deltas (by content-block index); the complete
 *   text block in the following `assistant` event is authoritative and
 *   replaces the streamed text. Thinking is never displayed.
 * - `tool-<tool_use_id>`: one bubble per tool call, `running` when the
 *   complete `tool_use` block arrives and `done`/`error` when its
 *   `tool_result` arrives. The ID matches the session tools' source-link
 *   anchor, exactly as with Pi's tool-call IDs.
 *
 * Claude Code sends each content block in its own `assistant` event (not a
 * cumulative message), so text is assembled per API message ID. Events from
 * subagents (`parent_tool_use_id` set) are internal to the Agent tool and are
 * skipped; the Agent tool's own bubble shows its input and result.
 *
 * Like PiTranscript, this retains only the active assistant message and the
 * inputs of running tool calls; tool results are forwarded, never retained.
 */
export class ClaudeTranscript {
  private assistantCount = 0;
  private assistant: AgentMessage | undefined;
  /** Claude API message ID (`msg_…`) that the current assistant bubble belongs to. */
  private assistantMessageId = '';
  /** Text per content-block index of the current API message. */
  private readonly textBlocks = new Map<number, string>();
  /** Index of the text block currently streaming, which the next complete text block finalizes. */
  private streamingTextIndex: number | undefined;
  /** Running tool calls by tool-use ID. Removed when their result arrives. */
  private readonly runningTools = new Map<string, AgentMessage>();

  constructor(
    private readonly emit: (message: AgentMessage) => void,
    private readonly toolFinished: ToolFinishedListener = () => {},
  ) {}

  receive(event: Record<string, unknown>): void {
    // Subagent traffic is internal to its Agent tool call.
    if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id) {
      return;
    }

    if (event.type === 'stream_event') {
      this.receiveStreamEvent(object(event.event));
      return;
    }

    if (event.type === 'assistant') {
      this.receiveAssistant(event);
      return;
    }

    if (event.type === 'user') {
      this.receiveUser(event);
      return;
    }

    if (event.type === 'result') {
      this.finish();
    }
  }

  /**
   * Close the open assistant bubble and any tool that never received a result,
   * so nothing stays `running` after the turn. Safe to call repeatedly.
   */
  finish(): void {
    this.finishAssistant();

    for (const [toolUseId, tool] of this.runningTools) {
      tool.state = 'error';
      this.emit({
        ...tool,
        text: 'Claude Code ended the turn before this tool returned a result.',
      });
      this.toolFinished(toolUseId, tool.toolName, false);
    }
    this.runningTools.clear();
  }

  private receiveStreamEvent(streamEvent: Record<string, unknown>): void {
    if (streamEvent.type === 'message_start') {
      const message = object(streamEvent.message);
      this.startAssistant(String(message.id ?? ''));
      return;
    }

    if (streamEvent.type === 'content_block_start') {
      const block = object(streamEvent.content_block);
      if (block.type !== 'text') {
        return;
      }

      const index = contentIndex(streamEvent.index);
      this.requireAssistant();
      this.textBlocks.set(index, typeof block.text === 'string' ? block.text : '');
      this.streamingTextIndex = index;
      return;
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = object(streamEvent.delta);
      if (delta.type !== 'text_delta' || typeof delta.text !== 'string') {
        return;
      }

      const index = contentIndex(streamEvent.index);
      const assistant = this.requireAssistant();
      this.textBlocks.set(index, (this.textBlocks.get(index) ?? '') + delta.text);
      this.streamingTextIndex = index;
      assistant.text = this.joinedText();
      this.emit({ ...assistant });
      return;
    }

    if (streamEvent.type === 'message_stop') {
      this.finishAssistant();
    }
  }

  private receiveAssistant(event: Record<string, unknown>): void {
    const message = object(event.message);
    const messageId = String(message.id ?? '');

    // Without partial-message events, a new API message ID is the only
    // boundary between two assistant messages.
    if (this.assistant === undefined || messageId !== this.assistantMessageId) {
      this.startAssistant(messageId);
    }
    const assistant = this.requireAssistant();

    // Claude Code reports API failures (unknown model, overload, …) as a
    // synthetic assistant message with a top-level `error` code.
    if (typeof event.error === 'string' && event.error) {
      assistant.state = 'error';
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = object(rawBlock);

      if (block.type === 'text' && typeof block.text === 'string') {
        this.completeTextBlock(block.text);
        assistant.text = this.joinedText();
        if (assistant.text) {
          this.emit({ ...assistant });
        }
      }

      if (block.type === 'tool_use') {
        this.startTool(block);
      }
    }
  }

  private receiveUser(event: Record<string, unknown>): void {
    const message = object(event.message);
    if (!Array.isArray(message.content)) {
      return;
    }

    for (const rawBlock of message.content) {
      const block = object(rawBlock);
      if (block.type === 'tool_result') {
        // Results only follow a finished API message; close its text first.
        this.finishAssistant();
        this.finishTool(block);
      }
    }
  }

  private startAssistant(messageId: string): void {
    this.finishAssistant();

    this.assistantCount += 1;
    const assistant = chatMessage(`assistant-${this.assistantCount}`, 'assistant', '');
    assistant.state = 'running';
    this.assistant = assistant;
    this.assistantMessageId = messageId;
    this.textBlocks.clear();
    this.streamingTextIndex = undefined;
  }

  private requireAssistant(): AgentMessage {
    if (this.assistant === undefined) {
      throw Error('Claude Code sent content before starting an assistant message');
    }

    return this.assistant;
  }

  /**
   * A complete text block replaces the block that was streaming. Without
   * stream events it is appended after the existing blocks.
   */
  private completeTextBlock(text: string): void {
    let index = this.streamingTextIndex;
    if (index === undefined) {
      index = this.textBlocks.size === 0 ? 0 : Math.max(...this.textBlocks.keys()) + 1;
    }

    this.textBlocks.set(index, text);
    this.streamingTextIndex = undefined;
  }

  private joinedText(): string {
    const indexes = [...this.textBlocks.keys()].sort((left, right) => left - right);
    const texts: string[] = [];
    for (const index of indexes) {
      texts.push(this.textBlocks.get(index) ?? '');
    }

    return texts.join('\n\n');
  }

  /** Emit the final state of the assistant bubble, like Pi's `message_end`. */
  private finishAssistant(): void {
    const assistant = this.assistant;
    if (assistant === undefined) {
      return;
    }

    this.assistant = undefined;
    this.assistantMessageId = '';
    this.streamingTextIndex = undefined;

    if (assistant.state === 'running') {
      assistant.state = 'done';
    }
    if (assistant.text) {
      this.emit({ ...assistant });
    }
  }

  private startTool(block: Record<string, unknown>): void {
    if (typeof block.id !== 'string' || !block.id) {
      throw Error('Claude Code sent a tool call without an ID');
    }

    const tool = chatMessage(`tool-${block.id}`, 'tool', '');
    tool.toolName = companionToolName(String(block.name || 'Tool'));
    tool.input = JSON.stringify(block.input ?? {}, null, 2);
    tool.state = 'running';
    this.runningTools.set(block.id, tool);
    this.emit({ ...tool });
  }

  private finishTool(block: Record<string, unknown>): void {
    const toolUseId = String(block.tool_use_id ?? '');
    const tool = this.runningTools.get(toolUseId);
    if (tool === undefined) {
      return;
    }

    this.runningTools.delete(toolUseId);
    const succeeded = block.is_error !== true;
    tool.state = succeeded ? 'done' : 'error';
    this.emit({ ...tool, text: toolResultText(block.content) });
    this.toolFinished(toolUseId, tool.toolName, succeeded);
  }
}
