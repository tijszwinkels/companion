import { chatMessage, type AgentMessage } from './types.ts';

/** Wire data is untrusted input even though Pi is a local child process. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => object(block).type === 'text')
    .map((block) => String(object(block).text ?? ''))
    .join('\n\n');
}

/**
 * Pi 0.85 RPC sends deltas without a cumulative message. Assemble text by
 * content index and reconcile with message_end, which is authoritative.
 * Thinking events are not part of the displayed answer. Tool output is plain
 * text, bounded here because shell commands can produce arbitrarily much data.
 */
export class PiTranscript {
  private nextId = 0;
  private assistant?: AgentMessage;
  private readonly textBlocks = new Map<number, string>();
  private readonly tools = new Map<string, AgentMessage>();
  failure = '';

  constructor(private readonly emit: (message: AgentMessage) => void) {}

  receive(event: Record<string, unknown>): void {
    const message = object(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') {
      this.assistant = chatMessage(`assistant-${++this.nextId}`, 'assistant', '');
      this.assistant.state = 'running';
      this.textBlocks.clear();
      this.failure = '';
    }

    if (event.type === 'message_update') {
      const delta = object(event.assistantMessageEvent);
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
        if (!this.assistant) {
          throw Error('Pi sent text before starting an assistant message');
        }
        const index = Number(delta.contentIndex);
        if (!Number.isInteger(index) || index < 0) {
          throw Error('Pi sent an invalid content index');
        }

        this.textBlocks.set(index, (this.textBlocks.get(index) ?? '') + delta.delta);
        this.assistant.text = [...this.textBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, text]) => text)
          .join('\n\n');
        this.emit({ ...this.assistant });
      }
    }

    if (event.type === 'message_end' && message.role === 'assistant') {
      this.assistant ??= chatMessage(`assistant-${++this.nextId}`, 'assistant', '');
      this.assistant.text = contentText(message.content);
      const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
      this.assistant.state = failed ? 'error' : 'done';
      this.failure = failed ? String(message.errorMessage || 'Pi could not finish the answer') : '';

      if (this.assistant.text) {
        this.emit({ ...this.assistant });
      }
      this.assistant = undefined;
    }

    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      const tool = chatMessage(`tool-${event.toolCallId}`, 'tool', '');
      tool.toolName = String(event.toolName || 'Tool');
      tool.input = JSON.stringify(event.args ?? {}, null, 2).slice(0, 16384);
      tool.state = 'running';
      this.tools.set(event.toolCallId, tool);
      this.emit({ ...tool });
    }

    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = this.tools.get(String(event.toolCallId));
      if (!tool) {
        return;
      }

      const result = object(event.result ?? event.partialResult);
      const text = contentText(result.content);
      tool.text =
        text.length > 16384 ? text.slice(0, 16384) + '\n[Output truncated in panel]' : text;
      if (event.type === 'tool_execution_end') {
        tool.state = event.isError === true ? 'error' : 'done';
      }
      this.emit({ ...tool });
    }
  }
}
